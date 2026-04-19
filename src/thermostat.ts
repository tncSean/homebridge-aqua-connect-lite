import { Service, PlatformAccessory, CharacteristicValue } from 'homebridge';
import { AquaConnectLitePlatform } from './platform';
import { AquaLogicClient } from './aqualogic/client';
import { PoolState } from './aqualogic/state';
import { Key, KeyValue } from './aqualogic/keys';

const F_TO_C = (f: number): number => ((f - 32) * 5) / 9;
const C_TO_F = (c: number): number => (c * 9) / 5 + 32;
const round1 = (n: number): number => Math.round(n * 10) / 10;

const sleep = (ms: number): Promise<void> => new Promise(r => setTimeout(r, ms));

/**
 * Pool Heater surfaced as HomeKit Thermostat.
 *
 * Control model: Pro Logic has no dedicated heater button — heater is menu-
 * driven. We drive the panel's *wired* keypad bus via W610 RS-485 TX
 * (AquaLogicClient.sendWiredKey), which was empirically proven 2026-04-18
 * to reach the panel (earlier conclusion "W610 TX doesn't reach panel" was
 * wrong — see memory: heater_state.md).
 *
 * The RS-485 bus is noisy; a single press frame lands with ~5-30% probability
 * due to collisions with the panel's master traffic. We compensate with
 * retry loops: each key is re-sent up to N times, and we verify every step
 * via display-text changes parsed into PoolState.heaterSetpointF.
 *
 * Nav sequence:
 *   MENU × until "Settings Menu"     → land on top-level Settings
 *   RIGHT × until "Pool Heater1"     → cycle Settings submenu to heater
 *   PLUS × until numeric/"Off"       → enter heater submenu
 *   PLUS/MINUS × delta               → step setpoint to target
 *   (auto-exit 30s later saves)      → no explicit MENU-exit needed
 *
 * Range: 65-104°F. PLUS from 104 wraps to Off; PLUS from Off enables at 65.
 * MINUS from 65 wraps to Off.
 *
 * Operations are slow (60-120s typical). We set the HomeKit characteristic
 * to the requested value *immediately* so the UI doesn't show "not
 * responding" — the actual write runs in background. Display parser
 * corrects the value if the write fails.
 */
export class Thermostat {
    private service: Service;
    private writing = false;
    private pendingTargetF: number | null = null;
    private pendingMode: 'on' | 'off' | null = null;
    private debounceTimer: NodeJS.Timeout | null = null;

    /** HomeKit's "set HEAT" + "set temp" PUTs arrive ~1s apart; debounce
     *  must be longer than that gap to coalesce them into a single flush. */
    private static readonly DEBOUNCE_MS = 2500;
    private static readonly MIN_F = 65;
    private static readonly MAX_F = 104;
    private static readonly DEFAULT_ON_F = 80;

    // RS-485 retry/timing constants — tuned from empirical spike 2026-04-18.
    /** Per-key retry budget for navigation (MENU, RIGHT, PLUS-enter). Generous:
     *  with ~15% per-press hit rate, cycling through 7 top-level menus may
     *  need 80+ retries to land on Settings. */
    private static readonly NAV_RETRIES = 120;
    /** Per-key retry budget for setpoint stepping (PLUS/MINUS within submenu). */
    private static readonly STEP_RETRIES = 80;
    /** Observation window per press before declaring "no panel response" (nav). */
    private static readonly OBSERVE_MS = 2000;
    /** Tighter observation window for setpoint stepping — display update is fast
     *  in submenu (alternates blank/numeric every ~500ms). Fire next press as
     *  soon as we see change, no fixed delay. */
    private static readonly STEP_OBSERVE_MS = 1500;
    /** Idle between nav keys to let delayed bus frames drain. */
    private static readonly NAV_SETTLE_MS = 2000;

