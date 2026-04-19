/**
 * Persistent TCP client to the USR-W610 RS-485 bridge.
 *
 * The W610 presents a raw passthrough socket on port 8899 that carries
 * 19200 8N2 bus traffic verbatim. We connect once, push received bytes
 * into a FrameExtractor, and hand each decoded frame payload to a
 * PoolStateStore. Writes (key emulation) are sent as encoded frames on
 * the same socket — the Pro Logic treats them as wireless-keypad events.
 *
 * Reconnect policy mirrors util.ts: exponential backoff capped at 10s.
 */
import { EventEmitter } from 'events';
import * as net from 'net';
import { encodeFrame, FrameExtractor, FrameType, isFrameType } from './frame';
import { Key, KeyValue } from './keys';
import { PoolStateStore } from './state';

export interface AquaLogicClientOptions {
    host: string;
    port: number;
    /** Optional logger — supply the Homebridge log; falls back to console. */
    log?: { debug: (m: string) => void; info: (m: string) => void; warn: (m: string) => void; error: (m: string) => void };
}

export class AquaLogicClient extends EventEmitter {
    public readonly state = new PoolStateStore();

    private socket: net.Socket | null = null;
    private extractor = new FrameExtractor();
    private reconnectDelay = 500;
    private readonly maxReconnectDelay = 10_000;
    private connected = false;
    private stopping = false;
    private reconnectTimer: NodeJS.Timeout | null = null;

    private readonly log: NonNullable<AquaLogicClientOptions['log']>;

    constructor(private readonly opts: AquaLogicClientOptions) {
        super();
        this.log = opts.log ?? {
            debug: m => console.debug(`[aqualogic] ${m}`),
            info: m => console.log(`[aqualogic] ${m}`),
            warn: m => console.warn(`[aqualogic] ${m}`),
            error: m => console.error(`[aqualogic] ${m}`),
        };
        this.extractor.on('frame', (payload: Buffer) => {
            try {
                this.state.ingest(payload);
            } catch (e) {
                this.log.warn(`state ingest failed: ${(e as Error).message}`);
            }
            // RS-485 collision avoidance: the Pro Logic only listens for
            // wireless-key frames in the quiet window right after sending
            // a KEEP_ALIVE. Writing at any other moment collides with the
            // panel's own transmission and the frame is silently dropped.
            if (isFrameType(payload, FrameType.KEEP_ALIVE)) {
                this.flushOnePending();
            }
        });
        this.state.on('change', (key, value) => {
            // Display text churns with every cycle — keep that at debug. All
            // other fields change rarely (only on real pool events), so surface
            // them at info so the user can watch the parser learn state
            // without enabling debug.
            if (key === 'lastDisplayText') {
                this.log.debug(`display: ${value}`);
            } else {
                this.log.info(`state: ${String(key)} = ${JSON.stringify(value)}`);
            }
            this.emit('state-change', key, value, this.state.current);
        });
    }

    start(): void {
        if (this.socket || this.stopping) return;
        this.connect();
    }

    stop(): void {
        this.stopping = true;
        if (this.reconnectTimer) { clearTimeout(this.reconnectTimer); this.reconnectTimer = null; }
        if (this.socket) {
            this.socket.removeAllListeners();
            this.socket.destroy();
            this.socket = null;
        }
        this.connected = false;
    }

    isConnected(): boolean {
        return this.connected;
    }

    /**
     * Send a keypress event. Queues the frame and flushes on the next
     * incoming KEEP_ALIVE. Rejects if no slot opens within SEND_TIMEOUT_MS.
     */
    private static readonly SEND_TIMEOUT_MS = 5000;
    private pending: Array<{ wire: Buffer; resolve: () => void; reject: (e: Error) => void; timer: NodeJS.Timeout }> = [];

    sendKey(key: KeyValue): Promise<void> {
        return this.queueWire(this.buildKeyPayload(key), 'sendKey');
    }

