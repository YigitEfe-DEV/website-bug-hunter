import { describe, it, expect } from 'vitest';
import { extractMeta, detectDuplicates, type PageMeta } from '../../src/scanners/duplicates.js';
import type { CrawledPage } from '../../src/types/index.js';

function pageOf(html: string, url = 'https://example.com/'): CrawledPage {
  return {
    requestUrl: url,
    finalUrl: url,
    status: 200,
    statusChain: [200],
    locationChain: [],
    contentType: 'text/html',
    html,
    fetchedAt: 0,
    bytes: html.length,
    isHtml: true,
  };
}

describe('extractMeta', () => {
  it('extracts title, description, canonical', () => {
    const html = `<html><head>
      <title>Hello World Page Title Here</title>
      <meta name="description" content="A description of about page">
      <link rel="canonical" href="https://example.com/foo">
    </head></html>`;
    const m = extractMeta(pageOf(html));
    expect(m?.title).toBe('Hello World Page Title Here');
    expect(m?.description).toBe('A description of about page');
    expect(m?.canonical).toBe('https://example.com/foo');
  });

  it('returns null for non-HTML', () => {
    const p = pageOf('x');
    p.isHtml = false;
    expect(extractMeta(p)).toBeNull();
  });
});

describe('detectDuplicates', () => {
  it('no findings when titles differ', () => {
    const pages: PageMeta[] = [
      { url: 'https://example.com/a', title: 'Page A', description: 'desc A', canonical: null },
      { url: 'https://example.com/b', title: 'Page B', description: 'desc B', canonical: null },
    ];
    expect(detectDuplicates(pages)).toEqual([]);
  });

  it('flags duplicate titles', () => {
    const pages: PageMeta[] = [
      { url: 'https://example.com/a', title: 'Same Title', description: '', canonical: null },
      { url: 'https://example.com/b', title: 'Same Title', description: '', canonical: null },
    ];
    const f = detectDuplicates(pages);
    expect(f.some((x) => x.type === 'duplicate' && x.message.includes('title'))).toBe(true);
  });

  it('does not flag if duplicate title appears only on the same URL', () => {
    const pages: PageMeta[] = [
      { url: 'https://example.com/a', title: 'X', description: '', canonical: null },
      { url: 'https://example.com/a', title: 'X', description: '', canonical: null }, // dedup upstream
    ];
    expect(detectDuplicates(pages)).toEqual([]);
  });

  it('flags duplicate descriptions', () => {
    const pages: PageMeta[] = [
      { url: 'https://example.com/a', title: 'A', description: 'Same description text', canonical: null },
      { url: 'https://example.com/b', title: 'B', description: 'Same description text', canonical: null },
    ];
    const f = detectDuplicates(pages);
    expect(f.some((x) => x.message.includes('description'))).toBe(true);
  });

  it('flags shared canonicals', () => {
    const pages: PageMeta[] = [
      { url: 'https://example.com/a', title: 'A', description: '', canonical: 'https://example.com/main' },
      { url: 'https://example.com/b', title: 'B', description: '', canonical: 'https://example.com/main' },
    ];
    const f = detectDuplicates(pages);
    expect(f.some((x) => x.message.includes('canonical'))).toBe(true);
  });

  it('every duplicate finding carries a fix recommendation', () => {
    const pages: PageMeta[] = [
      { url: 'https://example.com/a', title: 'Same', description: 'Same', canonical: 'https://example.com/x' },
      { url: 'https://example.com/b', title: 'Same', description: 'Same', canonical: 'https://example.com/x' },
    ];
    const f = detectDuplicates(pages);
    expect(f.length).toBeGreaterThan(0);
    expect(f.every((x) => typeof x.fix === 'string' && x.fix.length > 0)).toBe(true);
  });
});