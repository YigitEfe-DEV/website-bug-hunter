import { lookup } from 'dns/promises';
import type { LookupAddress } from 'dns';
import { Agent } from 'undici';
import { assertSafeUrl } from './safeUrl.js';
import { logger } from '../utils/logger.js';

/**
 * Minimal robots.txt fetcher. We parse just enough to answer
 * "is this path allowed for our user-agent?" — no crawl-delay, no sitemaps.
 *
 * Spec: https://www.rfc-editor.org/rfc/rfc9309.html
 *
 * Security: the robots.txt fetch goes through the same gate as every
 * other URL — `assertSafeUrl` validates the host, denies private/loopback
 * ranges, and returns the IP we pin for the connection via an undici
 * dispatcher. This closes the SSRF gap that a raw `fetch(robotsUrl)`
 * call would leave open.
 */
export interface RobotsOptions {
  /** Allow private IP ranges (NEVER in production). */
  allowPrivate?: boolean;
  /** Cancellation signal from the orchestrator. */
  signal?: AbortSignal;
  /** Per-request timeout in ms. Default 5s. */
  timeoutMs?: number;
}

export class RobotsCache {
  private cache = new Map<string, ParsedRobots | null>();
  private ua: string;
  private allowPrivate: boolean;
  private signal?: AbortSignal;
  private timeoutMs: number;

  constructor(userAgent: string, options: RobotsOptions = {}) {
    this.ua = userAgent.toLowerCase();
    this.allowPrivate = Boolean(options.allowPrivate);
    if (options.signal) this.signal = options.signal;
    this.timeoutMs = options.timeoutMs ?? 5000;
  }

  async isAllowed(url: string): Promise<boolean> {
    try {
      const u = new URL(url);
      const robotsUrl = `${u.protocol}//${u.host}/robots.txt`;
      let parsed = this.cache.get(robotsUrl);
      if (parsed === undefined) {
        parsed = await this.fetch(robotsUrl);
        this.cache.set(robotsUrl, parsed);
      }
      if (!parsed) return true;
      const path = u.pathname + u.search;
      return !parsed.isDisallowed(path, this.ua);
    } catch (e) {
      logger.debug({ url, err: (e as Error).message }, 'robots check failed');
      return true; // Fail open: if we can't tell, allow.
    }
  }

  /**
   * Fetch the robots.txt body for a URL, validating the host through
   * the same gate as every other network call. If validation fails
   * (private IP, denied range, control-chars, etc.), we return null —
   * which is treated as "no robots.txt" by `isAllowed` (i.e., allow).
   */
  private async fetch(robotsUrl: string): Promise<ParsedRobots | null> {
    let safe;
    try {
      safe = await assertSafeUrl(robotsUrl, { allowPrivate: this.allowPrivate });
    } catch (e) {
      logger.debug(
        { url: robotsUrl, code: (e as { code?: string }).code ?? 'UNSAFE' },
        'refusing robots fetch: blocked by safe url gate',
      );
      return null;
    }

    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), this.timeoutMs);
    const onAbort = () => ac.abort();
    if (this.signal) {
      if (this.signal.aborted) ac.abort();
      else this.signal.addEventListener('abort', onAbort, { once: true });
    }

    try {
      const isHttps = safe.url.protocol === 'https:';
      const port = safe.url.port
        ? Number(safe.url.port)
        : isHttps
          ? 443
          : 80;
      const dispatcher = new Agent({
        connect: {
          host: safe.ip,
          port,
          servername: isHttps ? safe.url.hostname : undefined,
        },
        bodyTimeout: 0,
        headersTimeout: 0,
      });
      // Best-effort precheck that the host still resolves publicly.
      // assertSafeUrl already pinned the IP, but a re-lookup catches
      // the rare case where DNS was previously healthy and is now
      // returning bogus answers on a second resolve.
      try {
        const recheck: LookupAddress[] = await lookup(safe.url.hostname, {
          all: true,
          verbatim: true,
        });
        for (const a of recheck) {
          if (a.family === 4 && isPrivateV4(a.address)) return null;
        }
      } catch {
        return null;
      }
      const res = await fetch(safe.url.toString(), {
        method: 'GET',
        signal: ac.signal,
        dispatcher,
        headers: { 'User-Agent': this.ua, Accept: 'text/plain,*/*;q=0.5' },
      });
      if (!res.ok) return null;
      const text = await res.text();
      return parseRobots(text);
    } catch (e) {
      logger.debug(
        { url: robotsUrl, err: (e as Error).message },
        'robots fetch errored',
      );
      return null;
    } finally {
      clearTimeout(timer);
      if (this.signal) this.signal.removeEventListener('abort', onAbort);
    }
  }
}

