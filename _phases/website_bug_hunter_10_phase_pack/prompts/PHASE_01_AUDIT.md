# PHASE 1 — Read-Only Repository Audit

You are the senior engineer working on Website Bug Hunter.

## Goal
Understand the actual repository and produce a concise, evidence-based plan for the next phases.

## Inspect only
- Actual framework, language, dependencies, runtime, build system, and repository structure.
- Existing features and their implementation status.
- Main request/scanning flow, result model, UI, and relevant tests/configuration files.
- Architectural blockers, obvious security risks, and high-impact maintainability concerns.
- The smallest viable path to a useful product.

Use file inspection and targeted code search. Do not run tests, lint, type checks, builds, browser automation, or benchmarks. Do not install packages.

## Constraints
- Do not modify files.
- Do not assume technologies or features.
- Distinguish verified facts from assumptions.
- Cite file paths and concise evidence for important findings.
- Do not produce a huge speculative redesign.

## Output
1. Verified stack and project structure.
2. Existing feature inventory: working, partial, broken, missing, or unverified.
3. Main architecture and data flow.
4. Important security risks, especially SSRF.
5. Recommended scope for Phases 2–9.
6. One concise next step.

Do not implement anything in this phase. Do not run tests; comprehensive testing is reserved for Phase 10.
