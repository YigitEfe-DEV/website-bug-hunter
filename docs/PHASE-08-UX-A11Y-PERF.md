# UX, Accessibility, and Focused Performance

Status: implemented.

## What changed

### Performance: cheerio parses cut from 6/page to 1/page

The previous scan path parsed each crawled page with `cheerio.load()` **six
times** — once in the orchestrator for BFS link extraction and once in each
of `scanLinks`, `scanImages`, `scanMeta`, `scanAccessibility`,
`extractMeta`. For a 500-page scan that's ~3,000 redundant DOM parses.

After: the orchestrator loads cheerio **once** per page and passes the
parsed root to every scanner that wants one. Scanners keep a back-compat
fallback (`load(...)` when no preload is supplied) so unit tests that call
them directly still work.

Files:
- `src/core/orchestrator.ts` — load `$` once, reuse for BFS link extraction
- `src/scanners/links.ts` — accept `preloadedCheerio?: CheerioAPI | null`
- `src/scanners/images.ts` — same
- `src/scanners/meta.ts` — same
- `src/scanners/accessibility.ts` — same
- `src/scanners/duplicates.ts` (`extractMeta`) — same

Scope: the change only restructures parse reuse. Cache content, redirect
handling, concurrency caps, signal propagation, abort timing, and ordering
are all unchanged. Backward-compatible: tests that call scanners with
`(page)` still receive the prior on-demand `load()` behavior.

### Performance: precomputed search text in HTML reports

The static HTML report and the JSON-file viewer computed per-card search
matches by reading `card.textContent` on every keystroke. For a 10k-finding
report that's a non-trivial DOM walk per character typed.

After: `renderFindingCard` (and the viewer's `renderFinding`) compute the
lowercased searchable string once at render time and stash it as
`data-search`. The filter path reads `card.dataset.search` instead — no DOM
walk, single attribute lookup per card per keystroke.

Files:
- `src/reporting/reporters.ts` (`renderFindingCard`, `applyFilters` in
  embedded script)
- `web/viewer.html` (`renderFinding`, `applyFilters`)

### UI / accessibility

Applied the same set of changes to both `renderHtml` (the static HTML
report) and `web/viewer.html` (the file-drop viewer):

- **Visible keyboard focus** — `:focus-visible { outline: 2px solid var(--info); outline-offset: 2px }` on both themes.
- **Severity beyond color** — every severity and confidence badge now
  carries an explicit glyph prefix (`✕` error, `!` warning, `i` info,
  `✓` confirmed, `~` probable, `?` inconclusive) so the meaning is
  visible without relying on the red/yellow/blue palette. Each badge
  also gets an `aria-label` (e.g. "Severity error").
- **`type="button"`** on every `<button>` in the report and viewer. The
  prior markup defaulted to `type="submit"`, which can submit a
  surrounding form if anyone wraps the report HTML in one.
- **`aria-pressed`** on the severity and confidence filter chips,
  toggled alongside the visual `active` class on click and on reset.
  Screen readers now learn which filter is applied, not just sighted
  users.
- **`role="status"` + `aria-live="polite"`** on the scan-status pill and
  on the partial / error banners so status changes are announced.
  `role="alert"` retained on the JSON-load error banner.
- **`<details>/<summary>` for the score formula** — replaced the prior
  click-`alert()` popup (which was not keyboard accessible and was not
  self-contained in the static report). The disclosure is rendered
  server-side in `renderHtml` with the per-report counts filled in, so
  the static report works fully with JavaScript disabled.
- **Form controls with labels** — the search, page, type, and sort
  controls now use `<label for="…">` and matching `aria-label`s. Filter
  chip groups use `role="group" aria-label="…"` to identify the group
  for assistive tech without depending on a visible label.
- **Empty / limit states keep `role="status"`** so screen readers
  announce "no findings match" and "no issues found".

Tradeoffs:
- The CSS pseudo-element glyphs (`✕`, `!`, `✓`, etc.) add visual noise in
  every badge. They follow the existing badge color exactly so the look
  is consistent with what was already there. If you prefer plain badges,
  the glyph selectors (`::before { content: "✕" }`) can be removed in one
  place per file.
- The score-formula `<details>` is always present in the static report;
  it expands inline. It adds ~6 lines to the report. The trade is
  removing a non-accessible `alert()` and making the report self-
  sufficient without JS.

### Limits not changed

- No caching that mixes results across targets/settings — same per-scan
  `ProbeCache` with the same scope as before. Concurrency, request
  budget, redirect hops, page/timeouts unchanged.
- No dependency added. No `cheerio` API change.
- No claim of measured performance — the cheerio-loads-per-page count
  went from 6 to 1, but I did not benchmark wall-clock. The benefit
  scales with HTML size and concurrent concurrency: a 500-page scan
  with `concurrency=4` previously hit ~3,000 parses; now ~500.

## Files touched

| File | Change |
|------|--------|
| `src/core/orchestrator.ts` | Load cheerio once per page; pass to scanners |
| `src/scanners/links.ts` | Accept optional `preloadedCheerio` |
| `src/scanners/images.ts` | Accept optional `preloadedCheerio` |
| `src/scanners/meta.ts` | Accept optional `preloadedCheerio` |
| `src/scanners/accessibility.ts` | Accept optional `preloadedCheerio` |
| `src/scanners/duplicates.ts` | `extractMeta` accepts optional `preloadedCheerio` |
| `src/reporting/reporters.ts` | aria-labels, `type="button"`, `aria-pressed`, severity glyphs, `:focus-visible`, inline `<details>` score formula, `data-search` for filter perf |
| `web/viewer.html` | Same UI/accessibility/filter-perf changes as `renderHtml` |

## What was intentionally NOT changed

- `renderText`, `renderSarif`, `renderCsv`, `renderJsonExport` — these
  are CLI / SIEM consumers, not interactive UIs. They emit plain text or
  machine-readable artifacts and have no accessibility surface.
- `scanRedirects` does not need cheerio; was already a no-load function.
- The `ProbeCache` semantics (one entry per URL per scan, no cross-
  target reuse) — the per-scan isolation contract stands.
- No new dependency. The status-banner `.err` variant and the
  `<details>` styling use existing color tokens.
