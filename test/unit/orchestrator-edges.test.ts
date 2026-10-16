/**
 * High-value regression tests — gaps not covered by the existing suites.
 * Each block targets a behaviour identified by the recent verification
 * calls out but that no other test owns yet.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createServer, type Server } from 'node:http';
import { runScan } from '../../src/core/orchestrator.js';
import type { AddressInfo } from 'node:net';

let server: Server;
let base = '';

/**
 * Minimal address-info lookup helper that satisfies noUncheckedIndexedAccess.
 */
function portFrom(server: Server): number {
  const addr = server.address() as AddressInfo;
  return addr.port;
}

beforeAll(async () => {
  server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    if (url.pathname === '/slow') {
      // Simulate a slow page so we can cancel mid-flight.
      setTimeout(() => {
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end('<html><body>late</body></html>');
      }, 30_000);
      return;
    }
    if (url.pathname === '/big') {
      // Send a >1MB body; orchestrator config caps at 1024 bytes below.
      res.writeHead(200, {
        'Content-Type': 'text/html',
        'Content-Length': String(2 * 1024 * 1024),
      });
      const chunk = 'A'.repeat(2 * 1024 * 1024);
      res.end(chunk);
      return;
    }
    if (url.pathname === '/empty') {
      // 2xx response with HTML Content-Type but zero bytes — must NOT
      // produce a flood of meta_missing findings.
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end('');
      return;
    }
    if (url.pathname === '/reset') {
      // Accept then immediately destroy the socket — undici reports
      // UND_ERR_SOCKET which the orchestrator maps to CONNECTION_RESET.
      // We get the underlying socket via the request and destroy it.
      req.socket.destroy();
      return;
    }
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(
      `<html lang="en"><head><title>Edge test</title><meta charset="utf-8">
        <meta name="viewport" content="width=device-width, initial-scale=1"></head>
        <body><h1>Edge</h1></body></html>`,
    );
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  base = `http://127.0.0.1:${portFrom(server)}`;
});

afterAll(async () => {
  await new Promise<void>((r) => server.close(() => r()));
});

describe('orchestrator edges', () => {
  it('honors caller AbortSignal — stops in-flight work and returns partial result', async () => {
    const ac = new AbortController();
    const p = runScan(
      {
        target: base + '/slow',
        overrides: {
          allowPrivate: true,
          maxPages: 1,
          maxDepth: 0,
          timeoutMs: 30_000,
          maxBytesPerPage: 64 * 1024,
          concurrency: 1,
        },
      },
      ac.signal,
    );
    // Abort as soon as the request is in flight.
    setTimeout(() => ac.abort(), 50);
    const result = await p;
    // Either the page was skipped/errored, or budget is marked exhausted.
    // We don't care which — what we care about is that the function returned
    // (didn't hang) and the result is well-formed.
    expect(result.target).toBe(base + '/slow');
    expect(Array.isArray(result.findings)).toBe(true);
    expect(Array.isArray(result.errors)).toBe(true);
  }, 10_000);

  it('caps response body to maxBytesPerPage without crashing', async () => {
    const result = await runScan({
      target: base + '/big',
      overrides: {
        allowPrivate: true,
        maxPages: 1,
        maxDepth: 0,
        timeoutMs: 5_000,
        // 1 KB cap should kick in on the 2 MB fixture body.
        maxBytesPerPage: 1024,
        concurrency: 1,
      },
    });
    expect(result.pagesScanned).toBe(1);
    // The page was scanned, but the body was truncated; we don't assert
    // on truncation at this layer — see the existing e2e for that detail.
  }, 10_000);

  it('reports a request_failed finding when the address is unreachable (offline)', async () => {
    // Bind to nothing — pick an ephemeral loopback that we never start.
    const result = await runScan({
      target: 'http://127.0.0.1:1/',
      overrides: {
        allowPrivate: true,
        maxPages: 1,
        maxDepth: 0,
        timeoutMs: 1000,
        maxBytesPerPage: 1024,
        concurrency: 1,
      },
    });
    // We expect pagesScanned=0, pagesFailed=1, budgetExhausted=true (because
    // the orchestrator aborts itself when requestsMade>=maxRequests on
    // connection failure).
    expect(result.pagesScanned).toBe(0);
    expect(result.pagesFailed).toBeGreaterThanOrEqual(1);
    const failed = result.findings.find((f) => f.type === 'request_failed');
    expect(failed).toBeDefined();
  }, 10_000);

  it('emits a single EMPTY_BODY finding instead of meta_missing flood for an empty HTML response', async () => {
    const result = await runScan({
      target: base + '/empty',
      overrides: {
        allowPrivate: true,
        maxPages: 1,
        maxDepth: 0,
        timeoutMs: 5_000,
        maxBytesPerPage: 1024,
        concurrency: 1,
      },
    });
    // Empty body counts in pagesIncomplete (2xx but unanalyzable),
    // NOT in pagesScanned (which only counts pages that were actually
    // analyzed). This keeps the counters honest.
    expect(result.pagesScanned).toBe(0);
    expect(result.pagesIncomplete).toBe(1);
    // The single emitted finding must be EMPTY_BODY, not a flood of
    // meta_missing / meta_invalid findings that imply the page is broken.
    const emptyBody = result.findings.filter(
      (f) =>
        f.detail &&
        typeof f.detail === 'object' &&
        (f.detail as { code?: string }).code === 'EMPTY_BODY',
    );
    expect(emptyBody).toHaveLength(1);
    const metaMissing = result.findings.filter((f) => f.type === 'meta_missing');
    expect(metaMissing).toHaveLength(0);
  }, 10_000);

  it('reports connection-reset failure with code CONNECTION_RESET (or NETWORK fallback) when the server destroys the socket', async () => {
    const result = await runScan({
      target: base + '/reset',
      overrides: {
        allowPrivate: true,
        maxPages: 1,
        maxDepth: 0,
        timeoutMs: 2_000,
        maxBytesPerPage: 1024,
        concurrency: 1,
      },
    });
    // Either pagesScanned=0 with a failed attempt, or pagesFailed>=1.
    expect(result.pagesFailed).toBeGreaterThanOrEqual(1);
    const failed = result.findings.find((f) => f.type === 'request_failed');
    expect(failed).toBeDefined();
    // The code must be classified — not left as a generic NETWORK miss
    // unless the underlying cause is unrecognizable.
    const code = (failed?.detail as { code?: string } | undefined)?.code;
    expect(['CONNECTION_RESET', 'NETWORK']).toContain(code);
  }, 10_000);

  it('does not mark a request_failed finding as confirmed when it is a transient transport error', async () => {
    const result = await runScan({
      target: 'http://127.0.0.1:1/',
      overrides: {
        allowPrivate: true,
        maxPages: 1,
        maxDepth: 0,
        timeoutMs: 1000,
        maxBytesPerPage: 1024,
        concurrency: 1,
      },
    });
    const failed = result.findings.find((f) => f.type === 'request_failed');
    expect(failed).toBeDefined();
    // The classification layer marks transport failures as inconclusive
    // so the operator does not treat a transient outage as a defect.
    expect(failed?.confidence).toBe('inconclusive');
  }, 10_000);
});
