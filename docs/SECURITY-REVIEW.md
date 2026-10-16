# Security Review — Crawler Path

**Scope:** every code path that performs network I/O during a scan, the
guards around each, what tests cover them, and the residual risks we
have not yet addressed.

**Verdict:** the design is sound for a public-internet scanner that runs
as an unprivileged user with no special network reach. The chief risk is
operator error (using `--allow-private` on untrusted input, or scanning
without authorization).

## Path-by-path review

### 1. `assertSafeUrl` — the SSRF / DNS-rebinding gate

**Where it lives:** `src/fetcher/safeUrl.ts`. The single chokepoint.
Every URL that enters the network layer must pass through it.

**What it does (in order):**
1. Reject empty, oversized (>2048), or control-character URLs.
2. Reject URLs carrying userinfo (`user:password@host`).
3. Reject non-http(s) schemes (file:, data:, javascript:, gopher:, ftp:).
4. Reject literal `localhost`, `metadata.google.internal`, etc.
5. If hostname is a literal IP, validate against the deny-list.
6. Otherwise resolve ONCE via `dns/promises` with `verbatim: true`.
7. Reject if ANY returned address (A or AAAA) is in a denied range.
8. Pin the first resolved IP; caller passes it to an undici `Agent`
   so the connection's TCP destination cannot be re-resolved.

**Coverage:** `test/unit/safeUrl.test.ts` — covers all listed ranges
including:
- All RFC1918 ranges (10/8, 172.16/12, 192.168/16)
- Loopback (127/8, ::1)
- Link-local + cloud metadata (169.254/16, fe80::/10, ::ffff:169.254.169.254)
- CGNAT (100.64/10)
- TEST-NET-1/2/3, benchmark, multicast, reserved
- IPv6 ULA, IPv6 documentation, IPv4-mapped private
- 6to4 (`2002::/16`), Teredo (`2001::/32`), NAT64 (`64:ff9b::/96`)
- IPv4-compatible (`::/96`)
- DNS empty / DNS fail
- IDN homograph `ⓛocalhost` (parser normalizes → blocked)
- Numeric IPv4 obfuscation (URL parser rejects)
- Embedded credentials (userinfo)
- `allowPrivate` opt-in

**Residual risk:** IPv6 allocations not yet in the deny-list (rare, but
new prefixes get assigned). Operators running this against an internal
range should NOT use `--allow-private` against user-supplied input.

### 2. `fetchPage` — manual redirect chain + IP pinning

**Where it lives:** `src/fetcher/httpClient.ts`.

**Guards applied:**
- `redirect: 'manual'` on `fetch` so we never auto-follow.
- Each `Location:` is run through `assertSafeUrl` before the next hop.
- Hard cap of 10 hops; exceeding throws `FetchError('REDIRECT_LOOP')`.
- Per-request timeout via `AbortController`, plus caller-supplied
  `AbortSignal` for cooperative cancellation.
- Body cap via streaming read with cancellation when limit exceeded.
- **Connection-time IP pinning.** Each fetch goes through an undici
  `Agent({ connect: { host: pinnedIp, port, servername: hostname }})`.
  The platform resolver is bypassed at connect time.
- `dispatcher.close()` releases sockets in the `finally` block.

**What could go wrong:** an attacker sets a `Location:` to a URL that
*resolves publicly* on the first hop but *resolves privately* on a
subsequent hop. **Mitigation:** `assertSafeUrl` is called per hop, and
each per-hop connection goes through a freshly-built `Agent` whose IP
was re-pinned at that hop. The first-hop-public / later-hop-private
DNS rebinding scenario is therefore impossible regardless of DNS caching.

**Test:** `test/unit/safeUrl.test.ts > resolves ONCE; later private
resolve must not be used` — documents the pin-once guarantee for the
single-fetch case. For multi-hop, the per-hop re-validation gives us
defense in depth.

### 3. `robots.ts` — gated robots fetcher

**Where it lives:** `src/fetcher/robots.ts`. Previously used a raw
`fetch(robotsUrl)` that bypassed `assertSafeUrl`; now goes through the
same gate.

**Guards applied:**
- Every robots URL passes through `assertSafeUrl` before any I/O.
- Per-fetch undici `Agent` pins the connection to the validated IP.
- A re-lookup just before the fetch adds a second DNS check; if any
  answer is in a private IPv4 range, the robots body is treated as
  unavailable (i.e., allowed by default).
