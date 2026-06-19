/**
 * PURE daily accumulator: how long the salt cell actually GENERATED vs sat
 * in a flow-blocked idle ("No Flow"). Fed from RS-485 state changes
 * (chlorinatorOn / chlorinatorIdleReason). No timers, no I/O — the caller
 * supplies `nowMs` so it is fully deterministic and unit-testable.
 *
 * State machine over three buckets:
 *   GENERATING : chlorinatorOn === true
 *   NOFLOW     : chlorinatorOn === false AND idleReason matches /no\s*flow/i
 *   NEITHER    : everything else (off for temp/CYA/menu, unknown) — ignored
 */
type Phase = 'generating' | 'noflow' | 'neither';

export interface GenInput {
    chlorinatorOn?: boolean;
    chlorinatorIdleReason?: string;
}

export interface GenSnapshot {
    generatingSec: number;
    noFlowSec: number;
    /** noFlowSec / (generatingSec + noFlowSec); 0 when both are 0. */
    noFlowFraction: number;
}

function phaseOf(s: GenInput): Phase {
    if (s.chlorinatorOn === true) return 'generating';
    if (s.chlorinatorOn === false && /no\s*flow/i.test(s.chlorinatorIdleReason ?? '')) {
        return 'noflow';
    }
    return 'neither';
}

export class GenerationTracker {
    private genMs = 0;
    private noFlowMs = 0;
    private phase: Phase = 'neither';
    private since: number | null = null;

    /** Apply a new observed state at time `nowMs`, banking elapsed time first. */
    update(s: GenInput, nowMs: number): void {
        this.bank(nowMs);
        this.phase = phaseOf(s);
        this.since = nowMs;
    }

    /** Read accumulators as of `nowMs` (banks in-progress time non-destructively). */
    snapshot(nowMs: number): GenSnapshot {
        let gen = this.genMs;
        let nf = this.noFlowMs;
        if (this.since !== null && nowMs > this.since) {
            const d = nowMs - this.since;
            if (this.phase === 'generating') gen += d;
            else if (this.phase === 'noflow') nf += d;
        }
        const total = gen + nf;
        return {
            generatingSec: Math.round(gen / 1000),
            noFlowSec: Math.round(nf / 1000),
            noFlowFraction: total > 0 ? nf / total : 0,
        };
    }

    /** Zero the day's accumulators and re-anchor the current phase at `nowMs`. */
    reset(nowMs: number): void {
        this.genMs = 0;
        this.noFlowMs = 0;
        this.since = nowMs;
    }

    private bank(nowMs: number): void {
        if (this.since !== null && nowMs > this.since) {
            const d = nowMs - this.since;
            if (this.phase === 'generating') this.genMs += d;
            else if (this.phase === 'noflow') this.noFlowMs += d;
        }
    }
}
