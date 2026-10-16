import { describe, it, expect } from 'vitest';
import {
  assertSafeUrl,
  UnsafeUrlError,
  type SafeUrlOptions,
} from '../../src/fetcher/safeUrl.js';

/**
 * SSRF / DNS rebinding guard rail. Every private/reserved range called
 * out in the security review (R1) must be rejected. Public addresses
 * (and the literal external test range) must pass. We use a stubbed
 * resolver so the suite is hermetic.
 */

const publicResolver: SafeUrlOptions['resolver'] = async () => [
  { address: '93.184.216.34', family: 4 },
];

const ipv6PublicResolver: SafeUrlOptions['resolver'] = async () => [
  { address: '2606:2800:220:1:248:1893:25c8:1946', family: 6 },
];

const failingResolver: SafeUrlOptions['resolver'] = async () => {
  const err = new Error('no such host');
  (err as Error & { code: string }).code = 'ENOTFOUND';
  throw err;
};

describe('safeUrl — scheme allowlist', () => {
  it.each([
    ['file:///etc/passwd'],
    ['javascript:alert(1)'],
    ['data:text/html,<script>alert(1)</script>'],
    ['ftp://example.com/'],
    ['gopher://example.com/'],
  ])('rejects %s', (u) => {
    expect(() => assertSafeUrl(u)).rejects.toBeInstanceOf(UnsafeUrlError);
  });

  it('accepts http and https', async () => {
    const r = await assertSafeUrl('https://example.com/', { resolver: publicResolver });
    expect(r.url.protocol).toBe('https:');
    expect(r.ip).toBe('93.184.216.34');
  });
});

describe('safeUrl — control characters & malformed input', () => {
  it('rejects empty string', async () => {
    await expect(assertSafeUrl('')).rejects.toMatchObject({ code: 'INVALID_URL' });
  });
  it('rejects control chars', async () => {
    await expect(assertSafeUrl('http://ex.com/\x00bad')).rejects.toMatchObject({
      code: 'CONTROL_CHARS',
    });
    await expect(assertSafeUrl('http://ex.com/\nbad')).rejects.toMatchObject({
      code: 'CONTROL_CHARS',
    });
  });
  it('rejects URLs longer than 2048 chars', async () => {
    const huge = 'http://a.b/' + 'a'.repeat(3000);
    await expect(assertSafeUrl(huge)).rejects.toMatchObject({ code: 'URL_TOO_LONG' });
  });
  it('rejects unparseable input', async () => {
    await expect(assertSafeUrl('not-a-url')).rejects.toBeInstanceOf(UnsafeUrlError);
  });
});

describe('safeUrl — hostname deny-list', () => {
  it.each([
    'http://localhost/',
    'http://localhost:8080/admin',
    'http://localhost.localdomain/',
    'http://ip6-localhost/',
  ])('rejects %s', async (u) => {
    await expect(assertSafeUrl(u)).rejects.toMatchObject({ code: 'BLOCKED_HOSTNAME' });
  });
});

describe('safeUrl — literal IPv4 ranges', () => {
  const blockedV4 = [
    ['127.0.0.1', 'loopback'],
    ['127.255.255.255', 'loopback edge'],
    ['10.0.0.1', 'private 10/8'],
    ['10.255.255.255', 'private 10/8 edge'],
    ['172.16.0.1', 'private 172.16/12'],
    ['172.31.255.255', 'private 172.16/12 edge'],
    ['192.168.0.1', 'private 192.168/16'],
    ['192.168.255.255', 'private 192.168/16 edge'],
    ['169.254.169.254', 'AWS / GCP / Azure metadata'],
    ['100.64.0.1', 'CGNAT'],
    ['100.127.255.255', 'CGNAT edge'],
    ['0.0.0.0', 'unspecified'],
    ['224.0.0.1', 'multicast'],
    ['255.255.255.255', 'broadcast'],
    ['198.51.100.1', 'TEST-NET-2'],
    ['203.0.113.1', 'TEST-NET-3'],
    ['192.0.2.1', 'TEST-NET-1'],
  ];

  it.each(blockedV4)('rejects literal %s (%s)', async (ip) => {
    await expect(assertSafeUrl(`http://${ip}/`)).rejects.toMatchObject({
      code: 'PRIVATE_IP',
    });
  });

  it('accepts literal 93.184.216.34 (public)', async () => {
    const r = await assertSafeUrl('http://93.184.216.34/');
    expect(r.ip).toBe('93.184.216.34');
  });
});

describe('safeUrl — literal IPv6 ranges', () => {
  const blockedV6 = [
    ['[::1]', 'IPv6 loopback'],
    ['[fe80::1]', 'IPv6 link-local'],
    ['[fc00::1]', 'IPv6 ULA'],
    ['[fd00::1]', 'IPv6 ULA alternate'],
    ['[::ffff:127.0.0.1]', 'IPv4-mapped loopback'],
    ['[::ffff:10.0.0.1]', 'IPv4-mapped private 10/8'],
    ['[::ffff:169.254.169.254]', 'IPv4-mapped metadata'],
    ['[2001:db8::1]', 'documentation prefix'],
    ['[::]', 'unspecified'],
  ];

  it.each(blockedV6)('rejects literal %s (%s)', async (ip) => {
    await expect(assertSafeUrl(`http://${ip}/`)).rejects.toMatchObject({
      code: 'PRIVATE_IP',
    });
  });

  it('accepts literal 2606:2800:220:1::1 (public)', async () => {
    const r = await assertSafeUrl('http://[2606:2800:220:1::1]/');
    expect(r.ip).toBe('2606:2800:220:1::1');
  });
});

