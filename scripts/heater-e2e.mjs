#!/usr/bin/env node
/**
 * End-to-end heater control test harness.
 *
 * Simulates the HomeKit thermostat driving the Hayward Pro Logic:
 *   - Reads live state from the W610 RS-485 bridge (192.168.1.70:8899)
 *   - Sends keypresses via the HTTP bridge (192.168.1.65/WNewSt.htm)
 *   - Navigates the Heater1 submenu and adjusts setpoint
 *   - Verifies end state from panel display
 *
 *   node heater-e2e.mjs <command>
 *
 * Commands:
 *   on <temp>   turn heater on and set setpoint (65-104°F)
 *   off         turn heater off
 *   set <temp>  set setpoint (assumes heater already on)
 *   observe     just read state for 15s (no presses)
 *
 * Homebridge MUST be stopped — W610 allows one TCP client.
 */
import net from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';

const W610_HOST = '192.168.1.70', W610_PORT = 8899;
const BRIDGE_URL = 'http://192.168.1.65/WNewSt.htm';

const MIN_F = 65, MAX_F = 104;
const MAX_STEPS = 45;
const KEY_GAP_MS = 500;
const READ_TIMEOUT_MS = 8000;

const KeyId = {
    RIGHT: '01', MENU: '02', LEFT: '03', MINUS: '05', PLUS: '06',
    POOL_SPA: '07', FILTER: '08', LIGHTS: '09', AUX_1: '0A', AUX_2: '0B',
    VALVE_3: '11', HEATER_1: '13',
};

// ------------------------------------------------------------------
// Frame decoder (mirrors production plugin)
// ------------------------------------------------------------------

const DLE = 0x10, STX = 0x02, ETX = 0x03;

function unstuff(buf) {
    const out = [];
    for (let i = 0; i < buf.length; i++) { out.push(buf[i]); if (buf[i] === DLE && buf[i+1] === 0x00) i++; }
    return Buffer.from(out);
}
function csum(payload) { let s = DLE + STX; for (const b of payload) s += b; return s & 0xffff; }
function decode(wire) {
    if (wire.length < 6 || wire[0] !== DLE || wire[1] !== STX) return null;
    if (wire[wire.length-2] !== DLE || wire[wire.length-1] !== ETX) return null;
    const inner = unstuff(wire.subarray(2, wire.length - 2));
    if (inner.length < 2) return null;
    const payload = inner.subarray(0, inner.length - 2);
    const c = (inner[inner.length-2] << 8) | inner[inner.length-1];
    return c === csum(payload) ? payload : null;
}

// ------------------------------------------------------------------
// Live W610 state reader
// ------------------------------------------------------------------

class PanelState {
    constructor() {
        this.heaterSetpoint = null; // 'off' | number | null
        this.heaterDisplayLine = null;
        this.lastDisplayText = null;
        this.heaterLedOn = false;
        this._listeners = [];
    }
    onChange(fn) { this._listeners.push(fn); }
    _emit(key, value) { for (const fn of this._listeners) fn(key, value); }

    ingest(payload) {
        const type = (payload[0] << 8) | payload[1];
        if (type === 0x0103 || type === 0x040a) this._ingestDisplay(payload);
        else if (type === 0x0102) this._ingestLeds(payload);
    }

    _ingestDisplay(payload) {
        const body = payload.subarray(2);
        // Extract longest printable ASCII run
        let best = '', cur = '';
        for (const b of body) {
            if ((b >= 0x20 && b <= 0x7e) || b === 0xdf || b === 0xba) cur += String.fromCharCode(b);
            else { if (cur.length > best.length) best = cur; cur = ''; }
        }
        if (cur.length > best.length) best = cur;
        if (best.length < 10) return;
        const text = best.replace(/\xdf/g, '°').replace(/\s+/g, ' ').trim();
        this.lastDisplayText = text;

        if (/Heater\s*1/i.test(text)) {
            this.heaterDisplayLine = text;
            if (process.env.E2E_VERBOSE) console.log(`      DISPLAY  "${text}"`);
            // Prefer direct setpoint readout: "Pool Heater1 XX°F"
            const m = text.match(/Heater\s*1\b[^\d]*?(\d{2,3})\s*°?F/i);
            if (m) {
                const f = parseInt(m[1], 10);
                if (f >= 50 && f <= 110) {
                    if (this.heaterSetpoint !== f) { this.heaterSetpoint = f; this._emit('setpoint', f); }
                    return;
                }
            }
            // Only treat "Off" as setpoint when we're in the submenu. The
            // submenu display is "Pool Heater1 Off"; the top-level auto-cycle
            // shows "Heater1 Manual Off" or "Heater1 Auto Control". Those are
            // control-mode labels, NOT setpoint values.
            if (/Pool\s+Heater\s*1\b.*\bOff\b/i.test(text) && !/Manual\s+Off/i.test(text)) {
                if (this.heaterSetpoint !== 'off') { this.heaterSetpoint = 'off'; this._emit('setpoint', 'off'); }
            }
        } else if (process.env.E2E_VERBOSE) {
            if (this._lastDisplayLogged !== text) {
                console.log(`      display "${text}"`);
                this._lastDisplayLogged = text;
            }
        }
    }