- Per-fetch 5s timeout, plus caller-supplied `AbortSignal`.
- Failure modes: invalid URL, denied range, re-validation fail, network
  error — all treated as "no robots.txt" (allow), since robots.txt is
  advisory and a fail-open behavior matches the spec's posture.

**Test:** covered transitively via the existing `crawl.test.ts` and the
`safeUrl.test.ts` deny-list. (Explicit unit tests for the new path
are tracked as a follow-up.)

### 4. `runScan` — BFS orchestration + global budget

**Where it lives:** `src/core/orchestrator.ts`.

**Guards applied:**
- Same-origin enforcement: `if (!sameOrigin(abs, originTarget)) return;`
  where `originTarget` is **locked at scan start from the original
  input target**, NOT from the page URL. A redirect-in-page cannot widen
  the scan scope.
- Budget: `maxPages`, `maxDepth`, `maxTimeMs`, `maxBytesPerPage`,
  `maxRequests` (NEW: global request counter for pages, redirects,
  link probes, asset probes, robots fetches).
- Concurrency cap: `p-limit(config.concurrency)`.
- Per-host rate limit: `config.rateMs` between batches.
- robots.txt respected (default on, `--no-robots` to disable).
- Internal `AbortSignal` honored at every iteration; also forwarded
  to each `fetchPage` and scanner call so half-finished work aborts.
- `errors[]` is capped at 200 entries to bound report size.
- Error messages are passed through `redactErrorMessage` which strips
  control chars, stack frames, and bidi controls, and caps length.

**Tests:**
- `test/e2e/crawl.test.ts > respects same-origin enforcement (no
  external follow)` — proves external.test is probed but never crawled.
- `test/e2e/orchestrator.test.ts > respects max-pages budget`.

**What could go wrong:** an attacker controls DNS for `example.com`
and, mid-scan, returns different IPs for `example.com`. Mitigation:
every redirect hop and every probe goes through `assertSafeUrl` AND
pins the IP for the connection. The orchestrator's same-origin lock
prevents cross-origin widening.

### 5. Scanners — link, image, meta, redirects, accessibility, duplicates

**What they do:** parse already-fetched HTML and report findings.

**Security considerations:**
- All parsing is via `cheerio` (server-side jQuery-like parser). No
  `eval`, no `Function`, no `dangerouslySetInnerHTML`.
- HTML never flows back into a request URL without going through
  `assertSafeUrl` (link scanner re-validates).
- Asset records are deduplicated through `ProbeCache` to prevent
  amplification — a single page referencing the same `<img>` 100x
  results in 1 network request, not 100.
- Abort signals are threaded through `scanLinks` and `scanImages` so
  a budget-aborted orchestrator also aborts in-flight probes.

**Test:** `test/unit/reporters.test.ts > renderHtml is a self-contained
HTML page with XSS-safe escaping` — confirms payload neutralization.

### 6. Playwright scanners — JS errors, mobile overflow

**Where:** `src/scanners/browser.ts`. Optional.

**Guards applied:**
- Default Chromium headless with sandbox on (operator must explicitly
  opt out with `args: ['--no-sandbox']`, which we never do).
- 30s browser **launch** timeout so a hung Chromium does not stall the
  scan (`chromium.launch({ timeout })`).
- Per-context `setDefaultNavigationTimeout` and `setDefaultTimeout`.
- A `page.route('**/*', handler)` aborts any navigation/sub-resource
  request whose host differs from the scan target's origin (defense
  against remote JS calling back to internal hosts).
- `waitUntil: 'networkidle'` for JS error; `domcontentloaded` for
  mobile (otherwise the viewport check runs before content settles).
- 30-second navigation timeout.
- Single context per scan; contexts are closed.
- Browser process killed in `finally` block.

**Test:** scanner crashes (Playwright not installed) are caught by
orchestrator; the result is an INFO-level "skipped" finding, not a
crash.

### 7. Report serialization

**Where:** `src/core/report.ts`.

**Guards applied:**
- `validateAndSanitize` runs on every ScanResult before it's serialized.
- `sanitizeString` strips: ASCII control chars, U+2028/U+2029, zero-width
  and bidi override characters, BOM.
- Caps finding list to 100k.
- Drops findings with unknown types (coerced to `scanner_error`).
- Drops findings with non-string `message` or `page`.
- Strips forbidden keys from `detail` (defense in depth: if a scanner
  accidentally logs a cookie or bearer token, it doesn't end up in the
  report).
