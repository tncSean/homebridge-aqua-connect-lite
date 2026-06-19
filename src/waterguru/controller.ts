/**
 * Chlorine auto-tuner controller. Orchestration: subscribes to RS-485 state
 * for the GenerationTracker, schedules a daily WaterGuru fetch + startup
 * fetch, computes the bounded step, drives the chlorinator (unless
 * computeOnly), evaluates red flags, and updates HomeKit sensor tiles.
 *
 * FAIL-SAFE: any error (WG fetch, RS-485 drive, unknown %) → no pool change,
 * error logged, alert raised if threshold met, loop continues.
 *
 * `msUntilNext` is exported as a PURE function (no I/O) and is unit-tested
 * by schedule.test.ts.
 */
import { AquaConnectLitePlatform } from '../platform';
import { AquaLogicClient } from '../aqualogic/client';
import { PoolState } from '../aqualogic/state';
import { Chlorinator } from '../chlorinator';
import { WaterGuruClient, WgReading } from './client';
import { LesliesClient, LesliesReading } from '../leslies/client';
import { computeTargetPct, ControlParams } from './control';
import { evaluateRedFlags, RedFlagInput } from './redflag';
import { nextBestAction, cyaDoseOz } from './nextaction';
import { GenerationTracker } from './generation-tracker';
import { ChlorineSensor } from './chlorinesensor';
import { PhSensor } from './phsensor';
import { PoolAlert } from './poolalert';
import { ChemistrySensor } from './chemistrysensor';
import { Band } from './compliance';
import { Notifier } from './notifier';
import { buildChemNotification, OutOfRangeParam, isOutOfRange } from './notifysummary';

export interface ControllerConfig extends ControlParams {
    enabled: boolean;
    /** "HH:MM" local time for the daily run. */
    runAt: string;
    /** If true, compute + log the proposed step but DO NOT drive the chlorinator. */
    computeOnly: boolean;
    /** Pool volume (gal), manual — feeds the salt-dose next-best-action. */
    poolGallons?: number;
    /** Last-known salt (ppm), manual — not on RS-485/WG. */
    saltCurrentPpm?: number;
    /** Target salt (ppm), manual. */
    saltTargetPpm?: number;
    /** Salt deadband (ppm) — don't prompt within this margin of target. */
    saltDeadbandPpm?: number;
    /** Compliance green bands (per-parameter) for the chemistry tiles. */
    saltGreenMin: number;
    saltGreenMax: number;
    phGreenMin: number;
    phGreenMax: number;
    fcGreenMin: number;
    fcGreenMax: number;
    taGreenMin: number;
    taGreenMax: number;
    cyaGreenMin: number;
    cyaGreenMax: number;
    /** Calcium hardness green band (ppm) for the Leslie's-fed Calcium tile. */
    calciumGreenMin: number;
    calciumGreenMax: number;
    /** Manual CYA reading (ppm); 0 = unknown → tile shows Unknown. */
    cyaCurrentPpm: number;
    /** CYA dose target (ppm) — conservative in-band target for the stabilizer dose. */
    cyaTargetPpm: number;
    /** Liquid stabilizer strength (fl oz per 1 ppm CYA per 10k gal) — owner's product. */
    stabilizerOzPerPpmPer10kGal: number;
    /** ntfy push config. Empty topic = disabled. */
    ntfyServer: string;
    ntfyTopic: string;
}

/** HomeKit sensor tiles the controller drives. All optional (creds/config gated). */
export interface ControllerSensors {
    chlorine?: ChlorineSensor;
    ph?: PhSensor;
    salt?: ChemistrySensor;
    ta?: ChemistrySensor;
    cya?: ChemistrySensor;
    calcium?: ChemistrySensor;
    alert?: PoolAlert;
}

const HISTORY_DAYS = 7;

export class WaterGuruController {
    private readonly tracker = new GenerationTracker();
    private readonly fcHistory: number[] = [];
    private readonly pctHistory: number[] = [];
    private wgFetchFailures = 0;
    private dailyTimer: NodeJS.Timeout | null = null;

