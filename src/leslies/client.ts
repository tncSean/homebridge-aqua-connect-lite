/**
 * Leslie's Pool Supplies water-test access. Mirrors the WaterGuru client
 * structure: a PURE parser (`parseHistory`, no network, unit-tested) plus a
 * thin networked `LesliesClient` (login → fetch → parse).
 *
 * Two-host mobile-app API (community reference: connorgallopo/leslies-pool,
 * a Home Assistant integration; the app Basic-auth secrets below are public,
 * baked into Leslie's official mobile app — they identify the APP, not the
 * owner). The OWNER's email/password come from config and are NEVER logged.
 *
 *   Layer 1 (OCAPI, once): POST {OCAPI}/customers/auth → JWT (Authorization
 *     response header) + customer_id (body); then GET {OCAPI}/customers/{id}
 *     → c_relateCustomerID (the durable identity key).
 *   Layer 2 (Boomi, every fetch): GET the water-test history with the static
 *     app Basic-auth + DDP_email/DDP_ID identity headers.
 *
 * `parseHistory` is PURE and fully unit-tested by client.test.ts.
 */

/** One chemistry parameter's latest reading. */
export interface LesliesParam {
    value: number;
    /** Ideal/target range if the response provides one. */
    range?: [number, number];
    /** Epoch ms of this reading (parsed from the Boomi `yyyyMMdd HHmmss.fff`). */
    testDate?: number;
}

/**
 * Latest-per-parameter water-test reading. Every chemistry field is optional
 * (a param may simply not have been measured). `testDate` is the epoch ms of
 * the most-recent reading across all parameters.
 */
export interface LesliesReading {
    salt?: number;
    cya?: number;
    calcium?: number;
    fc?: number;
    ph?: number;
    ta?: number;
    phosphates?: number;
    copper?: number;
    iron?: number;
    tds?: number;
    bromine?: number;
    totalChlorine?: number;
    /** Ideal/target ranges, when the response carries them, keyed like the values. */
    saltRange?: [number, number];
    cyaRange?: [number, number];
    calciumRange?: [number, number];
    fcRange?: [number, number];
    phRange?: [number, number];
    taRange?: [number, number];
    /** Epoch ms of the most recent reading across all parameters. */
    testDate?: number;
    /** True when the latest reading was an in-store test (vs AccuBlue Home). */
    isStoreTest?: boolean;
}

/**
 * Map of Leslie's `water_test_type` strings → our LesliesReading value field.
 * The API uses "Alkalinity" (= TA) and "Calcium" (= calcium hardness).
 */
const TYPE_TO_FIELD: Record<string, keyof LesliesReading> = {
    'Salt': 'salt',
    'Cyanuric Acid': 'cya',
    'Calcium': 'calcium',
    'Free Chlorine': 'fc',
    'pH': 'ph',
    'Alkalinity': 'ta',
    'Phosphates': 'phosphates',
    'Copper': 'copper',
    'Iron': 'iron',
    'TDS': 'tds',
    'Bromine': 'bromine',
    'Total Chlorine': 'totalChlorine',
};

/** Fields that also carry a parsed ideal range, and the range key they map to. */
const RANGE_KEY: Partial<Record<keyof LesliesReading, keyof LesliesReading>> = {
    salt: 'saltRange',
    cya: 'cyaRange',
    calcium: 'calciumRange',
    fc: 'fcRange',
    ph: 'phRange',
    ta: 'taRange',
};

interface RawTestValue {
    timestamp?: string;
    value?: number | null;
    boolean_test_value?: unknown;
    is_store_test?: boolean;
    results_id?: string;
    /** Some responses carry per-reading ideal bounds; tolerate several shapes. */
    ideal_low?: number | string | null;
    ideal_high?: number | string | null;
    min_ideal?: number | string | null;
    max_ideal?: number | string | null;
}
interface RawTestGroup {
    water_test_type?: string;
    /** Group-level ideal range (some payloads carry it here, not per-reading). */
    ideal_low?: number | string | null;
    ideal_high?: number | string | null;
    min_ideal?: number | string | null;
    max_ideal?: number | string | null;
    water_test_values?: RawTestValue[];
}
interface RawHistory {
    water_test_history?: { water_tests?: RawTestGroup[] };
}

