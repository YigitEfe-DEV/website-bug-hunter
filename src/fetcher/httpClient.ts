import { Buffer } from 'node:buffer';
import { assertSafeUrl, type SafeUrlResult } from './safeUrl.js';
import type { CrawledPage } from '../types/index.js';

export interface FetchOptions {
  userAgent: string;
  timeoutMs: number;
  maxBytes: number;
  allowPrivate: boolean;
  /** Manual redirect chain (we capture Location ourselves, do NOT follow). */
}

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
 * Fetch a single URL with strict limits. Resolves the redirect chain
 * manually so we can report it. Treats any redirect as a separate
 * "request" that must also pass assertSafeUrl.
 */
export async function fetchPage(
  startUrl: string,
  opts: FetchOptions,
): Promise<CrawledPage> {
  const statusChain: number[] = [];
  const locationChain: string[] = [];
  let current = startUrl;
  let safe: SafeUrlResult;

  // Resolve first hop.
  try {
    safe = await assertSafeUrl(current, { allowPrivate: opts.allowPrivate });
  } catch (e) {
    throw new FetchError('UNSAFE_URL', (e as Error).message);
  }

  // Manual redirect loop with a strict cap to prevent infinite chains.
  const MAX_HOPS = 10;
  for (let hop = 0; hop <= MAX_HOPS; hop++) {
    const res = await rawFetch(safe.url.toString(), opts);
    statusChain.push(res.status);
    if (res.status >= 300 && res.status < 400) {
      const loc = res.headers.get('location');
      if (!loc) {
        // Redirect without Location: treat as final.
        break;
      }
      const next = new URL(loc, safe.url).toString();
      locationChain.push(next);
      try {
        safe = await assertSafeUrl(next, { allowPrivate: opts.allowPrivate });
      } catch (e) {
        throw new FetchError('UNSAFE_REDIRECT', (e as Error).message);
      }
      current = next;
      continue;
    }
    // Final response.
    const contentType = res.headers.get('content-type') ?? '';
    const isHtml = /text\/html|application\/xhtml\+xml/i.test(contentType);
    if (!isHtml) {
      // Non-HTML final response (CSS, image, etc.). Return as opaque page
      // so link checkers can record status without forcing HTML parsing.
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
    const body = await readWithCap(res, opts.maxBytes);
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

async function rawFetch(url: string, opts: FetchOptions): Promise<Response> {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), opts.timeoutMs);
  try {
    return await fetch(url, {
      method: 'GET',
      redirect: 'manual',
      signal: ac.signal,
      headers: {
        'User-Agent': opts.userAgent,
        Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.5',
      },
    });
  } catch (e) {
    const msg = (e as Error).message || 'unknown';
    if (msg.includes('abort')) {
      throw new FetchError('TIMEOUT', `Fetch timed out after ${opts.timeoutMs}ms`);
    }
    throw new FetchError('NETWORK', `Network error: ${msg}`);
  } finally {
    clearTimeout(timer);
  }
}

async function readWithCap(res: Response, maxBytes: number): Promise<Buffer> {
  if (!res.body) return Buffer.alloc(0);
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    if (!value) continue;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => {});
      chunks.push(value.subarray(0, value.byteLength - (total - maxBytes)));
      break;
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks.map((c) => Buffer.from(c)));
}