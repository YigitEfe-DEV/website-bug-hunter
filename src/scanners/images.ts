import { load } from 'cheerio';
import { assertSafeUrl, UnsafeUrlError } from '../fetcher/safeUrl.js';
import { fetchPage, FetchError } from '../fetcher/httpClient.js';
import type { Confidence, CrawledPage, Finding, ScanConfig } from '../types/index.js';
import type { AssetRecord, ProbeCache } from '../core/cache.js';

/**
 * Confidence semantics:
 *   - HTTP >=400                       confirmed
 *   - DNS_FAIL / INVALID / PRIVATE_IP  confirmed
 *   - wrong MIME                       probable (could be intentional or a CDN bug)
 *   - TIMEOUT                          inconclusive
 *   - UNKNOWN                          inconclusive
 */
export async function scanImages(
  page: CrawledPage,
  config: ScanConfig,
  cache: ProbeCache,
  signal?: AbortSignal,
): Promise<{ findings: Finding[] }> {
  if (!page.isHtml) return { findings: [] };
  const $ = load(page.html, { xml: { decodeEntities: false } });
  const srcs = new Set<string>();
  $('img[src]').each((_, el) => {
    const s = $(el).attr('src');
    if (s && !/^data:/i.test(s)) srcs.add(new URL(s, page.finalUrl).toString());
  });
  $('img[srcset]').each((_, el) => {
    const srcset = $(el).attr('srcset') ?? '';
    for (const piece of srcset.split(',')) {
      const url = piece.trim().split(/\s+/)[0];
      if (url && !/^data:/i.test(url)) srcs.add(new URL(url, page.finalUrl).toString());
    }
  });
  $('link[rel~="icon"]').each((_, el) => {
    const s = $(el).attr('href');
    if (s) srcs.add(new URL(s, page.finalUrl).toString());
  });
  $('source[srcset],source[src]').each((_, el) => {
    const s = $(el).attr('src') ?? $(el).attr('srcset') ?? '';
    for (const piece of s.split(',')) {
      const url = piece.trim().split(/\s+/)[0];
      if (url && !/^data:/i.test(url)) srcs.add(new URL(url, page.finalUrl).toString());
    }
  });

  const findings: Finding[] = [];
  const records = await Promise.all(
    Array.from(srcs).map((src) => probeImage(src, config, cache, signal)),
  );
  for (const r of records) {
    const f = findingFromRecord(r, page.finalUrl);
    if (f) findings.push(f);
  }
  return { findings };
}

async function probeImage(
  src: string,
  config: ScanConfig,
  cache: ProbeCache,
  signal?: AbortSignal,
): Promise<AssetRecord> {
  const cached = cache.getAsset(src);
  if (cached) return cached;

  try {
    await assertSafeUrl(src, { allowPrivate: config.allowPrivate });
  } catch (e) {
    if (e instanceof UnsafeUrlError) {
      const r: AssetRecord = {
        src, status: null, errorCode: e.code, contentType: '', bytes: null,
        probedAt: Date.now(),
      };
      cache.putAsset(src, r);
      return r;
    }
    const r: AssetRecord = {
      src, status: null, errorCode: 'INVALID', contentType: '', bytes: null,
      probedAt: Date.now(),
    };
    cache.putAsset(src, r);
    return r;
  }
  if (signal?.aborted) {
    const r: AssetRecord = {
      src, status: null, errorCode: 'CANCELLED', contentType: '', bytes: null,
      probedAt: Date.now(),
    };
    cache.putAsset(src, r);
    return r;
  }
  try {
    const fetched = await fetchPage(src, {
      userAgent: config.userAgent,
      timeoutMs: config.timeoutMs,
      maxBytes: 256 * 1024,
      allowPrivate: config.allowPrivate,
      signal,
    });
    const r: AssetRecord = {
      src,
      status: fetched.status,
      errorCode: null,
      contentType: fetched.contentType,
      bytes: fetched.bytes,
      probedAt: Date.now(),
    };
    cache.putAsset(src, r);
    return r;
  } catch (e) {
    if (e instanceof FetchError) {
      const r: AssetRecord = {
        src,
        status: e.status ?? null,
        errorCode: e.code,
        contentType: '',
        bytes: null,
        probedAt: Date.now(),
      };
      cache.putAsset(src, r);
      return r;
    }
    const r: AssetRecord = {
      src, status: null, errorCode: 'UNKNOWN', contentType: '', bytes: null,
      probedAt: Date.now(),
    };
    cache.putAsset(src, r);
    return r;
  }
}