    constructor(
        private readonly platform: AquaConnectLitePlatform,
        private readonly wg: WaterGuruClient,
        private readonly aqua: AquaLogicClient,
        private readonly chlorinator: Chlorinator | null,
        private readonly sensors: ControllerSensors,
        private readonly cfg: ControllerConfig,
        private readonly notifier: Notifier | null = null,
        /** Leslie's Pool client — null when creds absent (Calcium tile force-excluded). */
        private readonly leslies: LesliesClient | null = null,
    ) {
        // Feed the generation tracker from live RS-485 state changes.
        this.aqua.state.on('change', (key: keyof PoolState) => {
            if (key === 'chlorinatorOn' || key === 'chlorinatorIdleReason') {
                this.tracker.update(
                    {
                        chlorinatorOn: this.aqua.state.current.chlorinatorOn,
                        chlorinatorIdleReason: this.aqua.state.current.chlorinatorIdleReason,
                    },
                    Date.now(),
                );
            }
        });
    }

    /** Start: one fetch now (populate tiles), then schedule the daily run. */
    start(): void {
        void this.runOnce('startup').catch(e =>
            this.platform.log.warn(`WG startup fetch failed: ${(e as Error).message}`));
        this.scheduleDaily();
    }

    stop(): void {
        if (this.dailyTimer) { clearTimeout(this.dailyTimer); this.dailyTimer = null; }
    }

    private scheduleDaily(): void {
        if (!isValidRunAt(this.cfg.runAt)) {
            this.platform.log.warn(
                `WG controller: configured run_at "${this.cfg.runAt}" is invalid (need HH:MM, 00-23:00-59) — defaulting to 09:30.`,
            );
        }
        const delay = msUntilNext(this.cfg.runAt, new Date());
        this.platform.log.info(`WG controller: next run in ${(delay / 3.6e6).toFixed(1)}h (at ${this.cfg.runAt})`);
        this.dailyTimer = setTimeout(() => {
            void this.runOnce('daily').catch(e =>
                this.platform.log.error(`WG daily run failed: ${(e as Error).message}`));
            this.scheduleDaily(); // re-arm for tomorrow
        }, delay);
        this.dailyTimer.unref?.();
    }

