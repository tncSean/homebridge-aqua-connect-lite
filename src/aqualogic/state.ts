/**
 * In-memory Pro Logic state model, updated by AquaLogic frame parser.
 *
 * Strategy: we trust the controller's own display text as the source of
 * truth for numeric and mode fields. The display cycles through labeled
 * strings (e.g. "Pool Temp  78F", "Pool Chlorinator  30%") which are
 * easy to parse reliably; the raw LED bitfield requires a precise
 * per-firmware bit→key mapping we can't validate without live toggling.
 * Display text also matches what the user sees on the Pro Logic keypad,
 * so any parsing mistake is visible from the outside.
 *
 * Fields are all optional until the first matching frame arrives.
 */
import { EventEmitter } from 'events';
import { FrameType, isFrameType } from './frame';

export interface PoolState {
    poolTempF?: number;
    airTempF?: number;
    spaTempF?: number;
    /**
     * Heater setpoint — populated only when the Pro Logic display happens to
     * show the "Heater1 SET TO XX" line, which is not part of the normal
     * auto-cycle. On Hayward, "Off" is a literal setpoint value (the PLUS/MINUS
     * cycle is: Off, 65, 66, ..., 104). 'off' here means the user chose that
     * value; undefined means we just haven't seen the menu yet.
     */
    heaterSetpointF?: number | 'off';
    /**
     * Heater mode — derived, not parsed directly.
     *  - 'heating'  when display shows "Heater1 … Heating" (relay actually firing)
     *  - 'off'      when heaterSetpointF === 'off' (setpoint disabled)
     *  - 'auto'     when heaterSetpointF is a number (armed, may or may not fire)
     * Do NOT infer from the "Heater1 Auto Control" status line — that string
     * reflects control mode (always automatic on this firmware) and says
     * nothing about whether the heater is enabled.
     */
    heaterMode?: 'off' | 'auto' | 'heating';
    /** Chlorinator output percent, 0-100. */
    chlorinatorPercent?: number;
    /** True when chlorinator is actively producing (vs. 'Chlorinator Off'). */
    chlorinatorOn?: boolean;
    /** Chlorinator idle reason (e.g. 'Low temperature', 'No Flow'), if any. */
    chlorinatorIdleReason?: string;
    /** Filter pump speed percent reported by the VSP (0 when off). */
    pumpPercent?: number;
    /** Raw pump RPM as reported in PUMP_STATUS frames, if derivable. */
    pumpRpm?: number;
    /** True when the Filter Speed display is active (pump considered running). */
    filterOn?: boolean;
    /** True when the display indicates Super Chlorinate cycle is running. */
    superChlorinateOn?: boolean;
    /** True when the controller is in Service mode. */
    serviceMode?: boolean;
    /** Most recent raw display line, for debugging. */
    lastDisplayText?: string;
    /** Most recent display line that contained "Heater" — for parser debugging. */
    heaterDisplayLine?: string;
}

const STRIP = (s: string) => s.replace(/\s+/g, ' ').trim();

export class PoolStateStore extends EventEmitter {
    private state: PoolState = {};

    get current(): Readonly<PoolState> {
        return this.state;
    }

    /** Entry point — hand a decoded frame payload to the store. */
    ingest(payload: Buffer): void {
        if (isFrameType(payload, FrameType.DISPLAY_UPDATE) ||
            isFrameType(payload, FrameType.LONG_DISPLAY_UPDATE)) {
            this.ingestDisplayPayload(payload);
            return;
        }
        if (isFrameType(payload, FrameType.PUMP_STATUS)) {
            this.ingestPumpStatus(payload);
            return;
        }
        // LEDS, KEEP_ALIVE, PUMP_SPEED_REQUEST: currently unused but not errors.
    }

