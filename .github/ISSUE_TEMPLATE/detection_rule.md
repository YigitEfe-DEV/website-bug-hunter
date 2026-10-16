---
name: Detection rule proposal
about: Propose a new finding type for one of the scanners (or a new scanner).
labels: enhancement
---

Before opening this issue, please skim [`CONTRIBUTING.md`](../CONTRIBUTING.md)
("Proposing a new detection rule") and confirm the proposal fits there.

## Symptom

A concrete user-visible behaviour you would like flagged. Real URL or
real HTML snippet preferred.

## Evidence the scanner can collect

What would the rule look at? A simple one-liner like
"`<meta name=\"viewport\">` with `initial-scale=0.5` on a mobile
landing page" tells a reviewer the dataflow already. A more complex
rule should describe cross-page context if any.

## Severity / confidence

- Severity: `error` / `warning` / `info`. Choose the smallest
  severity that still flags the issue.
- Confidence: `confirmed` / `probable` / `inconclusive`. Reserve
  `inconclusive` for cases where the scanner truly cannot decide.

## Fix and explanation

Two short paragraphs an operator can act on. The codebase uses an
actionable `fix` and an `explanation` on every finding.

## Expected false-positive sources

- Where does this fire wrongly? How does the rule distinguish?
- If you can't list a false-positive source, the rule probably emits
  too aggressively; please re-scope.

## Implementation sketch

- Does the rule work from a single response, or does it need
  cross-page context?
- New scanner module, or an addition to an existing one?
- Any new fields on `Finding`? (Most rules should not need any.)

## Test plan

- Positive case HTML.
- Negative case HTML.
- Edge case (truncated HTML, malformed attribute, etc.).
