/**
 * PURE red-flag detector for the chlorine auto-tuner. No I/O.
 *
 * Returns the single most-actionable alert (priority-ordered) so the HomeKit
 * Pool Alert tile names the likeliest root cause from observable data, rather
 * than letting the controller silently peg the setpoint. Spec §Red-Flag.
 *
 * Thresholds are conservative defaults; tune in the field.
 */
export interface RedFlagInput {
    /** FC ppm history, oldest→newest (>= 3 days for the climbing check). */
    fcHistory: number[];
    /** Chlorinator % history, oldest→newest. */
    pctHistory: number[];
    /** WG recommended FC band [low, high]. */
    recommendedRange: [number, number];
    maxPct: number;
    /** Fraction of yesterday spent in No-Flow (0..1) from GenerationTracker. */
    noFlowFraction: number;
    saltPpm?: number;
    cassettePercent?: number;
    podOnline?: boolean;
    /** Consecutive failed WG fetches. */
    wgFetchFailures: number;
}

export interface RedFlag {
    active: boolean;
    reason: string;
}

const SALT_LOW_PPM = 2600;       // Hayward T-Cell underdrive threshold
const NOFLOW_FRACTION_ALERT = 0.4;
const WG_FAIL_ALERT = 2;
const CLIMB_DAYS = 3;

function isRising(xs: number[]): boolean {
    if (xs.length < CLIMB_DAYS) return false;
    const tail = xs.slice(-CLIMB_DAYS);
    for (let i = 1; i < tail.length; i++) {
        if (tail[i] <= tail[i - 1]) return false;
    }
    return true;
}

function noFcImprovement(xs: number[]): boolean {
    if (xs.length < CLIMB_DAYS) return false;
    const tail = xs.slice(-CLIMB_DAYS);
    // newest not meaningfully higher than oldest in window
    return tail[tail.length - 1] <= tail[0] + 0.2;
}

/** Evaluate all conditions; return the highest-priority active alert. */
export function evaluateRedFlags(i: RedFlagInput): RedFlag {
    const ok = (reason: string): RedFlag => ({ active: true, reason });
    const [low] = i.recommendedRange;
    const latestFc = i.fcHistory[i.fcHistory.length - 1];
    const latestPct = i.pctHistory[i.pctHistory.length - 1];
    const belowTarget = typeof latestFc === 'number' && latestFc < low;

    // 1) Data integrity first — a broken pipe invalidates everything else.
    if (i.wgFetchFailures >= WG_FAIL_ALERT) {
        return ok(`Water Guru fetch failing (${i.wgFetchFailures} days) — chemistry is stale; auto-tuning paused.`);
    }
    if (i.podOnline === false) {
        return ok('Water Guru pod offline — no fresh chemistry; auto-tuning paused.');
    }
    if (i.cassettePercent !== undefined && i.cassettePercent <= 0) {
        return ok('Water Guru cassette empty — replace it to resume daily testing.');
    }

    // 2) Flow — the dominant failure mode this season; can't be fixed by %.
    if (i.noFlowFraction >= NOFLOW_FRACTION_ALERT) {
        const pctDay = Math.round(i.noFlowFraction * 100);
        return ok(`Cell spent ${pctDay}% of yesterday in No-Flow — raise pump speed/runtime during the chlorination window.`);
    }

    // 3) Salt — under-driven cell.
    if (i.saltPpm !== undefined && i.saltPpm < SALT_LOW_PPM) {
        return ok(`Salt low (${i.saltPpm} ppm) — cell under-driven; add salt.`);
    }

    // 4) Can't compensate further — already maxed and still low.
    if (belowTarget && latestPct >= i.maxPct) {
        return ok(`Chlorinator at max ${i.maxPct}% and FC still below target — can't compensate further; test/raise CYA or inspect the cell.`);
    }

    // 5) Climbing with no payoff — changes aren't reaching the water.
    if (belowTarget && isRising(i.pctHistory) && noFcImprovement(i.fcHistory)) {
        return ok('FC not holding despite raising the chlorinator 3 days running — test/raise CYA (UV burn-off) or inspect the cell.');
    }

    return { active: false, reason: '' };
}
