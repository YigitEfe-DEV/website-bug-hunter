/**
 * High-value regression test — renderers must not crash on partial input.
 *
 * The orchestrator routes every ScanResult through validateAndSanitize,
 * but the renderers are public library exports. Library consumers can
 * pass hand-built findings (e.g., test fixtures, an older report loaded
 * from disk, an upstream integration that builds findings outside
 * runScan). Renderers should treat partial confidence/severity/etc. as
 * defaults rather than blowing up the report.
 */
import { describe, it, expect } from 'vitest';
import {
  renderJson,
  renderText,
  renderSarif,
  renderHtml,
  renderCsv,
  renderJsonExport,
} from '../../src/reporting/reporters.js';
import type { ScanResult } from '../../src/types/index.js';

const baseResult: ScanResult = {
  target: 'https://example.com',
  startedAt: 1700000000000,
  finishedAt: 1700000060000,
  durationMs: 60000,
  pagesScanned: 0,
  pagesFailed: 0,
  findings: [],
  errors: [],
  budgetExhausted: false,
};

describe('renderers — defensive against partial findings', () => {
  it('renderText does not throw when findings lack confidence', () => {
    const r: ScanResult = {
      ...baseResult,
      findings: [
        {
          id: 'p1',
          type: 'accessibility',
          severity: 'warning',
          message: 'a finding with no confidence',
          page: 'https://example.com',
        } as unknown as ScanResult['findings'][number],
      ],
    };
    expect(() => renderText(r)).not.toThrow();
  });

  it('renderHtml does not throw when finding severity is the empty string', () => {
    const r: ScanResult = {
      ...baseResult,
      findings: [
        {
          id: 'p2',
          type: 'accessibility',
          severity: '' as unknown as 'warning',
          confidence: 'confirmed',
          message: 'severity empty',
          page: 'https://example.com',
        } as unknown as ScanResult['findings'][number],
      ],
    };
    expect(() => renderHtml(r)).not.toThrow();
  });

  it('renderSarif survives an empty findings array', () => {
    const json = renderSarif(baseResult);
    expect(() => JSON.parse(json)).not.toThrow();
  });

  it('renderJson is symmetric (stringify -> parse -> roundtrip)', () => {
    const r: ScanResult = {
      ...baseResult,
      findings: [
        {
          id: 'r1',
          type: 'link_broken',
          severity: 'error',
          confidence: 'confirmed',
          message: 'oops',
          page: 'https://x.example',
          detail: { status: 500 },
        },
      ],
    };
    const parsed = JSON.parse(renderJson(r));
    expect(parsed.findings).toHaveLength(1);
    expect(parsed.findings[0].id).toBe('r1');
  });

  it('renderCsv produces a parseable CSV with one row per finding', () => {
    const r: ScanResult = {
      ...baseResult,
      findings: [
        {
          id: 'c1',
          type: 'meta_missing',
          severity: 'info',
          confidence: 'inconclusive',
          message: 'meta missing',
          page: 'https://x.example',
        },
      ],
    };
    const csv = renderCsv(r);
    const lines = csv.split('\r\n').filter(Boolean);
    expect(lines[0].split(',')[0]).toBe('id');
    expect(lines).toHaveLength(2);
  });

  it('renderJsonExport wraps with the documented schema', () => {
    const j = JSON.parse(renderJsonExport(baseResult, { toolVersion: '0.1.0' }));
    expect(j.schema).toBe('wbh-report-export-1.0');
    expect(j.tool.name).toBe('website-bug-hunter');
    expect(Array.isArray(j.limitations)).toBe(true);
    expect(typeof j.disclaimer).toBe('string');
  });
});
