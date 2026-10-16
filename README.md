# Website Bug Hunter (WBH)

> Open-source website bug & quality scanner — broken links, broken images,
> JS console errors, redirect anomalies, missing metadata, accessibility
> issues, mobile responsiveness. Built with security as the gate, not an
> afterthought.

[![Node](https://img.shields.io/badge/node-%3E%3D20-blue)]()
[![License: MIT](https://img.shields.io/badge/license-MIT-green)]()

WBH is a single-binary Node CLI that fetches a public URL over HTTP(S),
walks its same-origin links up to a configurable budget, and emits a
report of website-quality findings. Every outbound request passes through
`assertSafeUrl`, the SSRF / DNS-rebinding gate, so the scanner cannot be
tricked into reaching RFC1918, loopback, link-local, multicast, or cloud-
metadata destinations.

## What it does

Given a target URL, WBH will:

1. Resolve and pin the target's IP through `assertSafeUrl`. Refuse to
   scan if the URL points at a denied range.
2. Respect `robots.txt` for the origin (configurable).
3. BFS-walk same-origin pages up to `--max-pages`, `--max-depth`, and
   `--max-time` (and a global `--max-requests` cap).
4. Probe every link and image reference, deduplicated through a bounded
   `ProbeCache` so a navigation link shared by N pages is probed once.
5. Detect redirect loops, long chains, and https→http downgrades.
6. Validate page metadata (title, charset, viewport, description,
   canonical, favicon, `<html lang>`).
7. Detect accessibility issues (missing `alt`, missing or multiple
   `<h1>`, heading-level skips).
8. Detect cross-page duplicate titles, descriptions, and canonicals.
9. Optionally (when Playwright is installed) load the start URL in
   headless Chromium and report JS console errors, uncaught page errors,
   sub-resource 4xx/5xx, and horizontal overflow at mobile/tablet sizes.
10. Render the report in your choice of formats: `json`, `text`, `sarif`,
    `html`, `csv`, or `export` (a forward-compatible wrapped JSON with a
    `disclaimer` and `limitations` block).
11. Always run `validateAndSanitize` on the result before serialization,
    stripping forbidden keys (`cookie`, `authorization`, `*.token`, …)
    from any `detail` bag.

## Quick start

```bash
npm install

# Plain text report to stdout
./node_modules/.bin/wbh https://example.com

# JSON report to a file (suitable for the standalone viewer)
./node_modules/.bin/wbh https://example.com --format json --output report.json

# HTML report (self-contained, drop into a browser or share)
./node_modules/.bin/wbh https://example.com --format html --output report.html

# SARIF 2.1.0 for GitHub code-scanning ingestion
./node_modules/.bin/wbh https://example.com --format sarif --output report.sarif

# Per-page progress on stderr (no fake completion %)
./node_modules/.bin/wbh https://example.com --progress
```

Or open `web/viewer.html` in a browser and drop a JSON report onto the
page for an interactive dashboard (filters, search, sort, viewer-local
history of up to 20 reports).

## Prerequisites

- **Node.js ≥ 20** (`engines.node` in `package.json`).
- npm. (Also works with pnpm; the committed `pnpm-workspace.yaml`
  declares pnpm-specific build settings.)
- Public internet reach to the target host. The scanner refuses to talk
  to private/loopback ranges by default.
- Linux, macOS, or Windows with a POSIX-style shell for the CLI scripts.
- **Optional**: Playwright (Chromium) for the JS-error and mobile-
  overflow scanners. See "Optional Playwright" below.

## Local installation

```bash
# 1. Fetch dependencies
npm install

# 2. (Optional) Install Playwright browser for JS-error + mobile checks
npx playwright install chromium

# 3. Build the CLI binary into ./dist
npm run build

# 4. Run a scan
./node_modules/.bin/wbh https://example.com
```

## Available commands (from `package.json`)

| Command | Purpose |
|---------|---------|
| `npm run build` | Bundle ESM + `.d.ts` into `dist/` via `tsup`. |
| `npm run lint` | ESLint with `--max-warnings 0` (`eslint.config.js`). |
| `npm run typecheck` | Strict TS, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`. |
| `npm test` | Vitest across `test/**/*.test.ts` (unit + e2e + fixtures). |
| `npm run test:watch` | Vitest in watch mode. |
| `npm run format` | Prettier with the project root config. |
| `npm run wbh` | Run the built CLI directly (`node dist/cli/index.mjs`). |

The CI workflow (`.github/workflows/ci.yml`) runs `lint`, `typecheck`,
`test`, and a build on Node 20, 22, and 24 for pushes and pull
requests. The same job on Node 22 also runs an `npm audit`.

## CLI

```
wbh <url> [flags]
  --max-pages <n>         Max pages to scan (default 500)
  --max-depth <n>         Max link depth (default 5)
  --max-time <ms>         Max total time in ms (default 600000)
  --max-requests <n>      Global cap on outbound requests (HTML + redirects + probes) (default 5000)
  --concurrency <n>       Parallel fetches (default 4)
  --rate <ms>             Per-request delay in ms (default 0)
  --user-agent <ua>       User-Agent string
  --timeout <ms>          Per-request timeout in ms (default 15000)
  --output <file>         Write report to file (default stdout)
  --format <fmt>          json|text|sarif|html|csv|export (default text)
  --no-robots             Ignore robots.txt
  --allow-private         Allow scanning private IP ranges (NEVER in production)
  --quiet                 Suppress info logs
  --progress              Print per-page progress to stderr
  --cache-capacity <n>    Probe cache capacity (entries) (default 50000)
```

### Exit codes

| Code | Meaning |
|------|---------|
| 0 | No error-severity findings |
| 1 | One or more `error`-severity findings |
| 2 | Scanner crashed (malformed target URL, network unreachable, etc.) |

## Stack (verified from `package.json`)

- **Language**: TypeScript 5.7, ESM (`"type": "module"`), target Node 20+.
- **Runtime**: `cheerio` 1.0.0 for HTML parsing (server-side jQuery-like).
- **Networking**: native `fetch` + `undici` `Agent` for IP pinning.
- **Concurrency**: `p-limit` 6.1.0.
- **Logging**: `pino` 9.5.0 (writes to STDERR; HTML/body/credential fields
  are redacted at source).
- **CLI**: `commander` 12.1.0.
- **Browser checks**: `playwright` 1.49.1 (optional dependency; only
  needed for JS-error and mobile-overflow scanners).
- **Build**: `tsup` 8.3.5 → ESM bundles in `dist/`.
- **Tests**: `vitest` 2.1.8, run on the included `test/fixtures/fixture-server.ts`
  fixture HTTP server.

## Configuration

WBH honors one environment variable:

| Variable | Effect | Default |
|---|---|---|
| `WBH_LOG_LEVEL` | Pino log level (`debug`, `info`, `warn`, `error`). `--quiet` overwrites this to `error` at start. | `info` |

No API keys, tokens, or remote endpoints are required. **Do not** add
secrets to your environment to "configure" WBH — it is a local CLI.

A sample `.env.example` is provided for documentation. The shipped
`.gitignore` excludes real `.env` files.

## Report contents

JSON shape (`--format json`):

```jsonc
{
  "target": "https://example.com/",
  "startedAt": 1700000000000,    // ms since epoch
  "finishedAt": 1700000060000,
  "durationMs": 60000,
  "pagesScanned": 12,
  "pagesFailed": 1,
  "pagesSkipped": 0,             // robots.txt denials
  "findings": [
    {
      "id": "link-abc",
      "type": "link_broken",
      "severity": "error",        // error | warning | info
      "confidence": "confirmed",  // confirmed | probable | inconclusive
      "message": "Broken link (HTTP 404): …",
      "page": "https://example.com/foo",
      "detail": { "status": 404, "code": null, "finalUrl": "..." },
      "fix": "Replace the link with the correct URL.",
      "explanation": "…",
      "affectedPages": ["https://example.com/foo"]
    }
  ],
  "errors": [],
  "budgetExhausted": false,
  "cache": { "linkProbes": 45, "assetProbes": 23 },
  "config": { … },
  "pages": [ { "url": "…", "finalUrl": "…", "status": 200, "fetchedAt": …, "bytes": … } ]
}
```

Every finding carries an actionable `fix` and an `explanation` of why
it matters. Affected-pages are aggregated when the same id fires across
multiple pages.

### Output formats

| `--format` | What you get | When to use |
|---|---|---|
| `json` | The raw, sanitised `ScanResult`. | Piping into other tools that already know the schema. |
| `export` | A wrapped JSON envelope with `tool`, `scan`, `configuration`, `pages`, `findings`, `summary`, `errors`, `limitations`, `disclaimer`. | Long-term archival. Forward-compatible (`schema: "wbh-report-export-1.0"`). |
| `csv` | RFC-4180 CSV with one finding per row. Columns: `id, type, severity, confidence, page, message, explanation, fix, affected_pages, detail`. | Spreadsheet triage. |
| `sarif` | SARIF 2.1.0 for GitHub code scanning. | CI / SAST integration. |
| `html` | Self-contained HTML report (works offline; embeds the sanitised report JSON). | Sharing with non-technical reviewers. |
| `text` | Human-readable plain text. | Terminal output, log aggregation. |

The `export` and `csv` formats share the same sanitiser as `json`: they
never include cookies, authorization headers, environment variables,
stack traces, or other internal infrastructure details. The `disclaimer`
and `limitations` arrays make the scope of the scan explicit in the
export itself.

## What it checks

| Check | Implementation | Notes |
|-------|----------------|-------|
| Broken links | `safeUrl` + native `fetch` | HTTP ≥ 400, DNS failures, timeouts, SSRF-blocked targets. Cached across pages — same URL only probed once. |
| Broken images | `cheerio` + `fetch` | HTTP ≥ 400, wrong MIME, image fetches capped at 256 KB. Cached. |
| Redirects | manual chain in `httpClient` | Loop detection, chains > 3 hops, https→http downgrade. Each hop re-validated by `assertSafeUrl`. |
| Missing / malformed metadata | `cheerio` | `<title>`, charset, viewport, og:title, og:image, canonical, html lang, favicon. |
| Accessibility | `cheerio` | `<img>` alt text, `<h1>` count, heading-order skip (h1 → h3). |
| Cross-page duplicates | cross-page pass | Duplicate `<title>`, duplicate meta description, shared canonical. |
| JS console errors | Playwright (optional) | `console.error`, `pageerror`, sub-resource 4xx/5xx. |
| Mobile overflow | Playwright (optional) | Horizontal overflow at 375 × 667 and 768 × 1024. |

Every finding has an `aria-label`-friendly badge and an inline `<details>`
for the evidence, the fix, and the explanation. The static HTML report
works with JavaScript disabled.

## Security

Threat model and mitigations are documented in detail in
[`docs/SECURITY.md`](docs/SECURITY.md) and
[`docs/SECURITY-REVIEW.md`](docs/SECURITY-REVIEW.md). Highlights:

- Every URL passes `assertSafeUrl` before any network I/O.
- DNS resolution happens **once** per URL and is pinned; the resolved IP
  is reused via an undici `Agent`, preventing DNS rebinding.
- Each redirect hop is independently re-validated.
- Same-origin enforcement locks to the original target origin (not the
  page URL), so a redirect-in-page cannot widen scan scope.
- All response bodies are treated as hostile. The HTML report renderer
  is XSS-safe by construction; ESCAPED `</` in the embedded JSON
  defeats naive `<script>` breakouts.
- Pino redacts `html`, `body`, `response`, plus credential-shaped fields
  (`password`, `token`, `cookie`, `authorization`, `*.apiKey`, …).
- Reports are validated and sanitised (`validateAndSanitize`) before
  write.

⚠️ **Legal**: Only scan sites you are authorised to test. Most
jurisdictions treat unauthorised scanning as a civil or criminal
offence; many hosts also forbid it in their terms of service. The scan
operator — not this software — is responsible for authorisation.

## Limitations

These are not bugs; they are scope. We do not consider any of them
"features that should ship later"; they are design constraints of an
authenticated, intrusive, public-network scanner that has to defend
itself from being abused.

- **Same-origin only.** Cross-origin links are reported as broken-or-OK
  but not enqueued for full scanning.
- **No authentication.** Pages behind login are not reachable.
- **Static HTML by default.** Pages rendered entirely by client JS
  appear empty during the static crawl and may trigger a wave of
  `meta_missing` findings. The optional Playwright scanners run on the
  initial URL once at the end of the scan; per-page client-side
  rendering is not enabled.
- **Playwright is optional.** Without it, `js_error` and
  `mobile_overflow` produce a single INCONCLUSIVE "skipped" finding
  each.
- **No resume.** Long scans don't survive a crash; the frontier lives
  in memory.
- **Heuristics, not audits.** SEO and accessibility checks are scoped
  heuristics. We do **not** claim a full SEO audit or WCAG
  conformance.
- **No config file.** CLI flags only, by design.

### Known false-positive sources

- **Heuristic SEO checks** (`meta_invalid` for short titles, short
  descriptions) can fire on pages where the operator has intentionally
  chosen a short title/description for branding reasons.
- **Heading skips** (`h1 → h3`) assume a strict document outline; some
  CSS-driven layouts break the outline visually without breaking the
  markup.
- **Image content-type checks** ("served non-image MIME") fire on CDNs
  that intentionally return a small text placeholder on error, or on
  single-pixel tracking images served as `image/gif`.
- **`request_failed` with TIMEOUT or 5xx** is reported as
  `inconclusive` precisely because the operator could be seeing a
  transient error, not a defect.

## Architecture

See [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md). The single chokepoint
for network I/O is `src/fetcher/safeUrl.ts` — no other module may call
`fetch`, `undici.fetch`, or `playwright.goto` directly.

## License

MIT — see the `LICENSE` file.

> **License notice.** A public source repository is not automatically
> open source without an explicit license file. WBH ships with the MIT
> `LICENSE` in the repository root; downstream redistributors must keep
> that file intact. The current `package.json` does not declare a
> `repository`, `homepage`, or `bugs` URL field — those are
> intentionally unset so this distribution has nothing inferring a
> public hosting location before there is one.

## Contributing

See [`CONTRIBUTING.md`](CONTRIBUTING.md) for setup, coding
conventions, and how to propose a new detection rule.
Vulnerability disclosure channels are listed in [`SECURITY.md`](SECURITY.md).

## Roadmap (next-step candidates, not commitments)

- **Config file**: JSON/TOML config so multi-target scans and per-host
  budgets don't need shell wrappers.
- **Multi-origin scans**: opt-in, with per-origin rate caps and a clear
  breakdown of which findings came from which origin.
- **Resume on crash**: snapshot the frontier + visited set to disk
  every N pages, recover on restart.
- **Server-side health score normalisation across scans**: the current
  heuristic is per-report.

These have been evaluated; none of them are unstarted. None of them are
on a release timeline either.

## Release status

This is pre-release software. The core capabilities (audit, scanner,
crawling, detection rules, reporting UI, export & history, security
controls, UX/accessibility/performance, and this documentation pass)
have been implemented. Run `npm test`, `npm run lint`,
`npm run typecheck`, `npm run build`, and `npm audit` locally before
relying on the scanner in any production setting.
