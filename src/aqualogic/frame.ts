/**
 * Hayward Pro Logic RS-485 wire-format primitives.
 *
 * Ported from swilson/aqualogic (Python). Wire is 19200 8N2. A frame is:
 *
 *   DLE STX | payload | checksum (16-bit big-endian sum) | DLE ETX
 *
 * where DLE = 0x10 and STX = 0x02, ETX = 0x03. Inside the bracketed region
 * (payload + checksum), any literal 0x10 byte is byte-stuffed by inserting
 * a 0x00 after it. The checksum covers DLE STX + payload — it is *not*
 * itself stuffed during the sum calculation, but it IS stuffed on the wire.
 */
import { EventEmitter } from 'events';

export const DLE = 0x10;
export const STX = 0x02;
export const ETX = 0x03;

/** Two-byte frame types, matching swilson/aqualogic. */
export const FrameType = {
    KEEP_ALIVE: Buffer.from([0x01, 0x01]),
    LEDS: Buffer.from([0x01, 0x02]),
    DISPLAY_UPDATE: Buffer.from([0x01, 0x03]),
    LONG_DISPLAY_UPDATE: Buffer.from([0x04, 0x0a]),
    PUMP_SPEED_REQUEST: Buffer.from([0x0c, 0x01]),
    PUMP_STATUS: Buffer.from([0x00, 0x0c]),
    WIRELESS_KEY_EVENT: Buffer.from([0x00, 0x83]),
} as const;

export type FrameTypeKey = keyof typeof FrameType;

/** Remove byte-stuffing: any 0x10 followed by 0x00 becomes a single 0x10. */
export function unstuff(buf: Buffer): Buffer {
    const out: number[] = [];
    for (let i = 0; i < buf.length; i++) {
        out.push(buf[i]);
        if (buf[i] === DLE && i + 1 < buf.length && buf[i + 1] === 0x00) {
            i++;
        }
    }
    return Buffer.from(out);
}

/** Insert byte-stuffing: any literal 0x10 gets a 0x00 inserted after it. */
export function stuff(buf: Buffer): Buffer {
    const out: number[] = [];
    for (const b of buf) {
        out.push(b);
        if (b === DLE) out.push(0x00);
    }
    return Buffer.from(out);
}

/** 16-bit big-endian sum of DLE + STX + payload bytes. */
export function checksum(payload: Buffer): number {
    let sum = DLE + STX;
    for (const b of payload) sum += b;
    return sum & 0xffff;
}

/**
 * Build a complete wire frame for a given payload. Returns a buffer
 * that starts with DLE STX and ends with DLE ETX, with byte-stuffing
 * applied to the payload and checksum region.
 */
export function encodeFrame(payload: Buffer): Buffer {
    const cs = checksum(payload);
    const inner = Buffer.concat([payload, Buffer.from([(cs >> 8) & 0xff, cs & 0xff])]);
    const stuffed = stuff(inner);
    return Buffer.concat([Buffer.from([DLE, STX]), stuffed, Buffer.from([DLE, ETX])]);
}

/**
 * Decode a raw frame (including DLE STX header and DLE ETX trailer).
 * Returns the payload (frame type + body, excluding checksum) on success,
 * or null if the frame is malformed or checksum fails.
 */
export function decodeFrame(wire: Buffer): Buffer | null {
    if (wire.length < 6) return null;
    if (wire[0] !== DLE || wire[1] !== STX) return null;
    if (wire[wire.length - 2] !== DLE || wire[wire.length - 1] !== ETX) return null;

    const inner = unstuff(wire.subarray(2, wire.length - 2));
    if (inner.length < 2) return null;

    const payload = inner.subarray(0, inner.length - 2);
    const cs = (inner[inner.length - 2] << 8) | inner[inner.length - 1];
    if (cs !== checksum(payload)) return null;

    return payload;
}

/** True if the payload's first two bytes match the given frame type. */
export function isFrameType(payload: Buffer, type: Buffer): boolean {
    if (payload.length < 2) return false;
    return payload[0] === type[0] && payload[1] === type[1];
}

/**
 * Streaming frame extractor. Fed raw bytes from a socket; emits 'frame'
 * events with the full wire frame (DLE STX ... DLE ETX) whenever one
 * is recognized. Resilient to partial reads, resyncs on stray bytes.
 */
export class FrameExtractor extends EventEmitter {
    private buf: Buffer = Buffer.alloc(0);
    /** Soft upper bound to avoid runaway allocation if we never resync. */
    private static readonly MAX_BUFFER = 4096;

    push(chunk: Buffer): void {
        this.buf = this.buf.length === 0 ? chunk : Buffer.concat([this.buf, chunk]);
        this.drain();
        if (this.buf.length > FrameExtractor.MAX_BUFFER) {
            // Find last DLE STX and keep from there; otherwise drop to the tail.
            const last = this.buf.lastIndexOf(Buffer.from([DLE, STX]));
            this.buf = last >= 0 ? this.buf.subarray(last) : Buffer.alloc(0);
        }
    }

    private drain(): void {
        while (true) {
            const start = this.indexOfStart();
            if (start < 0) {
                this.buf = Buffer.alloc(0);
                return;
            }
            if (start > 0) this.buf = this.buf.subarray(start);

            const end = this.indexOfEnd();
            if (end < 0) return; // wait for more bytes
            const frame = this.buf.subarray(0, end + 2);
            this.buf = this.buf.subarray(end + 2);
            const payload = decodeFrame(frame);
            if (payload) this.emit('frame', payload);
        }
    }

    /** Index of the first DLE STX marker in the buffer. */
    private indexOfStart(): number {
        for (let i = 0; i < this.buf.length - 1; i++) {
            if (this.buf[i] === DLE && this.buf[i + 1] === STX) return i;
        }
        return -1;
    }

    /**
     * Index of the first DLE ETX marker that ends the current frame.
     * Respects byte-stuffing: a DLE 0x00 sequence is data, not a terminator.
     */
    private indexOfEnd(): number {
        let i = 2;
        while (i < this.buf.length - 1) {
            if (this.buf[i] === DLE) {
                const next = this.buf[i + 1];
                if (next === 0x00) { i += 2; continue; }
                if (next === ETX) return i;
                // Any other sequence — could be resync noise. Skip one byte and keep scanning.
                i += 1;
            } else {
                i += 1;
            }
        }
        return -1;
    }
}
