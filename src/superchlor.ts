import { Service, PlatformAccessory, CharacteristicValue } from 'homebridge';
import { AquaConnectLitePlatform } from './platform';
import { AquaLogicClient } from './aqualogic/client';
import { Key, KeyValue } from './aqualogic/keys';
import { PoolState } from './aqualogic/state';

const sleep = (ms: number): Promise<void> => new Promise(r => setTimeout(r, ms));

/**
 * Super Chlorinate toggle (HomeKit Switch).
 *
 * CONTROL MODEL (rewritten 2026-06, v3.10.0 — mirrors chlorinator.ts):
 * Super Chlorinate has NO dedicated keypad button on the Pro Logic. The
 * owner activates it from the panel via:
 *   MENU → "Settings Menu" → RIGHT (repeatedly) → "Super Chlorinate" screen
 *   → PLUS ("up") to turn ON   (panel programs a duration, auto-terminates)
 *   → MINUS ("down") to turn OFF
 *
 * The previous implementation sent `client.sendKey(AUX_3)` — a WIRELESS key
 * frame, which the wired W610 bus IGNORES 100%, so it never worked. This
 * rewrite drives the WIRED keypad bus via blanket bursts
 * (client.sendWiredKeyBurst, through the shared client.navigatePressUntil),
 * the proven-reliable transport that sprays each press across the panel's
 * ~50ms accept window so a press lands despite WiFi jitter.
 *
 * "Super Chlorinate" sits ONE Settings item BEFORE "Pool Chlorinator"
 * (item order: Heater1 → VSP → Super Chlorinate → Pool Chlorinator → …),
 * so the same MENU→Settings→RIGHT pattern reaches it, just a different match.
 *
 * STATE: read authoritatively from the Super Chlorinate settings screen text
 * during navigation (on/off detected from the line), then recorded via
 * state.setSuperChlorinate() — which is the ONLY path that can lower the flag
 * (the passive display parser is a write-only latch that never clears).
 *
 * SAFETY: only MENU / RIGHT / PLUS / MINUS are ever pressed, and PLUS/MINUS
 * only while the latest display text contains "Super Chlorinate" — we never
 * step into an adjacent (possibly editable) item.
 */
export class SuperChlor {
    private service: Service;
    private writing = false;

    // --- nav/step tuning (mirrors chlorinator.ts, verified live 2026-06) -----
    /** Burst duration per keypress — 200ms reliably registers exactly one edge. */
    private static readonly BURST_MS = 200;
    /** Max MENU bursts to reach "Settings Menu" (~30% landing rate). */
    private static readonly NAV_MENU_TRIES = 40;
    /** Max RIGHT bursts to walk Settings items to "Super Chlorinate". */
    private static readonly NAV_RIGHT_TRIES = 40;
    /** Max PLUS/MINUS bursts to flip the on/off state (with retries). */
    private static readonly TOGGLE_TRIES = 20;
    /** Settle/readback window after a press. */
    private static readonly SETTLE_MS = 1500;
    /** Poll cadence while waiting for a display change. */
    private static readonly POLL_MS = 50;

    private static readonly RE_SETTINGS = /\bSettings\s+Menu\b/i;
    /** The Super Chlorinate settings line (any state). Used as the nav target
     *  and the SAFETY gate before any PLUS/MINUS. Won't match "Pool
     *  Chlorinator" (no "Super" word). */
    private static readonly RE_SUPER_ANY = /Super\s*Chlorinate/i;
    /** OFF form — "Super Chlorinate Off" / "… Disabled". The trailing word
     *  after the label, if present, tells us the state. */
    private static readonly RE_SUPER_OFF = /Super\s*Chlorinate\b[^\n]*\b(Off|Disabled)\b/i;
    /** ON form — "Super Chlorinate On" / "… Enabled" / "… NN h" (a programmed
     *  duration). A number or On/Enabled keyword after the label means it is
     *  running. */
    private static readonly RE_SUPER_ON = /Super\s*Chlorinate\b[^\n]*(?:\b(On|Enabled)\b|\b(\d+)\s*(?:h|hr|hrs|hours)?\b)/i;

