/** Unit tests for the PURE Leslie's history parser. No network. */
import * as assert from 'node:assert';
import { parseHistory, parseBoomiTimestamp, LesliesReading } from './client';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const FIXTURE = require('./__fixtures__/leslies-history.json');

let passed = 0;
function test(name: string, fn: () => void): void {
    fn(); passed++;
    // eslint-disable-next-line no-console
    console.log(`  ok - ${name}`);
}

// ── Boomi timestamp parsing ───────────────────────────────────────────────────

test('parseBoomiTimestamp: yyyyMMdd HHmmss.fff → epoch ms (UTC)', () => {
    const epoch = parseBoomiTimestamp('20260519 154842.757');
    assert.strictEqual(epoch, Date.UTC(2026, 4, 19, 15, 48, 42, 757));
});

test('parseBoomiTimestamp: fractional seconds optional', () => {
    const epoch = parseBoomiTimestamp('20260101 000000');
    assert.strictEqual(epoch, Date.UTC(2026, 0, 1, 0, 0, 0, 0));
});

test('parseBoomiTimestamp: malformed → undefined', () => {
    assert.strictEqual(parseBoomiTimestamp('2026-05-19T15:48:42Z'), undefined);
    assert.strictEqual(parseBoomiTimestamp(''), undefined);
    assert.strictEqual(parseBoomiTimestamp(undefined), undefined);
    assert.strictEqual(parseBoomiTimestamp(12345), undefined);
});

// ── Real-fixture: latest-per-param value extraction ───────────────────────────

test('real fixture: fc === 1.2 (latest reading wins, not the older 3.1)', () => {
    const r: LesliesReading = parseHistory(FIXTURE);
    assert.strictEqual(r.fc, 1.2);
});

test('real fixture: totalChlorine === 1.5', () => {
    assert.strictEqual(parseHistory(FIXTURE).totalChlorine, 1.5);
});

test('real fixture: ph === 7.5', () => {
    assert.strictEqual(parseHistory(FIXTURE).ph, 7.5);
});

test('real fixture: ta === 95 (from "Alkalinity")', () => {
    assert.strictEqual(parseHistory(FIXTURE).ta, 95);
});

test('real fixture: calcium === 250 (latest, not older 180)', () => {
    assert.strictEqual(parseHistory(FIXTURE).calcium, 250);
});

test('real fixture: cya === 16', () => {
    assert.strictEqual(parseHistory(FIXTURE).cya, 16);
});

test('real fixture: salt === 3100', () => {
    assert.strictEqual(parseHistory(FIXTURE).salt, 3100);
});

test('real fixture: copper === 0.1', () => {
    assert.strictEqual(parseHistory(FIXTURE).copper, 0.1);
});

test('real fixture: iron === 0 (zero is a real value, not missing)', () => {
    assert.strictEqual(parseHistory(FIXTURE).iron, 0);
});

test('real fixture: phosphates === 200', () => {
    assert.strictEqual(parseHistory(FIXTURE).phosphates, 200);
});

test('real fixture: tds === 1500', () => {
    assert.strictEqual(parseHistory(FIXTURE).tds, 1500);
});

// ── Real-fixture: ranges, testDate, isStoreTest ───────────────────────────────

test('real fixture: calciumRange [200, 400] from per-reading ideal bounds', () => {
    const r = parseHistory(FIXTURE);
    assert.ok(Array.isArray(r.calciumRange), 'calciumRange should be an array');
    assert.deepStrictEqual(r.calciumRange, [200, 400]);
});

test('real fixture: phRange [7.2, 7.8] from group-level ideal bounds', () => {
    assert.deepStrictEqual(parseHistory(FIXTURE).phRange, [7.2, 7.8]);
});

test('real fixture: testDate is the latest reading epoch (2026-05-19 15:48:42.757 UTC)', () => {
    const r = parseHistory(FIXTURE);
    assert.strictEqual(r.testDate, Date.UTC(2026, 4, 19, 15, 48, 42, 757));
});

test('real fixture: isStoreTest === false (latest reading was AccuBlue Home)', () => {
    assert.strictEqual(parseHistory(FIXTURE).isStoreTest, false);
});

// ── Real-fixture: skips that must NOT produce a value ──────────────────────────

test('real fixture: bromine undefined (null value skipped)', () => {
    assert.strictEqual(parseHistory(FIXTURE).bromine, undefined);
});

test('real fixture: diagnostic "Black Algae" param produces no chemistry field', () => {
    const r = parseHistory(FIXTURE) as Record<string, unknown>;
    // No chemistry key should have leaked from the boolean diagnostic group.
    assert.strictEqual(r['blackAlgae'], undefined);
});

// ── Edge cases ────────────────────────────────────────────────────────────────

test('empty payload {} → empty reading, no crash', () => {
    const r = parseHistory({});
    assert.strictEqual(r.fc, undefined);
    assert.strictEqual(r.salt, undefined);
    assert.strictEqual(r.testDate, undefined);
    assert.strictEqual(r.isStoreTest, undefined);
});

test('null payload → empty reading, no crash', () => {
    const r = parseHistory(null);
    assert.strictEqual(r.calcium, undefined);
});

test('missing water_tests array → empty reading', () => {
    const r = parseHistory({ water_test_history: {} });
    assert.strictEqual(r.fc, undefined);
});

test('group with all-null values → field undefined', () => {
    const r = parseHistory({
        water_test_history: {
            water_tests: [
                { water_test_type: 'Salt', water_test_values: [
                    { timestamp: '20260519 154842.757', value: null },
                ] },
            ],
        },
    });
    assert.strictEqual(r.salt, undefined);
    assert.strictEqual(r.testDate, undefined);
});

test('group with empty water_test_values → no throw, field undefined', () => {
    const r = parseHistory({
        water_test_history: { water_tests: [{ water_test_type: 'pH', water_test_values: [] }] },
    });
    assert.strictEqual(r.ph, undefined);
});

test('unknown water_test_type → ignored, no field leaks', () => {
    const r = parseHistory({
        water_test_history: { water_tests: [
            { water_test_type: 'Unobtanium', water_test_values: [
                { timestamp: '20260519 154842.757', value: 42 },
            ] },
        ] },
    });
    // Only known keys should ever be set; nothing should equal 42.
    assert.ok(!Object.values(r).includes(42 as unknown as never));
});

test('in-store latest reading → isStoreTest true', () => {
    const r = parseHistory({
        water_test_history: { water_tests: [
            { water_test_type: 'Salt', water_test_values: [
                { timestamp: '20260519 154842.757', value: 3200, is_store_test: true },
            ] },
        ] },
    });
    assert.strictEqual(r.salt, 3200);
    assert.strictEqual(r.isStoreTest, true);
});

// eslint-disable-next-line no-console
console.log(`\n${passed} passed`);
