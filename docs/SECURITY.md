# Security

The scanner is more dangerous than what it scans. This document calls out
the threats we built against, the mitigations we ship, and the residual
risks we have not yet addressed.

## Threat model

| ID | Threat | Severity | Mitigation |
|----|--------|----------|------------|
| R1 | SSRF: target URL points to internal services (e.g. `http://127.0.0.1:6379`, `http://169.254.169.254/`) | Critical | `assertSafeUrl` blocks RFC1918, loopback, link-local, CGNAT, multicast, TEST-NET ranges for both IPv4 and IPv6 |
| R2 | DNS rebinding: first resolve returns public IP, second returns private IP | Critical | DNS is resolved **once** per URL; the IP is pinned for the duration of the request |
| R3 | Untrusted content: pages contain `<script>` payloads that try to call back to attacker infrastructure | High | Playwright contexts are isolated; sub-resource calls outside the target are not made; no `eval`/`Function`/`innerHTML` on response bodies |
| R4 | Resource exhaustion: a single URL expands to millions (calendar pages, sitemap bombs) | High | Hard caps: `maxPages`, `maxDepth`, `maxTimeMs`, `maxBytesPerPage`; bounded concurrency (`p-limit`) |
| R5 | Open redirect reporting that hides a chain length | Medium | `httpClient` records the full `statusChain` and `locationChain`; the redirect scanner detects loops, long chains, and downgrade |
| R6 | Disk / log poisoning from attacker-controlled bytes | Medium | Filenames derived from a hash of the target; response bodies are never logged at INFO |
| R7 | Legal exposure: scanning without authorization may violate CFAA, GDPR, ToS | Medium | README warns; `--quiet` doesn't change this |
| R8 | Supply chain: an OSS scanner is a juicy target | Medium | Lockfile committed; minimal dependency surface; optional `playwright` |

## What `assertSafeUrl` does

Every URL that flows into the network layer must pass `assertSafeUrl`
in `src/fetcher/safeUrl.ts`. This is the **only** path to the network;
no other module may call `fetch` or `playwright.goto` directly.

Steps in order:

1. Reject empty, oversized (>2048), or control-character URLs.
2. Parse with `new URL()`; reject any scheme other than `http`/`https`.
3. Reject blocked literal hostnames (`localhost`, `metadata.google.internal`, etc.).
4. If hostname is a literal IP, check it against the deny-list.
5. Otherwise resolve via `dns/promises`, **once**, with `verbatim: true`.
6. Reject if **any** returned address (A or AAAA) is in a denied range.
7. Pin the first returned IP; the caller **must** use it for the connection.

Coverage matrix (see `test/unit/safeUrl.test.ts`):

| Range | Status |
|-------|--------|
| `127.0.0.0/8` (loopback) | blocked |
| `10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16` | blocked |
| `169.254.0.0/16` (link-local incl. metadata) | blocked |
| `100.64.0.0/10` (CGNAT) | blocked |
| `0.0.0.0/8` | blocked |
| `192.0.2.0/24`, `198.51.100.0/24`, `203.0.113.0/24` (TEST-NET) | blocked |
| `198.18.0.0/15` (benchmark) | blocked |
| `224.0.0.0/4` (multicast), `240.0.0.0/4` (reserved) | blocked |
| `::1/128` (IPv6 loopback) | blocked |
| `fc00::/7` (IPv6 ULA), `fe80::/10` (link-local) | blocked |
| IPv4-mapped (`::ffff:`) of any blocked v4 | blocked |
| `2001:db8::/32` (documentation) | blocked |
| `100::/64` (discard) | blocked |
| `localhost` and friends | blocked |
| `metadata.google.internal` | blocked |
| Numeric IPv4 obfuscation (`0x7f000001`, `2130706433`, etc.) | blocked at URL parse step |

## Reporting vulnerabilities

If you find a way to bypass `assertSafeUrl`, **please email the maintainer
privately** before disclosing publicly. Treat the package as
security-sensitive: every release is a potential target for abuse.

## Residual risks (not yet addressed)

- **Browser fingerprinting via sub-resources**: a page may include a
  third-party script that fingerprints the user-agent. We do not
  isolate this — Playwright's default sandboxing is the only barrier.
- **IPv6 SLAAC address confusion**: only the ranges listed above are
  denied; novel IPv6 allocations may slip through until the list is
  updated.
- **Slow-loris / connection-pool exhaustion**: `timeoutMs` caps
  per-request; long-lived idle sockets are limited by `maxConcurrency`.
  A future version should track open sockets globally.
- **ToS / authorization**: the scanner does not check for an
  authorization banner; the README is the only warning.

## Local development guardrails

- The fixture server in `test/fixtures/fixture-server.ts` binds to
  `127.0.0.1`; tests that talk to it must set `allowPrivate: true`
  on the scan config. This is opt-in.
- No response body is ever logged at INFO. Pino redacts `html`, `body`,
  `response` paths.
- HTML report renderer escapes `&<>"'` characters by construction;
  the XSS regression test in `test/unit/reporters.test.ts` confirms
  payload neutralization.