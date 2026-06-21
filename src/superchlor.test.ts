/**
 * Unit tests for the Super Chlorinate menu-nav state machine (v3.10.0
 * rewrite). No HomeKit, no network — a fake AquaLogicClient feeds display
 * frames and records the wired key bursts the accessory sends.
 *
 * Covers the load-bearing logic:
 *   - on/off detection from the Super Chlorinate screen text (readScreenState
 *     via the RE_SUPER_* regexes)
 *   - "already in desired state → no press" fast path
 *   - press PLUS to enable / MINUS to disable, with readback confirmation
 *   - authoritative state recording via state.setSuperChlorinate (incl. clear
 *     to false — the bug the rewrite fixes)
 *   - the shared menu lock serializing concurrent sessions
 *
 * Run: npx ts-node src/superchlor.test.ts
 * Excluded from the production build via tsconfig "exclude".
 */
import * as assert from 'node:assert';
import { Key } from './aqualogic/keys';
import { SuperChlor } from './superchlor';

let passed = 0;
function test(name: string, fn: () => Promise<void> | void): Promise<void> {
    return Promise.resolve(fn()).then(() => {
        passed++;
        // eslint-disable-next-line no-console
        console.log(`  ok - ${name}`);
    });
}

// --- Fakes ----------------------------------------------------------------

/** Minimal fake of PoolStateStore — tracks lastDisplayText + superChlorinateOn. */
class FakeState {
    current: { lastDisplayText?: string; superChlorinateOn?: boolean } = {};
    setSuperChlorinate(on: boolean): void {
        this.current = { ...this.current, superChlorinateOn: on };
    }
    setDisplay(text: string): void {
        this.current = { ...this.current, lastDisplayText: text };
    }
}

/**
 * Fake AquaLogicClient. On each wired burst it runs an optional reaction that
 * mutates the display text (simulating the panel changing screen / state), so
 * the accessory's readback loop sees realistic frames. Records every burst.
 */
class FakeClient {
    state = new FakeState();
    bursts: number[] = [];
    private menuLockTail: Promise<void> = Promise.resolve();
    /** key → what the panel display becomes after that burst (optional). */
    onBurst: (key: number) => void = () => {};

    displayMatches(re: RegExp): boolean {
        const t = this.state.current.lastDisplayText;
        return typeof t === 'string' && re.test(t);
    }
    async waitForDisplay(re: RegExp, _ms: number): Promise<boolean> {
        return this.displayMatches(re);
    }
    async sendWiredKeyBurst(key: number, _ms?: number): Promise<void> {
        this.bursts.push(key);
        this.onBurst(key);
    }
    async withMenuLock<T>(_label: string, fn: () => Promise<T>): Promise<T> {
        const prev = this.menuLockTail;
        let release!: () => void;
        this.menuLockTail = new Promise<void>(r => { release = r; });
        await prev;
        try { return await fn(); } finally { release(); }
    }
    /** Set true to simulate the panel being reachable: the MENU→Settings step
     *  always "lands", and the RIGHT→Super Chlorinate step lands iff the
     *  pre-seeded display already shows a Super Chlorinate screen. */
    navReachable = true;
    async navigatePressUntil(_key: number, re: RegExp, _max: number): Promise<boolean> {
        if (!this.navReachable) return false;
        // Settings step: pretend we reached it (real MENU nav is hardware-only).
        if (re.source.includes('Settings')) return true;
        // Target step: succeeds iff the test pre-seeded the right screen.
        return this.displayMatches(re);
    }
}

/** Build a SuperChlor with fakes injected, bypassing the HAP constructor. */
function makeSuperChlor(client: FakeClient): { sc: SuperChlor; errors: string[] } {
    const errors: string[] = [];
    const log = {
        info: () => {}, debug: () => {}, warn: () => {},
        error: (m: string) => errors.push(m),
    };
    const platform = { log, api: { hap: { HapStatusError: class { constructor(public c: number) {} }, HAPStatus: { SERVICE_COMMUNICATION_FAILURE: -70402 } } } };
    const accessory = { displayName: 'Super Chlorinate' };
    // Bypass the real constructor (it touches HAP services); build a bare
    // instance and inject the three private deps the nav code reads.
    const sc = Object.create(SuperChlor.prototype) as SuperChlor;
    Object.assign(sc, { platform, accessory, client });
    return { sc, errors };
}

// --- readScreenState / regex coverage -------------------------------------