    constructor(
        private readonly platform: AquaConnectLitePlatform,
        private readonly accessory: PlatformAccessory,
        private readonly client: AquaLogicClient,
    ) {
        this.service = this.accessory.getService(this.platform.Service.Thermostat)
            || this.accessory.addService(this.platform.Service.Thermostat);

        this.service.setCharacteristic(this.platform.Characteristic.Name, this.accessory.displayName);

        this.service.getCharacteristic(this.platform.Characteristic.TargetTemperature)
            .setProps({
                minValue: round1(F_TO_C(Thermostat.MIN_F)),
                maxValue: round1(F_TO_C(Thermostat.MAX_F)),
                minStep: round1(F_TO_C(1) - F_TO_C(0)),
            })
            .onGet(() => {
                const sp = this.client.state.current.heaterSetpointF;
                const f = typeof sp === 'number' ? sp : Thermostat.MIN_F;
                return round1(F_TO_C(f));
            })
            .onSet(this.onSetTargetTemp.bind(this));

        this.service.getCharacteristic(this.platform.Characteristic.CurrentTemperature)
            .onGet(() => round1(F_TO_C(this.client.state.current.poolTempF ?? 75)));

        this.service.getCharacteristic(this.platform.Characteristic.TargetHeatingCoolingState)
            .setProps({
                validValues: [
                    this.platform.Characteristic.TargetHeatingCoolingState.OFF,
                    this.platform.Characteristic.TargetHeatingCoolingState.HEAT,
                ],
            })
            .onGet(() => this.computeTargetState())
            .onSet(this.onSetTargetState.bind(this));

        this.service.getCharacteristic(this.platform.Characteristic.CurrentHeatingCoolingState)
            .onGet(() => this.computeCurrentState());

        this.service.setCharacteristic(
            this.platform.Characteristic.TemperatureDisplayUnits,
            this.platform.Characteristic.TemperatureDisplayUnits.FAHRENHEIT,
        );

        this.service.updateCharacteristic(
            this.platform.Characteristic.CurrentTemperature,
            round1(F_TO_C(Thermostat.MIN_F)),
        );
        this.service.updateCharacteristic(
            this.platform.Characteristic.TargetTemperature,
            round1(F_TO_C(Thermostat.MIN_F)),
        );

        this.client.state.on('change', (key: keyof PoolState) => {
            if (key === 'poolTempF') {
                const v = this.client.state.current.poolTempF;
                if (typeof v === 'number') {
                    this.service.updateCharacteristic(
                        this.platform.Characteristic.CurrentTemperature,
                        round1(F_TO_C(v)),
                    );
                }
            }
            if (key === 'heaterSetpointF') {
                const v = this.client.state.current.heaterSetpointF;
                const f = typeof v === 'number' ? v : Thermostat.MIN_F;
                this.service.updateCharacteristic(
                    this.platform.Characteristic.TargetTemperature,
                    round1(F_TO_C(f)),
                );
                this.service.updateCharacteristic(
                    this.platform.Characteristic.TargetHeatingCoolingState,
                    this.computeTargetState(),
                );
                this.service.updateCharacteristic(
                    this.platform.Characteristic.CurrentHeatingCoolingState,
                    this.computeCurrentState(),
                );
            }
            if (key === 'heaterMode') {
                this.service.updateCharacteristic(
                    this.platform.Characteristic.TargetHeatingCoolingState,
                    this.computeTargetState(),
                );
                this.service.updateCharacteristic(
                    this.platform.Characteristic.CurrentHeatingCoolingState,
                    this.computeCurrentState(),
                );
            }
        });
    }

    // --- HomeKit state computation -------------------------------------------

    private computeTargetState(): number {
        const st = this.client.state.current;
        const Char = this.platform.Characteristic.TargetHeatingCoolingState;
        if (st.heaterSetpointF === 'off') return Char.OFF;
        if (st.heaterMode === 'heating' || typeof st.heaterSetpointF === 'number') return Char.HEAT;
        return Char.OFF;
    }

    private computeCurrentState(): number {
        const mode = this.client.state.current.heaterMode;
        const Char = this.platform.Characteristic.CurrentHeatingCoolingState;
        return mode === 'heating' ? Char.HEAT : Char.OFF;
    }