    /**
     * Send a *wired* keypad event using a HOLD-PATTERN simulating a held button.
     *
     * Empirical testing 2026-04-18 showed:
     *   - Single press+release pair: ~5% reach panel (bus collision rate)
     *   - 5 press frames at 100-150ms + 1 release: ~30% reach panel
     *   - The panel sees multiple press frames as "key still held" and
     *     registers ONE keypress event on first transition, release = end.
     *     No overshoot from hold-pattern because panel only detects edges.
     *
     * Structure:
     *   1. First press frame: queued on KEEP_ALIVE (waits for quiet bus window)
     *   2. Next 4 press frames: written immediately at 150ms intervals
     *      (simulating a physical keypad that emits ~100ms repeat frames while held)
     *   3. Release frame: queued on next KEEP_ALIVE for clean delivery
     *
     * Key values are masked to 16 bits — the wired bus format only carries
     * the low 16 bits of the 32-bit Key table. Keys that set bits above
     * 0xFFFF (e.g. HEATER_1 = 0x40000) have no wired representation — the
     * Pro Logic's wired keypad has no dedicated heater button; heater is
     * menu-driven (MENU → RIGHT → PLUS → setpoint adjust).
     */
    private static readonly HOLD_FRAMES = 5;
    private static readonly HOLD_SPACING_MS = 150;
    private static readonly RELEASE_DELAY_MS = 80;

    /**
     * Send a SINGLE wired-key press+release. Both press and release are
     * KEEP_ALIVE-gated for reliability. Use for setpoint stepping (PLUS/MINUS)
     * where the caller polls the display for confirmation and fires the next
     * press immediately on response — avoids panel auto-repeat from holding.
     *
     * Single-press has lower per-call reliability (~15-30%) than the hold-
     * pattern but it's deterministic: one successful press = one advance,
     * never multiple. Caller should retry.
     */
    async sendWiredKeyOnce(key: KeyValue): Promise<void> {
        const key16 = key & 0xffff;
        if (key16 === 0) {
            throw new Error(`key 0x${key.toString(16)} has no wired-bus representation`);
        }
        const pressPayload = this.buildWiredKeyPayload(key16, key16);
        const releasePayload = this.buildWiredKeyPayload(key16, 0);
        await this.queueWire(pressPayload, 'wired press once (gated)');
        await sleep(AquaLogicClient.RELEASE_DELAY_MS);
        if (!this.socket || !this.connected) {
            throw new Error('disconnected between single press and release');
        }
        await this.queueWire(releasePayload, 'wired release once (gated)');
    }

    async sendWiredKey(key: KeyValue): Promise<void> {
        const key16 = key & 0xffff;
        if (key16 === 0) {
            throw new Error(`key 0x${key.toString(16)} has no wired-bus representation`);
        }
        const pressPayload = this.buildWiredKeyPayload(key16, key16);
        const releasePayload = this.buildWiredKeyPayload(key16, 0);

        // First press frame is gated on KEEP_ALIVE for clean bus entry.
        await this.queueWire(pressPayload, 'wired press (1/5, gated)');

        // Subsequent press frames simulate "key still held".
        const pressWire = encodeFrame(pressPayload);
        for (let i = 1; i < AquaLogicClient.HOLD_FRAMES; i++) {
            await sleep(AquaLogicClient.HOLD_SPACING_MS);
            if (!this.socket || !this.connected) break;
            this.socket.write(pressWire);
        }

        // Release gated on next KEEP_ALIVE — avoids collision with panel frames.
        await sleep(AquaLogicClient.HOLD_SPACING_MS);
        if (!this.socket || !this.connected) {
            throw new Error('disconnected during hold-pattern');
        }
        await this.queueWire(releasePayload, 'wired release (gated)');
    }

    /**
     * Begin a CONTINUOUS hold — sends the first press (KEEP_ALIVE-gated) then
     * keeps re-emitting "still held" press frames at HOLD_CONT_REFRESH_MS until
     * stopHold() is called. The Pro Logic's physical keypad does the same
     * thing while a button is physically held, triggering the panel's internal
     * key-repeat logic (~500-1000ms initial delay, then fast auto-scroll).
     *
     * Use for large setpoint sweeps where discrete stepping would take
     * minutes. Caller watches state.heaterSetpointF for target and releases.
     *
     * Only one hold active at a time — starting a new one releases the
     * previous. Auto-releases after HOLD_CONT_MAX_MS as a safety cap.
     */
    private static readonly HOLD_CONT_REFRESH_MS = 100;
    private static readonly HOLD_CONT_MAX_MS = 30_000;
    private activeHold: {
        key16: number;
        pressWire: Buffer;
        timer: NodeJS.Timeout;
        deadline: number;
    } | null = null;

