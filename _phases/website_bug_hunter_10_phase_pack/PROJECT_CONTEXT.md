# Website Bug Hunter — Project Context

## Vision
Website Bug Hunter is an open-source web application that lets users scan a public website and receive an evidence-based report of website quality issues.

## Target users
- Web developers and software engineers
- Independent developers and makers
- Web agencies
- Small and medium-sized businesses
- Website owners who want to discover issues

## Core principles
1. Inspect the existing code before changing it.
2. Discover the real stack and architecture from the repository; do not assume.
3. Preserve working functionality and avoid unnecessary rewrites.
4. Implement in small, focused phases.
5. Do not fabricate findings or claim unimplemented features work.
6. Clearly distinguish confirmed issues, potential issues, and inconclusive results.
7. Treat remote HTML and all scanned content as untrusted.
8. SSRF protection is a core product requirement.
9. Bound requests, concurrency, crawl depth, page count, response size, and total scan duration.
10. Keep architecture proportionate to the current product stage.
11. Prefer practical, maintainable solutions over unnecessary dependencies.
12. Be honest about limitations and verification status.

## Product direction
Users submit a public HTTP/HTTPS URL and receive findings such as HTTP failures, broken links, failed images, redirect problems, and selected page metadata issues. Later phases improve crawl coverage, reporting, export/history if suitable, abuse protections, UX, documentation, and release readiness.

## Security risks
A URL scanner can become an SSRF proxy if it follows user-supplied destinations without strict server-side controls. Validate the initial URL, DNS results, redirects, discovered links, and asset URLs. Block loopback, private, link-local, reserved, and metadata destinations; consider DNS rebinding and connection-time validation. Enforce strict resource limits and never expose secrets or internal network details in reports.

Automated checks can be inconclusive because websites may block bots, rate-limit requests, require authentication, or behave differently by region. Reports must show evidence and uncertainty.

## Ten-phase roadmap
1. Read-only repository audit; no tests.
2. Core safe scanner and first report data flow.
3. Bounded multi-page crawling.
4. Detection rules and metadata checks.
5. Report interface and issue navigation.
6. Export and scan history, only if suitable to current architecture.
7. Security and abuse controls.
8. UX, accessibility, and focused performance improvements.
9. Documentation and release preparation, without running tests.
10. Dedicated comprehensive test and fix phase.

## Token-efficient execution policy
During Phases 1–9, do not run tests, lint, type checks, production builds, browser automation, or broad verification commands. Do not repeatedly re-audit the entire repository. Read only the files needed for the phase. Phase 10 is the only dedicated testing phase. Implement security protections in the appropriate phases rather than postponing security work.
