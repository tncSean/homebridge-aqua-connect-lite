/**
 * USR-W610 LAN auto-discovery.
 *
 * The pool W610 lives on DHCP and its IP can change at any lease renewal
 * (it moved 192.168.1.70 → .73 → ...). A hardcoded host breaks the plugin
 * whenever that happens, so we identify the device by its (stable) MAC
 * address instead.
 *
 * PUSR devices implement a vendor discovery protocol: broadcast the ASCII
 * string `WWW.USR.CN` to UDP port 48899 and every reachable PUSR device on
 * the segment replies with an ASCII string of the form:
 *
 *     <ip>,<MAC>,        e.g.  "192.168.1.73,D4AD20DF8D58,"
 *
 * where MAC is 12 uppercase hex chars with no separators. A second PUSR
 * device (hot tub) is being added, so we MUST match on MAC, not on "the
 * first PUSR that answers".
 *
 * Two complementary discovery methods, both best-effort (NEVER throw — on any
 * error they resolve null/[] and the caller falls back to the static IP):
 *
 *   1. ARP-scan-by-MAC (PRIMARY for the Homebridge host). Ping-sweep the local
 *      /24, then read the kernel neighbour table and match on the device's
 *      LAYER-2 / Ethernet MAC. This is unicast and needs no broadcast, so it
 *      works from a wired LXC container whose subnet broadcast does NOT reach
 *      the WiFi-attached W610 (the exact CT 131 situation). NOTE: the W610's
 *      L2 MAC ends ...59 (`D4:AD:20:DF:8D:59`) — one greater than the MAC the
 *      USR protocol reports (...58). Match ARP on the ...59 address.
 *
 *   2. PUSR UDP broadcast (SECONDARY). Broadcast `WWW.USR.CN` to UDP 48899;
 *      each PUSR device replies `<ip>,<MAC>,` (MAC = ...58, the USR-protocol
 *      MAC). Works where subnet broadcast reaches the device (e.g. Sean's Mac).
 */
import { exec } from 'child_process';
import * as dgram from 'dgram';

/** PUSR vendor discovery magic string. */
const DISCOVERY_PAYLOAD = 'WWW.USR.CN';
/** PUSR vendor discovery UDP port. */
const DISCOVERY_PORT = 48899;
/** Default broadcast targets — global + the pool subnet directed broadcast. */
const DEFAULT_BROADCAST_ADDRS = ['255.255.255.255', '192.168.1.255'];
/** Default time to listen for replies. */
const DEFAULT_TIMEOUT_MS = 3000;

export interface DiscoveredDevice {
    ip: string;
    mac: string;
}

/**
 * Strip every non-hex character and uppercase the result.
 *
 * Accepts any common MAC spelling — "D4:AD:20:DF:8D:58", "d4-ad-20-df-8d-58",
 * "d4ad20df8d58" — and normalizes them all to "D4AD20DF8D58".
 */
export function normalizeMac(s: string): string {
    return (s ?? '').replace(/[^0-9a-fA-F]/g, '').toUpperCase();
}

/** True if the string is a plausible dotted-quad IPv4 address. */
function isIpv4(value: string): boolean {
    const m = value.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
    if (!m) return false;
    return m.slice(1, 5).every(o => {
        const n = parseInt(o, 10);
        return n >= 0 && n <= 255;
    });
}

/**
 * Parse a single PUSR discovery reply. PURE — no I/O, unit-testable.
 *
 * Expected form: `IP,MAC,` (trailing comma optional, extra fields ignored).
 * field[0] = IPv4 (validated), field[1] = MAC (normalized to 12 hex chars).
 * Returns null for anything malformed.
 */
export function parseDiscoveryReply(raw: string): DiscoveredDevice | null {
    if (typeof raw !== 'string') return null;
    const parts = raw.trim().split(',');
    if (parts.length < 2) return null;

    const ip = parts[0].trim();
    if (!isIpv4(ip)) return null;

    const mac = normalizeMac(parts[1]);
    if (mac.length !== 12) return null;

    return { ip, mac };
}

