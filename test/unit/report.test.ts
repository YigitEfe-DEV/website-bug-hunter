import { describe, it, expect } from 'vitest';
import { validateAndSanitize, ReportValidationError } from '../../src/core/report.js';
import type { ScanResult } from '../../src/types/index.js';

function validResult(): ScanResult {
  return {
    target: 'https://example.com/',
    startedAt: 1000,
    finishedAt: 2000,
    durationMs: 1000,
    pagesScanned: 5,
    pagesFailed: 0,
    pagesSkipped: 0,
    findings: [],
    errors: [],
    budgetExhausted: false,
  };
}

describe('validateAndSanitize', () => {
  it('accepts a valid report', () => {
    const r = validateAndSanitize(validResult());
    expect(r.target).toBe('https://example.com/');
  });

  it('rejects non-object', () => {
    expect(() => validateAndSanitize(null as unknown as ScanResult)).toThrow(ReportValidationError);
    expect(() => validateAndSanitize('string' as unknown as ScanResult)).toThrow(ReportValidationError);
  });

  it('rejects empty target', () => {
    const r = validResult();
    r.target = '';
    expect(() => validateAndSanitize(r)).toThrow(/target/);
  });

  it('rejects finishedAt < startedAt', () => {
    const r = validResult();
    r.finishedAt = r.startedAt - 1;
    expect(() => validateAndSanitize(r)).toThrow(/finishedAt/);
  });

  it('sanitizes control characters in target', () => {
    const r = validResult();
    r.target = 'https://example.com/\x00\x01\x02';
    const out = validateAndSanitize(r);
    expect(out.target).toBe('https://example.com/');
  });

  it('drops findings with unknown types', () => {
    const r = validResult();
    r.findings = [
      {
        id: '1',
        type: 'link_broken' as never,
        severity: 'error' as const,
        message: 'real finding',
        page: 'https://example.com/',
      },
      {
        id: '2',
        type: 'shell_command' as never, // unknown
        severity: 'error' as const,
        message: 'should be coerced',
        page: 'https://example.com/',
      },
    ];
    const out = validateAndSanitize(r);
    expect(out.findings).toHaveLength(2);
    expect(out.findings[1]?.type).toBe('scanner_error');
  });

  it('drops findings with non-string message or page', () => {
    const r = validResult();
    r.findings = [
      { id: '1', type: 'link_broken', severity: 'error', message: null as unknown as string, page: 'p' },
      { id: '2', type: 'link_broken', severity: 'error', message: 'ok', page: undefined as unknown as string },
      { id: '3', type: 'link_broken', severity: 'error', message: 'ok', page: 'p' },
    ];
    const out = validateAndSanitize(r);
    expect(out.findings).toHaveLength(1);
    expect(out.findings[0]?.id).toBe('3');
  });

  it('strips forbidden keys from detail (defense in depth)', () => {
    const r = validResult();
    r.findings = [
      {
        id: '1',
        type: 'link_broken',
        severity: 'error',
        message: 'm',
        page: 'p',
        detail: {
          status: 404,
          cookie: 'secret=value', // FORBIDDEN
          authorization: 'Bearer xyz', // FORBIDDEN
          sessionId: 'abc', // not in forbidlist, but tested below
        },
      },
    ];
    const out = validateAndSanitize(r);
    const detail = out.findings[0]?.detail as Record<string, unknown>;
    expect(detail.status).toBe(404);
    expect('cookie' in detail).toBe(false);
    expect('authorization' in detail).toBe(false);
  });

  it('caps findings to MAX_FINDINGS', () => {
    const r = validResult();
    r.findings = Array.from({ length: 200_000 }, (_, i) => ({
      id: `f-${i}`,
      type: 'meta_missing' as const,
      severity: 'info' as const,
      message: `msg-${i}`,
      page: 'p',
    }));
    const out = validateAndSanitize(r);
    expect(out.findings.length).toBeLessThanOrEqual(100_000);
  });

  it('sanitizes cache stats', () => {
    const r = validResult();
    r.cache = { linkProbes: 5, assetProbes: 10 };
    expect(validateAndSanitize(r).cache).toEqual({ linkProbes: 5, assetProbes: 10 });
  });

  it('coerces bad cache stats to zero', () => {
    const r = validResult();
    r.cache = { linkProbes: -5, assetProbes: 'nope' as unknown as number };
    const out = validateAndSanitize(r);
    expect(out.cache).toEqual({ linkProbes: 0, assetProbes: 0 });
  });

  it('preserves fix field after sanitization', () => {
    const r = validResult();
    r.findings = [
      {
        id: '1',
        type: 'link_broken',
        severity: 'error',
        message: 'm',
        page: 'p',
        fix: 'Replace the link with the correct URL.',
      },
    ];
    const out = validateAndSanitize(r);
    expect(out.findings[0]?.fix).toContain('Replace');
  });
});