/**
 * PURE next-best-action advisor. No I/O.
 *
 * Surfaces the single highest-priority FOUNDATIONAL chemistry action — work the
 * auto-tuner cannot do for you (today: add salt). When a foundational action is
 * pending it OWNS the Pool Alert tile and HOLDS the chlorinator auto-tune
 * (driving % is pointless while the cell is under-salted), so the tile names the
 * actual next move instead of letting the controller chase a setpoint it can't
 * reach. Extensible: salt is the only rung today; add higher rungs by extending
 * `nextBestAction` (priority-ordered, first match wins).
 *
 * Salt level is NOT available from RS-485 or WaterGuru, so current/target salt
 * and pool volume are manual config values Sean updates by hand.
 */
export interface NextActionInput {
    saltCurrentPpm?: number;
    saltTargetPpm?: number;
    saltDeadbandPpm?: number;   // don't nag within this margin of target
    poolGallons?: number;
}

export interface NextAction {
    kind: 'salt' | 'none';
    active: boolean;        // true => a foundational action is pending
    blocksDrive: boolean;   // true => hold the chlorinator tuner this run
    message: string;        // e.g. "Add 130 lbs salt"  ('' when kind==='none')
    tileName: string;       // e.g. "Pool: Add 130 lbs salt" (Pool Alert default when none)
}

const POOL_ALERT_DEFAULT_TILE = 'Pool Alert';

/** Salt dose (lbs) to raise current->target for the given volume. Pure. */
export function saltDoseLbs(currentPpm: number, targetPpm: number, gallons: number): number {
    if (targetPpm <= currentPpm) return 0;
    const lbs = (targetPpm - currentPpm) * gallons / 120000;
    return Math.round(lbs / 5) * 5;
}

/** Single highest-priority foundational action. Extensible (salt is the only rung today). */
export function nextBestAction(input: NextActionInput): NextAction {
    const none: NextAction = {
        kind: 'none', active: false, blocksDrive: false, message: '', tileName: POOL_ALERT_DEFAULT_TILE,
    };

    const { saltCurrentPpm, saltTargetPpm, poolGallons } = input;
    const deadband = input.saltDeadbandPpm ?? 0;

    // 1) Salt — foundational: an under-salted cell can't generate, so adding salt
    //    must precede any % auto-tuning.
    if (
        typeof saltCurrentPpm === 'number' &&
        typeof saltTargetPpm === 'number' &&
        typeof poolGallons === 'number' &&
        saltCurrentPpm < (saltTargetPpm - deadband)
    ) {
        const lbs = saltDoseLbs(saltCurrentPpm, saltTargetPpm, poolGallons);
        if (lbs > 0) {
            const message = `Add ${lbs} lbs salt`;
            return { kind: 'salt', active: true, blocksDrive: true, message, tileName: `Pool: ${message}` };
        }
    }

    return none;
}
