/**
 * PURE chemistry-compliance classifier. No I/O, no homebridge imports —
 * unit-tested by compliance.test.ts.
 *
 * Maps a measured chemistry value against a configurable green band onto a
 * HomeKit AirQuality level so each parameter tile shows a color-coded
 * compliance state at a glance. The exact value/instruction is delivered via
 * the controller log + the optional ntfy push, not the tile.
 */
export type ComplianceLevel = 0 | 1 | 3 | 5; // HomeKit AirQuality: 0 Unknown, 1 Excellent, 3 Fair, 5 Poor

export interface Band {
    min: number;
    max: number;
}

/** True when min <= value <= max (inclusive). */
export function inRange(value: number, band: Band): boolean {
    return value >= band.min && value <= band.max;
}

/**
 * value in band -> 1 (Excellent); outside the band by <= 25% of the band
 * width -> 3 (Fair); further outside -> 5 (Poor). Undefined value/band -> 0
 * (Unknown). A zero-width band never divides by zero (any out-of-band value
 * is Poor).
 */
export function complianceLevel(value: number | undefined, band: Band | undefined): ComplianceLevel {
    if (value === undefined || band === undefined) return 0;
    if (inRange(value, band)) return 1;
    // Deviation = distance outside the band (always > 0 here, since not in range).
    const deviation = value < band.min ? band.min - value : value - band.max;
    const width = band.max - band.min;
    // Zero-width band: any out-of-band value is Poor (no proportional Fair zone).
    if (width <= 0) return 5;
    return deviation <= 0.25 * width ? 3 : 5;
}