    constructor(
        private readonly platform: AquaConnectLitePlatform,
        private readonly accessory: PlatformAccessory,
        private readonly client: AquaLogicClient,
    ) {
        this.service = this.accessory.getService(this.platform.Service.Switch)
            || this.accessory.addService(this.platform.Service.Switch);

        this.service.setCharacteristic(this.platform.Characteristic.Name, this.accessory.displayName);

        this.service.getCharacteristic(this.platform.Characteristic.On)
            .onGet(() => this.client.state.current.superChlorinateOn === true)
            .onSet(this.setOn.bind(this));

        this.client.state.on('change', (key: keyof PoolState) => {
            if (key === 'superChlorinateOn') {
                this.service.updateCharacteristic(
                    this.platform.Characteristic.On,
                    this.client.state.current.superChlorinateOn === true,
                );
            }
        });
    }

    private log(msg: string): void {
        this.platform.log.info(`${this.accessory.displayName} ${msg}`);
    }
    private dbg(msg: string): void {
        this.platform.log.debug(`${this.accessory.displayName} ${msg}`);
    }

    private displayMatches(re: RegExp): boolean {
        return this.client.displayMatches(re);
    }

    /**
     * Read the Super Chlorinate on/off state from the CURRENT display text,
     * if the panel is on that screen. Returns:
     *   true  — screen shows it ON (On/Enabled keyword or a numeric duration)
     *   false — screen shows it OFF (Off/Disabled)
     *   null  — not on the Super Chlorinate screen, or state ambiguous
     */
    private readScreenState(): boolean | null {
        const t = this.client.state.current.lastDisplayText;
        if (typeof t !== 'string' || !SuperChlor.RE_SUPER_ANY.test(t)) return null;
        if (SuperChlor.RE_SUPER_OFF.test(t)) return false;
        if (SuperChlor.RE_SUPER_ON.test(t)) return true;
        return null; // on the screen but no decisive on/off token (blink frame)
    }

    private async setOn(value: CharacteristicValue): Promise<void> {
        const desired = value === true;
        if (this.writing) {
            this.dbg(`setOn(${desired}) ignored — a menu session is already running`);
            return;
        }
        this.writing = true;
        try {
            const final = await this.client.withMenuLock('super-chlorinate', () => this.toggle(desired));
            if (final !== desired) {
                this.platform.log.error(
                    `${this.accessory.displayName} could not confirm ${desired ? 'ON' : 'OFF'} ` +
                    `(panel readback=${final === null ? 'unknown' : final})`,
                );
                throw new this.platform.api.hap.HapStatusError(
                    this.platform.api.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE,
                );
            }
        } finally {
            this.writing = false;
        }
    }

