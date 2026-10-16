# Security

The scanner is more dangerous than what it scans. This document calls out
the threats we built against, the mitigations we ship, and the residual
risks we have not yet addressed.

## Threat model

| ID | Threat | Severity | Mitigation |
|----|--------|----------|------------|
| R1 | SSRF: target URL points to internal services (e.g. `http://127.0.0.1:6379`, `http://169.254.169.254/`) | Critical | `assertSafeUrl` blocks RFC1918, loopback, link-local, CGNAT, multicast, TEST-NET, 6to4, Teredo, NAT64, IPv4-compatible ranges for both IPv4 and IPv6; userinfo is rejected |
| R2 | DNS rebinding: first resolve returns public IP, second returns private IP | Critical | DNS is resolved **once** per URL; the IP is pinned and the connection goes through an undici `Agent` whose `connect.host` is the validated IP. SNI stays on the hostname so TLS verification still matches the public cert. Every redirect hop is re-validated. |
| R3 | Untrusted content: pages contain `<script>` payloads that try to call back to attacker infrastructure | High | Playwright contexts run a `page.route()` that aborts any navigation/sub-resource whose host differs from the scan target's origin; the robots fetcher and link/image probes go through `assertSafeUrl`; no `eval`/`Function`/`innerHTML` on response bodies |
| R4 | Resource exhaustion: a single URL expands to millions (calendar pages, sitemap bombs) | High | Hard caps: `maxPages`, `maxDepth`, `maxTimeMs`, `maxBytesPerPage`, **`maxRequests`** (global request counter covering pages, redirects, link probes, asset probes, robots fetches); bounded concurrency (`p-limit`); per-fetch timeout |
| R5 | Open redirect reporting that hides a chain length | Medium | `httpClient` records the full `statusChain` and `locationChain`; the redirect scanner detects loops, long chains, and downgrade |
| R6 | Disk / log poisoning from attacker-controlled bytes | Medium | Filenames derived from a hash of the target; response bodies are never logged at INFO; pino redacts `html`, `body`, `response`, and any field whose name matches a credential-shaped allowlist (`password`, `token`, `cookie`, `authorization`, `*.apiKey`, etc.) |
| R7 | Legal exposure: scanning without authorization may violate CFAA, GDPR, ToS | Medium | README warns; `--quiet` doesn't change this |
| R8 | Supply chain: an OSS scanner is a juicy target | Medium | Lockfile committed; minimal dependency surface; optional `playwright` |

## What `assertSafeUrl` does

Every URL that flows into the network layer must pass `assertSafeUrl`
in `src/fetcher/safeUrl.ts`. This is the **only** path to the network;
no other module may call `fetch`, `undici.fetch`, or `playwright.goto`
directly. The robots fetcher, the page fetcher, and the link/asset
probes all go through it.

Steps in order:

1. Reject empty, oversized (>2048), or control-character URLs.
2. Reject URLs carrying userinfo (`user:password@host`).
3. Parse with `new URL()`; reject any scheme other than `http`/`https`.
4. Reject blocked literal hostnames (`localhost`, `metadata.google.internal`, etc.).
5. If hostname is a literal IP, check it against the deny-list.
6. Otherwise resolve via `dns/promises`, **once**, with `verbatim: true`.
7. Reject if **any** returned address (A or AAAA) is in a denied range.
8. Pin the first returned IP; the caller passes it to an undici `Agent`
   whose `connect.host` is that IP, so the TCP destination can never
   be re-resolved to a different address by a malicious DNS server.

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
| `255.255.255.255/32` | blocked |
| `::1/128` (IPv6 loopback) | blocked |
| `fc00::/7` (IPv6 ULA), `fe80::/10` (link-local) | blocked |
| IPv4-mapped (`::ffff:`) of any blocked v4 | blocked |
| `::/96` (IPv4-compatible, deprecated form) | blocked |
| `2002::/16` (6to4, encapsulates IPv4) | blocked |
| `2001::/32` (Teredo tunneling) | blocked |
| `64:ff9b::/96` and `64:ff9b:1::/48` (NAT64) | blocked |
| `2001:db8::/32` (documentation) | blocked |
| `100::/64` (discard) | blocked |
| `localhost` and friends | blocked |
| `metadata.google.internal` | blocked |
| Numeric IPv4 obfuscation (`0x7f000001`, `2130706433`, etc.) | blocked at URL parse step |
| Embedded credentials (`user:password@host`) | rejected outright |

