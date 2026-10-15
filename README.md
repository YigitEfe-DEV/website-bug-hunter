# Website Bug Hunter (WBH)

> Open-source website bug & quality scanner — broken links, broken images,
> JS console errors, redirect anomalies, missing metadata, accessibility
> issues, mobile responsiveness. Built with security as the gate, not an
> afterthought.

[![Node](https://img.shields.io/badge/node-%3E%3D20-blue)]()
[![License: MIT](https://img.shields.io/badge/license-MIT-green)]()
[![Tests](https://img.shields.io/badge/tests-133%20passing-brightgreen)]()

## Why

Naive crawlers are dangerous: a URL like `http://127.0.0.1:6379` or
`http://169.254.169.254/` can turn the scanner itself into an SSRF
primitive. WBH treats the security boundary as the **first** thing it
gets right: every URL must pass through `assertSafeUrl` before any
network I/O, and the suite covers IPv4 (RFC 1918, CGNAT, multicast,
loopback, link-local, TEST-NET) and IPv6 (ULA, link-local, v4-mapped)
ranges with regression tests.

## Install

```bash
npm install
```

The optional `playwright` dep (used for JS error + mobile responsiveness
checks) is automatically included — if you want to use those scanners,
also run:

```bash
npx playwright install chromium
```

## Quickstart

```bash
# Scan a site, write a human-readable report
./node_modules/.bin/wbh https://example.com

# Save a JSON report you can pipe into other tools
./node_modules/.bin/wbh https://example.com --format json --output report.json

# Save a SARIF 2.1.0 report for GitHub code scanning
./node_modules/.bin/wbh https://example.com --format sarif --output report.sarif

# Save a self-contained HTML report
./node_modules/.bin/wbh https://example.com --format html --output report.html

# Save a sanitised, document-enriched JSON export
./node_modules/.bin/wbh https://example.com --format export --output report.export.json

# Save a CSV for spreadsheet triage
./node_modules/.bin/wbh https://example.com --format csv --output report.csv

# Show per-page progress on stderr (no fake completion %)
./node_modules/.bin/wbh https://example.com --progress
```

Or open `web/viewer.html` in a browser and drop a JSON report onto it
for an interactive dashboard. The viewer keeps a local history of the
last 20 reports loaded (see [History](#history)).

## CLI

```
wbh <url> [flags]

  --max-pages <n>         Max pages to scan (default 500)
  --max-depth <n>         Max link depth (default 5)
  --max-time <ms>         Max total time in ms (default 600000)
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
  --cache-capacity <n>    Probe cache capacity (default 50000)
```

### Exit codes

| code | meaning |
|------|---------|
| 0 | No error-severity findings |
| 1 | One or more `error`-severity findings |
| 2 | Scanner crashed (e.g., target URL malformed, network unreachable) |

## What it checks

| Check | Library | Notes |
|-------|---------|-------|
| Broken links | `safeUrl` + native `fetch` | Reports HTTP ≥400, DNS failures, timeouts, SSRF-blocked targets. Cached across pages — same URL only probed once |
| Broken images | `cheerio` + `fetch` | Reports HTTP ≥400, wrong MIME, image fetches capped at 256 KB. Cached |
| Redirects | manual chain in `httpClient` | Detects loops, chains >3 hops, https→http downgrade. Each hop re-validated by `assertSafeUrl` |
| Missing / malformed metadata | `cheerio` | `<title>`, charset, viewport, og:*, canonical, html lang, favicon |
| Accessibility | `cheerio` | `<img>` alt text, `<h1>` count, heading-order skip (h1→h3) |
| Cross-page duplicates | cross-page pass | Duplicate `<title>`, duplicate meta description, shared canonical |
| JS console errors | Playwright (optional) | `console.error`, `pageerror`, sub-resource 4xx/5xx |
| Mobile overflow | Playwright (optional) | Detects horizontal overflow at 375×667 and 768×1024 |

Every finding carries an actionable `fix` recommendation (HTML and text
reports surface it in expandable details; SARIF puts it in the
properties bag).

## Report contents

The JSON report has the following shape (see `docs/SECURITY-REVIEW.md`):

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
      "message": "Broken link (HTTP 404): ...",
      "page": "https://example.com/foo",
      "detail": { "status": 404, "code": null, "finalUrl": "..." },
      "fix": "Replace the link with the correct URL."
    }
  ],
  "errors": [],
  "budgetExhausted": false,
  "cache": { "linkProbes": 45, "assetProbes": 23 }
}
```

The report is validated and sanitized before write. Forbidden fields
(cookies, bearer tokens, etc.) are stripped from any `detail` bag, and
stack-trace frames are scrubbed from any `errors` string before export.

### Export formats

| Format | What you get | When to use it |
|---|---|---|
| `--format json` | The raw, sanitised `ScanResult`. | Piping into other tools that already know the schema. |
| `--format export` | A wrapped JSON envelope with `tool`, `scan`, `configuration`, `pages`, `findings`, `summary`, `errors`, `limitations`, and `disclaimer` keys. | Long-term archival. Forward-compatible (`schema: "wbh-report-export-1.0"`). |
| `--format csv` | RFC 4180 CSV with one finding per row. Columns: `id, type, severity, confidence, page, message, explanation, fix, affected_pages, detail`. | Spreadsheet triage. |
| `--format sarif` | SARIF 2.1.0 for GitHub code scanning. | CI / SAST integration. |
| `--format html` | Self-contained HTML report. | Sharing with non-technical reviewers. |
| `--format text` | Human-readable plain text. | Terminal output, log aggregation. |

The `export` and CSV formats share the same sanitiser as `json`: they never include cookies, authorization headers, environment variables, stack traces, or other internal infrastructure details. The `disclaimer` and `limitations` arrays make the scope of the scan explicit in the export itself.

## Architecture

See [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md). The security gate
(`src/fetcher/safeUrl.ts`) is the only path to the network — no
fetch, no Playwright navigation may bypass it.

## Security

See [`docs/SECURITY.md`](docs/SECURITY.md) and
[`docs/SECURITY-REVIEW.md`](docs/SECURITY-REVIEW.md). Highlights:

- Every URL must pass `assertSafeUrl` before any network I/O
- DNS resolution happens **once** per URL and is pinned; the resolved IP is reused, preventing DNS rebinding
- Each redirect hop is independently re-validated
- Same-origin enforcement locks to the original target origin, not the page URL — a redirect-in-page cannot widen scope
- All response bodies are treated as hostile; HTML report renderer is XSS-safe by construction
- No response bodies are logged at INFO level; pino redacts `html`, `body`, `response`
- Reports are validated and sanitized before write

⚠️ **Legal**: Only scan sites you are authorized to test. Most jurisdictions
treat unauthorized scanning as a civil or criminal offense.

## Development

```bash
npm run typecheck      # strict TS, noUncheckedIndexedAccess, exactOptionalPropertyTypes
npm run lint           # eslint with 0-warning policy
npm test               # vitest, 133 tests across 13 files
npm run build          # tsup, ESM, dts
```

## Limitations (v0.1.0)

- **Same-origin only**: cross-origin links are reported as broken-or-OK
  but not enqueued for full scanning. Add a multi-origin config later.
- **No resume**: long scans don't survive crashes (in-memory frontier).
- **Playwright is optional**: install separately to enable JS-error and
  mobile scanners.
- **No config file**: CLI flags only.

## History

The standalone viewer at `web/viewer.html` keeps a lightweight history
of the last 20 reports **in the browser's `localStorage` only**.

| Aspect | Behavior |
|---|---|
| Storage | `localStorage` key `wbh:history:v1`. No server, no cookies, no auth. |
| Scope | Per-origin, per-browser. Private-mode / disabled-storage contexts are detected and the viewer falls back gracefully. |
| Capacity | Up to 20 entries. Oldest dropped on overflow. Per-entry size is bounded by the JSON you loaded. |
| Re-load | Open / JSON / CSV / Delete per entry. Clear-history button empties the list. |
| Sensitive | The full sanitised report is stored. Cookies, auth headers, env vars, and stack traces are stripped before storage. The viewer UI is single-page, server-less, and never sends the report anywhere. |
| Lifetime | Cleared if the user clears browser data or switches browser/profile. |

There is no server-side history, no database, and no authentication.
The CLI tool itself does not retain history — it is one-shot. Persistent
history across machines, users, or runs requires a server you operate
yourself; that's out of scope for this phase.

## License

MIT.