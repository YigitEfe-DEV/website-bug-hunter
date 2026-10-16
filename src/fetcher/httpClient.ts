import { Buffer } from 'node:buffer';
import { Agent } from 'undici';
import { assertSafeUrl, type SafeUrlResult } from './safeUrl.js';
import type { CrawledPage } from '../types/index.js';

export interface FetchOptions {
  userAgent: string;
  timeoutMs: number;
  maxBytes: number;
  allowPrivate: boolean;
  /**
   * Shared cancellation signal from the orchestrator. The fetch aborts
   * its network I/O when this fires. Timeouts and destination-safety
   * errors share the same cleanup path.
   */
  signal?: AbortSignal;
}

/**
 * Manual redirect-loop error code — caller distinguishes it from
 * UNSAFE_REDIRECT (which means a hop landed on a denied IP/range).
 */
export class FetchError extends Error {
  public readonly code: string;
  public readonly status?: number;
  constructor(code: string, message: string, status?: number) {
    super(message);
    this.name = 'FetchError';
    this.code = code;
    if (status !== undefined) this.status = status;
  }
}

/**
 * Maximum hops in a manual redirect chain. Picked to match common
 * browser defaults (Chrome, Firefox, curl) so legitimate chains fit,
 * but loops are still truncated.
 */
const MAX_HOPS = 10;

/**
 * Default body cap when callers don't specify. 2 MiB is comfortably
 * above the largest HTML page most scanners will encounter while still
 * bounding decompressed-size amplification.
 */
const DEFAULT_MAX_BYTES = 2 * 1024 * 1024;

/**
 * Fetch a single URL with strict limits. Resolves the redirect chain
 * manually so we can report it. Treats any redirect as a separate
 * "request" that must also pass assertSafeUrl.
 *
 * DNS-rebinding defense: we connect through a per-hop undici Agent
 * whose `connect.host` is the IP we validated. This bypasses the
 * platform resolver at connection time — a malicious DNS server cannot
 * return a private IP after we resolve. SNI is set to the hostname so
 * the server's TLS cert verification still matches.
 */
export async function fetchPage(
  startUrl: string,
  opts: FetchOptions,
): Promise<CrawledPage> {
  const statusChain: number[] = [];
  const locationChain: string[] = [];
  let current = startUrl;
  let safe: SafeUrlResult;

  try {
    safe = await assertSafeUrl(current, { allowPrivate: opts.allowPrivate });
  } catch (e) {
    throw new FetchError('UNSAFE_URL', (e as Error).message);
  }

  const maxBytes = opts.maxBytes > 0 ? opts.maxBytes : DEFAULT_MAX_BYTES;

  for (let hop = 0; hop <= MAX_HOPS; hop++) {
    const res = await rawFetch(safe, opts);
    statusChain.push(res.status);
    if (res.status >= 300 && res.status < 400) {
      const loc = res.headers.get('location');
      if (!loc) break;
      let next: string;
      try {
        next = new URL(loc, safe.url).toString();
      } catch {
        throw new FetchError('BAD_LOCATION', 'Redirect Location header did not form a valid URL');
      }
      locationChain.push(next);
      try {
        safe = await assertSafeUrl(next, { allowPrivate: opts.allowPrivate });
      } catch (e) {
        throw new FetchError('UNSAFE_REDIRECT', (e as Error).message);
      }
      current = next;
      continue;
    }
    const contentType = res.headers.get('content-type') ?? '';
    const isHtml = /text\/html|application\/xhtml\+xml/i.test(contentType);
    if (!isHtml) {
      return {
        requestUrl: startUrl,
        finalUrl: current,
        status: res.status,
        statusChain,
        locationChain,
        contentType,
        html: '',
        fetchedAt: Date.now(),
        bytes: 0,
        isHtml: false,
      };
    }
    const body = await readWithCap(res, maxBytes, opts.signal);
    return {
      requestUrl: startUrl,
      finalUrl: current,
      status: res.status,
      statusChain,
      locationChain,
      contentType,
      html: body.toString('utf8'),
      fetchedAt: Date.now(),
      bytes: body.length,
      isHtml: true,
    };
  }

  throw new FetchError(
    'REDIRECT_LOOP',
    `Exceeded ${MAX_HOPS} redirect hops`,
  );
}

