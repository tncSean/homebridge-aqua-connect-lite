/** Unit tests for the PURE ntfy dedupe/rate-limit logic. No network. */
import * as assert from 'node:assert';
import { shouldNotify, recordNotify, NotifyState } from './notifier';

let passed = 0;
function test(name: string, fn: () => void): void {
    fn(); passed++;
    // eslint-disable-next-line no-console
    console.log(`  ok - ${name}`);
}

const HOUR = 60 * 60 * 1000;

test('first notification for a key → true', () => {
    const state: NotifyState = {};
    assert.strictEqual(shouldNotify(state, 'nba', 'Add 130 lbs salt', 1000, HOUR), true);
});

test('identical body → false (never re-notify)', () => {
    const state = recordNotify({}, 'nba', 'Add 130 lbs salt', 1000);
    // Even long after the interval, an identical body is never re-sent.
    assert.strictEqual(shouldNotify(state, 'nba', 'Add 130 lbs salt', 1000 + 5 * HOUR, HOUR), false);
});

test('changed body within interval → false (rate-limited)', () => {
    const state = recordNotify({}, 'nba', 'Add 130 lbs salt', 1000);
    assert.strictEqual(shouldNotify(state, 'nba', 'Add 200 lbs salt', 1000 + HOUR / 2, HOUR), false);
});

test('changed body after interval → true', () => {
    const state = recordNotify({}, 'nba', 'Add 130 lbs salt', 1000);
    assert.strictEqual(shouldNotify(state, 'nba', 'Add 200 lbs salt', 1000 + HOUR + 1, HOUR), true);
});

test('recordNotify updates state immutably', () => {
    const before: NotifyState = {};
    const after = recordNotify(before, 'nba', 'Add 130 lbs salt', 1234);
    assert.deepStrictEqual(before, {}); // original untouched
    assert.deepStrictEqual(after.nba, { body: 'Add 130 lbs salt', sentMs: 1234 });
});

test('distinct keys are independent', () => {
    const state = recordNotify({}, 'nba', 'Add 130 lbs salt', 1000);
    // A different key has no prior entry → notify.
    assert.strictEqual(shouldNotify(state, 'fc', 'FC low', 1000, HOUR), true);
});

// eslint-disable-next-line no-console
console.log(`\n${passed} passed`);