    /** One full cycle. FAIL-SAFE: any throw → no pool change, error logged, alert raised. */
    async runOnce(trigger: 'startup' | 'daily'): Promise<void> {
        let reading: WgReading;
        try {
            reading = await this.wg.fetch();
            this.wgFetchFailures = 0;
        } catch (e) {
            this.wgFetchFailures++;
            this.platform.log.warn(`WG fetch failed (${this.wgFetchFailures}): ${(e as Error).message}`);
            this.maybeAlertFetchFailure();
            return; // never adjust on stale data
        }

        // Leslie's Pool water-test import (DAILY only; non-fatal). Adds salt,
        // calcium, metals, phosphates etc. that WaterGuru does not measure. A
        // failure here NEVER breaks the WG run — warn + continue with no Leslie's.
        let leslies: LesliesReading | undefined;
        if (trigger === 'daily' && this.leslies) {
            try {
                leslies = await this.leslies.fetch();
                this.logLesliesReading(leslies);
            } catch (e) {
                this.platform.log.warn(`Leslie's fetch failed (non-fatal): ${(e as Error).message}`);
            }
        }

        // Update all chemistry compliance tiles from fresh chemistry. Each tile
        // shows a color-coded compliance state vs. its green band; the exact
        // value/instruction is delivered via the log + the optional ntfy push.
        // As we push each tile we collect (name, value, unit, band) so a single
        // batched notification can name every out-of-range param this run.
        const chem: Array<{ name: string; value: number | undefined; unit: string; band: Band }> = [];

        // Prefer the WG-recommended FC band when present; else the config band.
        const fcBand: Band = reading.fcRange
            ? { min: reading.fcRange[0], max: reading.fcRange[1] }
            : { min: this.cfg.fcGreenMin, max: this.cfg.fcGreenMax };
        if (reading.fc !== undefined) this.sensors.chlorine?.setFc(reading.fc, fcBand);
        chem.push({ name: 'Free Chlorine', value: reading.fc, unit: 'ppm', band: fcBand });

        const phBand: Band = { min: this.cfg.phGreenMin, max: this.cfg.phGreenMax };
        if (reading.ph !== undefined) this.sensors.ph?.setPh(reading.ph, phBand);
        chem.push({ name: 'pH', value: reading.ph, unit: 'pH', band: phBand });

        const taBand: Band = { min: this.cfg.taGreenMin, max: this.cfg.taGreenMax };
        if (reading.ta !== undefined) this.sensors.ta?.update(reading.ta, taBand);
        chem.push({ name: 'Total Alkalinity', value: reading.ta, unit: 'ppm', band: taBand });

        // Salt: prefer Leslie's MEASURED salt when present; else the manual
        // config value (not on RS-485/WG). Log which source fed the tile + NBA.
        const saltBand: Band = { min: this.cfg.saltGreenMin, max: this.cfg.saltGreenMax };
        const saltPpm = leslies?.salt !== undefined ? leslies.salt : this.cfg.saltCurrentPpm;
        const saltSource = leslies?.salt !== undefined ? "Leslie's (measured)" : 'config (manual)';
        this.platform.log.info(`Salt source: ${saltSource} → ${saltPpm} ppm`);
        this.sensors.salt?.update(saltPpm, saltBand);
        chem.push({ name: 'Salt', value: saltPpm, unit: 'ppm', band: saltBand });

        // Calcium hardness: Leslie's-only (WG does not measure it). Prefer the
        // ideal range Leslie's returns; else the configured calcium green band.
        // Tile shows Unknown when Leslie's has no calcium reading.
        const calciumBand: Band = leslies?.calciumRange
            ? { min: leslies.calciumRange[0], max: leslies.calciumRange[1] }
            : { min: this.cfg.calciumGreenMin, max: this.cfg.calciumGreenMax };
        this.sensors.calcium?.update(leslies?.calcium, calciumBand);
        chem.push({ name: 'Calcium Hardness', value: leslies?.calcium, unit: 'ppm', band: calciumBand });

        // CYA — WG tests this daily, so prefer the LIVE reading (value + GREEN band).
        // Fall back to the configured manual value/band only when WG omits CYA.
        const cyaBand: Band = reading.cyaRange
            ? { min: reading.cyaRange[0], max: reading.cyaRange[1] }
            : { min: this.cfg.cyaGreenMin, max: this.cfg.cyaGreenMax };
        const cyaValue = reading.cya !== undefined
            ? reading.cya
            : (this.cfg.cyaCurrentPpm > 0 ? this.cfg.cyaCurrentPpm : undefined);
        this.sensors.cya?.update(cyaValue, cyaBand);
        chem.push({ name: 'CYA', value: cyaValue, unit: 'ppm', band: cyaBand });

        // Out-of-range params (value defined AND outside its band) for the push.
        // CYA gets an actionable dose when it's below the band min (CYA can only
        // be removed by dilution, so we never advise reducing it). Salt stays the
        // NBA headline; no other param needs a dose right now.
        const outOfRange: OutOfRangeParam[] = chem
            .filter(p => isOutOfRange(p.value, p.band))
            .map(p => {
                const item: OutOfRangeParam = { name: p.name, value: p.value as number, unit: p.unit, band: p.band };
                if (p.name === 'CYA' && (p.value as number) < p.band.min && this.cfg.poolGallons !== undefined) {
                    const oz = cyaDoseOz(
                        p.value as number,
                        this.cfg.cyaTargetPpm,
                        this.cfg.poolGallons,
                        this.cfg.stabilizerOzPerPpmPer10kGal,
                    );
                    if (oz > 0) item.advice = `add ~${oz} oz stabilizer`;
                }
                return item;
            });

        // History bookkeeping.
        if (reading.fc !== undefined) push(this.fcHistory, reading.fc, HISTORY_DAYS);
        const curPct = this.aqua.state.current.chlorinatorPercent;
        if (typeof curPct === 'number') push(this.pctHistory, curPct, HISTORY_DAYS);

        // Next-best-action: a pending FOUNDATIONAL action (e.g. add salt) supersedes
        // auto-tuning — it holds the drive AND owns the Pool Alert tile this run.
        // Prefer Leslie's measured salt for the NBA dose when available, so the
        // "add salt" recommendation reflects the real measurement, not stale config.
        const nba = nextBestAction({
            saltCurrentPpm: saltPpm,
            saltTargetPpm: this.cfg.saltTargetPpm,
            saltDeadbandPpm: this.cfg.saltDeadbandPpm,
            poolGallons: this.cfg.poolGallons,
        });
        if (nba.blocksDrive) {
            this.platform.log.info(`WG: holding chlorinator auto-tune — next best action: ${nba.message}`);
        }

        // Compute + apply the bounded step (daily only; startup is read-only).
        if (trigger === 'daily' && !nba.blocksDrive && reading.fc !== undefined && reading.fcRange && typeof curPct === 'number') {
            const target = computeTargetPct(curPct, reading.fc, reading.fcRange, this.cfg);
            if (target === curPct) {
                this.platform.log.info(`WG: FC ${reading.fc}ppm in range — no chlorinator change (at ${curPct}%).`);
            } else if (this.cfg.computeOnly) {
                this.platform.log.info(`WG (compute-only): would set chlorinator ${curPct}% → ${target}% (FC ${reading.fc}ppm).`);
            } else if (this.chlorinator) {
                this.platform.log.info(`WG: driving chlorinator ${curPct}% → ${target}% (FC ${reading.fc}ppm).`);
                try {
                    const final = await this.chlorinator.driveTo(target);
                    if (final === null) {
                        // driveTo returns null on nav failure (it does NOT throw).
                        this.raiseDriveFailure(`Auto-tuner could not navigate the chlorinator menu to set ${target}%`);
                    }
                } catch (e) {
                    this.raiseDriveFailure(`Auto-tuner failed to set chlorinator to ${target}% — ${(e as Error).message}`);
                }
            }
        }

        // Tile precedence: a pending foundational action owns the Pool Alert tile
        // and supersedes red-flags for this run. Otherwise, evaluate red-flags as
        // usual (always, even startup, so an offline pod surfaces fast).
        if (nba.active) {
            this.sensors.alert?.raise(nba.message);
        } else {
            const snap = this.tracker.snapshot(Date.now());
            const rf = evaluateRedFlags(this.redflagInput(reading, snap.noFlowFraction));
            if (rf.active) this.sensors.alert?.raise(rf.reason);
            else this.sensors.alert?.clear();
        }

        // ONE batched push per DAILY run (single 'chem' dedupe key) naming the
        // foundational action AND every out-of-range param — never spam.
        // Startup runs still refresh the HomeKit tiles above but send NO push;
        // the notifier's ~20h window re-reminds each morning while work is pending
        // but never twice in a day. Best-effort: a notify failure never breaks the run.
        if (trigger === 'daily') {
            const note = buildChemNotification({
                nbaActive: nba.active,
                nbaMessage: nba.message,
                outOfRange,
            });
            if (note) {
                try {
                    await this.notifier?.maybeNotify('chem', note.title, note.body);
                } catch (e) {
                    this.platform.log.warn(`ntfy push (chem) failed: ${(e as Error).message}`);
                }
            }
        }

        // Roll the generation accumulator over at the daily mark.
        if (trigger === 'daily') this.tracker.reset(Date.now());
    }

