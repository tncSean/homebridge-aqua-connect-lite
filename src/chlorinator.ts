import { Service, PlatformAccessory, CharacteristicValue } from 'homebridge';
import { AquaConnectLitePlatform } from './platform';
import { AquaLogicClient } from './aqualogic/client';
import { PoolState } from './aqualogic/state';
import { Key, KeyValue } from './aqualogic/keys';

const sleep = (ms: number): Promise<void> => new Promise(r => setTimeout(r, ms));

/**
 * Chlorinator output control, surfaced as HomeKit Lightbulb for a clean
 * 0-100 dimmer slider (Fan's RotationSpeed would also work but Lightbulb
 * feels more natural — users already understand Brightness).
 *
 * CONTROL MODEL (rewritten 2026-06): the Pro Logic has no dedicated
 * chlorinator button. The percent setting lives inside the (unlocked)
 * "Settings Menu". We drive the panel's WIRED keypad bus via the W610 using
 * BLANKET BURSTS (client.sendWiredKeyBurst) — the proven-reliable transport
 * that sprays each press across the panel's ~50ms accept window so a press
 * lands despite WiFi jitter. The previous implementation sent WIRELESS key
 * frames (client.bump → sendKey), which the wired bus ignores 100%.
 *
 * Nav sequence (mirrors thermostat.ts):
 *   MENU-burst × until display shows "Settings Menu"
 *   RIGHT-burst × until display shows "Pool Chlorinator NN%"
 *   PLUS/MINUS-burst × one step at a time, reading back each time, to target
 *   (panel auto-exits ~30s later and saves — no explicit exit needed)
 *
 * Each press is verified by reading state.current.chlorinatorPercent after a
 * settle delay. A press that doesn't advance the value is retried; an
 * overshoot is reversed. SAFETY: PLUS/MINUS are only ever sent while the
 * latest display text contains "Pool Chlorinator" — we never press into the
 * locked Configuration menu.
 */
export class Chlorinator {
    private service: Service;
    private pendingTarget: number | null = null;
    private debounceTimer: NodeJS.Timeout | null = null;
    private writing = false;
    /** Resolvers of debounced callers superseded by a newer setBrightness — we
     *  resolve (never reject) them when their timer is cleared so every HAP
     *  request settles exactly once (otherwise HomeKit shows "No Response"). */
    private pendingResolvers: Array<() => void> = [];

    private static readonly DEBOUNCE_MS = 300;

    // --- nav/step tuning (verified live 2026-06 against the W610 bus) -------
    /** Burst duration per keypress. EMPIRICAL: 200ms reliably registers exactly
     *  ONE keypress edge (one increment). 300ms tripped the panel's auto-repeat
     *  and multi-stepped (RIGHT shot past the Chlorinator item into the clock
     *  editor), so 200ms is the ceiling. Per-press hit rate at 200ms is ~25-35%
     *  during the noisy in-menu blink, so the step loop RETRIES generously. */
    private static readonly BURST_MS = 200;
    /** Max MENU bursts to reach "Settings Menu". The panel cycles 5 top-level
     *  menus and we may start deep inside Settings (needs to exit first); with
     *  ~30% landing rate, 40 covers worst case. */
    private static readonly NAV_MENU_TRIES = 40;
    /** Max RIGHT bursts to walk Settings items to the Chlorinator item.
     *  Order (verified): Heater1 → VSP → Super Chlorinate → Pool Chlorinator →
     *  Set Day/Time → Display Light → (wrap). RIGHT past Chlorinator lands on
     *  the EDITABLE clock — so we stop the instant Chlorinator is confirmed. */
    private static readonly NAV_RIGHT_TRIES = 40;
    /** Max PLUS/MINUS bursts total (full 0-100 sweep is 100 edges; with retries
     *  for the ~30% hit rate a 15-step move can need ~50 bursts). */
    private static readonly STEP_TRIES = 120;
    /** Consecutive dead presses (no change) before abort. At ~30% hit rate, 3-4
     *  misses in a row is normal; 20 means the panel genuinely isn't responding
     *  (lost the menu / auto-exited) — abort cleanly. */
    private static readonly STEP_STUCK_CAP = 20;
    /** Settle/readback window after a press. The in-menu % line blinks between
     *  "Pool Chlorinator  NN%" and "Pool Chlorinator" (blank) every ~500ms; a
     *  successful press shows the new number within ~1.3s. */
    private static readonly SETTLE_MS = 1500;
    /** Poll cadence while waiting for a display change. */
    private static readonly POLL_MS = 50;

