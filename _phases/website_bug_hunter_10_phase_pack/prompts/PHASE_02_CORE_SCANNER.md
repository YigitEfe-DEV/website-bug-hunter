# PHASE 2 — Core Scanner and First Real Report

Use the Phase 1 findings and actual codebase. Implement the smallest reliable end-to-end scan flow.

## Implement
- Accept and normalize public HTTP/HTTPS URLs.
- Reject malformed URLs and unsupported protocols.
- Fetch the target using bounded timeouts, redirect limits, response-size limits, and safe error handling.
- Record requested URL, final URL where available, status, and duration.
- Parse the returned HTML and extract links and images.
- Resolve relative URLs correctly and deduplicate URLs.
- Check a bounded number of links/assets with bounded concurrency.
- Classify observations as confirmed, potential, or inconclusive; do not treat bot blocking as proof of a broken link.
- Return a structured report with issue type, severity, affected URL, evidence, and remediation.
- Integrate the result into the existing UI with loading, success, partial, and error states.

## Security requirements
Implement server-side SSRF protection for the initial URL and every outbound request. Block loopback, private, link-local, reserved, and metadata addresses. Validate DNS results and redirect destinations; account for DNS rebinding and ensure the actual connection cannot reach a blocked address. Do not expose internal IPs or stack traces to users. Bound total work and resource use.

Do not claim to detect JavaScript runtime errors, broken buttons, or responsive defects without a real browser-based implementation.

## Token policy
Do not run tests, lint, type checks, builds, browser automation, or broad verification in this phase. Do not install packages unless essential and justified by the existing architecture. Make focused changes and inspect only what is necessary to implement them.

## Finish
Summarize changed files, implemented behavior, important design decisions, known limitations, and the next phase. Do not claim tests passed; testing is reserved for Phase 10.