    async startHold(key: KeyValue): Promise<void> {
        const key16 = key & 0xffff;
        if (key16 === 0) {
            throw new Error(`key 0x${key.toString(16)} has no wired-bus representation`);
        }
        if (this.activeHold) {
            await this.stopHold();
        }
        const pressPayload = this.buildWiredKeyPayload(key16, key16);
        const pressWire = encodeFrame(pressPayload);

        // Gated first press for clean bus entry.
        await this.queueWire(pressPayload, 'wired hold-start (gated)');

        // Start refresh timer — fires immediately via setInterval's first tick.
        const deadline = Date.now() + AquaLogicClient.HOLD_CONT_MAX_MS;
        const timer = setInterval(() => {
            if (!this.socket || !this.connected) return;
            if (Date.now() > deadline) {
                this.log.warn('hold safety cap reached, auto-releasing');
                void this.stopHold();
                return;
            }
            this.socket.write(pressWire);
        }, AquaLogicClient.HOLD_CONT_REFRESH_MS);
        // Don't keep the event loop alive just for the hold refresh.
        timer.unref?.();
        this.activeHold = { key16, pressWire, timer, deadline };
        this.log.info(`hold started key=0x${key16.toString(16)}`);
    }

    async stopHold(): Promise<void> {
        const h = this.activeHold;
        if (!h) return;
        this.activeHold = null;
        clearInterval(h.timer);
        const releasePayload = this.buildWiredKeyPayload(h.key16, 0);
        try {
            await this.queueWire(releasePayload, 'wired hold-release (gated)');
            this.log.info(`hold released key=0x${h.key16.toString(16)}`);
        } catch (e) {
            this.log.warn(`hold release failed: ${(e as Error).message}`);
            throw e;
        }
    }

    isHolding(): boolean {
        return this.activeHold !== null;
    }

    private queueWire(payload: Buffer, label: string): Promise<void> {
        return new Promise((resolve, reject) => {
            if (!this.socket || !this.connected) {
                return reject(new Error('AquaLogic client not connected'));
            }
            const wire = encodeFrame(payload);
            const entry = { wire, resolve, reject } as Partial<typeof this.pending[number]> as typeof this.pending[number];
            entry.timer = setTimeout(() => {
                const idx = this.pending.indexOf(entry);
                if (idx >= 0) this.pending.splice(idx, 1);
                reject(new Error(`${label} timed out waiting for bus slot (no KEEP_ALIVE within 5s)`));
            }, AquaLogicClient.SEND_TIMEOUT_MS);
            this.pending.push(entry);
            this.log.debug(`${label} queued (${this.pending.length} pending)`);
        });
    }

    private flushOnePending(): void {
        const entry = this.pending.shift();
        if (!entry) return;
        clearTimeout(entry.timer);
        if (!this.socket || !this.connected) {
            entry.reject(new Error('disconnected before send'));
            return;
        }
        this.socket.write(entry.wire, err => {
            if (err) entry.reject(err);
            else {
                this.log.debug(`wire flushed on KEEP_ALIVE (${this.pending.length} still pending)`);
                entry.resolve();
            }
        });
    }

    /**
     * Send the same key N times with an inter-key delay. Used by setpoint
     * writes that need to emulate repeated PLUS/MINUS presses.
     *
     * Count is capped at MAX_STEPS so a pathological callsite (e.g. bump
     * from unknown-0 to target-100) cannot spray 100 consecutive keypresses
     * at the controller — worst realistic adjustment is ~40 units (65-104°F
     * thermostat range, 0-100% chlorinator steps bounded by menu behavior).
     */
    static readonly MAX_STEPS = 40;
    async sendKeyRepeated(key: KeyValue, count: number, intervalMs = 150): Promise<void> {
        const safe = Math.min(Math.max(0, Math.floor(count)), AquaLogicClient.MAX_STEPS);
        if (safe !== count) {
            this.log.warn(`sendKeyRepeated clamped ${count} → ${safe} presses`);
        }
        for (let i = 0; i < safe; i++) {
            await this.sendKey(key);
            if (i < safe - 1) await sleep(intervalMs);
        }
    }