    private ingestDisplayPayload(payload: Buffer): void {
        // Both DISPLAY_UPDATE and LONG_DISPLAY_UPDATE contain ASCII display
        // text, sometimes prefixed with a short binary preamble. We scan for
        // a long printable-ASCII run (≥ 16 chars) and treat it as the display.
        // The stored text is sanitized of control/escape bytes so any
        // downstream logger does not amplify injected ANSI/newline bytes
        // (anyone on LAN can inject frames into the W610 bus).
        const raw = extractDisplayText(payload.subarray(2));
        if (!raw) return;
        const text = sanitizeForLog(raw);
        this.setField('lastDisplayText', text);
        this.parseDisplayText(text);
    }

    private parseDisplayText(raw: string): void {
        const text = STRIP(raw);

        // Temperatures — "Pool Temp  47F", "Air Temp  82F", "Spa Temp  98F".
        const tempRe = /(Pool|Air|Spa)\s+Temp\s+(\d+)\s*(?:°|_|\xdf)?F/i;
        const tempM = text.match(tempRe);
        if (tempM) {
            const f = parseInt(tempM[2], 10);
            if (Number.isFinite(f) && f > 0 && f < 130) {
                const which = tempM[1].toLowerCase();
                if (which === 'pool') this.setField('poolTempF', f);
                else if (which === 'air') this.setField('airTempF', f);
                else if (which === 'spa') this.setField('spaTempF', f);
            }
        }

        // Heater setpoint — "Heater1 SET TO 84F" (number) or "Heater1 SET TO Off".
        // "Off" is a literal Hayward setpoint value, not a mode.
        const setptOffM = text.match(/Heater\s*1?[^\n]*SET\s*TO\s*Off\b/i);
        if (setptOffM) {
            this.setField('heaterSetpointF', 'off');
        } else {
            const setptNumM = text.match(/SET\s*TO\s*(\d+)\s*(?:°|_|\xdf)?F/i);
            if (setptNumM) {
                const f = parseInt(setptNumM[1], 10);
                if (Number.isFinite(f) && f >= 50 && f <= 110) {
                    this.setField('heaterSetpointF', f);
                }
            }
        }

        // Heater state from the auto-cycle status line. On Hayward, when the
        // controller reaches the "Heater1" slot in its cycle it prints one of
        //   "Heater1          Off"            → setpoint is the literal Off
        //   "Heater1          Auto Control"   → enabled, some numeric setpoint
        //   "Heater1          Heating"        → enabled and relay is firing
        // We act only on the Heater1-labeled line so we never match "Off" or
        // "Heating" words in unrelated cycle text. The raw matched line is
        // emitted to the change event as `heaterDisplayLine` so we can debug
        // firmware variance — if the panel says "Off" but the plugin says
        // "auto", the raw line tells us exactly what bytes the bus delivered.
        if (/Heater\s*1?\b/i.test(text)) {
            this.setField('heaterDisplayLine', text);
            if (/\bHeating\b/i.test(text)) {
                this.setField('heaterMode', 'heating');
            } else if (/\bAuto\s+Control\b/i.test(text)) {
                if (this.state.heaterSetpointF === 'off') {
                    this.setField('heaterSetpointF', undefined);
                }
                this.setField('heaterMode', 'auto');
            } else if (/\bOff\b/i.test(text)) {
                this.setField('heaterSetpointF', 'off');
                this.setField('heaterMode', 'off');
            }
        }

        // Chlorinator — "Pool Chlorinator 30%" or "Chlorinator Off  Low temperature".
        if (/Chlorinator/i.test(text)) {
            const pctM = text.match(/Chlorinator\s+(\d+)\s*%/i);
            if (pctM) {
                const pct = parseInt(pctM[1], 10);
                if (pct >= 0 && pct <= 100) {
                    this.setField('chlorinatorPercent', pct);
                    this.setField('chlorinatorOn', pct > 0);
                    this.setField('chlorinatorIdleReason', undefined);
                }
            } else if (/Chlorinator\s+Off/i.test(text)) {
                this.setField('chlorinatorOn', false);
                // Grab the trailing reason if present.
                const reason = text.replace(/.*Chlorinator\s+Off/i, '').trim();
                this.setField('chlorinatorIdleReason', reason || undefined);
            }
            if (/Super\s*Chlorinate/i.test(text)) {
                this.setField('superChlorinateOn', true);
            }
        }

        // Filter speed — "Filter Speed  90%  Speed4".
        const filterM = text.match(/Filter\s+Speed\s+(\d+)\s*%/i);
        if (filterM) {
            const pct = parseInt(filterM[1], 10);
            if (pct >= 0 && pct <= 100) {
                this.setField('pumpPercent', pct);
                this.setField('filterOn', pct > 0);
            }
        } else if (/Filter\s+Off/i.test(text)) {
            this.setField('filterOn', false);
            this.setField('pumpPercent', 0);
        }

        // Service mode — "Service Mode" banner.
        if (/Service\s+Mode/i.test(text)) this.setField('serviceMode', true);
        else if (/Auto\s+Control|Pool\s+Temp|Filter\s+Speed/i.test(text)) {
            // Any of the normal auto-cycle displays means we're not in service.
            this.setField('serviceMode', false);
        }
    }