/**
 * Parse the Boomi timestamp `yyyyMMdd HHmmss.fff` (literal space, treated as
 * UTC) → epoch ms. Returns undefined on any malformed input.
 */
export function parseBoomiTimestamp(ts: unknown): number | undefined {
    if (typeof ts !== 'string') return undefined;
    const m = ts.match(/^(\d{4})(\d{2})(\d{2})\s+(\d{2})(\d{2})(\d{2})(?:\.(\d{1,3}))?$/);
    if (!m) return undefined;
    const [, y, mo, d, h, mi, s, frac] = m;
    const ms = frac ? parseInt(frac.padEnd(3, '0').slice(0, 3), 10) : 0;
    const epoch = Date.UTC(
        parseInt(y, 10), parseInt(mo, 10) - 1, parseInt(d, 10),
        parseInt(h, 10), parseInt(mi, 10), parseInt(s, 10), ms,
    );
    return Number.isFinite(epoch) ? epoch : undefined;
}

/** Coerce a possibly-string numeric ideal bound to a finite number, else undefined. */
function num(v: unknown): number | undefined {
    if (typeof v === 'number') return Number.isFinite(v) ? v : undefined;
    if (typeof v === 'string' && v.trim() !== '') {
        const n = Number(v);
        return Number.isFinite(n) ? n : undefined;
    }
    return undefined;
}

/** Extract an ideal [low, high] range from a reading or its group, if present. */
function extractRange(reading: RawTestValue, group: RawTestGroup): [number, number] | undefined {
    const low = num(reading.ideal_low) ?? num(reading.min_ideal)
        ?? num(group.ideal_low) ?? num(group.min_ideal);
    const high = num(reading.ideal_high) ?? num(reading.max_ideal)
        ?? num(group.ideal_high) ?? num(group.max_ideal);
    if (low === undefined || high === undefined) return undefined;
    return [low, high];
}

/**
 * Flatten `water_tests[].water_test_values[]` to the latest numeric reading
 * per parameter, mapping `water_test_type` strings → typed fields. Diagnostic
 * (boolean) params and null values are ignored. `testDate`/`isStoreTest` come
 * from the most-recent reading across all parameters. PURE — no I/O.
 */
export function parseHistory(json: unknown): LesliesReading {
    const root = (json ?? {}) as RawHistory;
    const groups = root.water_test_history?.water_tests;
    const reading: LesliesReading = {};
    if (!Array.isArray(groups)) return reading;

    // Track the globally-latest reading (any param) for testDate/isStoreTest.
    let latestEpoch = -Infinity;

    for (const group of groups) {
        const field = TYPE_TO_FIELD[group?.water_test_type ?? ''];
        if (!field) continue; // diagnostic/observation or unknown param
        const values = Array.isArray(group.water_test_values) ? group.water_test_values : [];

        // Pick the latest numeric reading in this group (max timestamp).
        let best: RawTestValue | undefined;
        let bestEpoch = -Infinity;
        for (const v of values) {
            if (typeof v.value !== 'number' || !Number.isFinite(v.value)) continue;
            const epoch = parseBoomiTimestamp(v.timestamp);
            // Fall back to lexical timestamp ordering when unparseable, so a
            // group with timestamps still resolves a "latest".
            const ord = epoch ?? -Infinity;
            if (best === undefined || ord > bestEpoch
                || (ord === bestEpoch && (v.timestamp ?? '') > (best.timestamp ?? ''))) {
                best = v;
                bestEpoch = ord;
            }
        }
        if (best === undefined || typeof best.value !== 'number') continue;

        (reading[field] as number) = best.value;
        const range = extractRange(best, group);
        const rangeKey = RANGE_KEY[field];
        if (range && rangeKey) (reading[rangeKey] as [number, number]) = range;

        const epoch = parseBoomiTimestamp(best.timestamp);
        if (epoch !== undefined && epoch > latestEpoch) {
            latestEpoch = epoch;
            reading.testDate = epoch;
            reading.isStoreTest = best.is_store_test === true;
        }
    }

    return reading;
}

export interface LesliesLogger {
    debug: (m: string) => void;
    info: (m: string) => void;
    warn: (m: string) => void;
    error: (m: string) => void;
}

