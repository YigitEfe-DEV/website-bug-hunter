# PHASE 6 — Report Export and Lightweight History

Inspect the existing architecture briefly and implement the most useful low-complexity report retention/export approach that fits it. Do not add a database or account system by default.

## Export
- Add JSON export containing scan metadata, configuration, pages, findings, confidence/status, evidence, remediation, and limitations.
- Sanitize output. Never export credentials, cookies, authorization headers, environment variables, stack traces, or internal infrastructure details.
- Add CSV only if it is straightforward and fits the current data model.
- Ensure export handles empty and partial reports.

## History
- If the current application already has persistence, integrate with it using the existing patterns.
- If it has no persistence, prefer a lightweight local/session history only when appropriate to the current app. Explain its limitations and avoid storing sensitive data.
- Do not introduce authentication, a database, a queue, or server-side history without a clear product need and an architecture-based justification.
- Provide a way to revisit or re-export available reports if feasible.

## Token policy
Do not run tests, lint, type checks, builds, browser automation, or broad verification. Inspect only the report model, storage patterns, and relevant UI.

## Finish
Summarize export/history behavior, data retention boundaries, changed files, and limitations. Do not claim tests passed.
