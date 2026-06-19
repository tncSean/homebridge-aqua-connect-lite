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
const DAY = 24 * HOUR;
const INTERVAL = 20 * HOUR; // matches Notifier's MIN_INTERVAL_MS

test('first notification for a key → true', () => {
    const state: NotifyState = {};
    assert.strictEqual(shouldNotify(state, 'chem', 'Add 130 lbs salt', 1000, INTERVAL), true);
});

test('within the interval → false, even with an IDENTICAL body (already reminded today)', () => {
    const state = recordNotify({}, 'chem', 'Add 130 lbs salt', 1000);
    assert.strictEqual(shouldNotify(state, 'chem', 'Add 130 lbs salt', 1000 + 5 * HOUR, INTERVAL), false);
});

test('within the interval → false, even with a CHANGED body (time-window, not body-based)', () => {
    const state = recordNotify({}, 'chem', 'Add 130 lbs salt', 1000);
    assert.strictEqual(shouldNotify(state, 'chem', 'Add 200 lbs salt', 1000 + 5 * HOUR, INTERVAL), false);
});

test('after the interval → true even with the SAME body (next-morning re-reminder)', () => {
    const state = recordNotify({}, 'chem', 'Add 130 lbs salt', 1000);
    // A day later, work still pending, same body → re-remind.
    assert.strictEqual(shouldNotify(state, 'chem', 'Add 130 lbs salt', 1000 + DAY, INTERVAL), true);
});

test('exactly at the interval boundary → true (>=)', () => {
    const state = recordNotify({}, 'chem', 'Add 130 lbs salt', 1000);
    assert.strictEqual(shouldNotify(state, 'chem', 'Add 130 lbs salt', 1000 + INTERVAL, INTERVAL), true);
});

test('recordNotify updates state immutably', () => {
    const before: NotifyState = {};
    const after = recordNotify(before, 'chem', 'Add 130 lbs salt', 1234);
    assert.deepStrictEqual(before, {}); // original untouched
    assert.deepStrictEqual(after.chem, { body: 'Add 130 lbs salt', sentMs: 1234 });
});

test('distinct keys are independent', () => {
    const state = recordNotify({}, 'chem', 'Add 130 lbs salt', 1000);
    // A different key has no prior entry → notify.
    assert.strictEqual(shouldNotify(state, 'other', 'FC low', 1000, INTERVAL), true);
});

// eslint-disable-next-line no-console
console.log(`\n${passed} passed`);