    private ingestPumpStatus(payload: Buffer): void {
        // Observed payload: 00 0c 00 00 5a 10 64 — `5a` correlates with the
        // "90%" displayed by the controller. We treat byte index 4 (after the
        // 2-byte type prefix) as speed%; remaining bytes vary by firmware.
        // pumpPercent from the display text is the canonical source; this
        // just backfills RPM when the display text is showing a non-filter
        // screen.
        if (payload.length >= 5) {
            const pct = payload[4];
            if (pct >= 0 && pct <= 100 && this.state.pumpPercent === undefined) {
                this.setField('pumpPercent', pct);
            }
        }
        if (payload.length >= 7) {
            // Tentative RPM — 16-bit BE of last two bytes. Left as a best-effort
            // informational field; not used for accessory characteristic values.
            const rpm = (payload[5] << 8) | payload[6];
            if (rpm > 0 && rpm < 5000) this.setField('pumpRpm', rpm);
        }
    }

    private setField<K extends keyof PoolState>(key: K, value: PoolState[K]): void {
        if (this.state[key] === value) return;
        this.state = { ...this.state, [key]: value };
        this.emit('change', key, value, this.state);
    }
}

/**
 * Strip control characters and escape sequences from text before it is
 * logged or passed to any observer. Display bytes come from the RS-485
 * bus which is unauthenticated on-LAN — a rogue device can inject frames
 * with embedded newlines or ANSI color codes that would otherwise pollute
 * Homebridge log output.
 */
export function sanitizeForLog(s: string): string {
    return s.replace(/[\x00-\x1f\x7f\x1b]/g, '?');
}

/**
 * Extract the longest printable-ASCII run from a binary display payload.
 * The Pro Logic sometimes prefixes its display frames with a few status
 * bytes (e.g. 0x83 0x00 0x02) before the 40-character text region.
 */
export function extractDisplayText(buf: Buffer): string | null {
    let bestStart = -1;
    let bestLen = 0;
    let curStart = -1;
    let curLen = 0;
    for (let i = 0; i < buf.length; i++) {
        const b = buf[i];
        const printable = (b >= 0x20 && b <= 0x7e) || b === 0xdf || b === 0xba;
        if (printable) {
            if (curStart < 0) curStart = i;
            curLen++;
        } else {
            if (curLen > bestLen) { bestLen = curLen; bestStart = curStart; }
            curStart = -1;
            curLen = 0;
        }
    }
    if (curLen > bestLen) { bestLen = curLen; bestStart = curStart; }
    if (bestLen < 16 || bestStart < 0) return null;
    return buf.toString('latin1', bestStart, bestStart + bestLen);
}
