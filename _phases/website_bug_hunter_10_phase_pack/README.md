# Website Bug Hunter — 10-Phase Development Pack

This pack contains ten sequential prompts and supporting documentation for building Website Bug Hunter in an existing repository.

## Token-efficient workflow

- Phases 1–9 focus on inspection only where needed to understand the immediate task, then implementation.
- **Do not run tests, lint, type checks, builds, browser checks, or broad verification during Phases 1–9.** Do not spend tokens on repeated validation. Make focused code changes and summarize them.
- Phase 1 is a read-only audit and must not run tests.
- **Phase 10 is the dedicated test phase.** It performs comprehensive testing, identifies regressions, fixes issues, and reports actual results.
- Security protections must still be implemented during the relevant phases. Deferring tests does not mean deferring safe design or security controls.
- If a command is necessary to understand or modify code, keep it narrowly scoped and avoid test-like verification before Phase 10.
- Do not claim anything has been tested before Phase 10.
- Run phases in order in the same coding-agent session when possible. Review the implementation summary after each phase.
- Commit or back up working changes before each phase.

## Contents

- `PROJECT_CONTEXT.md`
- `prompts/PHASE_01_AUDIT.md`
- `prompts/PHASE_02_CORE_SCANNER.md`
- `prompts/PHASE_03_CRAWLING.md`
- `prompts/PHASE_04_DETECTION_RULES.md`
- `prompts/PHASE_05_REPORTING_UI.md`
- `prompts/PHASE_06_EXPORT_AND_HISTORY.md`
- `prompts/PHASE_07_SECURITY_AND_ABUSE_CONTROLS.md`
- `prompts/PHASE_08_UX_ACCESSIBILITY_AND_PERFORMANCE.md`
- `prompts/PHASE_09_DOCUMENTATION_AND_RELEASE_PREP.md`
- `prompts/PHASE_10_TEST_ONLY.md`
- `checklists/SECURITY_CHECKLIST.md`
- `checklists/RELEASE_CHECKLIST.md`
- `templates/IMPLEMENTATION_REPORT_TEMPLATE.md`

The pack is a development plan, not proof that any feature exists. The coding agent must use the actual repository as the source of truth.
