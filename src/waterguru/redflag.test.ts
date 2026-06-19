/** Unit tests for the PURE red-flag detector. No I/O. */
import * as assert from 'node:assert';
import { evaluateRedFlags, RedFlagInput } from './redflag';

let passed = 0;
function test(name: string, fn: () => void): void {
    fn(); passed++;
    // eslint-disable-next-line no-console
    console.log(`  ok - ${name}`);
}

function base(): RedFlagInput {
    return {
        fcHistory: [4, 4, 4],           // ppm, oldest→newest
        pctHistory: [10, 10, 10],       // chlorinator %, oldest→newest
        recommendedRange: [3, 5],
        maxPct: 20,
        noFlowFraction: 0.0,
        saltPpm: 3200,
        cassettePercent: 80,
        podOnline: true,
        wgFetchFailures: 0,
    };
}

test('all healthy → no alert', () => {
    const r = evaluateRedFlags(base());
    assert.strictEqual(r.active, false);
});

test('% climbing ≥3 days with no FC improvement → alert', () => {
    const i = base();
    i.pctHistory = [12, 15, 18];   // rising
    i.fcHistory = [1.0, 1.0, 0.9]; // flat/declining, below band
    const r = evaluateRedFlags(i);
    assert.strictEqual(r.active, true);
    assert.match(r.reason, /not (holding|reaching)|generation|cell|CYA/i);
});

test('at maxPct and FC still below target → alert', () => {
    const i = base();
    i.pctHistory = [20, 20, 20];
    i.fcHistory = [1, 1, 1];
    const r = evaluateRedFlags(i);
    assert.strictEqual(r.active, true);
    assert.match(r.reason, /max|compensate|further/i);
});

test('high No-Flow fraction → flow alert naming the cause', () => {
    const i = base();
    i.noFlowFraction = 0.6;
    const r = evaluateRedFlags(i);
    assert.strictEqual(r.active, true);
    assert.match(r.reason, /No-?Flow|pump|runtime/i);
});

test('low salt → under-driven cell alert with ppm', () => {
    const i = base();
    i.saltPpm = 2200;
    const r = evaluateRedFlags(i);
    assert.strictEqual(r.active, true);
    assert.match(r.reason, /salt/i);
    assert.match(r.reason, /2200/);
});

test('cassette empty → alert', () => {
    const i = base();
    i.cassettePercent = 0;
    const r = evaluateRedFlags(i);
    assert.strictEqual(r.active, true);
    assert.match(r.reason, /cassette/i);
});

test('pod offline → alert', () => {
    const i = base();
    i.podOnline = false;
    const r = evaluateRedFlags(i);
    assert.strictEqual(r.active, true);
    assert.match(r.reason, /pod|offline/i);
});

test('repeated WG fetch failures → alert', () => {
    const i = base();
    i.wgFetchFailures = 3;
    const r = evaluateRedFlags(i);
    assert.strictEqual(r.active, true);
    assert.match(r.reason, /Water\s*Guru|fetch/i);
});

test('flow problem takes priority in reason ordering', () => {
    const i = base();
    i.noFlowFraction = 0.7;
    i.saltPpm = 2200; // also low, but flow should lead
    const r = evaluateRedFlags(i);
    assert.match(r.reason, /No-?Flow|pump|runtime/i);
});

// eslint-disable-next-line no-console
console.log(`\n${passed} passed`);
