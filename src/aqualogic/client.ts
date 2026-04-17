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
import { encodeFrame, FrameExtractor, FrameType } from './frame';
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

    /** Send a keypress event. Returns after the bytes are written. */
    sendKey(key: KeyValue): Promise<void> {
        return new Promise((resolve, reject) => {
            if (!this.socket || !this.connected) {
                return reject(new Error('AquaLogic client not connected'));
            }
            const payload = this.buildKeyPayload(key);
            const wire = encodeFrame(payload);
            this.socket.write(wire, err => err ? reject(err) : resolve());
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
     */
    private buildKeyPayload(key: KeyValue): Buffer {
        const type = FrameType.WIRELESS_KEY_EVENT;
        const keyLE = Buffer.alloc(4);
        keyLE.writeUInt32LE(key >>> 0, 0);
        return Buffer.concat([type, Buffer.from([0x01]), keyLE, keyLE, Buffer.from([0x00])]);
    }
}

function sleep(ms: number): Promise<void> {
    return new Promise(r => setTimeout(r, ms));
}