    // --- HomeKit setters (debounce + coalesce into single operation) ---------

    private onSetTargetState(value: CharacteristicValue): void {
        const want =
            value === this.platform.Characteristic.TargetHeatingCoolingState.OFF ? 'off' : 'on';
        this.pendingMode = want;
        this.platform.log.info(`${this.accessory.displayName} setTargetState → ${want} (queued)`);
        this.scheduleFlush();
    }

    private onSetTargetTemp(value: CharacteristicValue): void {
        const targetC = value as number;
        const targetF = clamp(Math.round(C_TO_F(targetC)), Thermostat.MIN_F, Thermostat.MAX_F);
        this.pendingTargetF = targetF;
        this.platform.log.info(`${this.accessory.displayName} setTargetTemp → ${targetF}°F (queued)`);
        this.scheduleFlush();
    }

    private scheduleFlush(): void {
        if (this.debounceTimer) clearTimeout(this.debounceTimer);
        this.debounceTimer = setTimeout(() => {
            this.debounceTimer = null;
            void this.flush();
        }, Thermostat.DEBOUNCE_MS);
    }

    private async flush(): Promise<void> {
        if (this.writing) return;
        const mode = this.pendingMode;
        const target = this.pendingTargetF;
        this.pendingMode = null;
        this.pendingTargetF = null;
        if (mode === null && target === null) return;
        this.writing = true;
        try {
            if (mode === 'off') {
                await this.performOff();
            } else if (mode === 'on' && target !== null) {
                await this.performSet(target);
            } else if (mode === 'on') {
                const current = this.client.state.current.heaterSetpointF;
                if (current === 'off' || current === undefined) {
                    await this.performSet(Thermostat.DEFAULT_ON_F);
                } else {
                    this.platform.log.info(
                        `${this.accessory.displayName} on: already at ${current}°F, no-op`,
                    );
                }
            } else if (target !== null) {
                await this.performSet(target);
            }
        } catch (e) {
            this.platform.log.error(
                `${this.accessory.displayName} operation failed: ${(e as Error).message}`,
            );
        } finally {
            this.writing = false;
            if (this.pendingMode !== null || this.pendingTargetF !== null) {
                this.scheduleFlush();
            }
        }
    }

    // --- Core wired-key send wrapper ----------------------------------------

    /** Send a HOLD-PATTERN press (5 frames + release). Use for nav (MENU/RIGHT/PLUS-enter)
     *  where higher per-attempt reliability matters more than per-press precision. */
    private async pressOnce(key: KeyValue, name: string): Promise<void> {
        try {
            await this.client.sendWiredKey(key);
        } catch (e) {
            this.platform.log.debug(`${name} send failed: ${(e as Error).message}`);
        }
    }

    /** Send a SINGLE press+release (no hold). Use for setpoint stepping where
     *  the panel can auto-repeat under hold-pattern, causing overshoot. Caller
     *  watches display and fires next press immediately on display change. */
    // @ts-ignore unused for now
    private async pressSingle(key: KeyValue, name: string): Promise<void> {
        try {
            await this.client.sendWiredKeyOnce(key);
        } catch (e) {
            this.platform.log.debug(`${name} send failed: ${(e as Error).message}`);
        }
    }

    /**
     * Press `key` repeatedly until `predicate(displayText)` matches, or we
     * exhaust `maxAttempts`. Returns whether predicate matched.
     */
    private async pressUntil(
        key: KeyValue,
        name: string,
        predicate: (text: string) => boolean,
        maxAttempts: number,
    ): Promise<boolean> {
        for (let i = 1; i <= maxAttempts; i++) {
            if (this.currentDisplayMatches(predicate)) {
                this.platform.log.debug(`${name}: predicate already satisfied after ${i - 1} tries`);
                return true;
            }
            await this.pressOnce(key, name);
            // Wait up to OBSERVE_MS for a display update matching predicate.
            const deadline = Date.now() + Thermostat.OBSERVE_MS;
            while (Date.now() < deadline) {
                if (this.currentDisplayMatches(predicate)) {
                    this.platform.log.info(`${name}: matched on attempt ${i}`);
                    return true;
                }
                await sleep(80);
            }
        }
        this.platform.log.warn(`${name}: ${maxAttempts} attempts exhausted`);
        return this.currentDisplayMatches(predicate);
    }

