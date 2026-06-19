/** Unit tests for the PURE next-best-action advisor. No I/O. */
import * as assert from 'node:assert';
import { nextBestAction, saltDoseLbs, NextActionInput } from './nextaction';

let passed = 0;
function test(name: string, fn: () => void): void {
    fn(); passed++;
    // eslint-disable-next-line no-console
    console.log(`  ok - ${name}`);
}

function base(): NextActionInput {
    return {
        saltCurrentPpm: 2900,
        saltTargetPpm: 3400,
        saltDeadbandPpm: 150,
        poolGallons: 31400,
    };
}

test('default config 2900→3400 @ 31400 → add 130 lbs, blocks drive', () => {
    const r = nextBestAction(base());
    assert.strictEqual(saltDoseLbs(2900, 3400, 31400), 130);
    assert.strictEqual(r.kind, 'salt');
    assert.strictEqual(r.active, true);
    assert.strictEqual(r.blocksDrive, true);
    assert.strictEqual(r.message, 'Add 130 lbs salt');
    assert.strictEqual(r.tileName, 'Pool: Add 130 lbs salt');
});

test('rounds to nearest 5 (131.25 → 130)', () => {
    // 500 * 31500 / 120000 = 131.25 → 130
    assert.strictEqual(saltDoseLbs(2900, 3400, 31500), 130);
    const r = nextBestAction({ ...base(), poolGallons: 31500 });
    assert.strictEqual(r.message, 'Add 130 lbs salt');
});

test('rounds to nearest 5 (133.75 → 135)', () => {
    // 500 * 32100 / 120000 = 133.75 → 135
    assert.strictEqual(saltDoseLbs(2900, 3400, 32100), 135);
    const r = nextBestAction({ ...base(), poolGallons: 32100 });
    assert.strictEqual(r.message, 'Add 135 lbs salt');
});

test('within deadband → no action, does not block drive', () => {
    const r = nextBestAction({ ...base(), saltCurrentPpm: 3300 }); // 3300 vs 3400-150=3250
    assert.strictEqual(r.kind, 'none');
    assert.strictEqual(r.active, false);
    assert.strictEqual(r.blocksDrive, false);
    assert.strictEqual(r.message, '');
    assert.strictEqual(r.tileName, 'Pool Alert');
});

test('at/above target → no action, dose 0', () => {
    const r = nextBestAction({ ...base(), saltCurrentPpm: 3500, saltDeadbandPpm: 0 });
    assert.strictEqual(r.kind, 'none');
    assert.strictEqual(r.blocksDrive, false);
    assert.strictEqual(saltDoseLbs(3500, 3400, 31400), 0);
});

test('missing config (poolGallons undefined) → no action, no throw', () => {
    const r = nextBestAction({ saltCurrentPpm: 2900, saltTargetPpm: 3400, saltDeadbandPpm: 150 });
    assert.strictEqual(r.kind, 'none');
    assert.strictEqual(r.active, false);
    assert.strictEqual(r.blocksDrive, false);
    assert.strictEqual(r.tileName, 'Pool Alert');
});

test('saltDoseLbs returns 0 when current >= target', () => {
    assert.strictEqual(saltDoseLbs(3400, 3400, 31400), 0);
    assert.strictEqual(saltDoseLbs(3600, 3400, 31400), 0);
});

// eslint-disable-next-line no-console
console.log(`\n${passed} passed`);
