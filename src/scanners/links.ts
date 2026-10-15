import { load } from 'cheerio';
import { assertSafeUrl, UnsafeUrlError } from '../fetcher/safeUrl.js';
import { fetchPage, FetchError } from '../fetcher/httpClient.js';
import { normalizeUrl, sameOrigin } from '../utils/url.js';
import type { CrawledPage, Finding, FindingType, ScanConfig } from '../types/index.js';
import type { LinkRecord, ProbeCache } from '../core/cache.js';
import { logger } from '../utils/logger.js';

/**
 * Extract same-origin anchor hrefs from a page, deduped, and probe each one.
 * Probes go through a ProbeCache so the same URL across many pages is
 * only fetched once per scan.
 */
export async function scanLinks(
  page: CrawledPage,
  config: ScanConfig,
  cache: ProbeCache,
): Promise<{ findings: Finding[]; sameOriginLinks: string[]; records: LinkRecord[] }> {
  if (!page.isHtml) return { findings: [], sameOriginLinks: [], records: [] };
  const $ = load(page.html, { xml: { decodeEntities: false } });
  const findings: Finding[] = [];
  const seen = new Set<string>();
  const targets: string[] = [];

  $('a[href]').each((_, el) => {
    const href = $(el).attr('href');
    if (!href) return;
    if (/^(mailto:|tel:|sms:|javascript:|#)/i.test(href)) return;
    const abs = normalizeUrl(href, page.finalUrl);
    if (!abs) return;
    if (seen.has(abs)) return;
    seen.add(abs);
    targets.push(abs);
  });

  const records = await Promise.all(targets.map((href) => probe(href, page.finalUrl, config, cache)));
  const sameOriginLinks: string[] = [];
  for (const r of records) {
    if (r.sameOrigin && r.status !== null && r.status < 400) sameOriginLinks.push(r.finalUrl);
  }
  for (const r of records) {
    const f = findingFromRecord(r);
    if (f) findings.push(f);
  }
  return { findings, sameOriginLinks, records };
}

async function probe(
  href: string,
  parentUrl: string,
  config: ScanConfig,
  cache: ProbeCache,
): Promise<LinkRecord> {
  // Cache hit
  const cached = cache.getLink(href);
  if (cached) return cached;

  // Pre-validate URL. If it would resolve to a private range, treat as
  // external & flagged rather than fetching.
  try {
    await assertSafeUrl(href, { allowPrivate: config.allowPrivate });
  } catch (e) {
    if (e instanceof UnsafeUrlError) {
      const r: LinkRecord = {
        href,
        finalUrl: href,
        status: null,
        errorCode: e.code,
        sameOrigin: sameOrigin(href, parentUrl),
        probedAt: Date.now(),
      };
      cache.putLink(href, r);
      return r;
    }
    const r: LinkRecord = {
      href,
      finalUrl: href,
      status: null,
      errorCode: 'INVALID',
      sameOrigin: sameOrigin(href, parentUrl),
      probedAt: Date.now(),
    };
    cache.putLink(href, r);
    return r;
  }

  try {
    const fetched = await fetchPage(href, {
      userAgent: config.userAgent,
      timeoutMs: config.timeoutMs,
      maxBytes: config.maxBytesPerPage,
      allowPrivate: config.allowPrivate,
    });
    const r: LinkRecord = {
      href,
      finalUrl: fetched.finalUrl,
      status: fetched.status,
      errorCode: null,
      sameOrigin: sameOrigin(href, parentUrl),
      probedAt: Date.now(),
    };
    cache.putLink(href, r);
    return r;
  } catch (e) {
    if (e instanceof FetchError) {
      logger.debug({ href, code: e.code }, 'link probe failed');
      const r: LinkRecord = {
        href,
        finalUrl: href,
        status: e.status ?? null,
        errorCode: e.code,
        sameOrigin: sameOrigin(href, parentUrl),
        probedAt: Date.now(),
      };
      cache.putLink(href, r);
      return r;
    }
    const r: LinkRecord = {
      href,
      finalUrl: href,
      status: null,
      errorCode: 'UNKNOWN',
      sameOrigin: sameOrigin(href, parentUrl),
      probedAt: Date.now(),
    };
    cache.putLink(href, r);
    return r;
  }
}

function findingFromRecord(r: LinkRecord): Finding | null {
  if (r.status !== null && r.status < 400) return null;
  const type: FindingType = 'link_broken';
  let msg: string;
  if (r.errorCode === 'PRIVATE_IP' || r.errorCode === 'BLOCKED_HOSTNAME') {
    msg = `Link points to blocked host (${r.errorCode})`;
  } else if (r.errorCode === 'TIMEOUT') {
    msg = `Link timed out: ${r.href}`;
  } else if (r.errorCode === 'DNS_FAIL') {
    msg = `Link hostname did not resolve: ${r.href}`;
  } else if (r.status !== null && r.status >= 400) {
    msg = `Broken link (HTTP ${r.status}): ${r.href}`;
  } else {
    msg = `Link failed (${r.errorCode ?? 'unknown'}): ${r.href}`;
  }
  return {
    id: `link-${shortHash(r.href + r.status + (r.errorCode ?? ''))}`,
    type,
    severity: 'error',
    message: msg,
    page: r.href,
    detail: { status: r.status, code: r.errorCode, finalUrl: r.finalUrl },
    fix: r.status === 404
      ? 'Remove or replace the link. If the destination moved, update the URL or add a redirect at the source.'
      : r.status === 403
        ? 'The destination forbids crawling. This may be intentional; verify and remove if not needed.'
        : r.errorCode === 'TIMEOUT'
          ? 'Investigate why the host is slow. If intentional, exclude this URL from scans.'
          : 'Verify the destination exists and is reachable from the public internet.',
  };
}

function shortHash(s: string): string {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h * 33) ^ s.charCodeAt(i)) >>> 0;
  return h.toString(36);
}