/**
 * Broadcast the PUSR discovery probe and collect replies for `timeoutMs`.
 *
 * Sends to BOTH 255.255.255.255 and the directed subnet broadcast by default
 * (some switches/APs drop one or the other). Dedupes by MAC. NEVER throws —
 * resolves with [] on any error.
 */
export async function discoverDevices(opts?: {
    timeoutMs?: number;
    broadcastAddrs?: string[];
}): Promise<DiscoveredDevice[]> {
    const timeoutMs = opts?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const broadcastAddrs = opts?.broadcastAddrs ?? DEFAULT_BROADCAST_ADDRS;

    return new Promise<DiscoveredDevice[]>(resolve => {
        const byMac = new Map<string, DiscoveredDevice>();
        let settled = false;
        let socket: dgram.Socket;

        const finish = () => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            try { socket.close(); } catch { /* already closed */ }
            resolve([...byMac.values()]);
        };

        const timer = setTimeout(finish, timeoutMs);
        // Don't keep the Homebridge event loop alive just for a discovery window.
        timer.unref?.();

        try {
            socket = dgram.createSocket({ type: 'udp4', reuseAddr: true });
        } catch {
            clearTimeout(timer);
            resolve([]);
            return;
        }

        socket.on('error', () => finish());

        socket.on('message', msg => {
            const dev = parseDiscoveryReply(msg.toString('utf8'));
            if (dev) byMac.set(dev.mac, dev);
        });

        socket.bind(() => {
            try {
                socket.setBroadcast(true);
            } catch {
                // Some platforms reject setBroadcast on an unbound/odd socket —
                // still try the sends; if they fail too we just time out empty.
            }
            const payload = Buffer.from(DISCOVERY_PAYLOAD, 'ascii');
            for (const addr of broadcastAddrs) {
                socket.send(payload, 0, payload.length, DISCOVERY_PORT, addr, () => {
                    // Per-send errors are non-fatal; ignore and keep listening.
                });
            }
        });
    });
}

/**
 * Discover the IP of the device whose MAC matches `targetMac`.
 * Returns the IP string, or null if no matching device replied.
 */
export async function discoverIpByMac(
    targetMac: string,
    opts?: { timeoutMs?: number; broadcastAddrs?: string[] },
): Promise<string | null> {
    const want = normalizeMac(targetMac);
    if (want.length !== 12) return null;
    const devices = await discoverDevices(opts);
    const match = devices.find(d => d.mac === want);
    return match ? match.ip : null;
}

// --- ARP-scan discovery ---------------------------------------------------

/**
 * Parse one line of `ip neigh show` / `arp -an` output into a device. PURE —
 * unit-testable. Handles both formats:
 *
 *   ip neigh:  "192.168.1.73 dev eth0 lladdr d4:ad:20:df:8d:59 REACHABLE"
 *   arp -an:   "? (192.168.1.73) at d4:ad:20:df:8d:59 [ether] on eth0"
 *
 * Returns null for header lines, incomplete entries, or anything without both
 * a valid IPv4 and a 12-hex-char MAC.
 */
export function parseNeighborLine(line: string): DiscoveredDevice | null {
    if (typeof line !== 'string') return null;

    // Pull the first dotted-quad anywhere on the line (handles the arp `(ip)` form).
    const ipMatch = line.match(/(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})/);
    if (!ipMatch || !isIpv4(ipMatch[1])) return null;

    // Pull a colon/hyphen-separated 6-octet MAC. Excludes incomplete/FAILED
    // entries (no lladdr) and the "00:00:00:00:00:00" placeholder.
    const macMatch = line.match(/([0-9a-fA-F]{1,2}(?:[:-][0-9a-fA-F]{1,2}){5})/);
    if (!macMatch) return null;
    const mac = normalizeMac(macMatch[1]);
    if (mac.length !== 12 || mac === '000000000000') return null;

    return { ip: ipMatch[1], mac };
}