## DNS-rebinding defense (R2)

Two layers:

1. **Resolve-once + pin.** `assertSafeUrl` resolves the hostname via
   `dns/promises` (verbatim, so `/etc/hosts` etc. don't bypass) and pins
   the first returned address. If any answer is in a denied range, the
   URL is refused — even if other answers are public.
2. **Connection-time enforcement.** The undici `Agent` used for every
   TCP/TLS connection is built with `connect.host = <pinned IP>`,
   `servername = <hostname>`. The platform resolver is bypassed at
   connect time, so a malicious DNS server cannot return a private IP
   after the resolve step. SNI keeps TLS cert validation aligned with
   the public hostname.

Per-hop re-validation in the redirect loop applies the same gate to
every `Location:` so a chain that starts public and later pivots to
private is also blocked.

## Reporting vulnerabilities

If you find a way to bypass `assertSafeUrl`, **please email the maintainer
privately** before disclosing publicly. Treat the package as
security-sensitive: every release is a potential target for abuse.

## Residual risks (not yet addressed)

- **Browser fingerprinting via sub-resources**: cross-origin scripts
  blocked by `page.route()` may still **load enough to fingerprint** the
  default Chromium user-agent. We rely on Playwright's headless + sandbox
  defaults here.
- **IPv6 novel allocations**: only the ranges listed above are denied;
  new IPv6 allocations may slip through until the list is updated.
- **DNS caching via platform resolver**: a remote content URL that
  arrives via a chain of redirects may resolve differently on different
  hops — already mitigated by per-hop `assertSafeUrl`. The connection
  itself is pinned, so no platform-resolver caching is observable.
- **Slow-loris / connection-pool exhaustion**: per-hop `dispatcher.close()`
  releases sockets immediately; per-request timeouts cap the blast
  radius. Open-socket count is not yet tracked globally.
- **ToS / authorization**: the scanner does not check for an
  authorization banner; the README is the only warning.
- **Browser context limits**: we do not constrain total redirect chains
  through Playwright; a hostile page could redirect repeatedly within
  Chromium's default 20-redirect cap.

## Deployment guidance (recommended)

Defense in depth. The application-level protections above block the
documented threats, but should not be the only layer:

- **Outbound network restrictions**: deploy the scanner with a default-
  deny egress policy. Allow only ports 80/443 to public networks. This
  makes the SSRF guard a defense in depth, not the only barrier.
- **Dedicated unprivileged user**: run as a non-root user with no
  credentials and no write access outside the report output directory.
- **No special capabilities**: do not grant `CAP_NET_RAW` or similar;
  the scanner only needs standard TCP/TLS via the platform `fetch`.
- **TLS defaults**: rely on the platform's CA bundle; do not override
  `NODE_EXTRA_CA_CERTS` or disable cert verification.

## Local development guardrails

- The fixture server in `test/fixtures/fixture-server.ts` binds to
  `127.0.0.1`; tests that talk to it must set `allowPrivate: true`
  on the scan config. This is opt-in.
- No response body is ever logged at INFO. Pino redacts `html`, `body`,
  `response`, plus credential-shaped fields (`password`, `token`,
  `cookie`, `*.apiKey`, etc.).
- HTML report renderer escapes `&<>"'` characters by construction and
  the JSON embedded inside `<script>` is stripped of U+2028/U+2029 and
  bidi overrides to defeat naive `<script>` breakouts.
- The XSS regression test in `test/unit/reporters.test.ts` confirms
  payload neutralization.
