import { describe, it, expect } from 'vitest';
import { scanRedirects } from '../../src/scanners/redirects.js';
import type { CrawledPage } from '../../src/types/index.js';

function pageWith(opts: {
  requestUrl?: string;
  finalUrl?: string;
  statusChain: number[];
  locationChain: string[];
}): CrawledPage {
  return {
    requestUrl: opts.requestUrl ?? 'https://example.com/',
    finalUrl: opts.finalUrl ?? 'https://example.com/',
    status: opts.statusChain[opts.statusChain.length - 1] ?? 200,
    statusChain: opts.statusChain,
    locationChain: opts.locationChain,
    contentType: 'text/html',
    html: '',
    fetchedAt: 0,
    bytes: 0,
    isHtml: true,
  };
}

describe('scanRedirects', () => {
  it('no findings for a single 200', () => {
    const f = scanRedirects(pageWith({ statusChain: [200], locationChain: [] }));
    expect(f).toHaveLength(0);
  });

  it('flags loop', () => {
    const f = scanRedirects(
      pageWith({
        requestUrl: 'https://example.com/a',
        finalUrl: 'https://example.com/a',
        statusChain: [301, 301, 301],
        locationChain: [
          'https://example.com/b',
          'https://example.com/a',
          'https://example.com/b',
        ],
      }),
    );
    expect(f.some((x) => x.type === 'redirect_loop')).toBe(true);
  });

  it('flags long chain', () => {
    const f = scanRedirects(
      pageWith({
        statusChain: [301, 301, 301, 301, 301],
        locationChain: ['a', 'b', 'c', 'd', 'e'],
      }),
    );
    expect(f.some((x) => x.type === 'redirect_chain_long')).toBe(true);
  });

  it('flags https -> http downgrade as error', () => {
    const f = scanRedirects(
      pageWith({
        requestUrl: 'https://example.com/a',
        finalUrl: 'http://example.com/b',
        statusChain: [301, 200],
        locationChain: ['http://example.com/b'],
      }),
    );
    expect(f.some((x) => x.severity === 'error' && x.type === 'redirect_downgrade')).toBe(true);
  });

  it('flags http -> https upgrade as info only', () => {
    const f = scanRedirects(
      pageWith({
        requestUrl: 'http://example.com/a',
        finalUrl: 'https://example.com/b',
        statusChain: [301, 200],
        locationChain: ['https://example.com/b'],
      }),
    );
    const down = f.find((x) => x.type === 'redirect_downgrade');
    expect(down?.severity).toBe('info');
  });
});