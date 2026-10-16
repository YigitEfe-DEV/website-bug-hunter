---
name: Bug report
about: Something in the scanner doesn't behave the way the docs say it does.
labels: bug
---

## Symptom

A short sentence describing what happened. ("Scanning my own dev server
succeeded; scanning the same URL with `--allow-private` failed for the
wrong reason" is better than "It crashed".)

## Reproduction

The minimum command needed to reproduce. Include:

- The exact `wbh` invocation (URL, every flag, input file path if any).
- Whether `--allow-private` is on or off.
- Whether you ran the scan against a public host or a loopback fixture.
- The URL's HTTP status, the chain length if relevant, and whether
  `robots.txt` is in play.

## Expected vs observed behaviour

Two short paragraphs. Reference the relevant section of `README.md` or
`docs/ARCHITECTURE.md` if there is one.

## Output

A trimmed copy of the report or the relevant finding. **Redact
anything that looks like a credential** (bearer tokens, cookies, email
addresses); the public bug report is not the place for them.

## Environment

- WBH version (`wbh --version`) and the commit hash.
- Node.js version (`node -v`).
- OS.
- Whether Playwright is installed or not.

## Logs

Attach the pino log stream from STDERR with `-q` removed, **after
sanitising**. Don't paste full HTML responses — only the structured
log lines.
