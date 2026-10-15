# PHASE 9 — Documentation and Release Preparation (No Tests)

Prepare accurate project documentation and release materials based on the actual implementation. Do not perform the final verification yet; Phase 10 is reserved for that.

## README
Document:
- What Website Bug Hunter does.
- Features that are actually implemented.
- Explicit limitations and known false-positive sources.
- Technology stack verified from the repository.
- Prerequisites and setup.
- Exact local installation and run commands derived from project files.
- Configuration variables, using placeholder values only.
- Available commands for tests/lint/build, documented from package/config files without running them.
- Security boundaries and responsible use.
- Roadmap and contribution guidance.

Do not invent screenshots, badges, benchmarks, deployment URLs, or feature claims.

## Contributor and security docs
- Add/update `CONTRIBUTING.md` with setup, coding conventions, and how to propose a detection rule.
- Add/update `SECURITY.md` with responsible vulnerability reporting guidance. Do not invent a contact email; if no channel is configured, explicitly note that maintainers must configure one before advertising a private disclosure channel.
- Inspect license status. Do not silently choose or replace a license. Explain that a public repository is not automatically open source without an appropriate license.
- Add/update `.env.example` only using verified variable names and placeholder values.
- Review `.gitignore` for secrets and generated files.
- Add issue/PR templates only if useful and consistent with repository conventions.

## Release notes
Create a draft release checklist and a concise release-notes template. Do not state that the project is production-ready before Phase 10.

## Token policy
Do not run tests, lint, type checks, builds, browser automation, dependency audits, or broad verification. Read only the README, project manifests/configuration, and files needed to document actual behavior.

## Finish
List docs created/updated, any missing release prerequisites, exact documented commands, and the next phase. Explicitly state that final testing has not been run and is reserved for Phase 10.
