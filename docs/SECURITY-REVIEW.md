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
2. Reject non-http(s) schemes (file:, data:, javascript:, gopher:, ftp:).
3. Reject literal `localhost`, `metadata.google.internal`, etc.
4. If hostname is a literal IP, validate against the deny-list.
5. Otherwise resolve ONCE via `dns/promises` with `verbatim: true`.
6. Reject if ANY returned address (A or AAAA) is in a denied range.
7. Pin the first resolved IP; caller must use it for the connection.

**Coverage:** `test/unit/safeUrl.test.ts` — 54 tests across 8 describe
blocks. Includes:
- All RFC1918 ranges (10/8, 172.16/12, 192.168/16)
- Loopback (127/8, ::1)
- Link-local + cloud metadata (169.254/16, fe80::/10, ::ffff:169.254.169.254)
- CGNAT (100.64/10) — fixed during this phase
- TEST-NET-1/2/3, benchmark, multicast, reserved
- IPv6 ULA, IPv6 documentation, IPv4-mapped private
- DNS empty / DNS fail
- IDN homograph `ⓛocalhost` (parser normalizes → blocked)
- Numeric IPv4 obfuscation (URL parser rejects)
- `allowPrivate` opt-in

**Residual risk:** IPv6 allocations not yet in the deny-list (rare, but
new prefixes get assigned). Operators running this against an internal
range should NOT use `--allow-private` against user-supplied input.

### 2. `fetchPage` — manual redirect chain

**Where it lives:** `src/fetcher/httpClient.ts`.

**Guards applied:**
- `redirect: 'manual'` on `fetch` so we never auto-follow.
- Each `Location:` is run through `assertSafeUrl` before the next hop.
- Hard cap of 10 hops; exceeding throws `FetchError('REDIRECT_LOOP')`.
- Per-request timeout via `AbortController`.
- Body cap via streaming read with cancellation when limit exceeded.

**What could go wrong:** an attacker sets a `Location:` to a URL that
*resolves publicly* on the first hop but *resolves privately* on a
subsequent hop. **Mitigation:** `assertSafeUrl` is called per hop, so
each hop is independently re-validated. The first-hop-public /
later-hop-private DNS rebinding is therefore caught.

**Test:** `test/unit/safeUrl.test.ts > resolves ONCE; later private
resolve must not be used` — documents the pin-once guarantee for the
single-fetch case. For multi-hop, the per-hop re-validation gives us
defense in depth.

### 3. `runScan` — BFS orchestration

**Where it lives:** `src/core/orchestrator.ts`.

**Guards applied:**
- Same-origin enforcement: `if (!sameOrigin(abs, originTarget)) return;`
  where `originTarget` is **locked at scan start from the original
  input target**, NOT from the page URL. A redirect-in-page cannot widen
  the scan scope.
- Budget: `maxPages`, `maxDepth`, `maxTimeMs`, `maxBytesPerPage`.
- Concurrency cap: `p-limit(config.concurrency)`.
- Per-host rate limit: `config.rateMs` between batches.
- robots.txt respected (default on, `--no-robots` to disable).
- AbortSignal honored on every iteration.

**Tests:**
- `test/e2e/crawl.test.ts > respects same-origin enforcement (no
  external follow)` — proves external.test is probed but never crawled.
- `test/e2e/orchestrator.test.ts > respects max-pages budget`.

