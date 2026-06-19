/**
 * Water Guru access. Unofficial AWS path (community: jkoehl/homebridge-waterguru,
 * bdwilson/waterguru-api). Cognito SRP login → temp creds → SigV4 Lambda POST.
 *
 * `parseDashboard` is PURE (no network) and unit-tested by parse.test.ts.
 * `WaterGuruClient.fetch()` is the network entry point (Task 6).
 */
export interface WgReading {
    fc?: number;
    fcRange?: [number, number];
    ph?: number;
    ta?: number;
    waterTempF?: number;
    measureTime?: number;
    cassettePercent?: number;
    cassetteDays?: number;
    podOnline: boolean;
}

interface RawFloatRanges {
    GREEN_MIN?: number;
    GREEN_MAX?: number;
    [key: string]: number | undefined;
}
interface RawMeasurement {
    type?: string;
    floatValue?: number;
    intValue?: number;
    measureTime?: string;
    cfg?: { floatRanges?: RawFloatRanges };
}
interface RawRefillable {
    type?: string;   // 'LAB' = cassette, 'BATT' = battery
    pctLeft?: number;
    timeLeftText?: string;  // e.g. "9 days left"
}
interface RawPod {
    podId?: number;
    refillables?: RawRefillable[];
    rssiInfo?: { rssi?: number; rssiTime?: string };
}
interface RawWaterBody {
    waterBodyId?: string;
    name?: string;
    waterTemp?: number;
    latestMeasureTime?: string;
    pods?: RawPod[];
    measurements?: RawMeasurement[];
}
interface RawDashboard { waterBodies?: RawWaterBody[] }

/** Extract the chemistry we care about from a prod-getDashboardView payload. */
export function parseDashboard(json: unknown): WgReading {
    const dash = (json ?? {}) as RawDashboard;
    const wb = Array.isArray(dash.waterBodies) ? dash.waterBodies[0] : undefined;
    if (!wb) return { podOnline: false };

    const ms = Array.isArray(wb.measurements) ? wb.measurements : [];
    const find = (type: string): RawMeasurement | undefined =>
        ms.find(m => (m.type ?? '').toUpperCase() === type);

    const fcM = find('FREE_CL');
    const phM = find('PH');
    const taM = find('TA');

    // Pod online = pod exists and has a recent rssiInfo (rssiTime present → connected)
    const pod = Array.isArray(wb.pods) ? wb.pods[0] : undefined;
    const podOnline = !!(pod && pod.rssiInfo && pod.rssiInfo.rssiTime);

    const reading: WgReading = { podOnline };

    // FC
    if (fcM && typeof fcM.floatValue === 'number') reading.fc = fcM.floatValue;
    const fcRanges = fcM?.cfg?.floatRanges;
    if (fcRanges && typeof fcRanges.GREEN_MIN === 'number' && typeof fcRanges.GREEN_MAX === 'number') {
        reading.fcRange = [fcRanges.GREEN_MIN, fcRanges.GREEN_MAX];
    }
    // measureTime: parse ISO string from FREE_CL, fall back to latestMeasureTime
    const mtStr = fcM?.measureTime ?? wb.latestMeasureTime;
    if (mtStr) {
        const ms2 = Date.parse(mtStr);
        if (isFinite(ms2)) reading.measureTime = ms2;
    }

    // pH
    if (phM && typeof phM.floatValue === 'number') reading.ph = phM.floatValue;

    // TA — may be intValue (not floatValue) in real responses
    if (taM) {
        const taVal = typeof taM.floatValue === 'number' ? taM.floatValue
            : typeof taM.intValue === 'number' ? taM.intValue : undefined;
        if (taVal !== undefined) reading.ta = taVal;
    }

    // Water temp from water body directly
    if (typeof wb.waterTemp === 'number') reading.waterTempF = wb.waterTemp;

    // Cassette: from pods[0].refillables where type === 'LAB'
    if (pod && Array.isArray(pod.refillables)) {
        const cassette = pod.refillables.find(r => r.type === 'LAB');
        if (cassette) {
            if (typeof cassette.pctLeft === 'number') reading.cassettePercent = cassette.pctLeft;
            // Parse "9 days left" → 9
            if (cassette.timeLeftText) {
                const daysMatch = cassette.timeLeftText.match(/^(\d+)\s+day/);
                if (daysMatch) reading.cassetteDays = parseInt(daysMatch[1], 10);
            }
        }
    }

    return reading;
}

import {
    CognitoUserPool, CognitoUser, AuthenticationDetails,
} from 'amazon-cognito-identity-js';
import {
    CognitoIdentityClient, GetIdCommand, GetCredentialsForIdentityCommand,
} from '@aws-sdk/client-cognito-identity';
// eslint-disable-next-line @typescript-eslint/no-var-requires
const aws4 = require('aws4');

