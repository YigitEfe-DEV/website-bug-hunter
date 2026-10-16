import { load } from 'cheerio';
import { assertSafeUrl, UnsafeUrlError } from '../fetcher/safeUrl.js';
import { fetchPage, FetchError } from '../fetcher/httpClient.js';
import { normalizeUrl, sameOrigin } from '../utils/url.js';
import type { Confidence, CrawledPage, Finding, FindingType, ScanConfig } from '../types/index.js';
import type { LinkRecord, ProbeCache } from '../core/cache.js';
import { logger } from '../utils/logger.js';

/**
 * Extract same-origin anchor hrefs from a page, deduped, and probe each one.
 * Probes go through a ProbeCache so the same URL across many pages is
 * only fetched once per scan.
 *
 * Confidence semantics:
 *   - HTTP >=400                       confirmed
 *   - DNS_FAIL (NXDOMAIN)              confirmed
 *   - INVALID_URL                      confirmed (URL didn't parse)
 *   - PRIVATE_IP / BLOCKED_HOSTNAME    confirmed (we observed & refused)
 *   - TIMEOUT                          inconclusive (transient)
 *   - UNKNOWN                          inconclusive
 *   - 2xx/3xx                          not emitted
 */
export async function scanLinks(
  page: CrawledPage,
  config: ScanConfig,
  cache: ProbeCache,
  signal?: AbortSignal,
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

  const records = await Promise.all(
    targets.map((href) => probe(href, page.finalUrl, config, cache, signal)),
  );
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
  signal?: AbortSignal,
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

  if (signal?.aborted) {
    const r: LinkRecord = {
      href,
      finalUrl: href,
      status: null,
      errorCode: 'CANCELLED',
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
      signal,
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
  let confidence: Confidence = 'inconclusive';
  let explanation: string;
  let fix: string;

  if (r.errorCode === 'PRIVATE_IP' || r.errorCode === 'BLOCKED_HOSTNAME') {
    msg = `Link points to blocked host (${r.errorCode}): ${r.href}`;
    confidence = 'confirmed';
    explanation = `The scanner refused to fetch this URL because it resolves to a private/loopback/blocked range (SSRF guard). If the target is intentional, the operator must re-run with --allow-private and accept the risk.`;
    fix = 'Verify the destination exists and is reachable from the public internet. If intentional (e.g., intranet link), document or remove it from public pages.';
  } else if (r.errorCode === 'INVALID' || r.errorCode === 'BAD_SCHEME' || r.errorCode === 'URL_TOO_LONG' || r.errorCode === 'NO_HOST') {
    msg = `Link is malformed (${r.errorCode}): ${r.href}`;
    confidence = 'confirmed';
    explanation = `The URL did not parse or uses a non-http(s) scheme. Browsers cannot resolve this and search engines will ignore it.`;
    fix = 'Replace with a valid http(s) URL that points to the intended destination.';
  } else if (r.errorCode === 'TIMEOUT') {
    msg = `Link timed out: ${r.href}`;
    confidence = 'inconclusive';
    explanation = `The destination did not respond within the scan timeout. The link may be temporarily unreachable, the host may be rate-limiting the scanner, or the host may be permanently down — we cannot distinguish from a single probe.`;
    fix = 'Retry the scan; if the link still times out, investigate the host or remove the link.';
  } else if (r.errorCode === 'DNS_FAIL') {
    msg = `Link hostname did not resolve: ${r.href}`;
    confidence = 'confirmed';
    explanation = `The hostname has no DNS A/AAAA record, or the resolver returned an error. The link is broken as far as end users are concerned.`;
    fix = 'Remove the link or fix the hostname. If the destination moved, update the URL or set up a redirect.';
  } else if (r.errorCode === 'REDIRECT_LOOP') {
    msg = `Link redirected in a loop: ${r.href}`;
    confidence = 'confirmed';
    explanation = `Following the redirect chain reached the 10-hop cap without resolving. Users will see a "redirected too many times" error.`;
    fix = 'Inspect the Location headers along the chain and break the loop.';
  } else if (r.status !== null && r.status >= 400) {
    msg = `Broken link (HTTP ${r.status}): ${r.href}`;
    confidence = 'confirmed';
    if (r.status === 404) {
      explanation = `The server reports the page does not exist. Visitors clicking this link see an error page.`;
      fix = 'Remove the link or replace it with the correct URL. If the destination moved, add a redirect at the source or update the URL.';
    } else if (r.status === 403) {
      explanation = `The server explicitly forbids access. The destination exists but is not publicly reachable.`;
      fix = 'Verify the URL is intended to be public. If not, remove it. If yes, investigate why access is forbidden.`;
    } else if (r.status === 410) {
      explanation = `The server reports the resource is permanently gone.`;
      fix = 'Remove the link; do not redirect to a 410 target.';
    } else if (r.status >= 500) {
      confidence = 'inconclusive'; // 5xx is often transient
      explanation = `The server reports an internal error. The destination may be temporarily unavailable.`;
      fix = 'Retry the scan; if the link still returns 5xx, contact the destination operator or remove the link.';
    } else {
      explanation = `The server returned an error status for this URL.`;
      fix = 'Verify the destination exists and is reachable from the public internet.';
    }
    if (!fix) fix = 'Verify the destination exists and is reachable from the public internet.';
  } else {
    msg = `Link failed (${r.errorCode ?? 'unknown'}): ${r.href}`;
    confidence = 'inconclusive';
    explanation = `The scanner could not determine the link's status.`;
    fix = 'Investigate the link manually.';
  }
  return {
    id: `link-${shortHash(r.href + r.status + (r.errorCode ?? ''))}`,
    type,
    severity: 'error',
    confidence,
    message: msg,
    page: r.href,
    detail: { status: r.status, code: r.errorCode, finalUrl: r.finalUrl, sameOrigin: r.sameOrigin },
    explanation,
    fix,
  };
}

// Re-exported via the cli/index and orchestrator via constants.

function shortHash(s: string): string {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h * 33) ^ s.charCodeAt(i)) >>> 0;
  return h.toString(36);
}