describe('safeUrl — DNS resolution rejects private', () => {
  it('rejects if A record is in 127.0.0.0/8', async () => {
    const resolver: SafeUrlOptions['resolver'] = async () => [
      { address: '127.0.0.1', family: 4 },
    ];
    await expect(
      assertSafeUrl('http://attacker.example/', { resolver }),
    ).rejects.toMatchObject({ code: 'PRIVATE_IP' });
  });

  it('rejects if any of multiple A records is private', async () => {
    const resolver: SafeUrlOptions['resolver'] = async () => [
      { address: '93.184.216.34', family: 4 },
      { address: '10.0.0.5', family: 4 },
    ];
    await expect(
      assertSafeUrl('http://attacker.example/', { resolver }),
    ).rejects.toMatchObject({ code: 'PRIVATE_IP' });
  });

  it('rejects AAAA in fc00::/7', async () => {
    const resolver: SafeUrlOptions['resolver'] = async () => [
      { address: 'fc00::1', family: 6 },
    ];
    await expect(
      assertSafeUrl('http://attacker.example/', { resolver }),
    ).rejects.toMatchObject({ code: 'PRIVATE_IP' });
  });

  it('rejects AAAA in fe80::/10 (link-local)', async () => {
    const resolver: SafeUrlOptions['resolver'] = async () => [
      { address: 'fe80::1', family: 6 },
    ];
    await expect(
      assertSafeUrl('http://attacker.example/', { resolver }),
    ).rejects.toMatchObject({ code: 'PRIVATE_IP' });
  });

  it('rejects when DNS returns empty', async () => {
    const resolver: SafeUrlOptions['resolver'] = async () => [];
    await expect(
      assertSafeUrl('http://attacker.example/', { resolver }),
    ).rejects.toMatchObject({ code: 'DNS_EMPTY' });
  });

  it('rejects when DNS resolver throws', async () => {
    await expect(
      assertSafeUrl('http://attacker.example/', { resolver: failingResolver }),
    ).rejects.toMatchObject({ code: 'DNS_FAIL' });
  });

  it('accepts a hostname resolving to a public IPv4', async () => {
    const r = await assertSafeUrl('https://example.com/', { resolver: publicResolver });
    expect(r.ip).toBe('93.184.216.34');
    expect(r.url.hostname).toBe('example.com');
  });

  it('accepts a hostname resolving to a public IPv6', async () => {
    const r = await assertSafeUrl('https://example.com/', { resolver: ipv6PublicResolver });
    expect(r.ip).toBe('2606:2800:220:1:248:1893:25c8:1946');
  });
});

describe('safeUrl — DNS rebinding simulation', () => {
  it('resolves ONCE; later private resolve must not be used', async () => {
    // Simulate: first resolution is public; second resolution would be private.
    // assertSafeUrl only consults the resolver once, so the second is irrelevant.
    let calls = 0;
    const resolver: SafeUrlOptions['resolver'] = async () => {
      calls++;
      return [{ address: '93.184.216.34', family: 4 }];
    };
    const r = await assertSafeUrl('http://attacker.example/', { resolver });
    expect(calls).toBe(1);
    expect(r.ip).toBe('93.184.216.34');
  });
});

describe('safeUrl — allowPrivate opt-in', () => {
  it('allows private IPs only when opted in', async () => {
    await expect(
      assertSafeUrl('http://127.0.0.1/', { allowPrivate: true }),
    ).resolves.toBeTruthy();
    await expect(assertSafeUrl('http://127.0.0.1/')).rejects.toBeInstanceOf(UnsafeUrlError);
  });
});

describe('safeUrl — IDN / Unicode hostname normalization', () => {
  it('rejects IDN "ⓛocalhost" because WHATWG parser normalizes it to "localhost"', async () => {
    // The URL parser applies NFKC normalization, so the unicode homograph
    // collapses to "localhost" which is denied by BLOCKED_HOSTNAMES. Good.
    await expect(assertSafeUrl('http://ⓛocalhost/')).rejects.toMatchObject({
      code: 'BLOCKED_HOSTNAME',
    });
  });
});

describe('safeUrl — IPv4 decimal/octal/hex tricks (literal)', () => {
  // WHATWG URL parser rejects decimal/hex/octal IPv4 literals in URLs.
  // assertSafeUrl uses URL parsing, so those forms fail to parse. We document
  // that here: the URL parser is our first line of defense against numeric
  // obfuscation tricks.
  it('rejects decimal-form IPv4', async () => {
    await expect(
      assertSafeUrl('http://2130706433/', { resolver: publicResolver }),
    ).rejects.toBeInstanceOf(UnsafeUrlError);
  });
});