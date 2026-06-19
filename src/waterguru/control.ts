/**
 * PURE bounded-proportional control step for the chlorine auto-tuner.
 * No I/O, no homebridge imports — unit-tested by control.test.ts.
 *
 * Spec: target = midpoint(WG recommended FC range); deadband when FC is
 * inside the range; otherwise step = clamp(round(gain*error), ±maxStep);
 * new% = clamp(current% + step, minPct, maxPct). One adjustment/day.
 */
export interface ControlParams {
    minPct: number;
    maxPct: number;
    maxStep: number;
    gain: number;
}

function clamp(n: number, lo: number, hi: number): number {
    return n < lo ? lo : n > hi ? hi : n;
}

/**
 * Compute the next chlorinator percent.
 * @param currentPct      current chlorinator output % (0-100)
 * @param fc              measured free chlorine (ppm)
 * @param recommendedRange WG "ok" band [low, high] (ppm)
 * @param p               bounds + gain
 * @returns integer target % in [minPct, maxPct]
 */
export function computeTargetPct(
    currentPct: number,
    fc: number,
    recommendedRange: [number, number],
    p: ControlParams,
): number {
    const [low, high] = recommendedRange;
    // Deadband: inside the WG ok band (inclusive) → no change.
    if (fc >= low && fc <= high) {
        return clamp(Math.round(currentPct), p.minPct, p.maxPct);
    }
    const target = (low + high) / 2;
    const error = target - fc;
    const step = clamp(Math.round(p.gain * error), -p.maxStep, p.maxStep);
    return clamp(Math.round(currentPct) + step, p.minPct, p.maxPct);
}
