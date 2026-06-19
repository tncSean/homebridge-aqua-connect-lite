/**
 * ntfy push with dedupe + rate-limit. The PURE decision logic (shouldNotify /
 * recordNotify) is unit-tested by notifier.test.ts; the Notifier class wraps it
 * with the network POST and is injected with nowFn/fetchFn for testability.
 *
 * Issues NO equipment writes/commands — it only sends an outbound ntfy push.
 */
import { WgLogger } from './client';

export interface NotifyState {
    [key: string]: { body: string; sentMs: number };
}

/**
 * Time-window policy: notify when there is no prior send for the key, OR enough
 * time has elapsed since the last send — REGARDLESS of whether the body changed.
 * With a ~20h interval and a once-per-day (morning) caller, this re-reminds each
 * morning while work is still pending, but never twice in the same day. The
 * `body` is unused for the decision (kept in the signature for the recorded
 * state and call-site symmetry).
 *
 *   - no prior entry for key            → true
 *   - now - prior.sentMs >= interval    → true  (next morning)
 *   - now - prior.sentMs <  interval    → false (already reminded today)
 */
export function shouldNotify(
    state: NotifyState, key: string, _body: string, nowMs: number, minIntervalMs: number,
): boolean {
    const prior = state[key];
    if (!prior) return true;
    return nowMs - prior.sentMs >= minIntervalMs;
}

/** Return a NEW state with the key's last-sent body/time updated. Pure. */
export function recordNotify(state: NotifyState, key: string, body: string, nowMs: number): NotifyState {
    return { ...state, [key]: { body, sentMs: nowMs } };
}

export interface NotifierConfig {
    ntfyServer: string;
    ntfyTopic?: string;
}

/**
 * Re-notify a key at most once per ~20h. With the daily 8am caller this means
 * one reminder per morning while work is pending — the gap is short enough that
 * a slightly-early run never double-fires, long enough to span a day.
 */
const MIN_INTERVAL_MS = 20 * 60 * 60 * 1000;

export class Notifier {
    private state: NotifyState = {};
    constructor(
        private readonly cfg: NotifierConfig,
        private readonly log: WgLogger,
        private readonly nowFn: () => number,
        private readonly fetchFn: typeof fetch = fetch,
    ) {}

    /**
     * Send an ntfy push if not deduped/rate-limited/disabled. Returns true only
     * when a push was actually delivered. Network errors are logged and return
     * false — a notify failure never propagates.
     */
    async maybeNotify(key: string, title: string, body: string): Promise<boolean> {
        if (!this.cfg.ntfyTopic) return false; // disabled (no topic configured)
        const now = this.nowFn();
        if (!shouldNotify(this.state, key, body, now, MIN_INTERVAL_MS)) return false;
        try {
            const res = await this.fetchFn(`${this.cfg.ntfyServer}/${this.cfg.ntfyTopic}`, {
                method: 'POST',
                body,
                headers: { Title: title, Priority: 'default', Tags: 'droplet' },
            });
            if (!res.ok) {
                this.log.warn(`ntfy push failed: HTTP ${res.status}`);
                return false;
            }
            this.state = recordNotify(this.state, key, body, now);
            this.log.debug(`ntfy push sent (${key}): ${title} — ${body}`);
            return true;
        } catch (e) {
            this.log.warn(`ntfy push error: ${(e as Error).message}`);
            return false;
        }
    }
}
