/** Unit tests for the PURE chemistry-compliance classifier. No I/O. */
import * as assert from 'node:assert';
import { complianceLevel, inRange, Band } from './compliance';

let passed = 0;
function test(name: string, fn: () => void): void {
    fn(); passed++;
    // eslint-disable-next-line no-console
    console.log(`  ok - ${name}`);
}

const band: Band = { min: 2, max: 4 }; // width 2 → 25% = 0.5

test('value in band → 1 (Excellent)', () => {
    assert.strictEqual(complianceLevel(3, band), 1);
});

test('just below min within 25% → 3 (Fair)', () => {
    // 1.6 is 0.4 below min (<= 0.5) → Fair
    assert.strictEqual(complianceLevel(1.6, band), 3);
});

test('just above max within 25% → 3 (Fair)', () => {
    // 4.4 is 0.4 above max (<= 0.5) → Fair
    assert.strictEqual(complianceLevel(4.4, band), 3);
});

test('far below band → 5 (Poor)', () => {
    assert.strictEqual(complianceLevel(0.5, band), 5);
});

test('far above band → 5 (Poor)', () => {
    assert.strictEqual(complianceLevel(10, band), 5);
});

test('undefined value → 0 (Unknown)', () => {
    assert.strictEqual(complianceLevel(undefined, band), 0);
});

test('undefined band → 0 (Unknown)', () => {
    assert.strictEqual(complianceLevel(3, undefined), 0);
});

test('inRange true at lower boundary', () => {
    assert.strictEqual(inRange(2, band), true);
});

test('inRange true at upper boundary', () => {
    assert.strictEqual(inRange(4, band), true);
});

test('inRange false just outside boundaries', () => {
    assert.strictEqual(inRange(1.99, band), false);
    assert.strictEqual(inRange(4.01, band), false);
});

test('zero-width band does not divide by zero — out-of-band → 5', () => {
    const zero: Band = { min: 7.5, max: 7.5 };
    assert.strictEqual(complianceLevel(7.5, zero), 1); // exactly on the point → in band
    assert.strictEqual(complianceLevel(7.6, zero), 5); // any deviation → Poor
    assert.strictEqual(complianceLevel(7.4, zero), 5);
});

// eslint-disable-next-line no-console
console.log(`\n${passed} passed`);