**What could go wrong:** an attacker controls DNS for `example.com`
and, mid-scan, returns different IPs for `example.com`. The first hop
resolves publicly; subsequent hops for the *same origin* may redirect
to private ranges via the attacker. Mitigation: `assertSafeUrl` is
re-validated on every redirect hop (see #2). The orchestrator's
same-origin lock prevents cross-origin widening.

### 4. Scanners — link, image, meta, redirects, accessibility, duplicates

**What they do:** parse already-fetched HTML and report findings.

**Security considerations:**
- All parsing is via `cheerio` (server-side jQuery-like parser). No
  `eval`, no `Function`, no `dangerouslySetInnerHTML`.
- HTML never flows back into a request URL without going through
  `assertSafeUrl` (link scanner re-validates).
- Asset records are deduplicated through `ProbeCache` to prevent
  amplification — a single page referencing the same `<img>` 100x
  results in 1 network request, not 100.

**Test:** `test/unit/reporters.test.ts > renderHtml is a self-contained
HTML page with XSS-safe escaping` — confirms payload neutralization.

### 5. Playwright scanners — JS errors, mobile overflow

**Where:** `src/scanners/browser.ts`. Optional.

**Guards applied:**
- Default Chromium headless with sandbox on (operator must explicitly
  opt out with `args: ['--no-sandbox']`, which we never do).
- `waitUntil: 'networkidle'` for JS error; `domcontentloaded` for
  mobile (otherwise the viewport check runs before content settles).
- 30-second navigation timeout.
- Single context per scan; contexts are closed.
- Browser process killed in `finally` block.

**Test:** scanner crashes (Playwright not installed) are caught by
orchestrator; the result is an INFO-level "skipped" finding, not a
crash.

### 6. Report serialization

**Where:** `src/core/report.ts`.

**Guards applied:**
- `validateAndSanitize` runs on every ScanResult before it's serialized.
- Strips control characters from all string fields.
- Caps finding list to 100k.
- Drops findings with unknown types (coerced to `scanner_error`).
- Drops findings with non-string `message` or `page`.
- Strips forbidden keys from `detail` (defense in depth: if a scanner
  accidentally logs a cookie or bearer token, it doesn't end up in the
  report).
- Caps `fix` and `detail` string field lengths.

**Test:** `test/unit/report.test.ts` — 12 tests.

**What could still leak:** the target URL is logged at the orchestrator
INFO level (operator-visible). The target is also embedded in
`request_failed` findings. This is intentional and required for the
report to be useful.

### 7. Logging

**Where:** `src/utils/logger.ts`.

**Guards applied:**
- Pino configured with `redact: ['html', 'body', 'response']`.
- Logger writes to STDERR, not STDOUT — the report (JSON/SARIF/HTML)
  stays clean on STDOUT for piping into other tools.
- Default level is `info`; `--quiet` sets to `error`.

**Test:** visual inspection only — we don't have a regression test for
"this string never lands in logs" because pino's redaction is a
vendor-feature. (Future: add a vitest that scans log output for
sensitive substrings.)

## Threat matrix

| ID | Threat | Where addressed | Test |
|----|--------|-----------------|------|
| R1 | SSRF | `assertSafeUrl` (steps 4-6) | safeUrl.test.ts |
| R2 | DNS rebinding | `assertSafeUrl` (resolve once + pin) + per-hop re-validation in `fetchPage` | safeUrl.test.ts "resolves ONCE" |
| R3 | Untrusted content | cheerio (no eval); XSS-safe report renderer | reporters.test.ts "XSS-safe escaping" |
| R4 | Resource exhaustion | budget checks in orchestrator; body cap in fetchPage | orchestrator.test.ts; crawl.test.ts "enforces maxBytesPerPage" |
| R5 | Redirect chain rewriting | manual redirect, per-hop re-validation, 10-hop cap | safeUrl.test.ts |
| R6 | Disk / log poisoning | report sanitization; pino redaction; STDERR-only logging | report.test.ts |
| R7 | Legal | README + SECURITY.md warnings | manual / docs |
| R8 | Supply chain | pinned deps in package.json; optional Playwright | npm audit in CI |

## Residual risks

1. **Operator mistakes.** `--allow-private` against untrusted input is
   the obvious foot-gun. There is no UI guard against this; the operator
   is responsible.
2. **TOCTOU on per-hop re-validation.** The re-validation runs DNS at
   hop time, so the result is current. There is no scenario where a
   redirect's `Location:` URL bypasses the gate.
3. **Browser fingerprinting via sub-resources.** Pages with
   third-party scripts may fingerprint Playwright. We do not isolate
   this; users running the scanner against hostile sites should consider
   the threat surface.
4. **Slow-loris / connection-pool exhaustion.** `timeoutMs` and
   `maxConcurrency` bound the per-request and total blast radius. A
   future version should track open sockets globally.
5. **Cryptographic issues are out of scope.** We use the platform
   `fetch` defaults and never override TLS rejection.
6. **Authorization.** README + SECURITY.md warn. There is no in-band
   check for an authorization banner; this is intentional and the
   operator's responsibility.

## CI guardrails

- `npm run typecheck` — strict TypeScript with `noUncheckedIndexedAccess` and `exactOptionalPropertyTypes`. This catches off-by-one and undefined-prop bugs at compile time.
- `npm run lint` — 0-warning policy with `@typescript-eslint/no-explicit-any` as warn.
- `npm test` — 133 vitest tests, including the safeUrl suite which is the regression net for the security gate.

## Reporting a vulnerability

Open a private security advisory via GitHub Security. The maintainer
will acknowledge within 72 hours.