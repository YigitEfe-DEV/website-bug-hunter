# PHASE 7 — Security and Abuse Controls

Harden the scanner against misuse while preserving its core workflow. This phase implements protections; Phase 10 will run the dedicated comprehensive tests.

## Review and implement
- Centralize and consistently apply URL/destination validation.
- Block loopback, private, link-local, multicast, reserved, and cloud metadata addresses.
- Validate DNS answers and defend against DNS rebinding; ensure connection-time destination safety where the stack allows.
- Revalidate every redirect, discovered link, and asset.
- Bound request count, redirects, crawl depth, page count, concurrency, response/decompressed size, and total scan duration.
- Add reasonable rate limiting or abuse controls using existing infrastructure.
- Ensure cancellation/timeouts release resources.
- Avoid exposing internal addresses, stack traces, secrets, cookies, or authorization headers in errors, logs, and reports.
- Treat remote HTML and metadata as untrusted.
- Ensure remote content is never executed in a privileged application context.
- Sanitize exports and user-facing errors.
- Use safe logging and redact sensitive values.

## Implementation guidance
Prefer defense in depth. If a protection cannot be guaranteed by application-level code alone, document the need for outbound network restrictions at the deployment layer. Do not weaken protections to improve apparent scan success.

## Token policy
Do not run tests, lint, type checks, builds, browser automation, dependency audits, or broad verification in this phase. Make focused changes in the request/network/security path. Do not repeat a full project audit.

## Finish
Summarize protections implemented, residual risks, changed files, and the next phase. Do not claim tests passed.
