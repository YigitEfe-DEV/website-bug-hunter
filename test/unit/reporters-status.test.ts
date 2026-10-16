/**
 * Report-quality regression tests.
 *
 * Verifies the four user-facing categories are visually distinct in
 * the text and HTML renderers:
 *   - Confirmed findings (severity × confidence='confirmed')
 *   - Inconclusive findings (confidence='inconclusive', not skipped)
 *   - Skipped checks (id starts with `skip-` — Playwright/Chromium
 *     unavailable)
 *   - Request failed (type='request_failed', e.g. EMPTY_BODY)
 *
 * And verifies the heuristic health score ignores `skip-*` findings
 * so users with Playwright/Chromium uninstalled are not penalised for
 * checks that could not run.
 */
import { describe, it, expect } from 'vitest';
import {
  renderText,
  renderHtml,
  renderJson,
  computeHealthScore,
} from '../../src/reporting/reporters.js';
import type { Finding, ScanResult } from '../../src/types/index.js';

const baseResult: ScanResult = {
  target: 'https://example.com',
  startedAt: 1700000000000,
  finishedAt: 1700000060000,
  durationMs: 60000,
  pagesScanned: 5,
  pagesFailed: 1,
  pagesSkipped: 0,
  findings: [],
  errors: [],
  budgetExhausted: false,
};

const confirmedFinding = (id: string): Finding => ({
  id,
  type: 'link_broken',
  severity: 'error',
  confidence: 'confirmed',
  message: 'Broken link',
  page: 'https://example.com/x',
});

const inconclusiveFinding = (id: string): Finding => ({
  id,
  type: 'request_failed',
  severity: 'error',
  confidence: 'inconclusive',
  message: 'Request failed (NETWORK)',
  page: 'https://example.com/y',
  detail: { code: 'NETWORK' },
});

const skippedFinding = (id: string, type: 'js_error' | 'mobile_overflow'): Finding => ({
  id,
  type,
  severity: 'info',
  confidence: 'inconclusive',
  message: type === 'js_error'
    ? 'chromium browser binary not installed; JS error scan skipped'
    : 'chromium browser binary not installed; mobile scan skipped',
  page: 'https://example.com',
});

const emptyBodyFinding = (id: string): Finding => ({
  id,
  type: 'request_failed',
  severity: 'warning',
  confidence: 'inconclusive',
  message: 'Empty HTML body: https://example.com/z',
  page: 'https://example.com/z',
  detail: { code: 'EMPTY_BODY' },
});

describe('text report — categories are distinct', () => {
  it('shows a Skipped checks line when skip-* findings exist', () => {
    const r: ScanResult = {
      ...baseResult,
      findings: [
        skippedFinding('skip-js_error-1', 'js_error'),
        skippedFinding('skip-mobile_overflow-1', 'mobile_overflow'),
      ],
    };
    const txt = renderText(r);
    expect(txt).toMatch(/Skipped checks:\s*2/);
  });

  it('omits the Skipped checks line when no skip-* findings exist', () => {
    const r: ScanResult = {
      ...baseResult,
      findings: [confirmedFinding('c1')],
    };
    const txt = renderText(r);
    expect(txt).not.toMatch(/Skipped checks:/);
  });

  it('shows pages incomplete in the counters when > 0', () => {
    const r: ScanResult = { ...baseResult, pagesIncomplete: 2, findings: [] };
    const txt = renderText(r);
    expect(txt).toMatch(/Pages incomplete[^:]*:\s*2/);
  });

  it('omits pages incomplete when 0/undefined', () => {
    const txt = renderText(baseResult);
    expect(txt).not.toMatch(/Pages incomplete/);
  });
});

describe('html report — categories are distinct', () => {
  it('renders a skipped-checks stat tile when skip-* findings exist', () => {
    const r: ScanResult = {
      ...baseResult,
      findings: [
        skippedFinding('skip-js_error-1', 'js_error'),
        skippedFinding('skip-mobile_overflow-1', 'mobile_overflow'),
      ],
    };
    const html = renderHtml(r);
    expect(html).toMatch(/<div class="l">skipped checks<\/div>/);
  });

  it('renders a pages-incomplete stat tile when pagesIncomplete > 0', () => {
    const r: ScanResult = { ...baseResult, pagesIncomplete: 1, findings: [] };
    const html = renderHtml(r);
    expect(html).toMatch(/<div class="l">pages incomplete<\/div>/);
  });

  it('omits both tiles when neither applies', () => {
    const html = renderHtml(baseResult);
    expect(html).not.toMatch(/skipped checks/);
    expect(html).not.toMatch(/pages incomplete/);
  });
});

describe('computeHealthScore — skips skip-* findings', () => {
  it('does not penalise skip-* findings', () => {
    const r: ScanResult = {
      ...baseResult,
      findings: [
        skippedFinding('skip-js_error-1', 'js_error'),
        skippedFinding('skip-mobile_overflow-1', 'mobile_overflow'),
      ],
    };
    expect(computeHealthScore(r.findings)).toBe(100);
  });

  it('still penalises real findings', () => {
    const r: ScanResult = {
      ...baseResult,
      findings: [confirmedFinding('c1')],
    };
    // 1 confirmed error → 100 - 10 = 90
    expect(computeHealthScore(r.findings)).toBe(90);
  });

  it('mixes skipped and real findings correctly', () => {
    const r: ScanResult = {
      ...baseResult,
      findings: [
        skippedFinding('skip-js_error-1', 'js_error'),
        confirmedFinding('c1'),
        confirmedFinding('c2'),
      ],
    };
    // 2 confirmed errors → 100 - 20 = 80 (skipped findings do not subtract)
    expect(computeHealthScore(r.findings)).toBe(80);
  });
});

describe('JSON export — preserves pagesIncomplete and category types', () => {
  it('round-trips pagesIncomplete through JSON', () => {
    const r: ScanResult = { ...baseResult, pagesIncomplete: 3, findings: [] };
    const j = JSON.parse(renderJson(r));
    expect(j.pagesIncomplete).toBe(3);
  });

  it('keeps the four category tags distinct in the finding list', () => {
    const r: ScanResult = {
      ...baseResult,
      findings: [
        confirmedFinding('c1'),
        inconclusiveFinding('i1'),
        skippedFinding('skip-js_error-1', 'js_error'),
        emptyBodyFinding('e1'),
      ],
    };
    const j = JSON.parse(renderJson(r));
    const findings: Finding[] = j.findings;
    // All four categories present, identifiable by stable fields.
    expect(findings.find((f) => f.confidence === 'confirmed')).toBeDefined();
    expect(
      findings.find((f) => f.confidence === 'inconclusive' && !f.id.startsWith('skip-')),
    ).toBeDefined();
    expect(findings.find((f) => f.id.startsWith('skip-'))).toBeDefined();
    expect(
      findings.find(
        (f) => f.type === 'request_failed' && (f.detail as { code?: string } | undefined)?.code === 'EMPTY_BODY',
      ),
    ).toBeDefined();
  });
});