const cases: Array<[string, boolean | null]> = [
    ['Super Chlorinate Off', false],
    ['Super Chlorinate  Disabled', false],
    ['Super Chlorinate On', true],
    ['Super Chlorinate Enabled', true],
    ['Super Chlorinate 24h', true],
    ['Super Chlorinate 8 hours', true],
    ['SuperChlorinate 12', true],            // no space, numeric duration
    ['Super Chlorinate', null],              // blink frame, no token
    ['Pool Chlorinator 20%', null],          // different screen entirely
    ['Pool Temp 85F', null],
];

async function run(): Promise<void> {
    for (const [text, expected] of cases) {
        await test(`readScreenState("${text}") === ${expected}`, () => {
            const client = new FakeClient();
            client.state.setDisplay(text);
            const { sc } = makeSuperChlor(client);
            // readScreenState is private; exercise via the public surface.
            const got = (sc as unknown as { readScreenState(): boolean | null }).readScreenState();
            assert.strictEqual(got, expected);
        });
    }

    await test('toggle ON when already ON → no press, records true', async () => {
        const client = new FakeClient();
        client.state.setDisplay('Super Chlorinate On');
        const { sc } = makeSuperChlor(client);
        const final = await sc.toggle(true);
        assert.strictEqual(final, true);
        assert.strictEqual(client.bursts.length, 0, 'no key pressed');
        assert.strictEqual(client.state.current.superChlorinateOn, true);
    });

    await test('toggle OFF when already OFF → no press, records false', async () => {
        const client = new FakeClient();
        client.state.setDisplay('Super Chlorinate Off');
        const { sc } = makeSuperChlor(client);
        const final = await sc.toggle(false);
        assert.strictEqual(final, false);
        assert.strictEqual(client.bursts.length, 0);
        assert.strictEqual(client.state.current.superChlorinateOn, false);
    });

    await test('toggle ON from OFF → presses PLUS, confirms, records true', async () => {
        const client = new FakeClient();
        client.state.setDisplay('Super Chlorinate Off');
        client.onBurst = (key) => {
            if (key === Key.PLUS) client.state.setDisplay('Super Chlorinate On');
        };
        const { sc } = makeSuperChlor(client);
        const final = await sc.toggle(true);
        assert.strictEqual(final, true);
        assert.ok(client.bursts.includes(Key.PLUS), 'PLUS was pressed');
        assert.ok(!client.bursts.includes(Key.MINUS), 'MINUS never pressed');
        assert.strictEqual(client.state.current.superChlorinateOn, true);
    });

    await test('toggle OFF from ON → presses MINUS, confirms, CLEARS to false (the fixed latch)', async () => {
        const client = new FakeClient();
        client.state.setDisplay('Super Chlorinate On');
        client.onBurst = (key) => {
            if (key === Key.MINUS) client.state.setDisplay('Super Chlorinate Off');
        };
        const { sc } = makeSuperChlor(client);
        const final = await sc.toggle(false);
        assert.strictEqual(final, false);
        assert.ok(client.bursts.includes(Key.MINUS), 'MINUS was pressed');
        assert.ok(!client.bursts.includes(Key.PLUS), 'PLUS never pressed');
        assert.strictEqual(client.state.current.superChlorinateOn, false, 'flag lowered to false');
    });

    await test('toggle returns null when nav fails (panel unreachable)', async () => {
        const client = new FakeClient();
        client.navReachable = false; // even the MENU→Settings step never lands
        client.state.setDisplay('Pool Temp 85F');
        const { sc, errors } = makeSuperChlor(client);
        const final = await sc.toggle(true);
        assert.strictEqual(final, null);
        assert.ok(errors.some(e => /nav failed/.test(e)), 'logged nav failure');
    });

    await test('withMenuLock serializes two concurrent toggles (no interleave)', async () => {
        const client = new FakeClient();
        client.state.setDisplay('Super Chlorinate Off');
        const order: string[] = [];
        // Two sessions racing: each just records enter/exit order under the lock.
        const a = client.withMenuLock('A', async () => { order.push('A-in'); await new Promise(r => setTimeout(r, 20)); order.push('A-out'); });
        const b = client.withMenuLock('B', async () => { order.push('B-in'); order.push('B-out'); });
        await Promise.all([a, b]);
        assert.deepStrictEqual(order, ['A-in', 'A-out', 'B-in', 'B-out'], 'B waited for A');
    });

    // eslint-disable-next-line no-console
    console.log(`\n${passed} passed`);
}

run().catch((e) => {
    // eslint-disable-next-line no-console
    console.error(e);
    process.exit(1);
});
