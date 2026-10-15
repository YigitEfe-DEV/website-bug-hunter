# PHASE 3 — Bounded Multi-Page Crawling

Extend the working scanner without rewriting it.

## Implement
- Crawl multiple pages on the same origin by default.
- Normalize URLs and remove fragments where appropriate.
- Deduplicate pages and prevent loops.
- Enforce conservative page-count, crawl-depth, concurrency, timeout, response-size, and total-duration limits.
- Track discovered, scanned, skipped, and failed pages.
- Handle redirects and query parameters carefully.
- Preserve completed findings when individual pages fail or the scan ends early.
- Prevent scope escape unless cross-origin checks are explicitly supported and safely bounded.

## Security
Every discovered link, redirect, and asset must go through the same SSRF policy. Revalidate DNS/destination addresses at connection time where the stack permits. Do not allow URL variations to bypass crawl limits.

## Token policy
Do not run tests, lint, type checks, builds, browser automation, or broad verification. Read only the crawler, scanner, and related configuration files needed for this change. Do not re-audit the entire repository.

## Finish
Summarize files changed, crawl rules and limits, security behavior, known limitations, and the next phase. Do not claim tests passed.