    /**
     * Navigate MENU → Settings → RIGHT → "Super Chlorinate", read the screen,
     * and press PLUS (to enable) or MINUS (to disable) if it is not already in
     * the desired state. Reads back to confirm. Records the confirmed state via
     * state.setSuperChlorinate(). Public so a test harness can call it directly.
     *
     * @returns the final confirmed state (true/false), or null if nav/readback
     *          failed (caller surfaces a HAP error).
     */
    async toggle(desired: boolean): Promise<boolean | null> {
        this.log(`drive → ${desired ? 'ON' : 'OFF'}`);

        if (!(await this.navigateToSuperChlorinate())) {
            this.platform.log.error(`${this.accessory.displayName} nav failed — aborting (menu auto-exits)`);
            return null;
        }

        // Read the current on/off state off the screen. Give the blink a moment
        // to settle to a decisive frame if the first read is ambiguous.
        let cur = this.readScreenState();
        if (cur === null) {
            await this.waitForDecisiveState(SuperChlor.SETTLE_MS);
            cur = this.readScreenState();
        }
        if (cur === null) {
            this.platform.log.error(`${this.accessory.displayName} on Super Chlorinate screen but couldn't read on/off — aborting`);
            return null;
        }
        this.log(`screen reads ${cur ? 'ON' : 'OFF'}, want ${desired ? 'ON' : 'OFF'}`);

        if (cur === desired) {
            this.client.state.setSuperChlorinate(cur);
            this.log(`✅ already ${desired ? 'ON' : 'OFF'} — no press needed`);
            return cur;
        }

        // Press PLUS to enable, MINUS to disable; retry against the ~30% hit
        // rate, reading back each time. SAFETY: only press while still on the
        // Super Chlorinate screen.
        const key = desired ? Key.PLUS : Key.MINUS;
        const name = desired ? 'PLUS' : 'MINUS';
        for (let i = 1; i <= SuperChlor.TOGGLE_TRIES; i++) {
            if (!this.displayMatches(SuperChlor.RE_SUPER_ANY)) {
                this.dbg('display left Super Chlorinate screen — waiting for it to return before press');
                const back = await this.client.waitForDisplay(SuperChlor.RE_SUPER_ANY, SuperChlor.SETTLE_MS);
                if (!back) {
                    this.platform.log.error(
                        `${this.accessory.displayName} left Super Chlorinate screen (now ` +
                        `"${this.client.state.current.lastDisplayText?.trim()}") — aborting; menu auto-exits`,
                    );
                    return cur;
                }
            }

            await this.burst(key, name);
            await this.waitForStateChange(cur, SuperChlor.SETTLE_MS);
            const after = this.readScreenState();
            if (after !== null && after === desired) {
                this.client.state.setSuperChlorinate(after);
                this.log(`✅ ${name} #${i} → ${desired ? 'ON' : 'OFF'}`);
                return after;
            }
            if (after !== null) cur = after;
            this.dbg(`${name} #${i}: still ${cur ? 'ON' : 'OFF'} — retrying`);
        }

        this.platform.log.warn(`${this.accessory.displayName} could not reach ${desired ? 'ON' : 'OFF'} after ${SuperChlor.TOGGLE_TRIES} presses`);
        return cur;
    }

    /**
     * MENU-burst to "Settings Menu", then RIGHT-burst to the "Super Chlorinate"
     * settings item. Uses the shared client nav primitive.
     */
    private async navigateToSuperChlorinate(): Promise<boolean> {
        const onSettings = await this.client.navigatePressUntil(
            Key.MENU, SuperChlor.RE_SETTINGS, SuperChlor.NAV_MENU_TRIES, SuperChlor.BURST_MS, SuperChlor.SETTLE_MS,
        );
        if (!onSettings) {
            this.platform.log.error(`${this.accessory.displayName} couldn't reach Settings Menu`);
            return false;
        }
        this.log('on Settings Menu');
        // Let any in-flight MENU bursts drain before switching to RIGHT.
        await sleep(SuperChlor.SETTLE_MS);

        const onSuper = await this.client.navigatePressUntil(
            Key.RIGHT, SuperChlor.RE_SUPER_ANY, SuperChlor.NAV_RIGHT_TRIES, SuperChlor.BURST_MS, SuperChlor.SETTLE_MS,
        );
        if (!onSuper) {
            this.platform.log.error(`${this.accessory.displayName} couldn't reach Super Chlorinate item`);
            return false;
        }
        this.log('on Super Chlorinate item');
        return true;
    }

    private async burst(key: KeyValue, name: string): Promise<void> {
        try {
            await this.client.sendWiredKeyBurst(key, SuperChlor.BURST_MS);
        } catch (e) {
            this.dbg(`${name} burst send failed: ${(e as Error).message}`);
        }
    }

    /** Wait up to `ms` for the screen to show a decisive on/off token. */
    private async waitForDecisiveState(ms: number): Promise<void> {
        const deadline = Date.now() + ms;
        while (Date.now() < deadline) {
            if (this.readScreenState() !== null) return;
            await sleep(SuperChlor.POLL_MS);
        }
    }

    /** Wait up to `ms` for the read on/off state to differ from `before`. */
    private async waitForStateChange(before: boolean, ms: number): Promise<void> {
        const deadline = Date.now() + ms;
        while (Date.now() < deadline) {
            const s = this.readScreenState();
            if (s !== null && s !== before) return;
            await sleep(SuperChlor.POLL_MS);
        }
    }
}