    private static readonly RE_SETTINGS = /\bSettings\s+Menu\b/i;
    /** Numeric form "Pool Chlorinator NN%" — proves we're on the EDITABLE item
     *  and gives the readback. Won't match "Super Chlorinate" (no "Chlorinator"
     *  word) or "Chlorinator Off" status (no "Pool" prefix on this firmware's
     *  item). */
    private static readonly RE_CHLOR_PCT = /Pool\s+Chlorinator\s+\d+\s*%/i;
    /** Blink-tolerant presence test — matches both "Pool Chlorinator NN%" and
     *  the blank-digit blink frame "Pool Chlorinator". Used as the SAFETY gate
     *  before any PLUS/MINUS so we never step while the panel has cycled away. */
    private static readonly RE_CHLOR_ANY = /Pool\s+Chlorinator\b/i;

    constructor(
        private readonly platform: AquaConnectLitePlatform,
        private readonly accessory: PlatformAccessory,
        private readonly client: AquaLogicClient,
    ) {
        this.service = this.accessory.getService(this.platform.Service.Lightbulb)
            || this.accessory.addService(this.platform.Service.Lightbulb);

        this.service.setCharacteristic(this.platform.Characteristic.Name, this.accessory.displayName);

        this.service.getCharacteristic(this.platform.Characteristic.On)
            .onGet(() => this.client.state.current.chlorinatorOn === true)
            .onSet(this.setOn.bind(this));

        this.service.getCharacteristic(this.platform.Characteristic.Brightness)
            .onGet(() => this.client.state.current.chlorinatorPercent ?? 0)
            .onSet(this.setBrightness.bind(this));

        this.client.state.on('change', (key: keyof PoolState) => {
            if (key === 'chlorinatorPercent') {
                this.service.updateCharacteristic(
                    this.platform.Characteristic.Brightness,
                    this.client.state.current.chlorinatorPercent ?? 0,
                );
            }
            if (key === 'chlorinatorOn') {
                this.service.updateCharacteristic(
                    this.platform.Characteristic.On,
                    this.client.state.current.chlorinatorOn === true,
                );
            }
        });
    }

    private async setOn(value: CharacteristicValue): Promise<void> {
        // DIAGNOSTIC: capture exactly what the Home app sends.
        this.platform.log.info(`Chlorinator HomeKit ON set → ${JSON.stringify(value)}`);
        // Turning "off" means drive percent to 0 via the same keypress path.
        // Turning "on" with a previous percent just re-asserts HomeKit state —
        // HomeKit will also call setBrightness for a real value.
        if (value === false) {
            await this.queueBrightness(0);
        }
    }

    private async setBrightness(value: CharacteristicValue): Promise<void> {
        // DIAGNOSTIC: capture the raw Brightness value the Home app sends, before
        // clamp/round, so we can tell a plugin bug from a Home-app interaction.
        this.platform.log.info(`Chlorinator HomeKit BRIGHTNESS set → ${JSON.stringify(value)}`);
        const target = clamp(Math.round(value as number), 0, 100);
        await this.queueBrightness(target);
    }

    private queueBrightness(target: number): Promise<void> {
        this.pendingTarget = target;
        if (this.debounceTimer) {
            // A newer value supersedes the pending debounce window. Resolve every
            // caller queued so far so HAP gets a response (HomeKit coalesces rapid
            // slider drags; the final flush applies the latest target). Without
            // this, each superseded caller's Promise hangs → "No Response".
            clearTimeout(this.debounceTimer);
            this.debounceTimer = null;
            this.resolvePending();
        }
        return new Promise<void>((resolve) => {
            this.pendingResolvers.push(resolve);
            this.debounceTimer = setTimeout(() => {
                this.debounceTimer = null;
                // Hand the queued resolvers to the flush so they all settle when
                // the write completes (or immediately on failure).
                const resolvers = this.pendingResolvers;
                this.pendingResolvers = [];
                this.flushPending().then(
                    () => resolvers.forEach(r => r()),
                    () => resolvers.forEach(r => r()),
                );
            }, Chlorinator.DEBOUNCE_MS);
        });
    }

    /** Settle every queued debounced caller's Promise (resolve, never reject). */
    private resolvePending(): void {
        const resolvers = this.pendingResolvers;
        this.pendingResolvers = [];
        resolvers.forEach(r => r());
    }

    private async flushPending(): Promise<void> {
        if (this.pendingTarget === null || this.writing) return;
        const target = this.pendingTarget;
        this.pendingTarget = null;
        this.writing = true;
        try {
            // Acquire the shared Settings-menu lock so we never interleave
            // MENU/RIGHT bursts with the Super Chlorinate accessory (they walk
            // the SAME physical menu — concurrent nav would corrupt a setting).
            await this.client.withMenuLock('chlorinator', () => this.driveTo(target));
        } catch (e) {
            this.platform.log.error(`${this.accessory.displayName} adjust failed: ${(e as Error).message}`);
        } finally {
            this.writing = false;
        }
    }

