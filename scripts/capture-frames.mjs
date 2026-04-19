#!/usr/bin/env node
/**
 * Standalone AquaLogic frame capture.
 *
 *   node scripts/capture-frames.mjs [host] [port] [logfile]
 *
 * Connects to the W610 TCP-serial bridge, decodes AquaLogic frames, and
 * emits timestamped lines to stdout AND to a log file. Nothing is written
 * back to the bus — read-only observer.
 *
 * Frames: DLE(0x10) STX(0x02) <payload + csum> DLE(0x10) ETX(0x03), with
 * 0x10 byte-stuffed as 0x10 0x00 inside the bracketed region.
 */
import net from 'node:net';
import fs from 'node:fs';
import path from 'node:path';

const HOST = process.argv[2] || '192.168.1.70';
const PORT = Number(process.argv[3] || 8899);
const LOGFILE = process.argv[4] || `/tmp/aqualogic-capture-${new Date().toISOString().replace(/[:.]/g, '-')}.log`;

const DLE = 0x10;
const STX = 0x02;
const ETX = 0x03;

const FrameTypes = new Map([
    ['0101', 'KEEP_ALIVE'],
    ['0102', 'LEDS'],
    ['0103', 'DISPLAY_UPDATE'],
    ['040a', 'LONG_DISPLAY_UPDATE'],
    ['0c01', 'PUMP_SPEED_REQUEST'],
    ['000c', 'PUMP_STATUS'],
    ['0083', 'WIRELESS_KEY_EVENT'],
    ['0002', 'LOCAL_WIRED_KEY_EVENT'],
]);

const KeyNames = new Map([
    [0x00000001, 'RIGHT'], [0x00000002, 'MENU'], [0x00000004, 'LEFT'], [0x00000008, 'SERVICE'],
    [0x00000010, 'MINUS'], [0x00000020, 'PLUS'], [0x00000040, 'POOL_SPA'], [0x00000080, 'FILTER'],
    [0x00000100, 'LIGHTS'], [0x00000200, 'AUX_1'], [0x00000400, 'AUX_2'], [0x00000800, 'AUX_3'],
    [0x00001000, 'AUX_4'], [0x00002000, 'AUX_5'], [0x00004000, 'AUX_6'], [0x00008000, 'AUX_7'],
    [0x00010000, 'VALVE_3'], [0x00020000, 'VALVE_4'], [0x00040000, 'HEATER_1'], [0x00080000, 'AUX_8'],
    [0x00100000, 'AUX_9'], [0x00200000, 'AUX_10'], [0x00400000, 'AUX_11'], [0x00800000, 'AUX_12'],
    [0x01000000, 'AUX_13'], [0x02000000, 'AUX_14'],
]);

function unstuff(buf) {
    const out = [];
    for (let i = 0; i < buf.length; i++) {
        out.push(buf[i]);
        if (buf[i] === DLE && i + 1 < buf.length && buf[i + 1] === 0x00) i++;
    }
    return Buffer.from(out);
}

function sumCheck(payload) {
    let sum = DLE + STX;
    for (const b of payload) sum += b;
    return sum & 0xffff;
}

function decodeFrame(wire) {
    if (wire.length < 6) return null;
    if (wire[0] !== DLE || wire[1] !== STX) return null;
    if (wire[wire.length - 2] !== DLE || wire[wire.length - 1] !== ETX) return null;
    const inner = unstuff(wire.subarray(2, wire.length - 2));
    if (inner.length < 2) return null;
    const payload = inner.subarray(0, inner.length - 2);
    const cs = (inner[inner.length - 2] << 8) | inner[inner.length - 1];
    if (cs !== sumCheck(payload)) return null;
    return payload;
}

class Extractor {
    buf = Buffer.alloc(0);
    onFrame = () => {};
    push(chunk) {
        this.buf = this.buf.length ? Buffer.concat([this.buf, chunk]) : chunk;
        while (true) {
            const start = this.indexOfStart();
            if (start < 0) { this.buf = Buffer.alloc(0); break; }
            if (start > 0) this.buf = this.buf.subarray(start);
            const end = this.indexOfEnd();
            if (end < 0) break;
            const frame = this.buf.subarray(0, end + 2);
            this.buf = this.buf.subarray(end + 2);
            const payload = decodeFrame(frame);
            this.onFrame(payload, frame);
        }
        if (this.buf.length > 4096) {
            const last = this.buf.lastIndexOf(Buffer.from([DLE, STX]));
            this.buf = last >= 0 ? this.buf.subarray(last) : Buffer.alloc(0);
        }
    }
    indexOfStart() {
        for (let i = 0; i < this.buf.length - 1; i++) {
            if (this.buf[i] === DLE && this.buf[i + 1] === STX) return i;
        }
        return -1;
    }
    indexOfEnd() {
        let i = 2;
        while (i < this.buf.length - 1) {
            if (this.buf[i] === DLE) {
                const next = this.buf[i + 1];
                if (next === 0x00) { i += 2; continue; }
                if (next === ETX) return i;
                i += 1;
            } else i += 1;
        }
        return -1;
    }
}

