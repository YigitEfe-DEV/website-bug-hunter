# Security

> Two documents cover this codebase:
> - **`SECURITY.md`** (this file) — vulnerability *reporting* instructions.
> - [`docs/SECURITY.md`](docs/SECURITY.md) — the full threat model, the
>   `assertSafeUrl` gate description, DNS-rebinding defense, residual
>   risks, and deployment guidance.
> - [`docs/SECURITY-REVIEW.md`](docs/SECURITY-REVIEW.md) — the path-by-path
>   review, test-coverage map, and threat matrix.

## Reporting a vulnerability

If you find a way to bypass `assertSafeUrl`, evade the SSRF guards,
cause the scanner to leak a credential or a stack trace into a report
or log, or otherwise break the security boundaries documented in
`docs/SECURITY.md`, **please disclose it privately** before publishing
a write-up.

### Channel status

The project's `package.json` currently does **not** declare a `bugs`
URL, an email contact, or a hosting location. Until a public home for
the project is configured, a private disclosure channel is *not* yet
advertised. Operators and integrators should treat that gap as follows:

| Until a public channel exists | After a public channel is configured |
|---|---|
| Open an issue with the `[SECURITY]` prefix and request a private follow-up via the contact channel of whoever distributed the binary. | The maintainer will publish a `SECURITY.md` contact (GitHub Security Advisories URL, dedicated `security@` alias, or both) in this section. |
| Do **not** publish full exploit details until the maintainer confirms the patched version is in use. | Standard coordinated-disclosure timelines (90 days is a common default). |

> **Action item for maintainers.** Before publishing a public home for
> this project, decide on and publish at least one of the following:
> - A **GitHub Security Advisories** URL (the default GitHub feature,
>   works without dedicated email setup), or
> - A dedicated **security@<domain>** mailbox with an out-of-office
>   responder.
> Update this file with the chosen channel and the disclosed-issues
> policy.

### What to include

A good initial report covers:

- The vulnerability class (SSRF? log injection? credential leak? …)
- A reproducer — a URL, a target URL the scanner would be tricked into
  fetching, and the exact CLI invocation used.
- The expected vs observed behaviour, including any output that ended
  up in a report file (so the maintainer can correlate).
- Whether you've tested with `--allow-private` on or off. Most SSRF
  probes in this codebase only manifest under `--allow-private`.

### What we won't do

We will not threaten the reporter with legal action for good-faith
research. We will not demand a Non-Disclosure Agreement as a condition
of receiving the report. We will credit the reporter in the
release-notes if they want.

## Scope

The following are in scope and considered sensitive:

- Bypasses of `src/fetcher/safeUrl.ts` (`assertSafeUrl`).
- Bypasses of `src/fetcher/robots.ts` (the secondary gate around the
  robots fetcher).
- Anything that lets a malicious target HTML escape the
  `page.route('**/*')` boundary in `src/scanners/browser.ts`.
- Anything that lets a malicious target URL leak a stack trace, an
  environment variable, a credential, or an internal-network detail
  into:
  - a `ScanResult` written to stdout / a file
  - a `--format export` envelope
  - the pino log stream on STDERR
  - the standalone viewer's `localStorage`

The following are **out of scope** for this project:

- Unauthorised scanning itself. WBH does not enforce authorisation —
  that's the operator's responsibility. We document it; we don't police it.
- Vulnerabilities in `playwright`. Please disclose to the upstream
  project. We mirror only what Playwright gives us.

## Acknowledgements

This file does not yet have a hall of fame. The project's
`docs/SECURITY-REVIEW.md` (a developer-facing review of the network
path) is the closest thing to a published security posture statement.
