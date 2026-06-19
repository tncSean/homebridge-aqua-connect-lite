/**
 * Unit tests for the PURE pieces of W610 discovery — normalizeMac,
 * parseDiscoveryReply, parseNeighborLine, subnetHosts. No network I/O.
 *
 * There is no test runner configured for this project, so this is a
 * standalone script using Node's built-in `assert`. Run with:
 *
 *     npx ts-node src/aqualogic/discovery.test.ts
 *
 * Excluded from the production build via tsconfig "exclude".
 */
import * as assert from 'node:assert';
import { normalizeMac, parseDiscoveryReply, parseNeighborLine, subnetHosts } from './discovery';

let passed = 0;
function test(name: string, fn: () => void): void {
    fn();
    passed++;
    // eslint-disable-next-line no-console
    console.log(`  ok - ${name}`);
}

// --- normalizeMac ---------------------------------------------------------

test('normalizeMac strips colons and uppercases', () => {
    assert.strictEqual(normalizeMac('D4:AD:20:DF:8D:58'), 'D4AD20DF8D58');
});

test('normalizeMac uppercases lowercase compact form', () => {
    assert.strictEqual(normalizeMac('d4ad20df8d58'), 'D4AD20DF8D58');
});

test('normalizeMac handles hyphen separators', () => {
    assert.strictEqual(normalizeMac('d4-ad-20-df-8d-58'), 'D4AD20DF8D58');
});

test('normalizeMac drops non-hex noise', () => {
    assert.strictEqual(normalizeMac('  D4 AD 20 DF 8D 58  '), 'D4AD20DF8D58');
});

test('normalizeMac on empty string is empty', () => {
    assert.strictEqual(normalizeMac(''), '');
});

// --- parseDiscoveryReply --------------------------------------------------

test('parseDiscoveryReply parses the real pool reply', () => {
    const dev = parseDiscoveryReply('192.168.1.73,D4AD20DF8D58,');
    assert.deepStrictEqual(dev, { ip: '192.168.1.73', mac: 'D4AD20DF8D58' });
});

test('parseDiscoveryReply parses reply with no trailing comma', () => {
    const dev = parseDiscoveryReply('192.168.1.73,D4AD20DF8D58');
    assert.deepStrictEqual(dev, { ip: '192.168.1.73', mac: 'D4AD20DF8D58' });
});

test('parseDiscoveryReply normalizes a colon-formatted MAC in the reply', () => {
    const dev = parseDiscoveryReply('10.0.0.5,d4:ad:20:df:8d:58,extra');
    assert.deepStrictEqual(dev, { ip: '10.0.0.5', mac: 'D4AD20DF8D58' });
});

test('parseDiscoveryReply rejects a malformed IP', () => {
    assert.strictEqual(parseDiscoveryReply('999.1.1.1,D4AD20DF8D58,'), null);
});

test('parseDiscoveryReply rejects a non-IP first field', () => {
    assert.strictEqual(parseDiscoveryReply('not-an-ip,D4AD20DF8D58,'), null);
});

test('parseDiscoveryReply rejects a short MAC', () => {
    assert.strictEqual(parseDiscoveryReply('192.168.1.73,D4AD20,'), null);
});

test('parseDiscoveryReply rejects a missing MAC field', () => {
    assert.strictEqual(parseDiscoveryReply('192.168.1.73'), null);
});

test('parseDiscoveryReply rejects an empty string', () => {
    assert.strictEqual(parseDiscoveryReply(''), null);
});

test('parseDiscoveryReply rejects garbage', () => {
    assert.strictEqual(parseDiscoveryReply('WWW.USR.CN'), null);
});

// --- parseNeighborLine ----------------------------------------------------

test('parseNeighborLine parses an `ip neigh` REACHABLE line (W610 L2 MAC ...59)', () => {
    const dev = parseNeighborLine('192.168.1.73 dev eth0 lladdr d4:ad:20:df:8d:59 REACHABLE');
    assert.deepStrictEqual(dev, { ip: '192.168.1.73', mac: 'D4AD20DF8D59' });
});

test('parseNeighborLine parses a STALE `ip neigh` line', () => {
    const dev = parseNeighborLine('192.168.1.73 dev eth0 lladdr d4:ad:20:df:8d:59 STALE');
    assert.deepStrictEqual(dev, { ip: '192.168.1.73', mac: 'D4AD20DF8D59' });
});

test('parseNeighborLine parses BSD/macOS `arp -an` form', () => {
    const dev = parseNeighborLine('? (192.168.1.73) at d4:ad:20:df:8d:59 [ether] on en0 ifscope [ethernet]');
    assert.deepStrictEqual(dev, { ip: '192.168.1.73', mac: 'D4AD20DF8D59' });
});

test('parseNeighborLine rejects an incomplete entry (no lladdr)', () => {
    assert.strictEqual(parseNeighborLine('192.168.1.99 dev eth0 FAILED'), null);
});

test('parseNeighborLine rejects the all-zero placeholder MAC', () => {
    assert.strictEqual(parseNeighborLine('192.168.1.99 dev eth0 lladdr 00:00:00:00:00:00 INCOMPLETE'), null);
});

test('parseNeighborLine rejects a header / blank line', () => {
    assert.strictEqual(parseNeighborLine(''), null);
});

// --- subnetHosts ----------------------------------------------------------

test('subnetHosts enumerates .1–.254 of the /24', () => {
    const hosts = subnetHosts('192.168.1.73');
    assert.strictEqual(hosts.length, 254);
    assert.strictEqual(hosts[0], '192.168.1.1');
    assert.strictEqual(hosts[253], '192.168.1.254');
});

test('subnetHosts on a malformed IP returns []', () => {
    assert.deepStrictEqual(subnetHosts('not-an-ip'), []);
});

// eslint-disable-next-line no-console
console.log(`\n${passed} passed`);
