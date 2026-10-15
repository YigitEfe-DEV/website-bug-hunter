# PHASE 8 — UX, Accessibility, and Focused Performance Improvements

Improve practical usability without broad redesign or expensive speculative optimization.

## UI/accessibility
- Ensure form fields and buttons have accessible names.
- Improve keyboard navigation and visible focus.
- Do not communicate severity by color alone.
- Review contrast, text readability, responsive layouts, and long report behavior.
- Make loading, partial, error, empty, and limit states clear.
- Keep issue evidence and remediation easy to scan.
- Add appropriate loading/disabled states and prevent accidental duplicate submissions.

## Performance
- Review obvious repeated parsing/network work in the scan path.
- Reuse safe in-scan results when correct.
- Avoid unnecessary rerenders or repeated derived calculations in the existing UI framework.
- Keep concurrency and resource limits intact.
- Do not introduce caching that mixes results across different targets, settings, or security contexts.
- Do not add a dependency or optimize based on guesses. Make focused, explainable improvements only.

## Token policy
Do not run tests, lint, type checks, builds, browser automation, benchmarks, or broad verification. Do not claim measured performance improvements without measurements. Inspect only the UI and code paths relevant to the changes.

## Finish
Summarize improvements, changed files, tradeoffs, and limitations. Do not claim tests passed.
