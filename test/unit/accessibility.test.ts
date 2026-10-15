import { describe, it, expect } from 'vitest';
import { scanAccessibility } from '../../src/scanners/accessibility.js';
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

describe('scanAccessibility', () => {
  it('flags img with no alt attribute', () => {
    const html = `<html><body><img src="/x.png"></body></html>`;
    const f = scanAccessibility(pageOf(html));
    expect(f.some((x) => x.type === 'accessibility' && x.message.includes('alt'))).toBe(true);
  });

  it('accepts img with alt="" (decorative)', () => {
    const html = `<html><body><img src="/x.png" alt=""></body></html>`;
    const f = scanAccessibility(pageOf(html));
    expect(f.some((x) => x.message.includes('alt'))).toBe(false);
  });

  it('accepts img with descriptive alt', () => {
    const html = `<html><body><img src="/x.png" alt="A friendly dog"></body></html>`;
    const f = scanAccessibility(pageOf(html));
    expect(f.some((x) => x.message.includes('alt'))).toBe(false);
  });

  it('flags page with no h1', () => {
    const html = `<html><body><h2>Only an h2</h2></body></html>`;
    const f = scanAccessibility(pageOf(html));
    expect(f.some((x) => x.message.includes('no <h1>'))).toBe(true);
  });

  it('flags page with multiple h1', () => {
    const html = `<html><body><h1>A</h1><h1>B</h1></body></html>`;
    const f = scanAccessibility(pageOf(html));
    expect(f.some((x) => x.message.includes('multiple') || x.message.includes('2 <h1>'))).toBe(true);
  });

  it('accepts page with exactly one h1', () => {
    const html = `<html><body><h1>Main</h1><h2>Sub</h2></body></html>`;
    const f = scanAccessibility(pageOf(html));
    expect(f.some((x) => x.type === 'accessibility')).toBe(false);
  });

  it('flags heading level skip (h1 → h3)', () => {
    const html = `<html><body><h1>A</h1><h3>Skipped h2</h3></body></html>`;
    const f = scanAccessibility(pageOf(html));
    expect(f.some((x) => x.message.includes('skipped'))).toBe(true);
  });

  it('accepts sequential headings', () => {
    const html = `<html><body><h1>A</h1><h2>B</h2><h3>C</h3></body></html>`;
    const f = scanAccessibility(pageOf(html));
    expect(f.some((x) => x.message.includes('skipped'))).toBe(false);
  });

  it('returns no findings for non-HTML pages', () => {
    const page = pageOf('');
    page.isHtml = false;
    expect(scanAccessibility(page)).toEqual([]);
  });

  it('includes a fix recommendation on every accessibility finding', () => {
    const html = `<html><body><img src="/x.png"></body></html>`;
    const f = scanAccessibility(pageOf(html));
    expect(f.every((x) => typeof x.fix === 'string' && x.fix.length > 0)).toBe(true);
  });
});