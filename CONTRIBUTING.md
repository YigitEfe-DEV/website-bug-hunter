# Contributing

Thanks for considering a contribution to Website Bug Hunter. This document
covers local setup, code conventions, and the lifecycle of a change.

By contributing, you agree your work is released under the project
license (MIT — see `LICENSE`).

## Project layout

```
src/
  cli/           commander entry; reads flags, calls runScan
  core/          orchestrator, probe cache, progress, report sanitiser
  fetcher/       SSRF gate (assertSafeUrl), HTTP client, robots.txt
  scanners/      links | images | meta | redirects | accessibility | duplicates | browser
  reporting/     json | text | sarif | html | csv | export
  utils/         pino logger, URL helpers
  types/         shared types + DEFAULT_SCAN_CONFIG
  index.ts       public API surface

test/
  unit/          vitest units
  e2e/           vitest end-to-end against the in-process fixture server
  fixtures/      the fixture HTTP server itself

web/             standalone HTML viewer (file-drop, history, filters)
docs/            architecture, security notes, change logs
```

## Local setup

Requirements:

- Node.js ≥ 20 (`engines.node` in `package.json`)
- npm (the project's committed lockfile is `package-lock.json`; pnpm
  users should still run `npm ci` first to materialise the lockfile)
- Linux, macOS, or Windows with a POSIX shell

```bash
git clone <your-fork>
cd website-bug-hunter
npm ci
npm run build
npm test             # must pass locally before opening a PR
npm run lint         # must pass with 0 warnings
npm run typecheck    # must pass; strict TypeScript
```

The test suite ships its own in-process HTTP fixture in
`test/fixtures/fixture-server.ts`. Tests that exercise the scanner
against loopback URLs set `allowPrivate: true` on `RunScanOptions`;
production callers must not do that.

For the optional Playwright JS-error and mobile-overflow scanners:

```bash
npm install          # playwright is an optionalDependency and pulls in automatically
npx playwright install chromium
```

## Coding conventions

The existing code is the canonical reference. In short:

- **TypeScript**, ESM, target Node 20. Strict, with
  `noUncheckedIndexedAccess` and `exactOptionalPropertyTypes` enabled
  in `tsconfig.json`.
- **No `any`.** `@typescript-eslint/no-explicit-any` is `warn` in
  `eslint.config.js` — prefer narrowing with `unknown` and a runtime
  check.
- **No silent catches.** Wrap unknown errors; let the logger strip
  stacks.
- **`fail-fast` on parsed data, `fail-open` on advisory data.** Bad
  HTML must throw; bad robots.txt must allow the URL.
- **All outbound I/O goes through `assertSafeUrl`.** No module may
  call `fetch`, `undici.fetch`, or `playwright.goto` directly.
  The single chokepoint is `src/fetcher/safeUrl.ts`.
- **Every output string passes through `sanitizeString`.** Strip ASCII
  controls, U+2028/U+2029, zero-width and bidi overrides, BOM.
- **Pino, not console.** Use `logger.info({...}, 'msg')` so redaction
  and level handling stay uniform. Don't log response bodies.
- **Comments are present tense.** "This blocks X" — not "this will
  block X" or "this should block X".
- **Two-space indent, double quotes, trailing commas, semicolons on.**
  These come from `.prettierrc.json`.

## Architecture invariants

Don't break these unless you're explicitly changing them and the change
has been discussed:

1. **`assertSafeUrl` is the only network gate.** Every URL must pass
   it; every per-hop connection must go through the pinned-IP
   `dispatcher`. Bypassing this is a security regression.
2. **`CrawledPage` is plain data.** No `cheerio` references, no
   promises, no closures over scanner state.
3. **Scanners are pure functions over `CrawledPage`.** They produce
   `Finding[]` and nothing else. They must not call out to the
   network on their own initiative (link/image probes are passed
   through them as records, not originated).
4. **Reporters are read-only over `ScanResult`.** They never call back
   into the network and they never mutate the result. Mutations happen
   only in `core/report.ts:validateAndSanitize` after the orchestrator
   has finished.
5. **Concurrency is bounded by `p-limit(config.concurrency)`.** Adding
   work to the queue from inside a scanner is a leak.

## Proposing a new detection rule

Detection rules live in `src/scanners/`. Each rule is a single function
that takes a `CrawledPage` (and optional configuration), walks the
already-parsed HTML, and returns one or more `Finding` objects.

To propose one, open an issue with the following:

- **Symptom** — what user-visible behaviour triggered the rule? Be
  concrete; a real example URL or HTML snippet is best.
- **Evidence the scanner can collect from a single response** — what
  would the rule actually look at? If it needs cross-page context,
  describe the dataflow.
- **Severity / confidence** — is the finding directly observed
  (`confirmed`) or inferred from a heuristic (`probable`)?
  Inconclusive cases belong to logs, not findings.
- **Why and how to fix** — short explanations a non-expert operator
  can act on. The codebase uses an actionable `fix` and an `explanation`
  field on every finding.
- **False-positive rate, expected** — what's the rate on a real
  sample? Where would you expect it to fire wrongly, and how does the
  rule distinguish?

A rule that has none of these answers behind it is more often a metric
than a finding. The orchestrator's `dedupeFindings` already collapses
near-duplicates; please don't add rules that emit many findings per
page without a deduplication strategy.

### Adding the code

- Place the rule next to its siblings in `src/scanners/`.
- Accept `CrawledPage` and (optionally) `preloadedCheerio?: CheerioAPI
  | null`. The orchestrator pre-parses once per page; reuse it via
  the parameter, or fall back to `load(...)` so unit tests still work.
- Emit findings through the existing `Finding` shape. Don't invent new
  fields; if you need one, propose the schema change first.
- Don't add a CLI flag for the rule unless there is a real reason to
  toggle it. Default-on, with a clear way for advanced operators to
  filter via `--format text` after the fact.

### Tests

- A `test/unit/<your-rule>.test.ts` covering: positive case, negative
  case, edge case (truncated HTML, malformed attribute, empty page).
- Run `npm test` locally; the fixtures include a small HTML corpus
  you can lift snippets from.

## Pull-request rules

- One concern per PR. A bug fix and a refactor are two PRs.
- Match the project's commit-message shape where possible: short
  imperative subject (≤ 72 chars), blank line, body wrapped at 72.
- The CI workflow (`.github/workflows/ci.yml`) runs `lint`, `typecheck`,
  `test`, and a `build` on Node 20, 22, and 24. The PR must keep them
  green.
- All review comments must be addressed or explicitly deferred with
  reason. Unresolved comments block merge.

## Vulnerability reports

**Please do not file security issues as public GitHub issues.** See
[`SECURITY.md`](SECURITY.md) for the disclosure channel. The scanner
itself is sensitive infrastructure; treat it that way.

## License

By contributing, you confirm your contribution is MIT-licensed and you
have the right to submit it under those terms.