/**
 * Leslie's mobile-app API constants. PUBLIC app secrets from the official app
 * (community-extracted via connorgallopo/leslies-pool). Identify the APP, not
 * the owner — safe to live in source. The owner's email/password are config.
 */
const LESLIES = {
    ocapiBase: 'https://lesliespool.com/s/lpm_site/dw/shop/v23_2',
    ocapiClientId: 'a233c1f2-f115-434d-959e-efc789d0cd45',
    boomiBase: 'https://api.lesl.cloud',
    boomiUser: 'MobileApp@lesliespoolmart-N83JU5',
    boomiPass: '7cfa5832-d2ba-4997-adb7-2e2d81ccef96',
    userAgent: 'LesliesPoolCare/10.8 CFNetwork/1410.0.3 Darwin/22.6.0',
    historyPath: '/ws/rest/Mobile/waterTesting/history/v2',
    profilesPath: '/ws/rest/Mobile/RelateORCE/poolProfiles/v1',
    /** Oldest history start; wide window pulls the full series in one call. */
    historyStart: '20200101 000000.000',
} as const;

/** Per-attempt request timeout + retry policy (mirrors util.ts: 3 attempts). */
const FETCH_TIMEOUT_MS = 20000;
const RETRY_ATTEMPTS = 3;
const RETRY_BACKOFF_MS = [500, 1000, 2000];

/** A single discovered pool/water-body. */
export interface LesliesPool {
    id: string;
    name: string;
}

export class LesliesClient {
    /** Cached durable identity key (c_relateCustomerID); resolved once. */
    private relateId: string | null = null;

    constructor(
        private readonly email: string,
        private readonly password: string,
        private readonly poolId: string,
        private readonly log: LesliesLogger,
    ) {}

    /** Full flow: ensure identity → GET history for poolId → parse. Throws on failure. */
    async fetch(): Promise<LesliesReading> {
        const relateId = await this.ensureRelateId();
        const raw = await this.fetchHistory(this.poolId, relateId);
        return parseHistory(raw);
    }

    /** List the owner's registered pools (id + name). Throws on failure. */
    async discoverPools(): Promise<LesliesPool[]> {
        const relateId = await this.ensureRelateId();
        const res = await this.withRetry('poolProfiles', () => fetchWithTimeout(
            `${LESLIES.boomiBase}${LESLIES.profilesPath}`,
            { method: 'GET', headers: this.boomiHeaders(relateId) },
        ));
        if (!res.ok) throw new Error(`Leslie's poolProfiles HTTP ${res.status}`);
        const body = await res.json() as { pool_profiles?: Array<{ id?: unknown; pool_name?: unknown }> };
        const profiles = Array.isArray(body.pool_profiles) ? body.pool_profiles : [];
        return profiles.map(p => ({
            id: String(p.id ?? ''),
            name: typeof p.pool_name === 'string' ? p.pool_name : `Pool ${String(p.id ?? '')}`,
        }));
    }

    /** Resolve + cache the durable identity key from the OCAPI login. */
    private async ensureRelateId(): Promise<string> {
        if (this.relateId) return this.relateId;
        this.relateId = await this.resolveRelateId();
        return this.relateId;
    }

