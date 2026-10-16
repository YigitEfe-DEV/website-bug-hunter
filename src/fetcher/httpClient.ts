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
   *
   * `| undefined` is explicit because the project compiles with
   * `exactOptionalPropertyTypes: true`. Callers commonly pass through
   * a parameter that may itself be undefined; we want that to type-
   * check, not require every call site to omit the key conditionally.
   */
  signal?: AbortSignal | undefined;
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
 *
 * Error classification: Node's undici surfaces a generic `TypeError:
 * fetch failed` for every transport-level failure, with the real cause
 * attached to `error.cause`. We walk the cause chain so a TLS handshake
 * problem is not reported as a generic "Network error", and a remote
 * reset during the TLS handshake is not lumped in with a DNS failure.
 *
 * Recognized cause codes (undici / Node):
 *   - UND_ERR_SOCKET       ECONNRESET, "other side closed", TLS close
 *   - UND_ERR_CONNECT_TIMEOUT
 *   - UND_ERR_HEADERS_TIMEOUT
 *   - UND_ERR_BODY_TIMEOUT
 *   - ERR_SSL_* / UND_ERR_PRX_TLS   TLS handshake / cert failure
 *   - ENOTFOUND / EAI_AGAIN         DNS resolution failure (defense
 *                                   layer is in `safeUrl.ts`; this is
 *                                   only reached for hostname-literal
 *                                   cases that somehow bypassed)
 *
 * Anything else falls through to a generic NETWORK classification so
 * the operator can still tell the scan is incomplete.
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
    const classified = classifyFetchError(e as Error, ac.signal, opts.timeoutMs);
    throw classified;
  } finally {
    clearTimeout(timer);
    if (opts.signal) opts.signal.removeEventListener('abort', onAbort);
    // Tear down the per-hop dispatcher so its sockets are released.
    dispatcher.close().catch(() => {});
  }
}

/**
 * Map a thrown fetch error to a stable `FetchError` code.
 *
 * `fetch failed` is undici's wrapper; the underlying cause lives at
 * `cause` and may itself carry a `cause` (e.g. TLS errors wrap an
 * OpenSSL error which wraps a socket error). We walk the chain until
 * we find a recognizable code or message, then fall back to NETWORK.
 *
 * We never re-throw the underlying Error so the orchestrator cannot
 * accidentally serialize a stack trace into the report.
 */
function classifyFetchError(e: Error, signal: AbortSignal, timeoutMs: number): FetchError {
  if (signal.aborted) {
    return new FetchError('TIMEOUT', `Fetch timed out or aborted after ${timeoutMs}ms`);
  }
  // Walk the cause chain (max 4 hops — TLS errors can nest deeply).
  let cur: Error | { name?: string; code?: string; message?: string } | undefined = e;
  let undCode: string | undefined;
  let sysCode: string | undefined;
  let lastMessage = '';
  let isSsl = false;
  let isSocketReset = false;
  for (let hop = 0; hop < 4 && cur; hop++) {
    const obj = cur as { name?: string; code?: string; message?: string; cause?: unknown };
    if (typeof obj.code === 'string') {
      if (obj.code.startsWith('UND_ERR_')) {
        undCode = obj.code;
      } else {
        sysCode = obj.code;
      }
    }
    const msg = obj.message ?? '';
    if (msg) lastMessage = msg;
    const lower = msg.toLowerCase();
    if (
      obj.code === 'ERR_SSL_WRONG_VERSION_NUMBER' ||
      obj.code === 'ERR_TLS_CERT_ALTNAME_INVALID' ||
      obj.code?.startsWith('ERR_SSL_') ||
      obj.code?.startsWith('ERR_TLS_') ||
      obj.code === 'UND_ERR_PRX_TLS' ||
      lower.includes('ssl') ||
      lower.includes('tls') ||
      lower.includes('certificate')
    ) {
      isSsl = true;
    }
    if (
      obj.code === 'ECONNRESET' ||
      lower.includes('econnreset') ||
      lower.includes('connection reset') ||
      lower.includes('other side closed') ||
      lower.includes('socket hang up')
    ) {
      isSocketReset = true;
    }
    cur = obj.cause as Error | undefined;
  }
  // Aborted via signal — covers the case where the abort came from the
  // caller's signal rather than our timeout.
  if (e.name === 'AbortError' || sysCode === 'ABORT_ERR') {
    return new FetchError('TIMEOUT', `Fetch aborted after ${timeoutMs}ms`);
  }
  if (undCode === 'UND_ERR_CONNECT_TIMEOUT') {
    return new FetchError('CONNECT_TIMEOUT', `Connect timed out after ${timeoutMs}ms`);
  }
  if (
    undCode === 'UND_ERR_HEADERS_TIMEOUT' ||
    undCode === 'UND_ERR_BODY_TIMEOUT'
  ) {
    return new FetchError('TIMEOUT', `Response timed out after ${timeoutMs}ms`);
  }
  if (isSsl) {
    return new FetchError('TLS_ERROR', `TLS error: ${truncate(lastMessage, 200)}`);
  }
  if (isSocketReset || undCode === 'UND_ERR_SOCKET') {
    return new FetchError(
      'CONNECTION_RESET',
      `Connection reset by peer: ${truncate(lastMessage, 200)}`,
    );
  }
  if (sysCode === 'ENOTFOUND' || sysCode === 'EAI_AGAIN') {
    return new FetchError('DNS_FAIL', `DNS failure: ${truncate(lastMessage, 200)}`);
  }
  return new FetchError('NETWORK', `Network error: ${truncate(lastMessage || e.message || 'unknown', 200)}`);
}

function truncate(s: string, max: number): string {
  if (typeof s !== 'string') return '';
  return s.length > max ? s.substring(0, max) + '…' : s;
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