- Caps `fix` and `detail` string field lengths.

**Test:** `test/unit/report.test.ts`.

**What could still leak:** the target URL is logged at the orchestrator
INFO level (operator-visible). The target is also embedded in
`request_failed` findings. This is intentional and required for the
report to be useful.

### 8. Logging

**Where:** `src/utils/logger.ts`.

**Guards applied:**
- Pino configured with `redact` paths: response bodies (`html`, `body`,
  `response`) and credential-shaped fields (`password`, `token`,
  `cookie`, `authorization`, `*.apiKey`, etc., at top-level and one
  level deep).
- Logger writes to STDERR, not STDOUT — the report (JSON/SARIF/HTML)
  stays clean on STDOUT for piping into other tools.
- Default level is `info`; `--quiet` sets to `error`.
- The fatal path (`main().catch(...)`) logs only `name` and a 240-char
  redacted message; no stack traces.

**Test:** visual inspection only — we don't have a regression test for
"this string never lands in logs" because pino's redaction is a
vendor-feature. (Future: add a vitest that scans log output for
sensitive substrings.)

## Threat matrix

| ID | Threat | Where addressed | Test |
|----|--------|-----------------|------|
| R1 | SSRF | `assertSafeUrl` (all listed ranges) + connections pinned via undici | safeUrl.test.ts |
| R2 | DNS rebinding | `assertSafeUrl` (resolve once + pin) + undici Agent on every connection + per-hop re-validation | safeUrl.test.ts "resolves ONCE" |
| R3 | Untrusted content | cheerio (no eval); XSS-safe report renderer; `page.route()` in Playwright blocks cross-origin | reporters.test.ts "XSS-safe escaping" |
| R4 | Resource exhaustion | budget checks in orchestrator (incl. `maxRequests`); body cap in fetchPage; per-hop dispatcher.close() | orchestrator.test.ts; crawl.test.ts "enforces maxBytesPerPage" |
| R5 | Redirect chain rewriting | manual redirect, per-hop re-validation, 10-hop cap | safeUrl.test.ts |
| R6 | Disk / log poisoning | report sanitization (incl. U+2028/U+2029); pino redaction (incl. credentials); STDERR-only logging; fatal-path no-stack | report.test.ts |
| R7 | Legal | README + SECURITY.md warnings | manual / docs |
| R8 | Supply chain | pinned deps in package.json; optional Playwright | npm audit in CI |

## Residual risks

1. **Operator mistakes.** `--allow-private` against untrusted input is
   the obvious foot-gun. There is no UI guard against this; the operator
   is responsible.
2. **TOCTOU on per-hop re-validation.** The re-validation runs DNS at
   hop time, so the result is current. The connection itself is pinned,
   so no platform-resolver caching is observable.
3. **Browser fingerprinting via sub-resources.** The `page.route()` guard
   blocks cross-origin requests, but cross-origin scripts blocked at
   the network layer may still load enough to fingerprint the default
   Chromium user-agent. Users running the scanner against hostile sites
   should consider the threat surface.
4. **Slow-loris / connection-pool exhaustion.** Per-hop
   `dispatcher.close()` releases sockets; per-request timeouts and
   `maxConcurrency` bound the blast radius. Open-socket count is not
   yet tracked globally.
5. **Cryptographic issues are out of scope.** We use the platform
   `fetch` defaults and never override TLS rejection. Application-level
   pinning does NOT change TLS trust; the IP is sent to the platform's
   certificate validator with `servername` set to the hostname.
6. **Authorization.** README + SECURITY.md warn. There is no in-band
   check for an authorization banner; this is intentional and the
   operator's responsibility.
7. **Deployment-layer outbound restrictions.** Application-level SSRF
   defenses cannot fully substitute for egress firewalling. Operators
   are encouraged to deploy with a default-deny outbound policy. See
   SECURITY.md "Deployment guidance".

## CI guardrails

- `npm run typecheck` — strict TypeScript with `noUncheckedIndexedAccess` and `exactOptionalPropertyTypes`. This catches off-by-one and undefined-prop bugs at compile time.
- `npm run lint` — 0-warning policy with `@typescript-eslint/no-explicit-any` as warn.
- `npm test` — vitest tests, including the safeUrl suite which is the regression net for the security gate.

## Reporting a vulnerability

Open a private security advisory via GitHub Security. The maintainer
will acknowledge within 72 hours.