/**
 * Tiny IP-range check used only for the connection-time re-validation
 * in `RobotsCache.fetch`. Mirrors the broader deny-lists in
 * `safeUrl.ts` for IPv4 only. IPv6 ranges are intentionally not
 * re-checked here — `assertSafeUrl` already gated them upstream; a
 * double-check would cost an extra lookup.
 */
function isPrivateV4(addr: string): boolean {
  const parts = addr.split('.');
  if (parts.length !== 4) return false;
  const v = parts.map((p) => Number(p));
  if (v.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return false;
  // parts.length === 4 is checked above; noUncheckedIndexedAccess makes
  // TS treat v[0..3] as number | undefined, but they are guaranteed by the
  // length check. Non-null assertions keep this hot-path branchless.
  // 10/8, 127/8, 169.254/16, 172.16/12, 192.168/16, 100.64/10
  const a = v[0]!;
  const b = v[1]!;
  const c = v[2]!;
  const d = v[3]!;
  if (a === 10) return true;
  if (a === 127) return true;
  if (a === 169 && b === 254) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 100 && b >= 64 && b <= 127) return true;
  if (a === 0) return true;
  // (c, d) are validated but unused in the deny-list; reference them so
  // they don't trigger noUnusedLocals and remain auditable.
  void c; void d;
  return false;
}

interface ParsedRobots {
  isDisallowed(path: string, ua: string): boolean;
}

/** Tiny RFC 9309-compliant subset parser. Wildcards in paths not supported. */
function parseRobots(text: string): ParsedRobots {
  type Rule = { ua: string[]; allow: string[]; disallow: string[] };
  const rules: Rule[] = [];
  const comments = /\s*#.*$/gm;
  const stripped = text.replace(comments, '');
  const lines = stripped.split(/\r?\n/);
  let cur: Rule | null = null;
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    const idx = line.indexOf(':');
    if (idx < 0) continue;
    const key = line.substring(0, idx).trim().toLowerCase();
    const value = line.substring(idx + 1).trim();
    if (key === 'user-agent') {
      const ua = value.toLowerCase();
      const existing = rules.find((r) => r.ua.length === 1 && r.ua[0] === ua);
      if (existing) {
        cur = existing;
      } else {
        cur = { ua: [ua], allow: [], disallow: [] };
        rules.push(cur);
      }
    } else if (cur && key === 'allow') {
      cur.allow.push(value);
    } else if (cur && key === 'disallow') {
      cur.disallow.push(value);
    }
  }

  return {
    isDisallowed(path: string, ua: string): boolean {
      const candidates = rules.filter((r) => r.ua.includes(ua) || r.ua.includes('*'));
      let best: { rule: Rule; len: number; allow: boolean } | null = null;
      for (const r of candidates) {
        for (const d of r.disallow) {
          if (!d) continue;
          if (path.startsWith(d) && (!best || d.length > best.len)) {
            best = { rule: r, len: d.length, allow: false };
          }
        }
        for (const a of r.allow) {
          if (!a) continue;
          if (path.startsWith(a) && (!best || a.length > best.len)) {
            best = { rule: r, len: a.length, allow: true };
          }
        }
      }
      return best ? !best.allow : false;
    },
  };
}
