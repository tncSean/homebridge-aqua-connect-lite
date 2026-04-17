# Security Review — Aquaconnect Plugin v3.0.0

> **Status (as of v3.0.5):** All findings below have been remediated. The raw
> report is preserved unaltered for auditability. See the "Security posture"
> section of the README for the summary of what shipped in v3.0.1+.

**Date:** 2026-04-17
**Scope:** src/ + scripts/
**Threat model:** LAN-only Homebridge plugin; untrusted bytes from W610 TCP and from Hayward HTTP bridge; user-supplied Homebridge config.

---

## Summary

The plugin is generally well-structured for a LAN-only accessory. No hardcoded secrets, no `eval` or dynamic code execution, no SQL injection surface, and the frame parser is defensively written with buffer limits and checksum validation. The most significant issues are: (1) unbounded keypress loops in the `bump()` → `sendKeyRepeated()` path that can produce up to 100 consecutive keypresses from a single HomeKit write; (2) missing validation on `bridge_ip_address` / `w610_ip` config values before they are used in HTTP URLs and TCP connections; (3) a top-level throw in `keyFromName()` from an invalid config value that can crash Homebridge accessory setup for all accessories; and (4) display text from the RS-485 bus (attacker-controllable on a shared LAN) being logged verbatim with no sanitization. Total findings: 2 High, 3 Medium, 3 Low.

---

## Findings

### [HIGH] Unbounded keypress count in `bump()` / `sendKeyRepeated()`

- **File:** `src/aqualogic/client.ts:92-97`, `src/chlorinator.ts:87-91`
- **Evidence:**
  ```ts
  async sendKeyRepeated(key: KeyValue, count: number, intervalMs = 150): Promise<void> {
      for (let i = 0; i < count; i++) {
          await this.sendKey(key);
          if (i < count - 1) await sleep(intervalMs);
      }
  }
  ```
  `Chlorinator.flushPending()` calls `this.client.bump(current, target)` where `current` defaults to `0` (when the controller has not yet reported `chlorinatorPercent`) and `target` is the HomeKit Brightness value — potentially 100. This sends 100 PLUS keypresses over 15 seconds without any upper-bound guard.
- **Impact:** A HomeKit client dragging the chlorinator slider from 0 to 100 when `chlorinatorPercent` is `undefined` triggers 100 consecutive keypresses to the Pro Logic. The same applies to the thermostat when `heaterSetpointF` is unknown and target is far from the unknown current. This can leave the Pro Logic in an unpredictable mode (the PLUS key navigates menus, not just adjusts values) or briefly DoS bus traffic.
- **Fix:** Add a hard cap in `sendKeyRepeated` (e.g. `count = Math.min(count, 40)`) and guard the `bump` callers: if `current` is unknown (`undefined` state field), skip the bump and log a warning rather than defaulting to 0.

  ```ts
  async sendKeyRepeated(key: KeyValue, count: number, intervalMs = 150): Promise<void> {
      const MAX_STEPS = 40;
      const safe = Math.min(Math.abs(count), MAX_STEPS);
      for (let i = 0; i < safe; i++) {
          await this.sendKey(key);
          if (i < safe - 1) await sleep(intervalMs);
      }
  }
  ```

---

### [HIGH] Config values `bridge_ip_address` and `w610_ip` used without validation