    // --- core wired menu-nav + readback routine -----------------------------

    private log(msg: string): void {
        this.platform.log.info(`${this.accessory.displayName} ${msg}`);
    }
    private dbg(msg: string): void {
        this.platform.log.debug(`${this.accessory.displayName} ${msg}`);
    }

    private displayMatches(re: RegExp): boolean {
        const t = this.client.state.current.lastDisplayText;
        return typeof t === 'string' && re.test(t);
    }

    /**
     * Drive the chlorinator output percent to `target` via wired bursts.
     * Public so a test harness can call it directly. Returns the final
     * observed percent (or null if navigation failed before any step).
     */
    async driveTo(target: number): Promise<number | null> {
        const tgt = clamp(Math.round(target), 0, 100);
        const start = this.client.state.current.chlorinatorPercent;
        this.log(`drive → ${tgt}% (start=${start ?? 'unknown'}%)`);

        if (!(await this.navigateToChlorinator())) {
            this.platform.log.error(`${this.accessory.displayName} nav failed — aborting (menu will auto-exit)`);
            return null;
        }

        let read = this.readPercent();
        if (read === null) {
            // We're on the Chlorinator line but the parser hasn't captured a
            // number yet — wait one settle for the next refresh.
            await this.waitForPercent(Chlorinator.SETTLE_MS);
            read = this.readPercent();
        }
        if (read === null) {
            this.platform.log.error(`${this.accessory.displayName} on Chlorinator line but no % read — aborting`);
            return null;
        }
        let cur: number = read;
        this.log(`at ${cur}%, stepping toward ${tgt}%`);

        let presses = 0;
        let stuck = 0;
        while (cur !== tgt && presses < Chlorinator.STEP_TRIES) {
            // SAFETY: only ever press PLUS/MINUS while the panel is on the
            // Chlorinator item. The item blinks "Pool Chlorinator NN%" ↔
            // "Pool Chlorinator" (blank) every ~500ms, so accept either form
            // (RE_CHLOR_ANY). If the panel has cycled to a DIFFERENT item
            // (e.g. the editable "Set Day and Time" clock one step past us, or
            // an auto-exit to the time display), pressing would corrupt the
            // wrong setting — wait briefly for the blink to return, else abort.
            if (!this.onChlorItem()) {
                this.dbg('display off Chlorinator item — waiting for blink/re-confirm before press');
                const back = await this.waitForChlorItem(Chlorinator.SETTLE_MS);
                if (!back) {
                    this.platform.log.error(`${this.accessory.displayName} left Chlorinator item (now "${this.client.state.current.lastDisplayText?.trim()}") — aborting; menu auto-exits without saving a wrong value`);
                    return cur;
                }
            }

            const goingUp = tgt > cur;
            const key = goingUp ? Key.PLUS : Key.MINUS;
            const name = goingUp ? 'PLUS' : 'MINUS';
            const before: number = cur;

            await this.burst(key, name);
            presses++;
            await this.waitForPercentChange(before, Chlorinator.SETTLE_MS);
            const after = this.readPercent();

            if (after === null || after === before) {
                stuck++;
                this.dbg(`${name} #${presses}: unchanged at ${before}% (stuck=${stuck}/${Chlorinator.STEP_STUCK_CAP}) — retrying`);
            } else if ((goingUp && after < before) || (!goingUp && after > before)) {
                // Overshoot / wrong-direction — reverse on next iteration by
                // re-reading cur. Log it; the while-condition will correct.
                cur = after;
                stuck = 0;
                this.log(`${name} #${presses} → ${cur}% (overshot, will reverse)`);
            } else {
                cur = after;
                stuck = 0;
                this.log(`${name} #${presses} → ${cur}%`);
            }

            if (stuck >= Chlorinator.STEP_STUCK_CAP) {
                this.platform.log.error(`${this.accessory.displayName} stalled at ${cur}% after ${stuck} dead presses — aborting (menu auto-exits)`);
                return cur;
            }
        }

        if (cur === tgt) {
            this.log(`✅ reached ${tgt}% in ${presses} presses`);
        } else {
            this.platform.log.warn(`${this.accessory.displayName} stopped at ${cur}% (target ${tgt}) after ${presses} presses`);
        }
        return cur;
    }

