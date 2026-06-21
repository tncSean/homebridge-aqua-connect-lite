/**
 * Unit tests for the chlorinator drive step-loop, focused on the v3.10.1
 * IN-FLIGHT RE-TARGET fix: a newer HomeKit target arriving mid-drive must be
 * adopted by the running loop so the cell ends at the LATEST value, not a
 * stale premature one.
 *
 * No HomeKit, no network. A fake AquaLogicClient simulates the panel: each
 * PLUS/MINUS wired burst nudges chlorinatorPercent one step toward/away, and
 * keeps lastDisplayText on the editable "Pool Chlorinator NN%" item so the
 * loop's safety gate and readback pass.
 *
 * Run: npx ts-node src/chlorinator.test.ts
 * Excluded from the production build via tsconfig "exclude".
 */
import * as assert from 'node:assert';
import { Key } from './aqualogic/keys';
import { Chlorinator } from './chlorinator';

let passed = 0;
function test(name: string, fn: () => Promise<void> | void): Promise<void> {
    return Promise.resolve(fn()).then(() => {
        passed++;
        // eslint-disable-next-line no-console
        console.log(`  ok - ${name}`);
    });
}

/** Fake state store exposing the fields driveTo reads. */
class FakeState {
    current: { chlorinatorPercent?: number; lastDisplayText?: string } = {};
    private setDisplay(pct: number): void {
        this.current = {
            ...this.current,
            chlorinatorPercent: pct,
            lastDisplayText: `Pool Chlorinator ${pct}%`,
        };
    }
    init(pct: number): void { this.setDisplay(pct); }
    step(delta: number): void {
        const cur = this.current.chlorinatorPercent ?? 0;
        this.setDisplay(Math.max(0, Math.min(100, cur + delta)));
    }
}

/**
 * Fake client. PLUS burst → +1%, MINUS → -1% (instant readback). Optional
 * onBurst hook lets a test inject a mid-drive re-target. navigatePressUntil
 * always "lands" (real MENU/RIGHT nav is hardware-only). Records bursts.
 */
class FakeClient {
    state = new FakeState();
    bursts: number[] = [];
    onBurst: (key: number, burstNo: number) => void = () => {};
    private burstNo = 0;

    async withMenuLock<T>(_label: string, fn: () => Promise<T>): Promise<T> {
        return fn();
    }
    async navigatePressUntil(): Promise<boolean> { return true; }
    async waitForDisplay(): Promise<boolean> { return true; }
    async sendWiredKeyBurst(key: number, _ms?: number): Promise<void> {
        this.bursts.push(key);
        if (key === Key.PLUS) this.state.step(+1);
        else if (key === Key.MINUS) this.state.step(-1);
        this.onBurst(key, ++this.burstNo);
    }
}

/** Build a Chlorinator with fakes injected, bypassing the HAP constructor. */
function makeChlor(client: FakeClient): { chlor: Chlorinator; setPending: (n: number | null) => void } {
    const log = { info: () => {}, debug: () => {}, warn: () => {}, error: () => {} };
    const platform = { log };
    const accessory = { displayName: 'Chlorinator' };
    const chlor = Object.create(Chlorinator.prototype) as Chlorinator;
    Object.assign(chlor, { platform, accessory, client, pendingTarget: null, writing: false });
    // Stub the private MENU/RIGHT nav (hardware-only) so the test isolates the
    // step loop. The fake's display is already pinned on the editable
    // "Pool Chlorinator NN%" item, so navigation is a no-op here.
    (chlor as unknown as { navigateToChlorinator(): Promise<boolean> }).navigateToChlorinator =
        () => Promise.resolve(true);
    const setPending = (n: number | null) => { (chlor as unknown as { pendingTarget: number | null }).pendingTarget = n; };
    return { chlor, setPending };
}

async function run(): Promise<void> {
    await test('driveTo steps up to a static target', async () => {
        const client = new FakeClient();
        client.state.init(10);
        const { chlor, setPending } = makeChlor(client);
        setPending(15);
        const final = await chlor.driveTo(15);
        assert.strictEqual(final, 15);
        assert.strictEqual(client.state.current.chlorinatorPercent, 15);
    });

    await test('driveTo steps down to a static target', async () => {
        const client = new FakeClient();
        client.state.init(20);
        const { chlor, setPending } = makeChlor(client);
        setPending(12);
        const final = await chlor.driveTo(12);
        assert.strictEqual(final, 12);
    });

    await test('THE BUG: target moved 1 → 50 mid-drive is adopted, ends at 50', async () => {
        const client = new FakeClient();
        client.state.init(10);
        const { chlor, setPending } = makeChlor(client);
        // Start aiming at the premature HomeKit default of 1 (10 → 1 = down).
        setPending(1);
        // After 2 bursts (simulating the owner's real drag arriving mid-drive),
        // re-target to 50. The running loop must reverse and climb to 50.
        client.onBurst = (_key, n) => {
            if (n === 2) setPending(50);
        };
        const final = await chlor.driveTo(1);
        assert.strictEqual(final, 50, 'adopted the new target');
        assert.strictEqual(client.state.current.chlorinatorPercent, 50);
    });

    await test('re-target to a FARTHER value does not trip the stuck/step cap', async () => {
        const client = new FakeClient();
        client.state.init(9);
        const { chlor, setPending } = makeChlor(client);
        setPending(9); // no-op start (already there) → loop would exit immediately
        // Bump target up right away so a full 9 → 50 climb (41 steps) must run.
        client.onBurst = (_key, n) => { if (n === 1) setPending(50); };
        // Seed one upward intent so the loop enters (start 9, target 10 then 50).
        setPending(10);
        const final = await chlor.driveTo(10);
        assert.strictEqual(final, 50);
    });

    await test('driveTo with target === current does nothing (no bursts)', async () => {
        const client = new FakeClient();
        client.state.init(20);
        const { chlor, setPending } = makeChlor(client);
        setPending(20);
        const final = await chlor.driveTo(20);
        assert.strictEqual(final, 20);
        assert.strictEqual(client.bursts.length, 0);
    });

    // eslint-disable-next-line no-console
    console.log(`\n${passed} passed`);
}

run().catch((e) => {
    // eslint-disable-next-line no-console
    console.error(e);
    process.exit(1);
});
