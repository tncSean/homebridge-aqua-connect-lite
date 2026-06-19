/** Unit tests for the PURE schedule helper. No timers. */
import * as assert from 'node:assert';
import { msUntilNext } from './controller';

let passed = 0;
function test(name: string, fn: () => void): void {
    fn(); passed++;
    // eslint-disable-next-line no-console
    console.log(`  ok - ${name}`);
}

test('later today → positive sub-day delay', () => {
    const now = new Date('2026-06-18T08:00:00');
    const ms = msUntilNext('09:30', now);
    assert.strictEqual(ms, 90 * 60_000); // 1h30m
});

test('already past → rolls to tomorrow', () => {
    const now = new Date('2026-06-18T10:00:00');
    const ms = msUntilNext('09:30', now);
    assert.ok(ms > 23 * 3.6e6 && ms < 24 * 3.6e6);
});

test('malformed HH:MM falls back to 09:30', () => {
    const now = new Date('2026-06-18T08:00:00');
    const ms = msUntilNext('garbage', now);
    assert.strictEqual(ms, 90 * 60_000);
});

// eslint-disable-next-line no-console
console.log(`\n${passed} passed`);
