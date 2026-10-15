# PHASE 4 — Detection Rules and Page Metadata

Improve finding quality using the existing scanner and report model.

## Implement feasible checks
- HTTP errors and unreachable pages.
- Broken internal/external links, with uncertainty represented accurately.
- Broken images and failed assets.
- Redirect chains and loops.
- Missing/empty page title.
- Missing/empty meta description.
- Missing canonical URL and conflicting canonical declarations.
- Missing language declaration.
- Missing viewport metadata.
- Images missing alternative text.
- Duplicate titles across crawled pages.

For each finding, provide a stable type, severity, confidence/status, affected page/resource, evidence, explanation, and remediation guidance. Keep SEO/accessibility-related findings as scoped heuristics; do not claim a full SEO audit or accessibility certification.

## Rules
- Reuse the current parser and result model where reasonable.
- Avoid duplicate findings.
- Do not report a potential or inconclusive observation as a confirmed defect.
- Do not add AI or paid external APIs.

## Token policy
Do not run tests, lint, type checks, builds, browser automation, or broad verification. Read only relevant scanner/parser/rule files. Do not re-audit unrelated modules.

## Finish
Summarize added detection rules, their limitations, changed files, and the next phase. Do not claim tests passed.
