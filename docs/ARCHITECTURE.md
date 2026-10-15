# Architecture

## Goals

1. **Security gate is a single function** — `assertSafeUrl` is the only
   path to the network. Bypassing it means re-implementing the gate, not
   routing around it.
2. **Scanners are pure functions** over a `CrawledPage`. They produce
   `Finding[]` and nothing else.
3. **Orchestrator is the only stateful module**. It owns the frontier,
   the visited set, and the budget.
4. **Reporters are read-only** over a `ScanResult`. They never call
   back into the network.

## Module map

```
src/
├── cli/index.ts                 # commander entry; reads flags, calls runScan
├── cli/version.ts               # single source of truth for version string
├── core/orchestrator.ts         # runScan — BFS frontier, scanners, budget
├── fetcher/
│   ├── safeUrl.ts               # SSRF / DNS rebinding gate (assertSafeUrl)
│   ├── httpClient.ts            # manual redirect chain, timeouts, body cap
│   └── robots.ts                # minimal RFC 9309 parser
├── scanners/
│   ├── links.ts                 # extract <a>, probe status, emit link_broken
│   ├── images.ts                # extract <img>/<source>/icon, probe status
│   ├── meta.ts                  # cheerio-based metadata validation
│   ├── redirects.ts             # loop / chain length / downgrade
│   └── browser.ts               # Playwright: js_error + mobile_overflow
├── reporting/reporters.ts       # renderJson / renderText / renderSarif / renderHtml
├── utils/
│   ├── logger.ts                # pino with body-redaction
│   └── url.ts                   # normalize / sameOrigin / origin
├── types/index.ts               # shared types + DEFAULT_SCAN_CONFIG
└── index.ts                     # public API surface for library consumers
```

## Data flow

```
┌────────┐  argv   ┌─────────────────┐
│  CLI   │────────▶│  Orchestrator   │
└────────┘         └────────┬────────┘
                            │ config + budget + signal
                            ▼
              ┌─────────────────────────┐
              │   URL Frontier (queue)  │
              │   visited: Set<string>  │
              └────────────┬────────────┘
                           │
       ┌───────────────────┼───────────────────┐
       ▼                   ▼                   ▼
  ┌──────────┐       ┌─────────────┐     ┌─────────────┐
  │ safeUrl  │       │ httpClient  │     │ robots      │
  │ (gate)   │       │ (fetch)     │     │ (filter)    │
  └────┬─────┘       └──────┬──────┘     └─────────────┘
       │ accept             │ CrawledPage
       ▼                    ▼
  ┌──────────────────────────────────────────────┐
  │  scanners/links, scanners/images, …          │
  │  produce Finding[]                           │
  └────────────────────┬─────────────────────────┘
                       ▼
              ┌─────────────────┐
              │   ScanResult    │
              └────────┬────────┘
                       ▼
            ┌─────────────────────┐
            │ renderers           │
            │ json|text|sarif|html│
            └─────────────────────┘
```

## Concurrency model

Single-threaded Node. The orchestrator uses `p-limit` to bound HTTP
fetches (`config.concurrency`, default 4). Playwright runs in a single
shared context per scan to amortize browser startup cost.

## Threat-model alignment

| Threat | Code location |
|--------|---------------|
| SSRF (R1) | `fetcher/safeUrl.ts:assertSafeUrl` |
| DNS rebinding (R2) | `fetcher/safeUrl.ts` (resolver called once) |
| Untrusted content (R3) | `reporting/reporters.ts:renderHtml` (XSS-safe escaping), `scanners/browser.ts` (Playwright isolation) |
| Resource exhaustion (R4) | `core/orchestrator.ts` budget checks; `fetcher/httpClient.ts` maxBytes |
| Redirect chain (R5) | `fetcher/httpClient.ts:fetchPage` records chain; `scanners/redirects.ts` analyzes |
| Disk poisoning (R6) | `cli/index.ts` filename from CLI arg; `utils/logger.ts` redacts `html`, `body`, `response` |
| Legal (R7) | `README.md` warning |
| Supply chain (R8) | Pinned dependencies in `package.json`; optional `playwright` |

## Open questions

- **Crawler scope**: currently same-origin only. Multi-origin scanning
  needs an explicit opt-in and a per-origin budget cap.
- **Resume on crash**: in-memory frontier only. A future version could
  snapshot frontier + visited to disk every N pages.
- **Config file**: not yet supported. CLI flags are sufficient for
  v0.1.0; a JSON config file would be additive.