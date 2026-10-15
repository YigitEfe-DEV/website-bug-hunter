# PHASE 10 — Dedicated Testing, Regression Fixes, and Final Verification

This is the only dedicated test phase in the ten-phase workflow. Phases 1–9 intentionally avoided running tests and broad verification to conserve tokens. Now verify the integrated product thoroughly.

## Rules
- Inspect the current repository and all changes from Phases 1–9.
- Run tests and verification now.
- Do not add unrelated features or redesign the app.
- When tests reveal defects, fix the underlying issue and rerun the relevant checks.
- Never claim a command passed unless it actually ran and passed.
- If a command cannot run, report the exact reason and do not disguise it as a pass.

## 1. Test inventory
Identify available scripts and tools from the repository manifests/configuration. Build a concise verification matrix before execution. Include only applicable checks.

## 2. Automated tests
Run the full relevant unit and integration test suites. Add missing high-value tests for the implemented behavior, especially:
- URL parsing, normalization, and unsupported schemes.
- SSRF attempts using localhost, private/link-local/metadata addresses, IPv4/IPv6 edge cases, redirects, discovered links, and DNS rebinding behavior supported by the architecture.
- Request, redirect, response-size, page-count, crawl-depth, concurrency, and duration limits.
- HTTP success/error, DNS/network/TLS failures, timeouts, and partial scans.
- Broken link/image classification and inconclusive responses.
- Duplicate URL/page handling and crawl loops.
- Metadata detection and duplicate titles.
- Report rendering, filtering, search, and sorting.
- JSON/CSV export and sensitive-data exclusion.
- Cancellation and cleanup where implemented.

Use deterministic fixtures and controlled mock servers. Do not make public websites a required dependency for core tests.

## 3. Static and build checks
Run all applicable:
- Lint.
- Type checking.
- Production build.
- Formatting check if configured.
- Dependency/security audit if tooling is available.
- Documentation/setup command checks where practical.

## 4. Security-focused review
Review the complete path from user input through DNS, outbound connection, redirects, discovered URLs/assets, parsing, results rendering, and export. Fix issues found. If deployment-level network egress restrictions are needed, document them explicitly.

## 5. Smoke test
Perform a basic end-to-end smoke test with a controlled local fixture or mock server that is compatible with the scanner's security policy. Do not weaken SSRF protections just to make local testing easier; use a safe test seam or test-only dependency injection if needed.

## 6. Fix-and-rerun loop
For every failure:
1. Identify the cause.
2. Fix it if within scope.
3. Rerun the narrow failing test.
4. Rerun relevant broader checks after code changes.
5. Record the actual outcome.

Do not suppress tests, remove assertions, or weaken security just to obtain green output.

## 7. Final report
Provide a table with command/check, actual result, and notes. Include:
- Tests passed/failed/not run.
- Lint and type-check results.
- Build result.
- Security review findings and fixes.
- Smoke-test result.
- Files changed while fixing issues.
- Remaining defects and deployment risks.
- Exact commands to run the app and repeat tests.
- A release verdict: ready, ready with documented limitations, or not ready.

Be concise but evidence-based. This phase is complete only when actual results are recorded and remaining issues are clearly disclosed.