    private currentDisplayMatches(predicate: (text: string) => boolean): boolean {
        const cur = this.client.state.current.lastDisplayText;
        return typeof cur === 'string' && predicate(cur);
    }

    // --- Menu navigation -----------------------------------------------------

    private static readonly RE_ANY_MENU =
        /\b(Settings|Timers|Schedules|Diagnostic|Configuration|Default)\s+Menu\b|Heater\s*1/i;
    private static readonly RE_SETTINGS = /\bSettings\s+Menu\b/i;
    /** Top-level Settings → Heater1 entry. Display includes "Manual" or "Auto"
     *  ("Pool Heater1 Manual Off", "Heater1 Auto Control", etc.) — distinguishes
     *  the entry-point view from the in-submenu setpoint view. */
    private static readonly RE_HEATER_LINE = /\bHeater\s*1[^\n]*(?:Manual|Auto)/i;
    /** In-submenu setpoint display: "Pool Heater1 XX°F" or "Pool Heater1 Off"
     *  with NO "Manual" or "Auto" word (those appear at the top-level entry).
     *  Always has "Pool" prefix in submenu (per 2026-04-18 captures). */
    private static readonly RE_IN_SUBMENU =
        /Pool Heater\s*1\s*(?!.*(?:Manual|Auto))[^\n]*(\bOff\b|\d{2,3}\s*[°_\xdfßF])/i;
    /** Looser submenu signal: panel blinks between "Pool Heater1 74ßF" and
     *  "Pool Heater1" (blank digits) every ~500ms in submenu. During the blank
     *  frame RE_IN_SUBMENU fails. This regex catches both forms — use in
     *  combination with a recent numeric heaterSetpointF to avoid top-level
     *  "Pool Heater1 Manual Off" false positives (excluded by Manual|Auto). */
    private static readonly RE_SUBMENU_LOOSE =
        /Pool Heater\s*1\b(?!.*(?:Manual|Auto))/i;