    /**
     * Log the full latest Leslie's test verbatim — every parsed parameter plus
     * the test date — so the owner sees the complete reading in the daily log.
     * CYA/FC/pH/TA are logged here purely as a cross-check; their HomeKit tile
     * source stays WaterGuru (daily/fresher). NEVER logs credentials.
     */
    private logLesliesReading(r: LesliesReading): void {
        const parts: string[] = [];
        const add = (label: string, v: number | undefined, unit: string): void => {
            if (v !== undefined) parts.push(`${label} ${v}${unit}`);
        };
        add('salt', r.salt, ' ppm');
        add('CYA', r.cya, ' ppm');
        add('calcium', r.calcium, ' ppm');
        add('FC', r.fc, ' ppm');
        add('pH', r.ph, '');
        add('TA', r.ta, ' ppm');
        add('phosphates', r.phosphates, ' ppb');
        add('copper', r.copper, ' ppm');
        add('iron', r.iron, ' ppm');
        add('TDS', r.tds, ' ppm');
        add('bromine', r.bromine, ' ppm');
        add('total Cl', r.totalChlorine, ' ppm');
        const when = r.testDate !== undefined ? new Date(r.testDate).toISOString() : 'unknown date';
        const src = r.isStoreTest === true ? 'in-store' : r.isStoreTest === false ? 'AccuBlue Home' : 'source unknown';
        const body = parts.length > 0 ? parts.join(', ') : 'no chemistry parameters returned';
        this.platform.log.info(`Leslie's (tested ${when}, ${src}): ${body}`);
    }

