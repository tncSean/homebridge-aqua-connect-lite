/** Unit tests for the PURE chemistry-notification composer. No I/O. */
import * as assert from 'node:assert';
import { buildChemNotification, ChemNotificationInput, isOutOfRange } from './notifysummary';

let passed = 0;
function test(name: string, fn: () => void): void {
    fn(); passed++;
    // eslint-disable-next-line no-console
    console.log(`  ok - ${name}`);
}

function base(): ChemNotificationInput {
    return { nbaActive: false, nbaMessage: '', outOfRange: [] };
}

test('nba active → "Pool needs attention", nbaMessage first', () => {
    const i = base();
    i.nbaActive = true;
    i.nbaMessage = 'Add 130 lbs salt';
    const r = buildChemNotification(i);
    assert.ok(r);
    assert.strictEqual(r!.title, 'Pool needs attention');
    assert.strictEqual(r!.body, 'Add 130 lbs salt');
});

test('nba active + other out-of-range → message first, then "; also "', () => {
    const i = base();
    i.nbaActive = true;
    i.nbaMessage = 'Add 130 lbs salt';
    i.outOfRange = [{ name: 'pH', value: 8.1, unit: 'pH', band: { min: 7.2, max: 7.8 } }];
    const r = buildChemNotification(i);
    assert.ok(r);
    assert.strictEqual(r!.title, 'Pool needs attention');
    assert.strictEqual(r!.body, 'Add 130 lbs salt; also pH 8.1 pH high (target 7.2–7.8)');
});

test('only out-of-range → "Pool chemistry alert" with the list', () => {
    const i = base();
    i.outOfRange = [
        { name: 'Free Chlorine', value: 1, unit: 'ppm', band: { min: 2, max: 4 } },
        { name: 'Total Alkalinity', value: 140, unit: 'ppm', band: { min: 80, max: 120 } },
    ];
    const r = buildChemNotification(i);
    assert.ok(r);
    assert.strictEqual(r!.title, 'Pool chemistry alert');
    assert.strictEqual(
        r!.body,
        'Free Chlorine 1 ppm low (target 2–4); Total Alkalinity 140 ppm high (target 80–120)',
    );
});

test('all good (no nba, empty list) → null', () => {
    assert.strictEqual(buildChemNotification(base()), null);
});

test('high vs low wording', () => {
    const low = buildChemNotification({
        nbaActive: false, nbaMessage: '',
        outOfRange: [{ name: 'Salt', value: 2800, unit: 'ppm', band: { min: 3000, max: 3600 } }],
    });
    assert.match(low!.body, /Salt 2800 ppm low \(target 3000–3600\)/);
    const high = buildChemNotification({
        nbaActive: false, nbaMessage: '',
        outOfRange: [{ name: 'Salt', value: 4000, unit: 'ppm', band: { min: 3000, max: 3600 } }],
    });
    assert.match(high!.body, /Salt 4000 ppm high \(target 3000–3600\)/);
});

test('nba active with empty list → no "; also" suffix', () => {
    const r = buildChemNotification({ nbaActive: true, nbaMessage: 'Add 130 lbs salt', outOfRange: [] });
    assert.strictEqual(r!.body, 'Add 130 lbs salt');
    assert.ok(!r!.body.includes('also'));
});

test('isOutOfRange — defined+outside → true; in-band/undefined → false', () => {
    assert.strictEqual(isOutOfRange(1, { min: 2, max: 4 }), true);
    assert.strictEqual(isOutOfRange(3, { min: 2, max: 4 }), false);
    assert.strictEqual(isOutOfRange(undefined, { min: 2, max: 4 }), false);
    assert.strictEqual(isOutOfRange(3, undefined), false);
});

// eslint-disable-next-line no-console
console.log(`\n${passed} passed`);