    /**
     * Navigate to Pool Heater1 submenu. Returns current setpoint or null.
     * Fast path: if display already shows submenu (panel hasn't auto-exited
     * since prior op), return current setpoint immediately — no nav needed.
     */
    private async enterSubmenu(): Promise<'off' | number | null> {
        // Fast path — already in submenu. The panel blinks "Pool Heater1 74ßF"
        // ↔ "Pool Heater1" (blank digits) every ~500ms while in submenu, so
        // strict RE_IN_SUBMENU fails on half the frames. Accept the looser
        // "Pool Heater1 (no Manual/Auto)" signal when we ALSO have a recent
        // numeric/off setpoint — the combo of loose-match + known setpoint
        // distinguishes submenu from top-level "Heater1 Auto Control" (no Pool)
        // and "Pool Heater1 Manual Off" (has Manual, excluded).
        const cur = this.client.state.current;
        const sp = cur.heaterSetpointF;
        const inStrict = this.currentDisplayMatches(t => Thermostat.RE_IN_SUBMENU.test(t));
        const inLoose = this.currentDisplayMatches(t => Thermostat.RE_SUBMENU_LOOSE.test(t))
            && (sp === 'off' || typeof sp === 'number');
        if (inStrict || inLoose) {
            if (sp === 'off' || typeof sp === 'number') {
                this.platform.log.info(`${this.accessory.displayName} already in submenu, setpoint=${sp}`);
                return sp;
            }
        }

        this.platform.log.info(`${this.accessory.displayName} entering heater submenu`);

        // Step 1: land on any top-level menu
        const inMenu = await this.pressUntil(
            Key.MENU, 'MENU-any',
            t => Thermostat.RE_ANY_MENU.test(t),
            Thermostat.NAV_RETRIES,
        );
        if (!inMenu) {
            this.platform.log.error(`${this.accessory.displayName} couldn't enter any menu`);
            return null;
        }

        // Step 2: cycle MENU until specifically Settings (allow wrap through other menus)
        const onSettings = await this.pressUntil(
            Key.MENU, 'MENU-Settings',
            t => Thermostat.RE_SETTINGS.test(t),
            Thermostat.NAV_RETRIES,
        );
        if (!onSettings) {
            this.platform.log.error(`${this.accessory.displayName} couldn't reach Settings Menu`);
            return null;
        }

        // Step 3: let any queued MENU frames drain before switching to RIGHT
        await sleep(Thermostat.NAV_SETTLE_MS);

        // Step 4: RIGHT cycles through Settings submenu items until Heater1.
        // Accept either form:
        //   - "Pool Heater1 Manual Off" (some firmwares show setting inline)
        //   - "Pool Heater1"             (this firmware's Settings Menu item header)
        //   - "Pool Heater1 74ßF"        (already in submenu — RIGHT sometimes
        //     doubles as "enter" on certain firmwares)
        // Exclude top-level auto-cycle "Heater1 Auto Control" (no Pool prefix).
        const heaterPredicate = (t: string) =>
            Thermostat.RE_HEATER_LINE.test(t) || Thermostat.RE_SUBMENU_LOOSE.test(t);
        const onHeater = await this.pressUntil(
            Key.RIGHT, 'RIGHT-Heater',
            heaterPredicate,
            Thermostat.NAV_RETRIES,
        );
        if (!onHeater) {
            this.platform.log.error(`${this.accessory.displayName} couldn't reach Pool Heater1`);
            return null;
        }

        // Step 5: If already in submenu (RIGHT advanced us through), skip PLUS.
        // Otherwise PLUS to descend — submenu shows "Pool Heater1 XX°F" or "Pool Heater1 Off".
        await sleep(1500);
        const submenuPredicate = (t: string) =>
            Thermostat.RE_IN_SUBMENU.test(t) ||
            (Thermostat.RE_SUBMENU_LOOSE.test(t) && typeof this.client.state.current.heaterSetpointF !== 'undefined');
        if (!this.currentDisplayMatches(submenuPredicate)) {
            const inSubmenu = await this.pressUntil(
                Key.PLUS, 'PLUS-enter-submenu',
                submenuPredicate,
                15,
            );
            if (!inSubmenu) {
                this.platform.log.error(`${this.accessory.displayName} couldn't enter heater submenu`);
                return null;
            }
        } else {
            this.platform.log.info(`${this.accessory.displayName} submenu already entered via RIGHT`);
        }

        // Return the setpoint from the PoolState (populated by display parser)
        const sp2 = this.client.state.current.heaterSetpointF;
        if (sp2 === 'off' || typeof sp2 === 'number') {
            this.platform.log.info(`${this.accessory.displayName} submenu setpoint=${sp2}`);
            return sp2;
        }
        // Fall back: parse last display text ourselves
        const text = this.client.state.current.lastDisplayText ?? '';
        const parsed = parseSetpoint(text);
        this.platform.log.info(`${this.accessory.displayName} submenu setpoint (fallback)=${parsed}`);
        return parsed;
    }

