/**
 * PURE chemistry-notification composer. No I/O. Builds ONE push per run from
 * the day's foundational action + any out-of-range parameters, so we never
 * spam (the controller sends a single deduped 'chem' notification). Unit-tested
 * by notifysummary.test.ts.
 */
import { Band, inRange } from './compliance';

export interface OutOfRangeParam {
    name: string;
    value: number;
    unit: string;
    band: Band;
    /** Optional actionable dose, e.g. "add ~6.5 lbs stabilizer" — appended as "→ ...". */
    advice?: string;
}

export interface ChemNotificationInput {
    nbaActive: boolean;
    nbaMessage: string;
    outOfRange: OutOfRangeParam[];
}

export interface ChemNotification {
    title: string;
    body: string;
}

/**
 * "Salt 2900 ppm low (target 3000–3600)" — value, unit, direction, target band.
 * With advice: "CYA 14 ppm low (target 30–100) → add ~6.5 lbs stabilizer".
 */
function describe(p: OutOfRangeParam): string {
    const direction = p.value < p.band.min ? 'low' : 'high';
    const base = `${p.name} ${p.value} ${p.unit} ${direction} (target ${p.band.min}–${p.band.max})`;
    return p.advice ? `${base} → ${p.advice}` : base;
}

/** Concise "; "-joined list of out-of-range params. */
function listOutOfRange(params: OutOfRangeParam[]): string {
    return params.map(describe).join('; ');
}

/**
 * Compose the single per-run push, or null when nothing needs attention.
 *
 *   nbaActive            → "Pool needs attention": nbaMessage first, then
 *                          "; also " + the OTHER out-of-range params.
 *   else outOfRange != []→ "Pool chemistry alert": the out-of-range list.
 *   else                 → null (all good, no push).
 */
export function buildChemNotification(input: ChemNotificationInput): ChemNotification | null {
    if (input.nbaActive) {
        let body = input.nbaMessage;
        if (input.outOfRange.length > 0) {
            body += `; also ${listOutOfRange(input.outOfRange)}`;
        }
        return { title: 'Pool needs attention', body };
    }
    if (input.outOfRange.length > 0) {
        return { title: 'Pool chemistry alert', body: listOutOfRange(input.outOfRange) };
    }
    return null;
}

/** Helper: a param is out of range when its value is defined and not in band. */
export function isOutOfRange(value: number | undefined, band: Band | undefined): boolean {
    return value !== undefined && band !== undefined && !inRange(value, band);
}
