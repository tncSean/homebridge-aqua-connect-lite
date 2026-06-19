/** Unit tests for the PURE WG dashboard parser. No network. */
import * as assert from 'node:assert';
import { parseDashboard, WgReading } from './client';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const FIXTURE = require('./__fixtures__/wg-dashboard.json');

let passed = 0;
function test(name: string, fn: () => void): void {
    fn(); passed++;
    // eslint-disable-next-line no-console
    console.log(`  ok - ${name}`);
}

// ── Real-fixture tests ────────────────────────────────────────────────────────

test('real fixture: fc === 0.3', () => {
    const r: WgReading = parseDashboard(FIXTURE);
    assert.strictEqual(r.fc, 0.3);
});

test('real fixture: fcRange GREEN band [1.6, 5.4]', () => {
    const r = parseDashboard(FIXTURE);
    assert.ok(Array.isArray(r.fcRange), 'fcRange should be an array');
    assert.strictEqual(r.fcRange![0], 1.6);
    assert.strictEqual(r.fcRange![1], 5.4);
});

test('real fixture: ph === 7.4', () => {
    const r = parseDashboard(FIXTURE);
    assert.strictEqual(r.ph, 7.4);
});

test('real fixture: waterTempF === 81', () => {
    const r = parseDashboard(FIXTURE);
    assert.strictEqual(r.waterTempF, 81);
});

test('real fixture: podOnline === true', () => {
    const r = parseDashboard(FIXTURE);
    assert.strictEqual(r.podOnline, true);
});

test('real fixture: measureTime is a finite epoch ms', () => {
    const r = parseDashboard(FIXTURE);
    assert.ok(typeof r.measureTime === 'number', 'measureTime should be a number');
    assert.ok(isFinite(r.measureTime!), 'measureTime should be finite');
    assert.ok(r.measureTime! > 0, 'measureTime should be positive');
});

test('real fixture: cassettePercent === 28', () => {
    const r = parseDashboard(FIXTURE);
    assert.strictEqual(r.cassettePercent, 28);
});

test('real fixture: cassetteDays === 9', () => {
    const r = parseDashboard(FIXTURE);
    assert.strictEqual(r.cassetteDays, 9);
});

// ── Edge-case / empty-payload tests ──────────────────────────────────────────

test('empty payload (no waterBodies) → podOnline false, no crash', () => {
    const r = parseDashboard({});
    assert.strictEqual(r.podOnline, false);
    assert.strictEqual(r.fc, undefined);
    assert.strictEqual(r.fcRange, undefined);
});

test('onboarding payload {showSense3Setup:true} → podOnline false', () => {
    const r = parseDashboard({ showSense3Setup: true });
    assert.strictEqual(r.podOnline, false);
    assert.strictEqual(r.fc, undefined);
});

test('waterBody with no measurements → fields undefined, no throw', () => {
    const r = parseDashboard({ waterBodies: [{ waterBodyId: 'x', waterTemp: 75, pods: [] }] });
    assert.strictEqual(r.waterTempF, 75);
    assert.strictEqual(r.fc, undefined);
    assert.strictEqual(r.fcRange, undefined);
    assert.strictEqual(r.podOnline, false);
});

test('measurement with missing floatValue → field undefined, no NaN', () => {
    const payload = {
        waterBodies: [{
            waterTemp: 80,
            latestMeasureTime: '2026-06-18T11:40:54.769Z',
            pods: [{ podId: 1, refillables: [], rssiInfo: { rssi: -50, rssiTime: '2026-06-18T11:40:54.000Z' } }],
            measurements: [{ type: 'FREE_CL', cfg: { floatRanges: { GREEN_MIN: 1.6, GREEN_MAX: 5.4 } } }],
        }],
    };
    const r = parseDashboard(payload);
    assert.strictEqual(r.fc, undefined);
    assert.deepStrictEqual(r.fcRange, [1.6, 5.4]);
    assert.strictEqual(r.podOnline, true);
});

// eslint-disable-next-line no-console
console.log(`\n${passed} passed`);
