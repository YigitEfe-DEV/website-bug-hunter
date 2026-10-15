import { describe, it, expect } from 'vitest';
import { renderJson, renderText, renderSarif, renderHtml } from '../../src/reporting/reporters.js';
import type { ScanResult } from '../../src/types/index.js';

const sample: ScanResult = {
  target: 'https://example.com',
  startedAt: 1700000000000,
  finishedAt: 1700000060000,
  durationMs: 60000,
  pagesScanned: 12,
  pagesFailed: 1,
  findings: [
    {
      id: 'link-1',
      type: 'link_broken',
      severity: 'error',
      message: 'Broken link (HTTP 404): https://example.com/missing',
      page: 'https://example.com/missing',
      detail: { status: 404 },
    },
    {
      id: 'meta-1',
      type: 'meta_missing',
      severity: 'warning',
      message: 'Missing <meta name="description">',
      page: 'https://example.com',
      detail: { tag: 'description' },
    },
  ],
  errors: [],
  budgetExhausted: false,
};

describe('reporters', () => {
  it('renderJson is valid JSON round-trip', () => {
    const out = renderJson(sample);
    const parsed = JSON.parse(out);
    expect(parsed.target).toBe(sample.target);
    expect(parsed.findings).toHaveLength(2);
  });

  it('renderText contains summary and grouped sections', () => {
    const out = renderText(sample);
    expect(out).toContain('Website Bug Hunter');
    expect(out).toContain('Pages scanned: 12');
    expect(out).toContain('link_broken');
    expect(out).toContain('meta_missing');
  });

  it('renderSarif produces SARIF 2.1.0 with rules and results', () => {
    const out = renderSarif(sample);
    const sarif = JSON.parse(out);
    expect(sarif.version).toBe('2.1.0');
    expect(sarif.runs[0].tool.driver.name).toBe('website-bug-hunter');
    expect(sarif.runs[0].tool.driver.rules).toHaveLength(2);
    expect(sarif.runs[0].results).toHaveLength(2);
    expect(sarif.runs[0].results[0].ruleId).toBe('link_broken');
  });

  it('renderHtml is a self-contained HTML page with XSS-safe escaping', () => {
    const xss: ScanResult = {
      ...sample,
      findings: [
        {
          id: 'x',
          type: 'link_broken',
          severity: 'error',
          message: '<script>alert(1)</script>',
          page: 'https://example.com/?q="x"&y=<z>',
        },
      ],
    };
    const out = renderHtml(xss);
    expect(out).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(out).toContain('&quot;x&quot;');
    expect(out).toContain('&lt;z&gt;');
    expect(out).not.toContain('<script>alert(1)</script>');
  });
});