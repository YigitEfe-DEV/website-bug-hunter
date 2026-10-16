/**
 * Security gate: every URL that flows into the network layer must pass through
 * `assertSafeUrl`. This module is the single chokepoint that prevents the
 * scanner itself from becoming an SSRF / DNS-rebinding primitive.
 *
 * Threat model:
 *   R1 (SSRF)            - reject if URL would resolve to private/loopback/link-local
 *   R2 (DNS rebinding)   - resolve once, pin the IP for the caller to reuse
 *   R3 (non-http scheme) - only http(s); reject file:, data:, javascript:, gopher:, ftp:
 *   R7 (path traversal)  - normalize; reject hosts that look like control chars or NULs
 */
import { lookup } from 'dns/promises';
import type { LookupAddress } from 'dns';

export interface SafeUrlOptions {
  /** Override the DNS resolver (used for testing DNS rebinding). */
  resolver?: (hostname: string) => Promise<LookupAddress[]>;
  /** Allow private/loopback ranges. NEVER set in production. Off-limits by default. */
  allowPrivate?: boolean;
}

export interface SafeUrlResult {
  /** Canonicalized URL with a lowercased host. */
  url: URL;
  /** The single IP we resolved to (already validated). */
  ip: string;
}

/** Blocked literal IPv4 ranges (CIDR). Private + loopback + link-local + metadata + CGNAT. */
const BLOCKED_V4_CIDRS: ReadonlyArray<readonly [number, number]> = [
  // [10.0.0.0/8]
  [0x0a000000, 0x0affffff],
  // [127.0.0.0/8]  (loopback)
  [0x7f000000, 0x7fffffff],
  // [169.254.0.0/16]  (link-local incl. cloud metadata 169.254.169.254)
  [0xa9fe0000, 0xa9feffff],
  // [172.16.0.0/12]
  [0xac100000, 0xac1fffff],
  // [192.168.0.0/16]
  [0xc0a80000, 0xc0a8ffff],
  // [100.64.0.0/10]  (CGNAT, shared address space)
  [0x64400000, 0x647fffff],
  // [0.0.0.0/8]
  [0x00000000, 0x00ffffff],
  // [192.0.2.0/24], [198.51.100.0/24], [203.0.113.0/24]  (TEST-NET, often unmetered)
  [0xc0000200, 0xc00002ff],
  [0xc6336400, 0xc63364ff],
  [0xcb007100, 0xcb0071ff],
  // [198.18.0.0/15]  (benchmarking)
  [0xc6120000, 0xc613ffff],
  // [224.0.0.0/4]  (multicast)
  [0xe0000000, 0xefffffff],
  // [240.0.0.0/4]  (reserved/broadcast)
  [0xf0000000, 0xffffffff],
  // [255.255.255.255/32]  (broadcast — explicit to be safe)
  [0xffffffff, 0xffffffff],
];

/**
 * Blocked IPv6 prefixes.
 *
 * IPv4-mapped blocks (`::ffff:x.x.x.x`) and NAT64 (`64:ff9b::/96`) route
 * to an IPv4 destination; the v4 deny-list is consulted for these cases.
 * 6to4 (`2002::/16`) and Teredo (`2001::/32`) also collapse to an IPv4
 * destination at the routing layer; we deny both to avoid tunnels
 * bypassing the v4 gate. The deprecated IPv4-compatible form
 * (`::a.b.c.d`) is fully denied via `::/96` because no legitimate
 * current traffic uses it.
 */
const BLOCKED_V6_PREFIXES: ReadonlyArray<readonly [number, number, number] | string> = [
  '::1/128', // loopback
  'fc00::/7', // ULA
  'fe80::/10', // link-local
  '::ffff:127.0.0.0/104', // IPv4-mapped loopback
  '::ffff:10.0.0.0/104', // IPv4-mapped private
  '::ffff:172.16.0.0/108',
  '::ffff:192.168.0.0/112',
  '::ffff:169.254.0.0/112',
  '64:ff9b::/96', // NAT64 well-known prefix
  '64:ff9b:1::/48', // local-network NAT64
  '100::/64', // discard
  '2001::/32', // Teredo tunneling
  '2002::/16', // 6to4 (encapsulates IPv4; collapse considered part of v4 gate)
  '2001:db8::/32', // documentation
  '::/128', // unspecified
  '::/96', // IPv4-compatible (deprecated but parsers still accept it)
];

const BLOCKED_HOSTNAMES = new Set([
  'localhost',
  'localhost.localdomain',
  'ip6-localhost',
  'ip6-loopback',
  'broadcasthost',
  'metadata',
  'metadata.google.internal', // GCP
  'kubernetes.default.svc', // K8s
]);

export class UnsafeUrlError extends Error {
  public readonly code: string;
  public readonly url: string;
  constructor(code: string, message: string, url: string) {
    super(`[${code}] ${message} (url=${url})`);
    this.name = 'UnsafeUrlError';
    this.code = code;
    this.url = url;
  }
}