    /**
     * MENU-burst to "Settings Menu", then RIGHT-burst to the EDITABLE
     * "Pool Chlorinator NN%" item.
     *
     * No "already on the line" fast path: the panel's normal auto-cycle ALSO
     * displays "Pool Chlorinator 5%" (read-only status), and pressing PLUS/MINUS
     * there does nothing — the increment only works on the Settings item. So we
     * always run the full MENU→Settings→RIGHT navigation, and confirm the
     * editable item by requiring a NUMERIC readback (RE_CHLOR_PCT) — the
     * Settings item is the only place where "Pool Chlorinator NN%" coexists with
     * us having just navigated there.
     */
    private async navigateToChlorinator(): Promise<boolean> {
        // Step 1: MENU-burst until "Settings Menu".
        const onSettings = await this.pressUntil(
            Key.MENU, 'MENU', Chlorinator.RE_SETTINGS, Chlorinator.NAV_MENU_TRIES,
        );
        if (!onSettings) {
            this.platform.log.error(`${this.accessory.displayName} couldn't reach Settings Menu`);
            return false;
        }
        this.log('on Settings Menu');
        // Let any in-flight MENU bursts drain before switching to RIGHT.
        await sleep(Chlorinator.SETTLE_MS);

        // Step 2: RIGHT-burst through Settings items until "Pool Chlorinator NN%".
        const onChlor = await this.pressUntil(
            Key.RIGHT, 'RIGHT', Chlorinator.RE_CHLOR_PCT, Chlorinator.NAV_RIGHT_TRIES,
        );
        if (!onChlor) {
            this.platform.log.error(`${this.accessory.displayName} couldn't reach Pool Chlorinator item`);
            return false;
        }
        this.log('on Pool Chlorinator item');
        return true;
    }

    /**
     * Burst `key` until display matches `re`, or `maxTries` exhausted.
     * Returns whether it matched.
     */
    private async pressUntil(key: KeyValue, name: string, re: RegExp, maxTries: number): Promise<boolean> {
        for (let i = 1; i <= maxTries; i++) {
            if (this.displayMatches(re)) {
                this.dbg(`${name}: matched before press ${i}`);
                return true;
            }
            await this.burst(key, name);
            const matched = await this.waitForDisplay(re, Chlorinator.SETTLE_MS);
            if (matched) {
                this.dbg(`${name}: matched on burst ${i}`);
                return true;
            }
        }
        return this.displayMatches(re);
    }

    private async burst(key: KeyValue, name: string): Promise<void> {
        try {
            await this.client.sendWiredKeyBurst(key, Chlorinator.BURST_MS);
        } catch (e) {
            this.dbg(`${name} burst send failed: ${(e as Error).message}`);
        }
    }

    private readPercent(): number | null {
        const p = this.client.state.current.chlorinatorPercent;
        return typeof p === 'number' ? p : null;
    }

    /**
     * True when the panel is currently on the editable Chlorinator item.
     * Blink-tolerant: the item alternates "Pool Chlorinator NN%" ↔
     * "Pool Chlorinator" (blank digits) every ~500ms, so we match either form
     * via RE_CHLOR_ANY. We do NOT additionally require a numeric readback here
     * because that would reject the legitimate blank-blink frame mid-step;
     * the nav phase already confirmed the numeric (editable) item, and the
     * adjacent items ("Super Chlorinate", "Set Day and Time") don't contain
     * the word "Chlorinator", so RE_CHLOR_ANY uniquely identifies our item.
     */
    private onChlorItem(): boolean {
        return this.displayMatches(Chlorinator.RE_CHLOR_ANY);
    }

    /** Wait up to `ms` for the Chlorinator item (blink-tolerant) to reappear. */
    private async waitForChlorItem(ms: number): Promise<boolean> {
        const deadline = Date.now() + ms;
        while (Date.now() < deadline) {
            if (this.onChlorItem()) return true;
            await sleep(Chlorinator.POLL_MS);
        }
        return this.onChlorItem();
    }

    /** Wait up to `ms` for the display to match `re`. */
    private async waitForDisplay(re: RegExp, ms: number): Promise<boolean> {
        const deadline = Date.now() + ms;
        while (Date.now() < deadline) {
            if (this.displayMatches(re)) return true;
            await sleep(Chlorinator.POLL_MS);
        }
        return this.displayMatches(re);
    }

    /** Wait up to `ms` for chlorinatorPercent to become a number. */
    private async waitForPercent(ms: number): Promise<void> {
        const deadline = Date.now() + ms;
        while (Date.now() < deadline) {
            if (this.readPercent() !== null) return;
            await sleep(Chlorinator.POLL_MS);
        }
    }

    /** Wait up to `ms` for chlorinatorPercent to differ from `before`. */
    private async waitForPercentChange(before: number, ms: number): Promise<void> {
        const deadline = Date.now() + ms;
        while (Date.now() < deadline) {
            const p = this.readPercent();
            if (p !== null && p !== before) return;
            await sleep(Chlorinator.POLL_MS);
        }
    }
}

function clamp(n: number, lo: number, hi: number): number {
    return n < lo ? lo : n > hi ? hi : n;
}
