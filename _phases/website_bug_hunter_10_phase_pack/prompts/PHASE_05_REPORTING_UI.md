# PHASE 5 — Actionable Report Interface

Improve the existing UI to make scan findings understandable and useful. Follow the current design system and avoid a full redesign.

## Implement
- Overview: scan status, pages scanned, URLs checked, duration, and counts by confirmed/potential/inconclusive and severity.
- A readable findings list with stable issue type, severity, confidence, affected page/resource, status/reason, evidence, and remediation.
- Filters by severity, issue type, and page.
- Search within findings.
- Sorting by severity and URL.
- Expandable finding details.
- Clear loading, empty, success, partial-success, error, and scan-limit states.
- Responsive behavior and prevention of duplicate scan submissions.
- Progress only when it reflects actual scanner state; never invent percentages.

If a score is added, document the formula and label it as a project-specific heuristic.

## Constraints
- Preserve the existing architecture and functional components.
- Do not fabricate data or placeholder findings.
- Do not add dependencies unless genuinely needed.
- Do not run tests, lint, type checks, builds, browser automation, or broad verification in this phase.

## Finish
Summarize UI changes, changed files, known limitations, and the next phase. Do not claim tests passed.
