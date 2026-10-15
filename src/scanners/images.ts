import { load } from 'cheerio';
import { assertSafeUrl, UnsafeUrlError } from '../fetcher/safeUrl.js';
import { fetchPage, FetchError } from '../fetcher/httpClient.js';
import type { CrawledPage, Finding, ScanConfig } from '../types/index.js';
import type { AssetRecord, ProbeCache } from '../core/cache.js';

export async function scanImages(
  page: CrawledPage,
  config: ScanConfig,
  cache: ProbeCache,
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
    Array.from(srcs).map((src) => probeImage(src, config, cache)),
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
  try {
    const fetched = await fetchPage(src, {
      userAgent: config.userAgent,
      timeoutMs: config.timeoutMs,
      maxBytes: 256 * 1024,
      allowPrivate: config.allowPrivate,
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
  if (r.errorCode) {
    msg = `Image failed to load (${r.errorCode}): ${r.src}`;
  } else if (r.status !== null && r.status >= 400) {
    msg = `Broken image (HTTP ${r.status}): ${r.src}`;
  } else if (r.status !== null && !/^image\//i.test(r.contentType)) {
    msg = `Image URL returned non-image content-type "${r.contentType || 'unknown'}": ${r.src}`;
  } else {
    return null;
  }
  return {
    id: `img-${shortHash(r.src + r.status + (r.errorCode ?? ''))}`,
    type: 'image_broken',
    severity: 'error',
    message: msg,
    page: pageUrl,
    detail: { status: r.status, contentType: r.contentType, code: r.errorCode },
    fix: 'Verify the image exists, the URL is correct, and the server returns image/* content-type.',
  };
}

function shortHash(s: string): string {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h * 33) ^ s.charCodeAt(i)) >>> 0;
  return h.toString(36);
}