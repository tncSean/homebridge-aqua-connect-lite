/** Unit tests for the PURE daily generation accumulator. No I/O. */
import * as assert from 'node:assert';
import { GenerationTracker } from './generation-tracker';

let passed = 0;
function test(name: string, fn: () => void): void {
    fn(); passed++;
    // eslint-disable-next-line no-console
    console.log(`  ok - ${name}`);
}

const t0 = 1_000_000; // arbitrary ms epoch

test('fresh tracker reports zero fractions', () => {
    const g = new GenerationTracker();
    const s = g.snapshot(t0);
    assert.strictEqual(s.generatingSec, 0);
    assert.strictEqual(s.noFlowSec, 0);
    assert.strictEqual(s.noFlowFraction, 0);
});

test('time in generating accrues to generatingSec', () => {
    const g = new GenerationTracker();
    g.update({ chlorinatorOn: true, chlorinatorIdleReason: undefined }, t0);
    const s = g.snapshot(t0 + 60_000); // +60s generating
    assert.strictEqual(s.generatingSec, 60);
    assert.strictEqual(s.noFlowSec, 0);
});

test('No-Flow idle accrues to noFlowSec, not generating', () => {
    const g = new GenerationTracker();
    g.update({ chlorinatorOn: false, chlorinatorIdleReason: 'No Flow' }, t0);
    const s = g.snapshot(t0 + 30_000);
    assert.strictEqual(s.noFlowSec, 30);
    assert.strictEqual(s.generatingSec, 0);
});

test('transition splits time correctly and computes fraction', () => {
    const g = new GenerationTracker();
    g.update({ chlorinatorOn: true, chlorinatorIdleReason: undefined }, t0);          // generating
    g.update({ chlorinatorOn: false, chlorinatorIdleReason: 'No Flow' }, t0 + 100_000); // +100s gen
    const s = g.snapshot(t0 + 300_000); // +200s noflow
    assert.strictEqual(s.generatingSec, 100);
    assert.strictEqual(s.noFlowSec, 200);
    assert.strictEqual(Math.round(s.noFlowFraction * 100), 67); // 200/300
});

test('off-but-not-NoFlow (e.g. Low temperature) counts as neither', () => {
    const g = new GenerationTracker();
    g.update({ chlorinatorOn: false, chlorinatorIdleReason: 'Low temperature' }, t0);
    const s = g.snapshot(t0 + 50_000);
    assert.strictEqual(s.generatingSec, 0);
    assert.strictEqual(s.noFlowSec, 0);
});

test('reset() zeroes the accumulators and re-anchors', () => {
    const g = new GenerationTracker();
    g.update({ chlorinatorOn: true, chlorinatorIdleReason: undefined }, t0);
    g.snapshot(t0 + 60_000);
    g.reset(t0 + 60_000);
    const s = g.snapshot(t0 + 120_000);
    assert.strictEqual(s.generatingSec, 60); // still generating since reset
});

// eslint-disable-next-line no-console
console.log(`\n${passed} passed`);