    private async performOff(): Promise<void> {
        const cur = await this.enterSubmenu();
        if (cur === null) throw new Error('menu nav failed');
        if (cur === 'off') {
            this.platform.log.info(`${this.accessory.displayName} already off`);
            return;
        }
        this.platform.log.info(`${this.accessory.displayName} stepping ${cur}°F → Off`);

        // Hold MINUS, release when setpoint hits 65 (one below is Off), then
        // send one discrete MINUS to cross into Off. Panel auto-wraps 65→Off.
        // Large delta (e.g. 104→65 = 39 steps) benefits most from hold.
        let seen: 'off' | number = cur;
        if (typeof seen === 'number' && seen > Thermostat.MIN_F) {
            seen = await this.stepWithHold(
                Key.MINUS, 'MINUS',
                seen, Thermostat.MIN_F,
                (sp, target) => typeof sp === 'number' && sp <= target,
            );
        }
        // Discrete stepping for final Off crossing (panel: MINUS past 65 → Off)
        let stuck = 0;
        while (seen !== 'off' && stuck < Thermostat.STEP_RETRIES) {
            const before: 'off' | number = seen;
            await this.pressOnce(Key.MINUS, 'MINUS');
            const deadline = Date.now() + Thermostat.STEP_OBSERVE_MS;
            while (Date.now() < deadline) {
                const sp = this.client.state.current.heaterSetpointF;
                if ((sp === 'off' || typeof sp === 'number') && sp !== before) { seen = sp; break; }
                await sleep(40);
            }
            if (seen === before) stuck++;
            else { stuck = 0; this.platform.log.info(`${this.accessory.displayName} MINUS → ${seen}`); }
        }
        if (seen !== 'off') throw new Error(`couldn't reach Off, stuck at ${seen}`);
        this.platform.log.info(`${this.accessory.displayName} ✅ OFF`);
    }

    private async performSet(targetF: number): Promise<void> {
        const target = clamp(targetF, Thermostat.MIN_F, Thermostat.MAX_F);
        const cur = await this.enterSubmenu();
        if (cur === null) throw new Error('menu nav failed');

        let seen: 'off' | number = cur;

        // If currently Off, one PLUS enables to MIN_F (65)
        if (seen === 'off') {
            this.platform.log.info(`${this.accessory.displayName} enabling Off → 65°F`);
            let tries = 0;
            while (seen === 'off' && tries++ < Thermostat.STEP_RETRIES) {
                await this.pressOnce(Key.PLUS, 'PLUS-enable');
                const deadline = Date.now() + Thermostat.STEP_OBSERVE_MS;
                while (Date.now() < deadline) {
                    const sp = this.client.state.current.heaterSetpointF;
                    if (typeof sp === 'number') { seen = sp; break; }
                    await sleep(40);
                }
            }
            if (seen === 'off') throw new Error('couldn\'t enable heater');
            this.platform.log.info(`${this.accessory.displayName} enabled at ${seen}°F`);
        }

        // Large delta → hold stepping; panel's internal key-repeat auto-scrolls
        // at ~150-200ms/step once its ~500ms initial-delay fires. Release when
        // we see the target (or slightly past it) on the bus.
        if (typeof seen === 'number' && Math.abs(target - seen) >= Thermostat.HOLD_MIN_DELTA) {
            const delta = target - seen;
            const key = delta > 0 ? Key.PLUS : Key.MINUS;
            const name = delta > 0 ? 'PLUS' : 'MINUS';
            seen = await this.stepWithHold(
                key, name, seen, target,
                (sp, tgt) => typeof sp === 'number' && (delta > 0 ? sp >= tgt : sp <= tgt),
            );
        }

        // Fine tuning: discrete hold-pattern presses for the last 0-2°F.
        // Corrects any overshoot from the hold release, and handles the case
        // where hold did nothing (panel didn't auto-repeat) and we're still
        // at the starting setpoint.
        let stuck = 0;
        while (seen !== target && stuck < Thermostat.STEP_RETRIES) {
            const delta = target - (seen as number);
            const key = delta > 0 ? Key.PLUS : Key.MINUS;
            const name = delta > 0 ? 'PLUS' : 'MINUS';
            const before: 'off' | number = seen;
            await this.pressOnce(key, name);
            const deadline = Date.now() + Thermostat.STEP_OBSERVE_MS;
            while (Date.now() < deadline) {
                const sp = this.client.state.current.heaterSetpointF;
                if (typeof sp === 'number' && sp !== before) { seen = sp; break; }
                await sleep(40);
            }
            if (seen === before) stuck++;
            else { stuck = 0; this.platform.log.info(`${this.accessory.displayName} ${name} → ${seen}°F`); }
        }
        if (seen !== target) throw new Error(`couldn't reach ${target}°F, stuck at ${seen}`);
        this.platform.log.info(`${this.accessory.displayName} ✅ setpoint=${target}°F`);
    }

