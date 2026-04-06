# homebridge-aqua-connect-lite

Control your Hayward pool controller via HomeKit using the Aqua Connect Home Network interface.

## Features

- **HomeKit Integration** - Control pool lights and aux relays from the Home app, Siri, or automations
- **Reliable Communication** - Retry logic with exponential backoff for transient failures
- **Configurable Timeout** - Adjustable HTTP request timeout (default: 5 seconds)
- **Firmware Resilience** - Robust HTML parsing with fallback patterns

## Requirements

- **Hayward Pool Controller**: Pro Logic, Aqua Plus, or Aqua Rite Pro
- **Aqua Connect Home Network** (AQ-CO-HOMENET) device
- **Homebridge** v1.3.5 or later
- **Node.js** v18 or later

## Installation

### Via Homebridge Config UI X (Recommended)

1. Open Homebridge Config UI X
2. Go to **Plugins** → **+ Add Plugin**
3. Search for `homebridge-aqua-connect-lite`
4. Click **Install**
5. Configure your bridge IP address (e.g., `192.168.1.65`)
6. Restart Homebridge

### Manual Installation

```bash
npm install -g homebridge-aqua-connect-lite
```

## Configuration

Add to your Homebridge `config.json`:

```json
{
  "platforms": [
    {
      "platform": "AquaConnectLite",
      "name": "Aqua Connect Lite",
      "bridge_ip_address": "192.168.1.65",
      "request_timeout": 5000,
      "retry_attempts": 3,
      "exclude_accessories": []
    }
  ]
}
```

### Configuration Options

| Option | Type | Required | Default | Description |
|--------|------|----------|---------|-------------|
| `bridge_ip_address` | string | Yes | - | IP address of your Aqua Connect device |
| `request_timeout` | number | No | 5000 | HTTP timeout in milliseconds |
| `retry_attempts` | number | No | 3 | Number of retry attempts (0-5) |
| `exclude_accessories` | string[] | No | [] | Accessories to disable (e.g., `["Pool Light"]`) |

## Supported Devices

| Device | Type | Process Key | Status Index |
|--------|------|-------------|--------------|
| Pool Light | Lightbulb | 09 | 4 |
| Aux 1 | Switch | 0A | 9 |
| Aux 2 | Switch | 0B | 10 |

### Adding Aux 3-6

To support additional aux channels, edit `src/settings.ts` and add entries:

```typescript
{
    NAME: 'Aux 3',
    TYPE: ACCESSORY_TYPE.SWITCH,
    PROCESS_KEY_NUM: '0C',  // Check your controller manual for key numbers
    STATUS_KEY_INDEX: 11
}
```

Then rebuild and reinstall the plugin.

## Troubleshooting

### Device Not Responding

1. **Check connectivity**: `curl http://192.168.1.65/WNewSt.htm`
2. **Verify IP address**: Ensure the bridge IP in config matches your device
3. **Check timeout**: Increase `request_timeout` if your network is slow

### Device Shows "No Response" in HomeKit

- The pool controller may be offline
- Check Homebridge logs for connection errors
- Verify the Aqua Connect device is powered and connected

### HTML Parsing Errors

If a firmware update changes the controller's web interface, you may see parsing errors. The plugin has fallback patterns, but you may need to:

1. Check the plugin issues for updates
2. Temporarily increase `retry_attempts`
3. Consider the RS-485 direct connection alternative (see Roadmap)

## How It Works

The plugin communicates with the Aqua Connect Home Network device via HTTP:

1. **Status Query**: POST `Update Local Server&` to `/WNewSt.htm`
2. **Parse Response**: Extract LED status from HTML (24-character byte string)
3. **Toggle Device**: POST `KeyId=XX&` to simulate button press

This approach emulates physical button presses on the controller - the same method used by the official Aqua Connect mobile app.

## Roadmap

- [ ] **RS-485 Direct Connection** - Bypass web scraping for direct serial communication
- [ ] **Configurable Accessories** - Add Aux 3-6 via Config UI
- [ ] **Connection Health Monitoring** - Mark devices offline after repeated failures
- [ ] **Energy Monitoring** - Track pump runtime and energy usage (if supported)

## Credits

- Original plugin by [cupshir](https://github.com/cupshir/homebridge-aqua-connect-lite)
- Hayward pool controller protocol reverse-engineered by the [Home Assistant community](https://community.home-assistant.io/t/hayward-aqualogic-prologic-automation/52340)

## License

Apache-2.0