/** WG production AWS constants (spec Appendix; community-verified 2026-06). */
const WG = {
    region: 'us-west-2',
    userPoolId: 'us-west-2_icsnuWQWw',
    clientId: '7pk5du7fitqb419oabb3r92lni',
    identityPoolId: 'us-west-2:691e3287-5776-40f2-a502-759de65a8f1c',
    lambdaHost: 'lambda.us-west-2.amazonaws.com',
    lambdaPath: '/2015-03-31/functions/prod-getDashboardView/invocations',
} as const;

export interface WgLogger {
    debug: (m: string) => void;
    info: (m: string) => void;
    warn: (m: string) => void;
    error: (m: string) => void;
}

export class WaterGuruClient {
    constructor(
        private readonly email: string,
        private readonly password: string,
        private readonly log: WgLogger,
    ) {}

    /** Full flow: login → temp creds → signed Lambda invoke → parse. Throws on any failure. */
    async fetch(): Promise<WgReading> {
        const { idToken, userId } = await this.login();
        const creds = await this.getAwsCreds(idToken);
        const raw = await this.invokeDashboard(creds, userId);
        return parseDashboard(raw);
    }

    private login(): Promise<{ idToken: string; userId: string }> {
        const pool = new CognitoUserPool({ UserPoolId: WG.userPoolId, ClientId: WG.clientId });
        const user = new CognitoUser({ Username: this.email, Pool: pool });
        const details = new AuthenticationDetails({ Username: this.email, Password: this.password });
        return new Promise((resolve, reject) => {
            user.authenticateUser(details, {
                onSuccess: (session) => {
                    const idToken = session.getIdToken().getJwtToken();
                    // userId = Cognito 'cognito:username' claim from the id token payload.
                    const payload = JSON.parse(
                        Buffer.from(idToken.split('.')[1], 'base64').toString('utf8'),
                    );
                    resolve({ idToken, userId: payload['cognito:username'] as string });
                },
                onFailure: (err) => reject(new Error(`WG Cognito login failed: ${err.message ?? err}`)),
            });
        });
    }

    private async getAwsCreds(idToken: string): Promise<{ accessKeyId: string; secretAccessKey: string; sessionToken: string }> {
        const idp = new CognitoIdentityClient({ region: WG.region });
        const loginKey = `cognito-idp.${WG.region}.amazonaws.com/${WG.userPoolId}`;
        const id = await idp.send(new GetIdCommand({
            IdentityPoolId: WG.identityPoolId,
            Logins: { [loginKey]: idToken },
        }));
        if (!id.IdentityId) throw new Error('WG GetId returned no IdentityId');
        const out = await idp.send(new GetCredentialsForIdentityCommand({
            IdentityId: id.IdentityId,
            Logins: { [loginKey]: idToken },
        }));
        const c = out.Credentials;
        if (!c?.AccessKeyId || !c.SecretKey || !c.SessionToken) {
            throw new Error('WG GetCredentialsForIdentity returned incomplete creds');
        }
        return { accessKeyId: c.AccessKeyId, secretAccessKey: c.SecretKey, sessionToken: c.SessionToken };
    }

    private async invokeDashboard(
        creds: { accessKeyId: string; secretAccessKey: string; sessionToken: string },
        userId: string,
    ): Promise<unknown> {
        const body = JSON.stringify({ userId, clientType: 'WEB_APP', clientVersion: '0.2.3' });
        const opts = {
            host: WG.lambdaHost,
            path: WG.lambdaPath,
            service: 'lambda',
            region: WG.region,
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body,
        };
        aws4.sign(opts, {
            accessKeyId: creds.accessKeyId,
            secretAccessKey: creds.secretAccessKey,
            sessionToken: creds.sessionToken,
        });
        this.log.debug(`WG Lambda invoke → ${WG.lambdaHost}${WG.lambdaPath}`);
        const res = await fetch(`https://${WG.lambdaHost}${WG.lambdaPath}`, {
            method: 'POST',
            headers: opts.headers as Record<string, string>,
            body,
        });
        if (!res.ok) throw new Error(`WG Lambda invoke HTTP ${res.status}`);
        const text = await res.text();
        // Lambda may wrap the payload as a JSON string in a `body` field.
        const outer = JSON.parse(text);
        if (typeof outer === 'object' && outer && typeof (outer as { body?: unknown }).body === 'string') {
            return JSON.parse((outer as { body: string }).body);
        }
        return outer;
    }
}
