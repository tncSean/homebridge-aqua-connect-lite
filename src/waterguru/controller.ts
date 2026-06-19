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
import { computeTargetPct, ControlParams } from './control';
import { evaluateRedFlags, RedFlagInput } from './redflag';
import { nextBestAction } from './nextaction';
import { GenerationTracker } from './generation-tracker';
import { ChlorineSensor } from './chlorinesensor';
import { PhSensor } from './phsensor';
import { PoolAlert } from './poolalert';

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
        private readonly sensors: { chlorine?: ChlorineSensor; ph?: PhSensor; alert?: PoolAlert },
        private readonly cfg: ControllerConfig,
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

        // Update tiles from fresh chemistry.
        if (reading.fc !== undefined) this.sensors.chlorine?.setFc(reading.fc);
        if (reading.ph !== undefined) this.sensors.ph?.setPh(reading.ph);

        // History bookkeeping.
        if (reading.fc !== undefined) push(this.fcHistory, reading.fc, HISTORY_DAYS);
        const curPct = this.aqua.state.current.chlorinatorPercent;
        if (typeof curPct === 'number') push(this.pctHistory, curPct, HISTORY_DAYS);

        // Next-best-action: a pending FOUNDATIONAL action (e.g. add salt) supersedes
        // auto-tuning — it holds the drive AND owns the Pool Alert tile this run.
        const nba = nextBestAction({
            saltCurrentPpm: this.cfg.saltCurrentPpm,
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
            this.sensors.alert?.raise(nba.message, nba.tileName);
        } else {
            const snap = this.tracker.snapshot(Date.now());
            const rf = evaluateRedFlags(this.redflagInput(reading, snap.noFlowFraction));
            if (rf.active) this.sensors.alert?.raise(rf.reason);
            else this.sensors.alert?.clear();
        }

        // Roll the generation accumulator over at the daily mark.
        if (trigger === 'daily') this.tracker.reset(Date.now());
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