- **File:** `src/util.ts:28`, `src/platform.ts:82-85`
- **Evidence:**
  ```ts
  url: `http://${platform.config.bridge_ip_address}${AC_API_SETTINGS.PATH}`,
  ```
  ```ts
  const host = (this.config.w610_ip as string | undefined) || AQUALOGIC_DEFAULTS.HOST;
  const port = (this.config.w610_port as number | undefined) || AQUALOGIC_DEFAULTS.PORT;
  this.aquaLogicClient = new AquaLogicClient({ host, port, log: this.log });
  ```
- **Impact:** `bridge_ip_address` is user-supplied from `config.json` and is interpolated directly into an Axios URL with no validation. A misconfigured or malicious value like `"192.168.1.65@evil.internal/WNewSt.htm#"` or an unexpected protocol-relative string could result in requests being sent to unintended hosts (SSRF risk on the local network). `w610_ip` is passed directly to `net.createConnection` — if it is `undefined`, `null`, or a non-string type, Node.js will either throw synchronously inside `connect()` (uncaught in a constructor) or connect to an unexpected address. `w610_port` has no range check; `0` or `65536` would produce a Node.js error that propagates uncaught.
- **Fix:** Validate `bridge_ip_address` and `w610_ip` as dotted-decimal IPv4 addresses (or simple hostnames) before use; validate `w610_port` as `1-65535`. A simple regex check at platform startup suffices:

  ```ts
  const IP_RE = /^(\d{1,3}\.){3}\d{1,3}$/;
  if (!IP_RE.test(config.bridge_ip_address)) {
      this.log.error('bridge_ip_address is not a valid IPv4 address — aborting');
      return;
  }
  ```

---

### [MEDIUM] `keyFromName()` throw crashes Homebridge accessory setup if config value is invalid

- **File:** `src/aqualogic/keys.ts:44`, `src/superchlor.ts:31`
- **Evidence:**
  ```ts
  export function keyFromName(name: string): KeyValue {
      const k = name.toUpperCase() as KeyName;
      const v = Key[k];
      if (v === undefined) throw new Error(`Unknown Pro Logic key: ${name}`);
      return v;
  }
  ```
  Called from `SuperChlor` constructor → `bindAccessory()` → `discoverAccessories()`. The call chain has no try/catch.
- **Impact:** If the user sets `super_chlorinate_key` to any string not in the `Key` map (a typo, an empty string, or a numeric value cast to string), the thrown `Error` propagates through `discoverAccessories()` uncaught. Depending on Homebridge's internal error handling for `didFinishLaunching`, this can abort registration of all subsequent accessories in the loop, leaving the platform partially or fully non-functional with no actionable user-facing error.
- **Fix:** Wrap the `keyFromName` call in `SuperChlor` constructor (or in `bindAccessory`) with try/catch, log a meaningful error and fall back to the default key or skip the accessory gracefully:

  ```ts
  let toggleKey: KeyValue;
  try {
      toggleKey = keyFromName(keyName);
  } catch {
      this.platform.log.error(
          `super_chlorinate_key "${keyName}" is not a valid Pro Logic key. ` +
          `Valid keys: ${Object.keys(Key).join(', ')}. Defaulting to AUX_3.`
      );
      toggleKey = Key.AUX_3;
  }
  ```

---

### [MEDIUM] Log injection via attacker-controllable display text

- **File:** `src/aqualogic/state.ts:74`, `src/tempsensor.ts:48`
- **Evidence:**
  ```ts
  this.setField('lastDisplayText', text);   // state.ts:74
  // ...
  platform.log.debug(`${this.accessory.displayName} temp=${c.toFixed(1)}°C`);
  ```
  `extractDisplayText` accepts all printable latin1 bytes including `0xdf` and `0xba`, then the display text is stored as `lastDisplayText` and eventually logged by accessory handlers. The RS-485 bus is unauthenticated — any LAN device can connect to the W610's TCP port and inject frames. An injected DISPLAY_UPDATE frame with crafted text could contain ANSI escape sequences (e.g. `\x1b[31m`) or embedded newlines that pollute the Homebridge log output.
- **Impact:** Log injection enables visual spoofing of Homebridge log output in terminal environments. It does not enable code execution. Impact is low in practice (LAN-only, Homebridge runs headlessly) but can confuse operators and potentially exploit log-aggregator parsing.
- **Fix:** Strip non-printable ASCII and ANSI escape sequences from display text before logging:

  ```ts
  const sanitizeLog = (s: string) => s.replace(/[\x00-\x1f\x7f\x1b]/g, '?');
  platform.log.debug(`display: ${sanitizeLog(text)}`);
  ```
  The `lastDisplayText` field stored in `PoolState` can remain unsanitized for debugging purposes; only the log output path needs sanitizing.

---

### [MEDIUM] `exclude_accessories` config value not guarded as array at runtime

- **File:** `src/platform.ts:77-79`
- **Evidence:**
  ```ts
  const excluded = (this.config.exclude_accessories as string[] | undefined) ?? [];
  const hasAqualogic = ACCESSORIES.some(
      a => a.TRANSPORT === 'aqualogic' && !excluded.includes(a.NAME),
  );
  ```
- **Impact:** If a user sets `exclude_accessories` to a non-array (e.g. a string `"Pool Light"` instead of `["Pool Light"]`), the `as string[]` cast silently succeeds at the TypeScript layer but at runtime `excluded.includes` will behave unexpectedly (`"Pool Light".includes("Pool Light")` returns `true` via `String.prototype.includes`, which coincidentally works, but `"Pool Light".includes("Aux 1")` will character-scan the string rather than checking list membership). This could silently fail to exclude accessories.
- **Fix:** Add a runtime array check:
  ```ts
  const excluded = Array.isArray(this.config.exclude_accessories)
      ? (this.config.exclude_accessories as string[])
      : [];
  if (!Array.isArray(this.config.exclude_accessories) && this.config.exclude_accessories !== undefined) {
      this.log.warn('exclude_accessories must be an array of strings — ignoring value');
  }
  ```

---

### [LOW] `scripts/` directory ships in the npm package

- **File:** `package.json` (no `files` field, no `.npmignore` at project root)
- **Evidence:** `package.json` has no `files` field and there is no `.npmignore` in `plugin-source/`. The `scripts/verify-frame.ts` and `scripts/verify-state.ts` files will be included in any published tarball.
- **Impact:** The scripts contain a hardcoded reference to `/tmp/aqualogic-capture.bin` — a file that may contain raw RS-485 bus capture data including pool controller traffic. While the path is a `/tmp/` reference and the scripts themselves are benign, shipping unnecessary development scripts increases the attack surface for downstream consumers inspecting the package, and the capture-file path could hint at operational details.
- **Fix:** Add a `files` field to `package.json` to whitelist only shipped artifacts:
  ```json
  "files": ["dist/", "config.schema.json", "LICENSE"]
  ```

---

### [LOW] Default W610 IP address hardcoded in `settings.ts`

- **File:** `src/settings.ts:22`
- **Evidence:**
  ```ts
  export const AQUALOGIC_DEFAULTS = {
      HOST: '192.168.1.70',
      PORT: 8899,
  };
  ```
- **Impact:** The default host IP is a specific internal network address that ships in the public npm package. This is a minor information disclosure — it reveals the installer's LAN addressing scheme to anyone who reads the source. It is not a vulnerability in isolation but is unnecessary; a generic placeholder (e.g. `''`) forces explicit configuration.
- **Fix:** Either use an empty string default (which would cause the W610 path to fail gracefully if not configured) or document clearly that this is a common default and users should override it.

---

### [LOW] `console.log/warn/error` fallback bypasses Homebridge log redaction

- **File:** `src/aqualogic/client.ts:41-44`
- **Evidence:**
  ```ts
  this.log = opts.log ?? {
      debug: m => console.debug(`[aqualogic] ${m}`),
      info:  m => console.log(`[aqualogic] ${m}`),
      warn:  m => console.warn(`[aqualogic] ${m}`),
      error: m => console.error(`[aqualogic] ${m}`),
  };
  ```
- **Impact:** The fallback path is only exercised if `opts.log` is not provided. In normal Homebridge operation `platform.log` is always injected. The fallback is therefore only relevant to unit tests or direct instantiation. The messages logged on this path contain only host:port strings and error messages — no secrets. Risk is negligible.
- **Fix:** No action required. Informational only.

---

## Clean areas

- **Frame parsing (`frame.ts`):** `FrameExtractor` has an explicit 4096-byte buffer cap with resync on overflow. `decodeFrame` validates checksum before returning payload. `unstuff` and `stuff` are O(n) with no loops, no recursion, no integer underflow possible (index checks are all `i + 1 < buf.length`). No infinite loop risk found.
- **ReDoS:** All regexes in `util.ts` (`candidateRe`, `ledPattern`) and `state.ts` (`tempRe`, `setptM`, filter/chlorinator patterns) use simple character classes and `\d+` quantifiers with no alternation or nested quantifiers. No catastrophic backtracking is possible.
- **No hardcoded secrets:** No passwords, API tokens, or credentials were found in any source file. The `192.168.1.70` default is a network address constant, not a credential.
- **No `eval`, `Function()`, `vm.runInThisContext`, or dynamic `require`:** Confirmed absent across all source files.
- **Socket error handling (`client.ts`):** `'error'` event handler is registered before `connect()` returns. `'close'` handler implements exponential backoff. The `extractor.push` and `state.ingest` calls inside data/frame callbacks are wrapped in try/catch that log warnings rather than propagating. Unhandled rejection risk is contained.
- **HTTP path injection (`util.ts`):** The URL path component is hardcoded to `/WNewSt.htm` from `AC_API_SETTINGS.PATH`. The only user-controlled component is the host, which is the same `bridge_ip_address` concern noted above. No query-string injection, no path traversal.
- **Axios `validateStatus`:** Strictly requires HTTP 200; any other status throws and is caught by retry logic.
- **`decodeFrame` on PUMP_STATUS bytes:** Index bounds are checked (`payload.length >= 5`, `>= 7`) before accessing bytes. No out-of-bounds read possible.
- **Thermostat `clamp()`:** Target temperature is clamped to `[MIN_F, MAX_F]` = `[65, 104]` before computing the `bump()` delta. This bounds the worst-case keypress count to 39 (still potentially problematic — see High finding — but not unbounded for the thermostat path specifically).

---

## Recommended follow-ups

1. **Add a startup config validation function** in `platform.ts` that checks all required and optional config fields (IP format, port range, key name validity) before `discoverAccessories()` runs. A single validation pass gives the user a clear error rather than runtime failures scattered across accessory constructors.

2. **Consider a per-operation lock or cooldown for `bump()`** to prevent multiple concurrent HomeKit characteristic writes from stacking key bursts. The `writing` flag in `Chlorinator` and `Thermostat` is a good start but the debounce window (300ms / 500ms) may still allow a second write to arrive and queue while the first flush is in flight.

3. **Sanitize display text before storing it in `lastDisplayText`** (not just before logging), so that any consumer of `PoolState.lastDisplayText` gets clean data. The field is currently marked as "for debugging" — if it ever surfaces in a HomeKit characteristic or log aggregator, unsanitized content could cause issues.

4. **Run `npm audit` before each release.** The plugin has two runtime dependencies (`axios`, `node-html-parser`) and both receive regular security updates. Axios in particular has had past CVEs related to SSRF and header injection.