    _ingestLeds(payload) {
        const body = payload.subarray(2);
        if (body.length < 1) return;
        const on = (body[0] & 0x01) !== 0;
        const hex = body.toString('hex');
        if (this._lastLedHex !== hex) {
            if (process.env.E2E_VERBOSE) console.log(`      LEDS     ${hex}`);
            this._lastLedHex = hex;
        }
        if (on !== this.heaterLedOn) { this.heaterLedOn = on; this._emit('led', on); }
    }

    clearSetpoint() {
        this.heaterSetpoint = null;
    }
}

class Reader {
    constructor(host, port, state) {
        this.host = host; this.port = port; this.state = state;
        this.buf = Buffer.alloc(0);
    }
    connect() {
        return new Promise((resolve, reject) => {
            this.sock = net.createConnection({ host: this.host, port: this.port });
            this.sock.setNoDelay(true);
            this.sock.once('connect', resolve);
            this.sock.once('error', reject);
            this.sock.on('data', chunk => this._onData(chunk));
        });
    }
    close() { if (this.sock) this.sock.destroy(); }

    _onData(chunk) {
        this.buf = this.buf.length ? Buffer.concat([this.buf, chunk]) : chunk;
        while (true) {
            let start = -1;
            for (let i = 0; i < this.buf.length - 1; i++) if (this.buf[i] === DLE && this.buf[i+1] === STX) { start = i; break; }
            if (start < 0) { this.buf = Buffer.alloc(0); break; }
            if (start > 0) this.buf = this.buf.subarray(start);
            let end = -1, i = 2;
            while (i < this.buf.length - 1) {
                if (this.buf[i] === DLE) {
                    if (this.buf[i+1] === 0x00) { i += 2; continue; }
                    if (this.buf[i+1] === ETX) { end = i; break; }
                    i++;
                } else i++;
            }
            if (end < 0) break;
            const frame = this.buf.subarray(0, end + 2);
            this.buf = this.buf.subarray(end + 2);
            const payload = decode(frame);
            if (payload) this.state.ingest(payload);
        }
    }
}

// ------------------------------------------------------------------
// HTTP keypress
// ------------------------------------------------------------------

async function pressKey(keyId, label) {
    const body = `KeyId=${keyId}&`;
    const res = await fetch(BRIDGE_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Connection': 'close' },
        body,
    });
    log(`>>> press ${label}(${keyId}) → HTTP ${res.status}`);
    if (res.status !== 200) throw new Error(`press ${label} failed HTTP ${res.status}`);
}

// ------------------------------------------------------------------
// Test harness
// ------------------------------------------------------------------

const t0 = Date.now();
function log(msg) { console.log(`[${(Date.now() - t0).toString().padStart(5, ' ')}ms] ${msg}`); }

function waitFor(state, key, timeoutMs, predicate) {
    return new Promise(resolve => {
        let done = false;
        const finish = v => { if (done) return; done = true; clearTimeout(timer); resolve(v); };
        const timer = setTimeout(() => finish(null), timeoutMs);
        state.onChange((k, v) => {
            if (k !== key) return;
            if (!predicate || predicate(v)) finish(v);
        });
        // If already set, resolve now
        const cur = key === 'setpoint' ? state.heaterSetpoint : state.heaterLedOn;
        if (cur !== null && cur !== undefined && (!predicate || predicate(cur))) finish(cur);
    });
}

