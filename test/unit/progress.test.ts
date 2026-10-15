import { describe, it, expect } from 'vitest';
import { ProgressReporter, formatProgressLine } from '../../src/core/progress.js';

describe('ProgressReporter', () => {
  it('emits events to subscribers', () => {
    const p = new ProgressReporter();
    const events: string[] = [];
    const unsub = p.on((e) => events.push(e.kind));
    p.emit({ kind: 'started', target: 'http://x', maxPages: 5, maxDepth: 2 });
    p.emit({ kind: 'page-scanned', url: 'http://x/', status: 200, pagesScanned: 1, pagesFailed: 0, queueSize: 0 });
    expect(events).toEqual(['started', 'page-scanned']);
    unsub();
  });

  it('unsub stops further events', () => {
    const p = new ProgressReporter();
    const events: string[] = [];
    const unsub = p.on((e) => events.push(e.kind));
    p.emit({ kind: 'started', target: 't', maxPages: 1, maxDepth: 1 });
    unsub();
    p.emit({ kind: 'finished', pagesScanned: 0, pagesFailed: 0, findings: 0, budgetExhausted: false, durationMs: 0 });
    expect(events).toEqual(['started']);
  });

  it('listener errors do not crash the reporter', () => {
    const p = new ProgressReporter();
    p.on(() => { throw new Error('boom'); });
    expect(() => p.emit({ kind: 'started', target: 't', maxPages: 1, maxDepth: 1 })).not.toThrow();
  });

  it('tracks stats from events', () => {
    const p = new ProgressReporter();
    p.emit({ kind: 'page-scanned', url: 'a', status: 200, pagesScanned: 1, pagesFailed: 0, queueSize: 0 });
    p.emit({ kind: 'page-scanned', url: 'b', status: 200, pagesScanned: 2, pagesFailed: 0, queueSize: 0 });
    p.emit({ kind: 'page-failed', url: 'c', code: 'TIMEOUT', pagesScanned: 2, pagesFailed: 1, queueSize: 0 });
    p.emit({ kind: 'finding', type: 'link_broken', severity: 'error', message: 'x' });
    p.emit({ kind: 'cache-hit', kind2: 'link', url: 'z' });
    const s = p.statsSnapshot();
    expect(s.pagesScanned).toBe(2);
    expect(s.pagesFailed).toBe(1);
    expect(s.findings).toBe(1);
    expect(s.cacheHits).toBe(1);
  });
});

describe('formatProgressLine', () => {
  it('formats started', () => {
    const line = formatProgressLine({ kind: 'started', target: 'http://x', maxPages: 5, maxDepth: 2 });
    expect(line).toContain('start');
    expect(line).toContain('maxPages=5');
  });

  it('formats page-scanned', () => {
    const line = formatProgressLine({
      kind: 'page-scanned', url: 'http://x/', status: 200,
      pagesScanned: 1, pagesFailed: 0, queueSize: 3,
    });
    expect(line).toContain('scanned');
    expect(line).toContain('1 ok');
  });

  it('formats finished with budget exhausted marker', () => {
    const line = formatProgressLine({
      kind: 'finished', pagesScanned: 1, pagesFailed: 0, findings: 0,
      budgetExhausted: true, durationMs: 1000,
    });
    expect(line).toContain('budget exhausted');
  });

  it('returns null for noisy cache-hit events', () => {
    expect(formatProgressLine({ kind: 'cache-hit', kind2: 'link', url: 'x' })).toBeNull();
  });

  it('does NOT include a fake percentage', () => {
    // Hard rule: no completion percentages — we don't know the total.
    const events: Parameters<typeof formatProgressLine>[0][] = [
      { kind: 'started', target: 'http://x', maxPages: 5, maxDepth: 2 },
      { kind: 'page-scanned', url: 'a', status: 200, pagesScanned: 1, pagesFailed: 0, queueSize: 0 },
      { kind: 'finished', pagesScanned: 1, pagesFailed: 0, findings: 0, budgetExhausted: false, durationMs: 0 },
    ];
    for (const e of events) {
      const line = formatProgressLine(e);
      if (line) expect(line).not.toMatch(/\d+%/);
    }
  });
});