// ------------------------------------------------------------------
// Display / LED helpers
// ------------------------------------------------------------------

const DISPLAY_CHARS = {
    0xba: '°', 0xdf: '°', 0x00: ' ',
};

function decodeDisplayText(payload) {
    // 0x01 0x03 ...ascii text, high bits sometimes set
    const body = payload.subarray(2);
    const chars = [];
    for (const b of body) {
        if (b === 0x00) chars.push(' ');
        else if (b >= 0x20 && b <= 0x7e) chars.push(String.fromCharCode(b));
        else if (DISPLAY_CHARS[b]) chars.push(DISPLAY_CHARS[b]);
        else chars.push('.');
    }
    return chars.join('');
}

function decodeWirelessKey(payload) {
    // 0x00 0x83 | 0x01 | key[4 LE] | key[4 LE] | 0x00
    if (payload.length < 7) return null;
    const prefix = payload[2];
    const key = payload.readUInt32LE(3);
    const name = KeyNames.get(key) || `UNKNOWN_0x${key.toString(16)}`;
    return { prefix, key, name };
}

function decodeLeds(payload) {
    // 0x01 0x02 | 4 bytes LE bitmask (swilson) — bit positions map to LEDs
    const body = payload.subarray(2);
    return body.toString('hex');
}

// ------------------------------------------------------------------
// Main
// ------------------------------------------------------------------

fs.mkdirSync(path.dirname(LOGFILE), { recursive: true });
const logStream = fs.createWriteStream(LOGFILE, { flags: 'a' });
let frameCount = 0;
const typeCounts = new Map();

function log(line) {
    const ts = new Date().toISOString();
    const msg = `${ts}  ${line}`;
    process.stdout.write(msg + '\n');
    logStream.write(msg + '\n');
}

log(`=== capture started host=${HOST} port=${PORT} logfile=${LOGFILE} ===`);

const sock = net.createConnection({ host: HOST, port: PORT });
sock.setNoDelay(true);

sock.on('connect', () => log(`connected to ${HOST}:${PORT}`));
sock.on('error', err => log(`!! socket error: ${err.message}`));
sock.on('close', () => {
    log(`disconnected (captured ${frameCount} frames)`);
    log('type counts: ' + JSON.stringify(Object.fromEntries(typeCounts)));
    logStream.end();
});

const ex = new Extractor();
ex.onFrame = (payload, wire) => {
    if (!payload || payload.length < 2) {
        log(`[bad   ] wire=${wire.toString('hex')}`);
        return;
    }
    frameCount++;
    const t = payload.subarray(0, 2).toString('hex');
    const typeName = FrameTypes.get(t) || `UNKNOWN_0x${t}`;
    typeCounts.set(typeName, (typeCounts.get(typeName) || 0) + 1);

    const body = payload.subarray(2);
    const bodyHex = body.toString('hex');

    if (typeName === 'KEEP_ALIVE') {
        // Too chatty — summarize every 25th
        const n = typeCounts.get('KEEP_ALIVE');
        if (n === 1 || n % 25 === 0) log(`[KA #${n}] ${bodyHex}`);
        return;
    }

    if (typeName === 'DISPLAY_UPDATE' || typeName === 'LONG_DISPLAY_UPDATE') {
        const text = decodeDisplayText(payload);
        log(`[${typeName}] "${text.trimEnd()}"  raw=${bodyHex}`);
        return;
    }

    if (typeName === 'LEDS') {
        log(`[${typeName}] ${decodeLeds(payload)}`);
        return;
    }

    if (typeName === 'WIRELESS_KEY_EVENT' || typeName === 'LOCAL_WIRED_KEY_EVENT') {
        const k = decodeWirelessKey(payload);
        log(`[${typeName}] ${k ? `${k.name} key=0x${k.key.toString(16)} prefix=0x${k.prefix.toString(16)}` : bodyHex}`);
        return;
    }

    log(`[${typeName}] ${bodyHex}`);
};

sock.on('data', chunk => ex.push(chunk));

process.on('SIGINT', () => { log('SIGINT — closing'); sock.destroy(); process.exit(0); });
process.on('SIGTERM', () => { log('SIGTERM — closing'); sock.destroy(); process.exit(0); });
