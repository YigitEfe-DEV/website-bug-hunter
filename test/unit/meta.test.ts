import { describe, it, expect } from 'vitest';
import { scanMeta } from '../../src/scanners/meta.js';
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

describe('scanMeta', () => {
  it('reports missing title', () => {
    const html = `<html lang="en"><head><meta charset="utf-8"></head><body></body></html>`;
    const findings = scanMeta(pageOf(html));
    expect(findings.some((f) => f.message.includes('<title>'))).toBe(true);
  });

  it('reports missing viewport', () => {
    const html = `<html lang="en"><head><title>OK</title><meta charset="utf-8"></head></html>`;
    const findings = scanMeta(pageOf(html));
    expect(findings.some((f) => f.message.includes('viewport'))).toBe(true);
  });

  it('warns when viewport lacks width=device-width', () => {
    const html = `<html lang="en"><head><title>OK</title><meta charset="utf-8">
<meta name="viewport" content="initial-scale=1"></head></html>`;
    const findings = scanMeta(pageOf(html));
    expect(findings.some((f) => f.message.includes('width=device-width'))).toBe(true);
  });

  it('reports missing html lang', () => {
    const html = `<html><head><title>OK</title><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1"></head></html>`;
    const findings = scanMeta(pageOf(html));
    expect(findings.some((f) => f.message.includes('<html lang>'))).toBe(true);
  });

  it('reports no findings for a fully-formed head', () => {
    const html = `<html lang="en"><head>
      <title>Hello World page</title>
      <meta charset="utf-8">
      <meta name="viewport" content="width=device-width, initial-scale=1">
      <meta name="description" content="A reasonably long description that is at least fifty characters in total.">
      <meta property="og:title" content="Hello">
      <meta property="og:image" content="https://example.com/og.png">
      <link rel="canonical" href="https://example.com/">
      <link rel="icon" href="https://example.com/favicon.ico">
    </head><body></body></html>`;
    const findings = scanMeta(pageOf(html));
    expect(findings).toHaveLength(0);
  });
});