const defaultResolver = async (hostname: string): Promise<LookupAddress[]> => {
  return await lookup(hostname, { all: true, verbatim: true });
};

/** Convert an IPv4 string into a 32-bit integer. */
function ipv4ToInt(addr: string): number | null {
  const parts = addr.split('.');
  if (parts.length !== 4) return null;
  let n = 0;
  for (const p of parts) {
    if (!/^\d+$/.test(p)) return null;
    const v = Number(p);
    if (v < 0 || v > 255) return null;
    n = (n * 256 + v) >>> 0;
  }
  return n >>> 0;
}

/** Expand an IPv6 address to its 8 groups (16-bit each). */
function ipv6ToGroups(addr: string): number[] | null {
  let s = addr.toLowerCase();
  // Handle IPv4-mapped suffix: rewrite '::ffff:a.b.c.d' to '::ffff:HHHH:LLLL'
  const lastColon = s.lastIndexOf(':');
  const tail = s.substring(lastColon + 1);
  if (tail.includes('.')) {
    const v4 = ipv4ToInt(tail);
    if (v4 === null) return null;
    const hi = ((v4 >>> 16) & 0xffff).toString(16);
    const lo = (v4 & 0xffff).toString(16);
    s = s.substring(0, lastColon + 1) + hi + ':' + lo;
  }
  // Split on '::'
  const dblColonIdx = s.indexOf('::');
  const left = dblColonIdx >= 0 ? s.substring(0, dblColonIdx).split(':') : s.split(':');
  const right = dblColonIdx >= 0 ? s.substring(dblColonIdx + 2).split(':') : [];
  const leftFiltered = left.filter((g) => g !== '');
  const rightFiltered = right.filter((g) => g !== '');
  const missing = 8 - (leftFiltered.length + rightFiltered.length);
  if (dblColonIdx >= 0 && missing < 0) return null;
  if (dblColonIdx < 0 && missing !== 0) return null;
  const groups: number[] = [];
  for (const g of leftFiltered) {
    const n = parseInt(g, 16);
    if (Number.isNaN(n)) return null;
    groups.push(n);
  }
  if (dblColonIdx >= 0) {
    for (let i = 0; i < missing; i++) groups.push(0);
  }
  for (const g of rightFiltered) {
    const n = parseInt(g, 16);
    if (Number.isNaN(n)) return null;
    groups.push(n);
  }
  if (groups.length !== 8) return null;
  return groups;
}

function _parseCidrV4(cidr: string): { base: number; mask: number } | null {
  const idx = cidr.indexOf('/');
  if (idx < 0) return null;
  const addr = cidr.substring(0, idx);
  const bitsStr = cidr.substring(idx + 1);
  const bits = Number(bitsStr);
  if (!Number.isInteger(bits) || bits < 0 || bits > 32) return null;
  const base = ipv4ToInt(addr);
  if (base === null) return null;
  const mask = bits === 0 ? 0 : (~((1 << (32 - bits)) - 1)) >>> 0;
  return { base: base & mask, mask };
}

function isBlockedV4(addr: string): boolean {
  const n = ipv4ToInt(addr);
  if (n === null) return false;
  for (const [lo, hi] of BLOCKED_V4_CIDRS) {
    if (n >= lo && n <= hi) return true;
  }
  return false;
}

function parseCidrV6(cidr: string): { groups: number[]; prefixLen: number } | null {
  const idx = cidr.indexOf('/');
  if (idx < 0) return null;
  const addr = cidr.substring(0, idx);
  const bitsStr = cidr.substring(idx + 1);
  const bits = Number(bitsStr);
  if (!Number.isInteger(bits) || bits < 0 || bits > 128) return null;
  const groups = ipv6ToGroups(addr);
  if (!groups) return null;
  return { groups, prefixLen: bits };
}

function ipv6MatchesCidr(groups: number[], cidr: { groups: number[]; prefixLen: number }): boolean {
  const fullBits = Math.floor(cidr.prefixLen / 16);
  for (let i = 0; i < fullBits; i++) {
    if (groups[i] !== cidr.groups[i]) return false;
  }
  const remainder = cidr.prefixLen % 16;
  if (remainder === 0) return true;
  const refGroup = cidr.groups[fullBits];
  const targetGroup = groups[fullBits];
  if (refGroup === undefined || targetGroup === undefined) return false;
  const mask = (~((1 << (16 - remainder)) - 1)) & 0xffff;
  return (targetGroup & mask) === (refGroup & mask);
}

function isBlockedV6(addr: string): boolean {
  // Strip zone ID
  const noScope = addr.split('%')[0] ?? addr;
  // Detect IPv4-mapped directly and re-check via v4 rules
  const lower = noScope.toLowerCase();
  if (lower.startsWith('::ffff:')) {
    const tail = lower.substring(7);
    const v4 = ipv4ToInt(tail);
    if (v4 !== null) return isBlockedV4(tail);
  }
  const groups = ipv6ToGroups(noScope);
  if (!groups) return false;
  for (const cidr of BLOCKED_V6_PREFIXES) {
    if (typeof cidr !== 'string') continue;
    const parsed = parseCidrV6(cidr);
    if (!parsed) continue;
    if (ipv6MatchesCidr(groups, parsed)) return true;
  }
  return false;
}