/** Run a shell command, resolve stdout (or '' on any error/non-zero exit). */
function runCmd(cmd: string, timeoutMs: number): Promise<string> {
    return new Promise<string>(resolve => {
        try {
            exec(cmd, { timeout: timeoutMs, windowsHide: true }, (_err, stdout) => {
                resolve(stdout ?? '');
            });
        } catch {
            resolve('');
        }
    });
}

/** Read the kernel neighbour table via `ip neigh`, falling back to `arp -an`. */
async function readNeighbors(timeoutMs: number): Promise<DiscoveredDevice[]> {
    let out = await runCmd('ip neigh show', timeoutMs);
    if (!out.trim()) out = await runCmd('arp -an', timeoutMs);
    const byMac = new Map<string, DiscoveredDevice>();
    for (const line of out.split('\n')) {
        const dev = parseNeighborLine(line);
        if (dev) byMac.set(dev.mac, dev);
    }
    return [...byMac.values()];
}

/** Derive the list of /24 host IPs (.1–.254) from a dotted-quad in that subnet. */
export function subnetHosts(anyIpInSubnet: string): string[] {
    const m = anyIpInSubnet.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.\d{1,3}$/);
    if (!m) return [];
    const prefix = `${m[1]}.${m[2]}.${m[3]}`;
    const hosts: string[] = [];
    for (let i = 1; i <= 254; i++) hosts.push(`${prefix}.${i}`);
    return hosts;
}

/**
 * Discover the IP of the device whose LAYER-2 (Ethernet/ARP) MAC matches
 * `targetL2Mac`, by ping-sweeping the /24 that `subnetIp` lives in and then
 * reading the neighbour table.
 *
 * This is the PRIMARY method on the Homebridge host: it is unicast end-to-end,
 * so it works even when subnet broadcast doesn't reach the device. Linux-only
 * (`ip neigh` / `arp`); on platforms without those tools it simply finds
 * nothing and returns null. NEVER throws.
 *
 * @param targetL2Mac  the device's Ethernet MAC (W610: D4:AD:20:DF:8D:59)
 * @param subnetIp     any IP in the target /24 (use the static fallback IP)
 */
export async function discoverIpByArp(
    targetL2Mac: string,
    opts?: { subnetIp?: string; sweepTimeoutMs?: number; pingConcurrency?: number },
): Promise<string | null> {
    const want = normalizeMac(targetL2Mac);
    if (want.length !== 12) return null;

    const sweepTimeoutMs = opts?.sweepTimeoutMs ?? 4000;
    const concurrency = opts?.pingConcurrency ?? 24;
    const subnetIp = opts?.subnetIp;

    try {
        // Fast path: the device may already be in the neighbour table.
        const existing = await readNeighbors(2000);
        const hit = existing.find(d => d.mac === want);
        if (hit) return hit.ip;

        const hosts = subnetIp ? subnetHosts(subnetIp) : [];
        if (hosts.length > 0) {
            // Ping-sweep to populate ARP. -c1 one probe, -W1 1s wait. Run a
            // bounded number of pings in parallel; each rejects silently.
            const deadline = Date.now() + sweepTimeoutMs;
            const perPing = 1500;
            let idx = 0;
            const worker = async (): Promise<void> => {
                while (idx < hosts.length && Date.now() < deadline) {
                    const ip = hosts[idx++];
                    await runCmd(`ping -c 1 -W 1 ${ip}`, perPing);
                }
            };
            const workers: Promise<void>[] = [];
            for (let i = 0; i < Math.min(concurrency, hosts.length); i++) {
                workers.push(worker());
            }
            await Promise.all(workers);
        }

        const after = await readNeighbors(2500);
        const match = after.find(d => d.mac === want);
        return match ? match.ip : null;
    } catch {
        return null;
    }
}