function findingFromRecord(r: AssetRecord, pageUrl: string): Finding | null {
  if (r.status !== null && r.status < 400 && /^image\//i.test(r.contentType)) return null;
  let msg: string;
  let confidence: Confidence = 'inconclusive';
  let explanation: string;
  let fix: string;

  if (r.errorCode === 'TIMEOUT') {
    msg = `Image failed to load (TIMEOUT): ${r.src}`;
    confidence = 'inconclusive';
    explanation = `The image host did not respond within the scan timeout. May be transient.`;
    fix = 'Retry the scan; if it still times out, investigate the host.';
  } else if (r.errorCode === 'DNS_FAIL') {
    msg = `Image hostname did not resolve: ${r.src}`;
    confidence = 'confirmed';
    explanation = `The hostname for this image has no DNS record. Visitors will see a broken-image icon.`;
    fix = 'Fix the URL or remove the image reference.';
  } else if (
    r.errorCode === 'PRIVATE_IP' ||
    r.errorCode === 'BLOCKED_HOSTNAME' ||
    r.errorCode === 'INVALID' ||
    r.errorCode === 'BAD_SCHEME'
  ) {
    msg = `Image URL was blocked (${r.errorCode}): ${r.src}`;
    confidence = 'confirmed';
    explanation = `The scanner refused to fetch this URL — it resolves to a private range, is malformed, or uses a non-http(s) scheme.`;
    fix = 'Use a public, well-formed http(s) URL.';
  } else if (r.status !== null && r.status >= 400 && r.status < 500) {
    msg = `Broken image (HTTP ${r.status}): ${r.src}`;
    confidence = 'confirmed';
    explanation = `The image server returned a 4xx status; the image is not retrievable by users.`;
    fix = 'Verify the image exists at this URL, or replace the <img> src.';
  } else if (r.status !== null && r.status >= 500) {
    msg = `Broken image (HTTP ${r.status}): ${r.src}`;
    confidence = 'inconclusive';
    explanation = `The image host returned a 5xx error. May be transient.`;
    fix = 'Retry the scan; if it persists, contact the operator.';
  } else if (r.status !== null && !/^image\//i.test(r.contentType)) {
    msg = `Image URL returned non-image content-type "${r.contentType || 'unknown'}": ${r.src}`;
    confidence = 'probable';
    explanation = `The URL resolved but the Content-Type is not image/*. The browser will refuse to render it as an image. (Some CDN misconfigurations cause this; can also be intentional placeholders.)`;
    fix = 'Verify the server is configured to serve image/* for this URL.';
  } else {
    msg = `Image failed (${r.errorCode ?? 'unknown'}): ${r.src}`;
    confidence = 'inconclusive';
    explanation = `The image could not be retrieved.`;
    fix = 'Investigate the URL manually.';
  }
  return {
    id: `img-${shortHash(r.src + r.status + (r.errorCode ?? ''))}`,
    type: 'image_broken',
    severity: 'error',
    confidence,
    message: msg,
    page: pageUrl,
    detail: { status: r.status, contentType: r.contentType, code: r.errorCode, src: r.src },
    explanation,
    fix,
  };
}

function shortHash(s: string): string {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h * 33) ^ s.charCodeAt(i)) >>> 0;
  return h.toString(36);
}