/**
 * Validate a URL and resolve its host to a single safe IP.
 * Throws UnsafeUrlError if the URL is unsafe.
 */
export async function assertSafeUrl(
  rawUrl: string,
  opts: SafeUrlOptions = {},
): Promise<SafeUrlResult> {
  if (typeof rawUrl !== 'string' || rawUrl.length === 0) {
    throw new UnsafeUrlError('INVALID_URL', 'Empty or non-string URL', String(rawUrl));
  }
  if (rawUrl.length > 2048) {
    throw new UnsafeUrlError('URL_TOO_LONG', 'URL exceeds 2048 chars', rawUrl);
  }
  if (/[\x00-\x1f\x7f]/.test(rawUrl)) {
    throw new UnsafeUrlError('CONTROL_CHARS', 'URL contains control characters', rawUrl);
  }

  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch (e) {
    throw new UnsafeUrlError(
      'PARSE_FAIL',
      `Could not parse URL: ${(e as Error).message}`,
      rawUrl,
    );
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new UnsafeUrlError(
      'BAD_SCHEME',
      `Refusing non-http(s) scheme: ${parsed.protocol}`,
      rawUrl,
    );
  }

  // Reject URLs that carry userinfo (user:password@host). WHATWG URL
  // preserves it in toString(), which leaks credentials into logs and
  // cache keys. The scanner has no use for it.
  if (parsed.username !== '' || parsed.password !== '') {
    throw new UnsafeUrlError(
      'USERINFO',
      `Refusing URL with embedded credentials (userinfo)`,
      rawUrl,
    );
  }

  const hostname = parsed.hostname;
  if (!hostname) {
    throw new UnsafeUrlError('NO_HOST', 'URL has no hostname', rawUrl);
  }

  // WHATWG URL keeps brackets around IPv6 hostnames; strip them for parsing.
  const bareHost = hostname.startsWith('[') && hostname.endsWith(']')
    ? hostname.slice(1, -1)
    : hostname;

  const lowerHost = hostname.toLowerCase();
  if (BLOCKED_HOSTNAMES.has(lowerHost)) {
    throw new UnsafeUrlError('BLOCKED_HOSTNAME', `Hostname is in deny-list: ${lowerHost}`, rawUrl);
  }

  // Hostname that is already a literal IP: validate it directly without DNS.
  const literalV4 = ipv4ToInt(bareHost);
  const literalV6Groups = literalV4 === null ? ipv6ToGroups(bareHost) : null;
  if (literalV4 !== null || literalV6Groups !== null) {
    if (!opts.allowPrivate) {
      if (literalV4 !== null && isBlockedV4(bareHost)) {
        throw new UnsafeUrlError(
          'PRIVATE_IP',
          `Literal IPv4 is in a denied range: ${bareHost}`,
          rawUrl,
        );
      }
      if (literalV6Groups !== null && isBlockedV6(bareHost)) {
        throw new UnsafeUrlError(
          'PRIVATE_IP',
          `Literal IPv6 is in a denied range: ${bareHost}`,
          rawUrl,
        );
      }
    }
    return { url: parsed, ip: bareHost };
  }

  // Hostname needs DNS resolution.
  const resolver = opts.resolver ?? defaultResolver;
  let addrs: LookupAddress[];
  try {
    addrs = await resolver(hostname);
  } catch (e) {
    throw new UnsafeUrlError(
      'DNS_FAIL',
      `Could not resolve hostname: ${(e as Error).message}`,
      rawUrl,
    );
  }
  if (addrs.length === 0) {
    throw new UnsafeUrlError('DNS_EMPTY', 'DNS resolver returned no addresses', rawUrl);
  }

  // Reject if ANY resolved address is in a blocked range.
  for (const a of addrs) {
    const fam = a.family;
    const ip = a.address;
    if (fam === 4) {
      if (!opts.allowPrivate && isBlockedV4(ip)) {
        throw new UnsafeUrlError(
          'PRIVATE_IP',
          `DNS resolved to private IPv4: ${ip}`,
          rawUrl,
        );
      }
    } else if (fam === 6) {
      if (!opts.allowPrivate && isBlockedV6(ip)) {
        throw new UnsafeUrlError(
          'PRIVATE_IP',
          `DNS resolved to private IPv6: ${ip}`,
          rawUrl,
        );
      }
    } else {
      throw new UnsafeUrlError('UNKNOWN_FAMILY', `Unknown address family: ${fam}`, rawUrl);
    }
  }

  // Pin the first address; caller MUST use this IP for the connection.
  const first = addrs[0];
  if (!first) {
    throw new UnsafeUrlError('DNS_EMPTY', 'DNS resolver returned no addresses', rawUrl);
  }
  return { url: parsed, ip: first.address };
}