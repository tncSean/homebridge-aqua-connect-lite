/** Unit tests for the PURE next-best-action advisor. No I/O. */
import * as assert from 'node:assert';
import { nextBestAction, saltDoseLbs, cyaDoseLbs, cyaDoseOz, NextActionInput } from './nextaction';

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

test('cyaDoseLbs 14→40 @ 31400 gal ≈ 6.5 lbs', () => {
    // (31400/10000) * ((40-14)/10) * 0.8 = 3.14 * 2.6 * 0.8 = 6.5312 → 6.5
    assert.strictEqual(cyaDoseLbs(14, 40, 31400), 6.5);
});

test('cyaDoseLbs at/above target → 0', () => {
    assert.strictEqual(cyaDoseLbs(40, 40, 31400), 0);
    assert.strictEqual(cyaDoseLbs(55, 40, 31400), 0);
});

test('cyaDoseLbs rounds to nearest 0.5', () => {
    // 20→30 @ 10000 gal: (1) * (1) * 0.8 = 0.8 → 1.0 (nearest 0.5)
    assert.strictEqual(cyaDoseLbs(20, 30, 10000), 1.0);
    // 0→30 @ 10000 gal: (1) * (3) * 0.8 = 2.4 → 2.5
    assert.strictEqual(cyaDoseLbs(0, 30, 10000), 2.5);
    // 0→20 @ 10000 gal: (1) * (2) * 0.8 = 1.6 → 1.5
    assert.strictEqual(cyaDoseLbs(0, 20, 10000), 1.5);
});

test('cyaDoseOz 14→40 @ 31400 gal, 4 oz/ppm/10k → 325 oz', () => {
    // (31400/10000) * (40-14) * 4 = 3.14 * 26 * 4 = 326.56 → nearest 5 = 325
    assert.strictEqual(cyaDoseOz(14, 40, 31400, 4), 325);
});

test('cyaDoseOz at/above target → 0', () => {
    assert.strictEqual(cyaDoseOz(40, 40, 31400, 4), 0);
    assert.strictEqual(cyaDoseOz(55, 40, 31400, 4), 0);
});

test('cyaDoseOz rounds to nearest 5', () => {
    // 0→10 @ 10000 gal, 4 oz: (1) * 10 * 4 = 40 → 40
    assert.strictEqual(cyaDoseOz(0, 10, 10000, 4), 40);
    // 0→3 @ 10000 gal, 4 oz: (1) * 3 * 4 = 12 → nearest 5 = 10
    assert.strictEqual(cyaDoseOz(0, 3, 10000, 4), 10);
    // 0→4 @ 10000 gal, 4 oz: (1) * 4 * 4 = 16 → nearest 5 = 15
    assert.strictEqual(cyaDoseOz(0, 4, 10000, 4), 15);
});

// eslint-disable-next-line no-console
console.log(`\n${passed} passed`);