    /** Layer 1: OCAPI login → JWT → c_relateCustomerID. Never logs the password. */
    private async resolveRelateId(): Promise<string> {
        const creds = Buffer.from(`${this.email}:${this.password}`).toString('base64');
        const authUrl = `${LESLIES.ocapiBase}/customers/auth?client_id=${LESLIES.ocapiClientId}`;
        this.log.debug(`Leslie's OCAPI login → ${LESLIES.ocapiBase}/customers/auth`);
        const authRes = await this.withRetry('OCAPI auth', () => fetchWithTimeout(authUrl, {
            method: 'POST',
            headers: {
                'Authorization': `Basic ${creds}`,
                'Content-Type': 'application/json',
                'User-Agent': LESLIES.userAgent,
            },
            body: JSON.stringify({ type: 'credentials' }),
        }));
        if (authRes.status === 401) throw new Error("Leslie's login rejected the email/password (HTTP 401)");
        if (!authRes.ok) throw new Error(`Leslie's OCAPI auth HTTP ${authRes.status}`);

        const jwt = (authRes.headers.get('Authorization') ?? '').replace(/^Bearer\s+/i, '').trim();
        const authBody = await authRes.json() as { customer_id?: unknown; c_relateCustomerID?: unknown };

        // Fast path: relate id already present in the auth body (seen live).
        if (authBody.c_relateCustomerID) return String(authBody.c_relateCustomerID);

        if (!jwt) throw new Error("Leslie's OCAPI auth response missing JWT");
        const customerId = authBody.customer_id;
        if (!customerId) throw new Error("Leslie's OCAPI auth response missing customer_id");

        // Fallback: read the customer record for c_relateCustomerID.
        const custUrl = `${LESLIES.ocapiBase}/customers/${encodeURIComponent(String(customerId))}?client_id=${LESLIES.ocapiClientId}`;
        const custRes = await this.withRetry('OCAPI customer', () => fetchWithTimeout(custUrl, {
            method: 'GET',
            headers: {
                'Authorization': `Bearer ${jwt}`,
                'User-Agent': LESLIES.userAgent,
                'Accept': 'application/json',
            },
        }));
        if (!custRes.ok) throw new Error(`Leslie's OCAPI customer HTTP ${custRes.status}`);
        const custBody = await custRes.json() as { c_relateCustomerID?: unknown };
        if (!custBody.c_relateCustomerID) throw new Error("Leslie's customer record missing c_relateCustomerID");
        return String(custBody.c_relateCustomerID);
    }

    /** Layer 2: GET the water-test history for a pool profile. */
    private async fetchHistory(poolProfileId: string, relateId: string): Promise<unknown> {
        const end = boomiEndDate(new Date());
        const params = new URLSearchParams({
            pool_profile_id: poolProfileId,
            start_date: LESLIES.historyStart,
            end_date: end,
        });
        const url = `${LESLIES.boomiBase}${LESLIES.historyPath}?${params.toString()}`;
        this.log.debug(`Leslie's history → ${LESLIES.historyPath} (pool ${poolProfileId})`);
        const res = await this.withRetry('history', () => fetchWithTimeout(url, {
            method: 'GET',
            headers: this.boomiHeaders(relateId),
        }));
        if (!res.ok) throw new Error(`Leslie's history HTTP ${res.status}`);
        return res.json();
    }

    /** Static app Basic-auth + identity headers required on every Boomi call. */
    private boomiHeaders(relateId: string): Record<string, string> {
        const auth = Buffer.from(`${LESLIES.boomiUser}:${LESLIES.boomiPass}`).toString('base64');
        return {
            'Authorization': `Basic ${auth}`,
            'User-Agent': LESLIES.userAgent,
            'Accept': 'application/json',
            'source': 'APP',
            'DDP_email': this.email,
            'DDP_ID': relateId,
        };
    }

    /** Retry wrapper with backoff (mirrors util.ts). Never logs the password. */
    private async withRetry(label: string, fn: () => Promise<Response>): Promise<Response> {
        let lastErr: unknown;
        for (let attempt = 0; attempt < RETRY_ATTEMPTS; attempt++) {
            try {
                return await fn();
            } catch (e) {
                lastErr = e;
                if (attempt < RETRY_ATTEMPTS - 1) {
                    const wait = RETRY_BACKOFF_MS[attempt] ?? 2000;
                    this.log.debug(`Leslie's ${label} attempt ${attempt + 1} failed: ${(e as Error).message} — retrying in ${wait}ms`);
                    await delay(wait);
                }
            }
        }
        throw new Error(`Leslie's ${label} failed after ${RETRY_ATTEMPTS} attempts: ${(lastErr as Error)?.message ?? 'unknown error'}`);
    }
}

/** `yyyyMMdd 235959.999` end-of-day, +365d (matches the reference window). */
function boomiEndDate(now: Date): string {
    const d = new Date(now.getTime() + 365 * 24 * 3600 * 1000);
    const p = (n: number, w = 2): string => String(n).padStart(w, '0');
    return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())} 235959.999`;
}

function delay(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
}

/** fetch() with an AbortController timeout so a hung connection can't stall the run. */
async function fetchWithTimeout(url: string, init: RequestInit): Promise<Response> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    try {
        return await fetch(url, { ...init, signal: controller.signal });
    } finally {
        clearTimeout(timer);
    }
}