    /**
     * Navigate the Pro Logic to the given menu context by sending MENU, then
     * adjust by pressing PLUS or MINUS the required number of times. Relies
     * on the display auto-exit timer; does not attempt readback verification
     * (the display parser will catch up on the next DISPLAY_UPDATE).
     *
     * @param current   current reading (°F for heater, % for chlorinator)
     * @param target    desired reading
     * @param stepKeyHi the key to press to increase (usually PLUS)
     * @param stepKeyLo the key to press to decrease (usually MINUS)
     */
    async bump(current: number, target: number, stepKeyHi: KeyValue = Key.PLUS, stepKeyLo: KeyValue = Key.MINUS): Promise<void> {
        const delta = Math.round(target - current);
        if (delta === 0) return;
        const key = delta > 0 ? stepKeyHi : stepKeyLo;
        await this.sendKeyRepeated(key, Math.abs(delta));
    }

    // --- connection management ------------------------------------------------

    private connect(): void {
        const { host, port } = this.opts;
        this.log.info(`connecting to ${host}:${port}...`);
        const sock = net.createConnection({ host, port });
        this.socket = sock;

        sock.on('connect', () => {
            this.connected = true;
            this.reconnectDelay = 500;
            this.log.info(`connected to ${host}:${port}`);
            this.emit('connected');
        });

        sock.on('data', (chunk: Buffer) => {
            try {
                this.extractor.push(chunk);
            } catch (e) {
                this.log.warn(`extractor push failed: ${(e as Error).message}`);
            }
        });

        sock.on('error', err => {
            this.log.warn(`socket error: ${err.message}`);
        });

        sock.on('close', () => {
            this.connected = false;
            this.socket = null;
            // Kill any active hold — can't refresh over a dead socket, and a
            // stale timer would fire after reconnect and pretend keys are held.
            if (this.activeHold) {
                clearInterval(this.activeHold.timer);
                this.activeHold = null;
            }
            // Reject any in-flight key presses — they can't land without a bus.
            while (this.pending.length) {
                const entry = this.pending.shift()!;
                clearTimeout(entry.timer);
                entry.reject(new Error('socket closed before send'));
            }
            this.emit('disconnected');
            if (this.stopping) return;
            const delay = Math.min(this.reconnectDelay, this.maxReconnectDelay);
            this.log.warn(`disconnected — reconnecting in ${delay}ms`);
            this.reconnectTimer = setTimeout(() => { this.reconnectTimer = null; this.connect(); }, delay);
            this.reconnectDelay = Math.min(this.reconnectDelay * 2, this.maxReconnectDelay);
        });
    }

    /**
     * Construct a wireless key event payload.
     *
     * Format (from swilson/aqualogic): FRAME_TYPE_WIRELESS_KEY_EVENT (2 bytes)
     *   + 0x01 (unknown prefix byte, always 1)
     *   + key as 4-byte little-endian (sent twice for redundancy)
     *   + 0x00 trailer.
     *
     * Retained for a future wireless-remote integration. The Pro Logic's
     * wired remote-display port (the W610) ignores these frames — the
     * wired bus only accepts LOCAL_WIRED_KEY_EVENT frames.
     */
    private buildKeyPayload(key: KeyValue): Buffer {
        const type = FrameType.WIRELESS_KEY_EVENT;
        const keyLE = Buffer.alloc(4);
        keyLE.writeUInt32LE(key >>> 0, 0);
        return Buffer.concat([type, Buffer.from([0x01]), keyLE, keyLE, Buffer.from([0x00])]);
    }

    /**
     * Construct a wired key event payload: FRAME_TYPE_LOCAL_WIRED_KEY_EVENT
     *   + key[2 LE] (key that is currently down, 0 = none)
     *   + held[2 LE] (bitmask of keys being held; same as key on press,
     *                 0 on release).
     *
     * Observed from real panel traffic on 2026-04-18 — see HEATER-ANALYSIS.md.
     */
    private buildWiredKeyPayload(key16: number, held16: number): Buffer {
        const type = FrameType.LOCAL_WIRED_KEY_EVENT;
        const buf = Buffer.alloc(4);
        buf.writeUInt16LE(key16 & 0xffff, 0);
        buf.writeUInt16LE(held16 & 0xffff, 2);
        return Buffer.concat([type, buf]);
    }
}

function sleep(ms: number): Promise<void> {
    return new Promise(r => setTimeout(r, ms));
}
