# homebridge-aqua-connect-lite

A Homebridge plugin that exposes Hayward Pro Logic / Aqua Rite Pro / Aqua Plus pool controllers to Apple HomeKit.

Version 3 uses **two transports** simultaneously:

1. The official **Aqua Connect Home Network** HTTP bridge (AQ-CO-HOMENET) at `http://<ip>/WNewSt.htm` — the way the Hayward mobile app talks to the controller — for LED-tracked actuators like pool light and valves.
2. A direct **RS-485 connection** via a USR-W610 serial-to-WiFi bridge (or equivalent) for numeric telemetry and control surfaces the HTTP bridge can't expose: water/air temperature, heater setpoint, chlorinator percent, pump RPM, Super Chlorinate state.

The RS-485 path is based on the [swilson/aqualogic](https://github.com/swilson/aqualogic) protocol reverse-engineering, ported to TypeScript and validated byte-for-byte against a live 60-second bus capture (468/470 frames decode with valid checksums).

## What HomeKit sees

| HomeKit accessory       | Transport   | Notes |
|-------------------------|-------------|-------|
| Pool Light (Lightbulb)  | HTTP        | On/off via `LIGHTS` key; LED-tracked. |
| Waterfalls (Switch)     | HTTP        | Via `VALVE_3`. `INVERT: true` — LED tracks valve position, which is inverse of flow. |
| Aux 1 / Aux 2 (Switch)  | HTTP        | Disabled by default; enable via `exclude_accessories`. |
| Pool Heater (Thermostat)| RS-485      | Current temp, target setpoint, mode (Off / Heat / Heating). Setpoint writes via `PLUS`/`MINUS` keypress emulation after `HEATER_1` navigation. |
| Chlorinator (Lightbulb-as-dimmer) | RS-485 | On = producing; Brightness 0–100 = output %. Debounced keypress writes. |
| Super Chlorinate (Switch) | RS-485    | State reflects the "Super Chlorinate" display banner. Duration is set on the Pro Logic, not by the plugin. |
| Filter Pump (Fan)       | RS-485      | On/off via `FILTER` key. **Rotation speed is read-only** — the Pro Logic's VSP speed profiles own pump speed (set `SPILLOVER → 90%` on the keypad); HomeKit slider writes snap back to the actual value. |
| Pool Water Temp (TemperatureSensor) | RS-485 | Read-only. |
| Air Temp (TemperatureSensor) | RS-485 | Read-only. |

## Requirements

- **Hayward pool controller:** Pro Logic, Aqua Plus, or Aqua Rite Pro.
- **Aqua Connect Home Network** (`AQ-CO-HOMENET`) — already on your LAN.
- **For RS-485 accessories (v3 additions):** a USR-W610 or compatible serial-to-WiFi bridge wired to the Pro Logic's REMOTE DISPLAY / YELLOW-BLACK (RS-485) terminals, configured for **19200 8N2** in TCP-Server mode on port **8899**.
- **Homebridge** ≥ 1.3.5, **Node.js** ≥ 18.

### RS-485 wiring gotcha

On the Hayward Pro Logic REMOTE DISPLAY header the pins are:
```
1 = +12V   2 = A (data)   3 = B (data)   4 = GND
```
The W610 labels are `A+` and `B-`. **Polarity must cross**: Hayward pin 2 (A/black) → W610 `B-`, Hayward pin 3 (B/yellow) → W610 `A+`. Naive A-to-A / B-to-B produces garbled bytes. Set the W610 to 19200 baud, 8 data bits, no parity, 2 stop bits. Leave pin 1 (+12V) disconnected if the W610 is self-powered.

## Install

### Via Homebridge Config UI X (recommended)

1. In the Config UI, **Plugins → + Add Plugin**, search `homebridge-aqua-connect-lite`, click **Install**.
2. Fill in `bridge_ip_address` (required) and — if you have the RS-485 bridge — `w610_ip`.
3. Restart Homebridge.

### Manual

```bash
npm install -g homebridge-aqua-connect-lite
```

## Configuration

```json
{
  "platforms": [
    {
      "platform": "AquaConnectLite",
      "name": "Aqua Connect Lite",
      "bridge_ip_address": "192.168.1.65",
      "w610_ip": "192.168.1.70",
      "w610_port": 8899,
      "super_chlorinate_key": "AUX_3",
      "request_timeout": 5000,
      "retry_attempts": 3,
      "exclude_accessories": ["Aux 1", "Aux 2"]
    }
  ]
}
```

| Option                  | Type     | Required | Default         | Description |
|-------------------------|----------|----------|-----------------|-------------|
| `bridge_ip_address`     | string   | yes      | —               | IP of the Aqua Connect Home Network device. |
| `w610_ip`               | string   | no       | `192.168.1.70`  | IP of the USR-W610 RS-485 bridge. Leave empty to disable all RS-485 accessories. |
| `w610_port`             | number   | no       | `8899`          | TCP port the W610 listens on. |
| `super_chlorinate_key`  | string   | no       | `AUX_3`         | Pro Logic button programmed to trigger Super Chlorinate. Must match your installer's setup. |
| `request_timeout`       | number   | no       | `5000`          | HTTP timeout in milliseconds for the AQ-CO-HOMENET bridge. |
| `retry_attempts`        | number   | no       | `3`             | HTTP retries with exponential backoff (500ms → 1s → 2s). |
| `exclude_accessories`   | string[] | no       | `["Aux 1","Aux 2"]` | Accessory names to disable. |

## Behavior notes you should know

**Cold-start writes are refused, not guessed.** The RS-485 path is a passive observer — the plugin only learns the heater setpoint and chlorinator percent when the Pro Logic's display auto-cycles through those screens (usually within ~30–60 seconds of connection). Until then, HomeKit writes to the Thermostat or Chlorinator will log a warning and no-op rather than emit fabricated keypresses. Wait for the first "setpoint read from Pro Logic" log line before expecting writes to take effect.

**"Heater1 Off" is a setpoint, not a mode.** On Hayward, the heater PLUS/MINUS cycle goes `Off → 65 → 66 → … → 104`. The plugin treats `Off` as a distinct first-class state: HomeKit shows the thermostat as OFF, and setpoint-bump writes refuse to run (you must enable the heater at the keypad first; the first PLUS press from Off jumps to 65°F, not `current + N`).

**Pump speed is owned by Pro Logic.** The RS-485 protocol cannot set a pump percent directly. It can only toggle the FILTER key and emit LEFT/RIGHT on the pump menu (Low/High). For "waterfalls on → pump at 90%" behavior, program the Pro Logic VSP speed profiles at the keypad (SPILLOVER → 90%). The plugin's Fan accessory exposes `RotationSpeed` as **read-only**; HomeKit writes snap back to the actual value.

**Schedule ownership.** The Pro Logic has its own timeclocks (Settings → Timers) for filter, heater, chlorinator, and aux relays. HomeKit Automations also work against the plugin's switches. Pick one owner per piece of equipment — running both will conflict.

**Keypress bursts are capped.** A single HomeKit write fires at most 40 keypresses over the RS-485 bus (see `AquaLogicClient.MAX_STEPS`). This bounds both the worst-case Pro Logic setpoint adjust and the worst-case bus utilization.

## Architecture

```
src/
├── index.ts                    # Homebridge entry point
├── platform.ts                 # Platform + accessory discovery + transport wiring
├── settings.ts                 # Accessory registry, constants, types
├── util.ts                     # HTTP client for the AQ-CO-HOMENET bridge
│
├── light.ts · switch.ts        # HTTP-transport accessories (v2 parity)
│
├── thermostat.ts               # Pool Heater
├── chlorinator.ts              # Chlorinator (Lightbulb-as-dimmer)
├── superchlor.ts               # Super Chlorinate (Switch)
├── fan.ts                      # Filter Pump (Fan, read-only speed)
├── tempsensor.ts               # Pool Water + Air temperature sensors
│
└── aqualogic/                  # RS-485 protocol implementation
    ├── frame.ts                # Byte-stuffing, checksum, streaming FrameExtractor
    ├── keys.ts                 # Pro Logic keycode bitfield
    ├── state.ts                # PoolStateStore — display-text parser + state model
    └── client.ts               # TCP client, reconnect/backoff, sendKey, bump
```

Display text is the source of truth for numeric state, not the raw LED bitfield — the Pro Logic cycles self-labeling strings like `Pool Temp  78°F` and `Pool Chlorinator  30%` through its display every few seconds, so parsing errors are visible from the outside.

## Build from source

```bash
npm install
npm run build
npm pack                # produces homebridge-aqua-connect-lite-<version>.tgz
```

### Offline protocol tests

Two standalone verification scripts exercise the frame decoder and state parser against a captured byte stream:

```bash
# Capture live bus traffic first (optional — the scripts look for /tmp/aqualogic-capture.bin):
nc 192.168.1.70 8899 > /tmp/aqualogic-capture.bin
# Then:
npx ts-node scripts/verify-frame.ts   # 9 parser + round-trip assertions
npx ts-node scripts/verify-state.ts   # 5 state-field assertions
```

Both scripts exit non-zero on any failure.

## Security posture

A structured security review was performed in April 2026 — see [`SECURITY-REVIEW.md`](SECURITY-REVIEW.md). Two High, three Medium, and one Low finding were identified; all were remediated in v3.0.1. No critical vulnerabilities, no hardcoded secrets, no dynamic code execution paths.

Specifically addressed:
- Unbounded keypress loops in `bump()` / `sendKeyRepeated()` (now hard-capped at 40).
- Config-supplied IPs and ports are validated before use in URLs and sockets.
- `keyFromName()` exceptions are contained per-accessory with graceful fallback.
- Display text is sanitized of control/escape bytes before logging (the RS-485 bus is unauthenticated on-LAN).
- `exclude_accessories` is type-guarded at runtime.
- `scripts/` and `src/` are excluded from the published npm tarball via `"files"`.

## Contributing

Issues and PRs welcome. The protocol work — especially LED-bitfield decoding and PUMP_STATUS byte-level semantics across firmware versions — is the area most likely to benefit from community captures. If you submit a capture file, strip any setpoint-menu frames that reveal identifying timings.

## Credits

- Original Aqua Connect HTTP plugin by [@cupshir](https://github.com/cupshir/homebridge-aqua-connect-lite).
- RS-485 protocol: [swilson/aqualogic](https://github.com/swilson/aqualogic) (Python reference).
- Hayward Pro Logic community documentation via the Home Assistant forums.

## License

Apache-2.0 — see [`LICENSE`](LICENSE).