    /** Log + raise a Pool Alert for a chlorinator drive failure (thrown OR nav-null). */
    private raiseDriveFailure(reason: string): void {
        this.platform.log.error(`WG: ${reason}`);
        this.sensors.alert?.raise(reason);
    }

    private redflagInput(r: WgReading, noFlowFraction: number): RedFlagInput {
        if (r.fcRange === undefined) {
            this.platform.log.warn(
                'WG response lacked a recommended FC range (floatRanges) — auto-tuner using default [3,5] band.',
            );
        }
        return {
            fcHistory: this.fcHistory,
            pctHistory: this.pctHistory,
            recommendedRange: r.fcRange ?? [3, 5],
            maxPct: this.cfg.maxPct,
            noFlowFraction,
            cassettePercent: r.cassettePercent,
            podOnline: r.podOnline,
            wgFetchFailures: this.wgFetchFailures,
            // saltPpm: not in the WG dashboard — left undefined (Hayward-only).
        };
    }

    private maybeAlertFetchFailure(): void {
        const rf = evaluateRedFlags({
            fcHistory: this.fcHistory, pctHistory: this.pctHistory,
            recommendedRange: [3, 5], maxPct: this.cfg.maxPct,
            noFlowFraction: 0, podOnline: true, wgFetchFailures: this.wgFetchFailures,
        });
        if (rf.active) this.sensors.alert?.raise(rf.reason);
    }
}

function push(arr: number[], v: number, cap: number): void {
    arr.push(v);
    while (arr.length > cap) arr.shift();
}

/** Parse "HH:MM" into a valid {h,m} (0-23/0-59) or null. Shared by msUntilNext + isValidRunAt. */
function parseRunAt(hhmm: string): { h: number; m: number } | null {
    const parts = hhmm.split(':').map(n => parseInt(n, 10));
    const h = parts[0];
    const m = parts[1];
    if (!Number.isFinite(h) || !Number.isFinite(m)) return null;
    if (h < 0 || h > 23 || m < 0 || m > 59) return null;
    return { h, m };
}

/** True when `hhmm` parses into a valid local HH:MM. */
export function isValidRunAt(hhmm: string): boolean {
    return parseRunAt(hhmm) !== null;
}

/** ms from `now` until the next local HH:MM. Falls back to 09:30 on parse failure. */
export function msUntilNext(hhmm: string, now: Date): number {
    const parsed = parseRunAt(hhmm) ?? { h: 9, m: 30 };
    const next = new Date(now);
    next.setHours(parsed.h, parsed.m, 0, 0);
    if (next.getTime() <= now.getTime()) next.setDate(next.getDate() + 1);
    return next.getTime() - now.getTime();
}