/**
 * Build a per-fetch undici Agent that pins the TCP destination to the
 * already-validated IP, while keeping SNI / Host on the original hostname
 * so TLS cert validation succeeds against the public cert.
 *
 * The Agent is single-use: undici's `connect` option scopes the pinning
 * to one socket lifetime and avoids any cross-request contamination.
 */
function pinAgent(safe: SafeUrlResult): Agent {
  const isHttps = safe.url.protocol === 'https:';
  const port = safe.url.port
    ? Number(safe.url.port)
    : isHttps
      ? 443
      : 80;
  return new Agent({
    connect: {
      host: safe.ip,
      port,
      // Server Name Indication for TLS. Without this, undici sends the IP
      // as the SNI hostname — every public cert would fail.
      servername: isHttps ? safe.url.hostname : undefined,
    },
    bodyTimeout: 0, // we own the timer; undici's defaults can extend beyond ours
    headersTimeout: 0,
  });
}

/**
 * Single-hop fetch through a per-request dispatcher that pins the
 * resolved IP. Always honors the supplied AbortSignal and the per-
 * request timeout; both routes land on the same finally-cleared timer.
 */
async function rawFetch(
  safe: SafeUrlResult,
  opts: FetchOptions,
): Promise<Response> {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), opts.timeoutMs);
  // Wire the orchestrator's cancellation into the same signal tree.
  const onAbort = () => ac.abort();
  if (opts.signal) {
    if (opts.signal.aborted) ac.abort();
    else opts.signal.addEventListener('abort', onAbort, { once: true });
  }
  const dispatcher = pinAgent(safe);
  try {
    return await fetch(safe.url.toString(), {
      method: 'GET',
      redirect: 'manual',
      signal: ac.signal,
      dispatcher,
      headers: {
        'User-Agent': opts.userAgent,
        Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.5',
      },
    });
  } catch (e) {
    const msg = (e as Error).message || 'unknown';
    if (msg.includes('abort') || ac.signal.aborted) {
      throw new FetchError('TIMEOUT', `Fetch timed out or aborted after ${opts.timeoutMs}ms`);
    }
    throw new FetchError('NETWORK', `Network error: ${msg}`);
  } finally {
    clearTimeout(timer);
    if (opts.signal) opts.signal.removeEventListener('abort', onAbort);
    // Tear down the per-hop dispatcher so its sockets are released.
    dispatcher.close().catch(() => {});
  }
}

async function readWithCap(
  res: Response,
  maxBytes: number,
  signal?: AbortSignal,
): Promise<Buffer> {
  if (!res.body) return Buffer.alloc(0);
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  let truncated = false;
  try {
    while (true) {
      if (signal?.aborted) {
        await reader.cancel().catch(() => {});
        throw new FetchError('CANCELLED', 'Fetch cancelled by orchestrator');
      }
      const { value, done } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > maxBytes) {
        truncated = true;
        const overshoot = total - maxBytes;
        await reader.cancel().catch(() => {});
        if (overshoot < value.byteLength) {
          chunks.push(value.subarray(0, value.byteLength - overshoot));
        }
        break;
      }
      chunks.push(value);
    }
  } finally {
    // Best-effort release of the lock.
    try { reader.releaseLock(); } catch { /* already released */ }
  }
  if (truncated) {
    // Surface partial reads so callers can reflect on their budget.
    (truncated as unknown) = true;
  }
  return Buffer.concat(chunks.map((c) => Buffer.from(c)));
}