    /** Minimum delta (°F) to attempt hold-until-target before discrete stepping.
     *
     *  EMPIRICAL (v3.2.13 live test 2026-04-18): holding wired-key did NOT
     *  auto-repeat the setpoint — 30 press frames over 3s produced zero
     *  steps. This firmware's wired-key decoder only sees the first press
     *  edge; subsequent "held" frames are ignored. Kept as best-effort
     *  experiment: the stall detector falls back to discrete within ~1.5s
     *  when the panel doesn't move. Set to Infinity to disable entirely. */
    private static readonly HOLD_MIN_DELTA = Number.POSITIVE_INFINITY;
    /** Max time to hold before assuming the panel isn't auto-repeating and
     *  falling back to discrete stepping. */
    private static readonly HOLD_MAX_MS = 20_000;
    /** Max time without observing any setpoint change while holding. Short
     *  because we already know wired-hold is a no-op on this firmware — fail
     *  fast so discrete stepping takes over. */
    private static readonly HOLD_STALL_MS = 1_500;

    /**
     * Hold `key` continuously, watching heaterSetpointF. Release when
     * predicate(sp, target) is true (at or past target) or on stall/timeout.
     * Returns the final observed setpoint.
     */
    private async stepWithHold(
        key: KeyValue,
        name: string,
        start: number,
        target: number,
        reached: (sp: 'off' | number | undefined, target: number) => boolean,
    ): Promise<'off' | number> {
        this.platform.log.info(
            `${this.accessory.displayName} hold ${name} from ${start}°F toward ${target}°F`,
        );

        let seen: 'off' | number = start;
        let lastChangeAt = Date.now();
        const deadline = Date.now() + Thermostat.HOLD_MAX_MS;

        const onChange = (k: keyof PoolState) => {
            if (k !== 'heaterSetpointF') return;
            const sp = this.client.state.current.heaterSetpointF;
            if (sp === 'off' || typeof sp === 'number') {
                if (sp !== seen) {
                    seen = sp;
                    lastChangeAt = Date.now();
                    this.platform.log.debug(
                        `${this.accessory.displayName} hold ${name} sp=${sp}`,
                    );
                }
            }
        };
        this.client.state.on('change', onChange);

        try {
            await this.client.startHold(key);

            while (Date.now() < deadline) {
                if (reached(seen, target)) break;
                if (Date.now() - lastChangeAt > Thermostat.HOLD_STALL_MS) {
                    this.platform.log.warn(
                        `${this.accessory.displayName} hold ${name} stalled at ${seen}°F — releasing`,
                    );
                    break;
                }
                await sleep(50);
            }
        } finally {
            this.client.state.off('change', onChange);
            try {
                await this.client.stopHold();
            } catch (e) {
                this.platform.log.warn(
                    `${this.accessory.displayName} hold ${name} release failed: ${(e as Error).message}`,
                );
            }
        }

        this.platform.log.info(
            `${this.accessory.displayName} hold ${name} released at ${seen}°F (target ${target})`,
        );
        return seen;
    }
}

function clamp(n: number, lo: number, hi: number): number {
    return n < lo ? lo : n > hi ? hi : n;
}

function parseSetpoint(text: string): 'off' | number | null {
    const numM = text.match(/Heater\s*\d?\s*[^\d]{0,30}?(\d{2,3})\s*[°_\xdfßF]/i);
    if (numM) {
        const f = parseInt(numM[1], 10);
        if (f >= 60 && f <= 110) return f;
    }
    if (/Pool Heater[^\n]*\bOff\b/i.test(text)) return 'off';
    return null;
}
