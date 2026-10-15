import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startFixtureServer } from '../fixtures/fixture-server.js';
import { runScan } from '../../src/core/orchestrator.js';

let fixtureUrl = '';
let close: () => Promise<void> = async () => {};

beforeAll(async () => {
  const server = await startFixtureServer();
  fixtureUrl = server.url;
  close = server.close;
});

afterAll(async () => {
  await close();
});

describe('e2e: orchestrator against local fixture server', () => {
  it('scans home, finds broken link, missing image', async () => {
    const result = await runScan({
      target: fixtureUrl + '/',
      overrides: {
        allowPrivate: true, // required to talk to 127.0.0.1 fixture
        maxPages: 20,
        maxDepth: 2,
        timeoutMs: 5000,
        maxBytesPerPage: 256 * 1024,
        concurrency: 2,
      },
    });

    expect(result.pagesScanned).toBeGreaterThanOrEqual(2);
    // The /loop fixture deliberately creates a redirect cycle, which surfaces
    // as a pagesFailed entry; that is correct behavior.
    expect(result.pagesFailed).toBeGreaterThanOrEqual(1);

    const types = new Set(result.findings.map((f) => f.type));
    // The fixture has a /broken page (404) — should fire link_broken.
    expect(types.has('link_broken')).toBe(true);

    // /missing-image is referenced as <img> AND as <a>; both scanners fire.
    expect(types.has('image_broken')).toBe(true);

    expect(result.findings.length).toBeGreaterThan(0);
  }, 30_000);

  it('respects max-pages budget', async () => {
    const result = await runScan({
      target: fixtureUrl + '/',
      overrides: {
        allowPrivate: true,
        maxPages: 1,
        maxDepth: 5,
        timeoutMs: 5000,
        maxBytesPerPage: 256 * 1024,
        concurrency: 1,
      },
    });
    // With maxDepth=5, the root page has links; after scanning 1 page,
    // additional pages would be enqueued but budget blocks them.
    expect(result.pagesScanned).toBe(1);
    expect(result.budgetExhausted).toBe(true);
  }, 30_000);
});