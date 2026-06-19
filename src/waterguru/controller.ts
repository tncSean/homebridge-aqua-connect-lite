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

        // Compute + apply the bounded step (daily only; startup is read-only).
        if (trigger === 'daily' && reading.fc !== undefined && reading.fcRange && typeof curPct === 'number') {
            const target = computeTargetPct(curPct, reading.fc, reading.fcRange, this.cfg);
            if (target === curPct) {
                this.platform.log.info(`WG: FC ${reading.fc}ppm in range — no chlorinator change (at ${curPct}%).`);
            } else if (this.cfg.computeOnly) {
                this.platform.log.info(`WG (compute-only): would set chlorinator ${curPct}% → ${target}% (FC ${reading.fc}ppm).`);
            } else if (this.chlorinator) {
                this.platform.log.info(`WG: driving chlorinator ${curPct}% → ${target}% (FC ${reading.fc}ppm).`);
                try {
                    await this.chlorinator.driveTo(target);
                } catch (e) {
                    this.platform.log.error(`WG: chlorinator drive failed: ${(e as Error).message}`);
                }
            }
        }

        // Red-flag evaluation (always, even startup, so an offline pod surfaces fast).
        const snap = this.tracker.snapshot(Date.now());
        const rf = evaluateRedFlags(this.redflagInput(reading, snap.noFlowFraction));
        if (rf.active) this.sensors.alert?.raise(rf.reason);
        else this.sensors.alert?.clear();

        // Roll the generation accumulator over at the daily mark.
        if (trigger === 'daily') this.tracker.reset(Date.now());
    }

    private redflagInput(r: WgReading, noFlowFraction: number): RedFlagInput {
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

/** ms from `now` until the next local HH:MM. Falls back to 09:30 on parse failure. */
export function msUntilNext(hhmm: string, now: Date): number {
    const parts = hhmm.split(':').map(n => parseInt(n, 10));
    const h = Number.isFinite(parts[0]) ? parts[0] : 9;
    const m = Number.isFinite(parts[1]) ? parts[1] : 30;
    const next = new Date(now);
    next.setHours(h, m, 0, 0);
    if (next.getTime() <= now.getTime()) next.setDate(next.getDate() + 1);
    return next.getTime() - now.getTime();
}
