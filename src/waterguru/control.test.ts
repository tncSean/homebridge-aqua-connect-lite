/**
 * Unit tests for the PURE control-step math. No I/O.
 * Run via `npm test` (standalone node:assert; see discovery.test.ts).
 */
import * as assert from 'node:assert';
import { computeTargetPct, ControlParams } from './control';

let passed = 0;
function test(name: string, fn: () => void): void {
    fn();
    passed++;
    // eslint-disable-next-line no-console
    console.log(`  ok - ${name}`);
}

const P: ControlParams = { minPct: 2, maxPct: 20, maxStep: 3, gain: 2 };
const RANGE: [number, number] = [3, 5]; // WG "ok" band, midpoint 4

test('FC within range → no change (deadband)', () => {
    assert.strictEqual(computeTargetPct(10, 4, RANGE, P), 10);
    assert.strictEqual(computeTargetPct(10, 3, RANGE, P), 10); // low edge inclusive
    assert.strictEqual(computeTargetPct(10, 5, RANGE, P), 10); // high edge inclusive
});

test('FC below range → raise by clamp(gain*error, ±maxStep)', () => {
    // target=midpoint(4), measured=0 → error=4 → gain*err=8 → clamp to +3
    assert.strictEqual(computeTargetPct(10, 0, RANGE, P), 13);
});

test('FC above range → lower by maxStep', () => {
    // measured=8 → error=4-8=-4 → gain*err=-8 → clamp to -3
    assert.strictEqual(computeTargetPct(10, 8, RANGE, P), 7);
});

test('small error rounds and stays under maxStep', () => {
    // fc=3.9 just below band [4,5] → midpoint=4.5 → error=0.6 → gain*err=1.2 → round=1
    assert.strictEqual(computeTargetPct(10, 3.9, [4, 5], P), 11);
});

test('result clamps to maxPct', () => {
    assert.strictEqual(computeTargetPct(19, 0, RANGE, P), 20); // 19+3=22 → 20
});

test('result clamps to minPct', () => {
    assert.strictEqual(computeTargetPct(3, 9, RANGE, P), 2); // 3-3=0 → 2
});

test('already at maxPct, still low → stays at maxPct (no overflow)', () => {
    assert.strictEqual(computeTargetPct(20, 0, RANGE, P), 20);
});

test('returns an integer percent', () => {
    const out = computeTargetPct(10, 0, RANGE, P);
    assert.strictEqual(out, Math.round(out));
});

// eslint-disable-next-line no-console
console.log(`\n${passed} passed`);
