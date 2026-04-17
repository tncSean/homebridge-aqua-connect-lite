/**
 * Verify the AquaLogic frame decoder against the live-capture file
 * /tmp/aqualogic-capture.bin and against synthetic round-trip inputs.
 *
 * Run with: npx ts-node scripts/verify-frame.ts
 *
 * Exits non-zero on any failure. Designed to be runnable by CI or by
 * hand before deploying; it is NOT a Homebridge runtime dependency.
 */
import * as fs from 'fs';
import {
    FrameExtractor,
    FrameType,
    decodeFrame,
    encodeFrame,
    stuff,
    unstuff,
    isFrameType,
} from '../src/aqualogic/frame';

type TestResult = { name: string; pass: boolean; detail?: string };
const results: TestResult[] = [];

function check(name: string, cond: boolean, detail?: string) {
    results.push({ name, pass: cond, detail });
}

// --- 1. Byte-stuffing round-trip -------------------------------------------
const raw = Buffer.from([0x10, 0x00, 0x05, 0x10, 0x10, 0x99]);
const stuffed = stuff(raw);
const unstuffed = unstuff(stuffed);
check(
    'stuff/unstuff round-trip preserves bytes',
    Buffer.compare(raw, unstuffed) === 0,
    `stuffed=${stuffed.toString('hex')} unstuffed=${unstuffed.toString('hex')}`
);

// --- 2. Encode/decode round-trip for known payloads ------------------------
const samples = [
    Buffer.from([0x01, 0x01]),                      // keep-alive
    Buffer.from([0x01, 0x02, 0x00, 0x00, 0x00, 0x00]),
    Buffer.concat([FrameType.LONG_DISPLAY_UPDATE, Buffer.from('Pool Temp  78F', 'ascii')]),
    Buffer.from([0x00, 0x83, 0x01, 0x80, 0x00, 0x00, 0x00, 0x80, 0x00, 0x00, 0x00, 0x00]),
];
for (const [i, p] of samples.entries()) {
    const wire = encodeFrame(p);
    const back = decodeFrame(wire);
    check(
        `round-trip sample #${i} (type ${p[0].toString(16)} ${p[1].toString(16)})`,
        back !== null && Buffer.compare(p, back) === 0,
        `wire=${wire.toString('hex')}`
    );
}

// --- 3. Corrupted checksum is rejected -------------------------------------
{
    const good = encodeFrame(Buffer.from([0x01, 0x03, 0x41, 0x42]));
    // Flip a byte inside the payload region.
    const bad = Buffer.from(good);
    bad[3] ^= 0xff;
    check('decodeFrame rejects corrupted checksum', decodeFrame(bad) === null);
}

// --- 4. Live capture file --------------------------------------------------
const CAPTURE = '/tmp/aqualogic-capture.bin';
if (!fs.existsSync(CAPTURE)) {
    console.warn(`! capture file ${CAPTURE} not found, skipping live-bytes test`);
} else {
    const bytes = fs.readFileSync(CAPTURE);
    const ex = new FrameExtractor();
    const collected: Buffer[] = [];
    ex.on('frame', (p: Buffer) => collected.push(p));

    // Push in 64-byte chunks to exercise streaming logic (real socket reads
    // split frames across reads; we must not depend on chunk alignment).
    for (let i = 0; i < bytes.length; i += 64) {
        ex.push(bytes.subarray(i, Math.min(i + 64, bytes.length)));
    }

    // Live-capture file is a 60-second raw stream from the W610 bus bridge.
    // Observed frames-per-second in these captures is 7-8, so the floor here
    // (450) is a safety net against parser regressions, not a precise count.
    check(
        `capture: at least 450 valid frames extracted`,
        collected.length >= 450,
        `extracted=${collected.length} bytes=${bytes.length}`
    );

    // Every payload must have a recognized frame type (first two bytes match
    // a known type constant) OR be one of the observed rare types.
    const known = [
        FrameType.KEEP_ALIVE,
        FrameType.LEDS,
        FrameType.DISPLAY_UPDATE,
        FrameType.LONG_DISPLAY_UPDATE,
        FrameType.PUMP_SPEED_REQUEST,
        FrameType.PUMP_STATUS,
    ];
    const recognized = collected.filter(p =>
        known.some(t => isFrameType(p, t))
    ).length;
    check(
        `capture: ≥95% of frames are known types (${recognized}/${collected.length})`,
        recognized >= collected.length * 0.95
    );

    // All keep-alive frames should be exactly the 2-byte payload 01 01.
    const keepAlive = collected.filter(p => isFrameType(p, FrameType.KEEP_ALIVE));
    check(
        `capture: keep-alives are well-formed (${keepAlive.length} found)`,
        keepAlive.every(p => p.length === 2)
    );
}

// --- Report ----------------------------------------------------------------
let failed = 0;
for (const r of results) {
    const mark = r.pass ? 'PASS' : 'FAIL';
    if (!r.pass) failed++;
    console.log(`${mark}  ${r.name}${r.detail ? `  [${r.detail}]` : ''}`);
}
console.log(`\n${results.length - failed}/${results.length} tests passed`);
process.exit(failed === 0 ? 0 : 1);