async function enterSubmenuAndReadSetpoint(state) {
    log(`entering heater submenu`);
    state.clearSetpoint();
    await pressKey(KeyId.HEATER_1, 'HEATER_1');
    await delay(KEY_GAP_MS);
    await pressKey(KeyId.PLUS, 'PLUS');
    log(`waiting for setpoint readback...`);
    const sp = await waitFor(state, 'setpoint', READ_TIMEOUT_MS);
    if (sp === null) throw new Error('setpoint not observed within timeout');
    log(`read setpoint = ${sp === 'off' ? 'Off' : sp + '°F'}`);
    return sp;
}

async function pressN(keyId, label, count) {
    const n = Math.min(Math.max(0, Math.floor(count)), MAX_STEPS);
    log(`pressing ${label} × ${n}`);
    for (let i = 0; i < n; i++) {
        await pressKey(keyId, label);
        if (i < n - 1) await delay(KEY_GAP_MS);
    }
}

async function turnOn(state, targetF) {
    const target = Math.min(Math.max(MIN_F, targetF), MAX_F);
    const current = await enterSubmenuAndReadSetpoint(state);
    if (current === target) { log(`already at ${target}°F — done`); return; }
    if (current === 'off') {
        const extra = target - MIN_F;
        log(`Off → ${target}°F (1 PLUS to enable + ${extra} PLUS to adjust)`);
        await pressN(KeyId.PLUS, 'PLUS', 1 + extra);
    } else {
        const delta = target - current;
        await pressN(delta > 0 ? KeyId.PLUS : KeyId.MINUS, delta > 0 ? 'PLUS' : 'MINUS', Math.abs(delta));
    }
    // Verify
    state.clearSetpoint();
    const final = await waitFor(state, 'setpoint', READ_TIMEOUT_MS);
    log(`FINAL setpoint = ${final === 'off' ? 'Off' : final + '°F'}`);
    if (final !== target) log(`⚠ expected ${target}, got ${final}`);
}

async function turnOff(state) {
    const current = await enterSubmenuAndReadSetpoint(state);
    if (current === 'off') { log(`already off — done`); return; }
    const presses = (current - MIN_F) + 1;
    log(`${current}°F → Off (${presses} MINUS)`);
    await pressN(KeyId.MINUS, 'MINUS', presses);
    state.clearSetpoint();
    const final = await waitFor(state, 'setpoint', READ_TIMEOUT_MS);
    log(`FINAL setpoint = ${final === 'off' ? 'Off' : final + '°F'}`);
    if (final !== 'off') log(`⚠ expected Off, got ${final}`);
}

async function observe(state, secs) {
    log(`observing for ${secs}s...`);
    const end = Date.now() + secs * 1000;
    while (Date.now() < end) {
        await delay(1000);
        log(`display: "${state.lastDisplayText}" | heaterSetpoint=${state.heaterSetpoint} | heaterLedOn=${state.heaterLedOn}`);
    }
}

// ------------------------------------------------------------------
// Main
// ------------------------------------------------------------------

async function main() {
    const cmd = (process.argv[2] || '').toLowerCase();
    const arg = Number(process.argv[3]);
    const state = new PanelState();
    const reader = new Reader(W610_HOST, W610_PORT, state);
    await reader.connect();
    log(`connected to W610 ${W610_HOST}:${W610_PORT}`);

    try {
        if (cmd === 'on') {
            if (!Number.isFinite(arg)) throw new Error('usage: on <temp>');
            await turnOn(state, arg);
        } else if (cmd === 'off') {
            await turnOff(state);
        } else if (cmd === 'set') {
            if (!Number.isFinite(arg)) throw new Error('usage: set <temp>');
            await turnOn(state, arg);
        } else if (cmd === 'observe') {
            await observe(state, Number.isFinite(arg) ? arg : 15);
        } else if (cmd === 'press') {
            // press <keyName> — diagnostic single-press then observe 8s
            const name = (process.argv[3] || '').toUpperCase();
            const id = KeyId[name];
            if (!id) throw new Error(`unknown key ${name}; options: ${Object.keys(KeyId).join(', ')}`);
            await pressKey(id, name);
            await observe(state, 8);
        } else {
            console.error('commands: on <t>, off, set <t>, observe [secs], press <keyName>');
            process.exit(2);
        }
    } catch (e) {
        log(`ERROR: ${e.message}`);
        process.exitCode = 1;
    } finally {
        reader.close();
    }
}

main().catch(e => { log(`FATAL: ${e.message}`); process.exit(1); });
