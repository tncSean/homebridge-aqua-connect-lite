#!/usr/bin/env node
/**
 * Diagnostic: send a key event to the W610 after waiting for a KEEP_ALIVE,
 * then watch the bus for 8 seconds to see whether the panel reacts.
 *
 *   node send-test-key.mjs [key] [mode]
 *
 * key  = MENU (default), RIGHT, LEFT, PLUS, MINUS, LIGHTS, FILTER
 * mode = wired (default, 0x00 0x02) or wireless (0x00 0x83)
 *
 * Homebridge MUST be stopped before running — W610 allows one TCP client.
 */
import net from 'node:net';

const KEYS = {
    MENU: 0x02, RIGHT: 0x01, LEFT: 0x04, PLUS: 0x20, MINUS: 0x10,
    LIGHTS: 0x100, FILTER: 0x80, POOL_SPA: 0x40, HEATER_1: 0x40000,
};
const KEY_NAME = (process.argv[2] || 'MENU').toUpperCase();
const MODE = (process.argv[3] || 'wired').toLowerCase();
const KEY = KEYS[KEY_NAME];
if (!KEY) { console.error(`unknown key ${KEY_NAME}`); process.exit(1); }
if (MODE !== 'wired' && MODE !== 'wireless') { console.error('mode must be wired or wireless'); process.exit(1); }

const HOST = '192.168.1.70', PORT = 8899;
const DLE = 0x10, STX = 0x02, ETX = 0x03;

function unstuff(buf) {
    const out = [];
    for (let i = 0; i < buf.length; i++) { out.push(buf[i]); if (buf[i] === DLE && buf[i+1] === 0x00) i++; }
    return Buffer.from(out);
}
function csum(payload) { let s = DLE + STX; for (const b of payload) s += b; return s & 0xffff; }
function encode(payload) {
    const c = csum(payload);
    const inner = Buffer.concat([payload, Buffer.from([(c >> 8) & 0xff, c & 0xff])]);
    const out = [];
    for (const b of inner) { out.push(b); if (b === DLE) out.push(0x00); }
    return Buffer.concat([Buffer.from([DLE, STX]), Buffer.from(out), Buffer.from([DLE, ETX])]);
}
function decode(wire) {
    if (wire.length < 6 || wire[0] !== DLE || wire[1] !== STX) return null;
    if (wire[wire.length-2] !== DLE || wire[wire.length-1] !== ETX) return null;
    const inner = unstuff(wire.subarray(2, wire.length - 2));
    if (inner.length < 2) return null;
    const payload = inner.subarray(0, inner.length - 2);
    const c = (inner[inner.length-2] << 8) | inner[inner.length-1];
    return c === csum(payload) ? payload : null;
}

function buildWiredPress(key16, held16) {
    const body = Buffer.alloc(4);
    body.writeUInt16LE(key16 & 0xffff, 0);
    body.writeUInt16LE(held16 & 0xffff, 2);
    return Buffer.concat([Buffer.from([0x00, 0x02]), body]);
}

function buildWirelessPress(key32) {
    // swilson/aqualogic: FRAME_TYPE_WIRELESS_KEY_EVENT + 0x01 + key[4 LE] + key[4 LE] + 0x00
    const keyLE = Buffer.alloc(4);
    keyLE.writeUInt32LE(key32 >>> 0, 0);
    return Buffer.concat([Buffer.from([0x00, 0x83]), Buffer.from([0x01]), keyLE, keyLE, Buffer.from([0x00])]);
}

const sock = net.createConnection({ host: HOST, port: PORT });
sock.setNoDelay(true);
let buf = Buffer.alloc(0);
let sent = false;
const tsStart = Date.now();
const ts = () => `+${(Date.now() - tsStart).toString().padStart(4, '0')}ms`;

function extractFrames(chunk) {
    buf = buf.length ? Buffer.concat([buf, chunk]) : chunk;
    const frames = [];
    while (true) {
        let start = -1;
        for (let i = 0; i < buf.length - 1; i++) { if (buf[i] === DLE && buf[i+1] === STX) { start = i; break; } }
        if (start < 0) { buf = Buffer.alloc(0); break; }
        if (start > 0) buf = buf.subarray(start);
        let end = -1, i = 2;
        while (i < buf.length - 1) {
            if (buf[i] === DLE) {
                if (buf[i+1] === 0x00) { i += 2; continue; }
                if (buf[i+1] === ETX) { end = i; break; }
                i += 1;
            } else i += 1;
        }
        if (end < 0) break;
        frames.push(buf.subarray(0, end + 2));
        buf = buf.subarray(end + 2);
    }
    return frames;
}

function labelFrame(payload) {
    if (!payload || payload.length < 2) return 'bad';
    const t = (payload[0] << 8) | payload[1];
    const map = {
        0x0101: 'KEEP_ALIVE', 0x0102: 'LEDS', 0x0103: 'DISPLAY',
        0x040a: 'LONG_DISP', 0x000c: 'PUMP', 0x0c01: 'PUMP_REQ',
        0x0002: 'WIRED_KEY', 0x0083: 'WIRELESS_KEY',
    };
    return map[t] || `T0x${t.toString(16).padStart(4,'0')}`;
}

sock.on('connect', () => console.log(`[${ts()}] connected; ${MODE} ${KEY_NAME}(0x${KEY.toString(16)}) on next KEEP_ALIVE...`));

sock.on('data', chunk => {
    for (const frame of extractFrames(chunk)) {
        const payload = decode(frame);
        const label = labelFrame(payload);
        const body = payload ? payload.subarray(2) : Buffer.alloc(0);
        if (label === 'KEEP_ALIVE' && !sent) {
            if (MODE === 'wired') {
                const press = encode(buildWiredPress(KEY & 0xffff, KEY & 0xffff));
                const rel = encode(buildWiredPress(KEY & 0xffff, 0));
                sock.write(press);
                console.log(`[${ts()}] >>> sent WIRED PRESS   ${press.toString('hex')}`);
                setTimeout(() => { sock.write(rel); console.log(`[${ts()}] >>> sent WIRED RELEASE ${rel.toString('hex')}`); }, 70);
            } else {
                const p = encode(buildWirelessPress(KEY));
                sock.write(p);
                console.log(`[${ts()}] >>> sent WIRELESS KEY  ${p.toString('hex')}`);
            }
            sent = true;
        }
        if (label === 'DISPLAY' || label === 'LONG_DISP') {
            const text = [];
            for (const b of body) text.push((b >= 0x20 && b <= 0x7e) ? String.fromCharCode(b) : (b === 0xdf ? '°' : '.'));
            const clean = text.join('').replace(/\.+/g, '.').replace(/^\./,'').replace(/\s+$/,'');
            if (clean.length > 2) console.log(`[${ts()}] <<< ${label}  "${clean}"`);
        } else if (label === 'LEDS') {
            console.log(`[${ts()}] <<< LEDS  ${body.toString('hex')}`);
        } else if (label === 'WIRED_KEY' || label === 'WIRELESS_KEY') {
            console.log(`[${ts()}] <<< ${label}  ${body.toString('hex')}`);
        }
    }
});
sock.on('error', e => console.log(`[${ts()}] !! ${e.message}`));
setTimeout(() => { console.log(`[${ts()}] --- done ---`); sock.destroy(); process.exit(0); }, 8000);
