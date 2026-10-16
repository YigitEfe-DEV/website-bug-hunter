import { load, type CheerioAPI } from 'cheerio';
import pLimit from 'p-limit';
import { fetchPage, FetchError } from '../fetcher/httpClient.js';
import { RobotsCache } from '../fetcher/robots.js';
import { scanLinks } from '../scanners/links.js';
import { scanImages } from '../scanners/images.js';
import { scanMeta } from '../scanners/meta.js';
import { scanRedirects } from '../scanners/redirects.js';
import { scanAccessibility } from '../scanners/accessibility.js';
import { extractMeta, detectDuplicates } from '../scanners/duplicates.js';
import { scanJsErrors, scanMobile } from '../scanners/browser.js';
import { normalizeUrl, sameOrigin } from '../utils/url.js';
import { logger } from '../utils/logger.js';
import type { CrawledPage, Finding, ScanConfig, ScanResult } from '../types/index.js';
import { DEFAULT_SCAN_CONFIG } from '../types/index.js';
import { ProbeCache } from './cache.js';
import type { ProgressReporter } from './progress.js';
import { validateAndSanitize } from './report.js';

export interface ScanInput {
  target: string;
  overrides?: Partial<ScanConfig>;
}

export interface RunScanOptions {
  progress?: ProgressReporter;
  cache?: ProbeCache;
}

/**
 * Main scan orchestrator. BFS over same-origin links up to maxDepth,
 * dispatching static + dynamic scanners concurrently.
 *
 * Security:
 *   - Every URL passes through httpClient (which calls assertSafeUrl
 *     on each redirect hop, AND pins the IP for the connection).
 *   - Cross-origin links are NOT enqueued for full page scanning.
 *   - The same-origin target is locked at scan start from input.target,
 *     not from the page URL — so a redirect-in-page cannot widen scope.
 *   - A global request counter caps the total outbound HTTP calls
 *     regardless of how many fragments the site expands into.
 */
export async function runScan(
  input: ScanInput,
  signal?: AbortSignal,
  options: RunScanOptions = {},
): Promise<ScanResult> {
  const startedAt = Date.now();
  const config: ScanConfig = { ...DEFAULT_SCAN_CONFIG, ...input.overrides, target: input.target };
  const findings: Finding[] = [];
  const errors: string[] = [];
  const visited = new Set<string>();
  const frontier: { url: string; depth: number }[] = [];
  const limit = pLimit(config.concurrency);
  // Internal abort signal so we can cancel half-finished work when a
  // budget is reached. Sourced from the caller's signal when present.
  // The listener is detached in `cleanup` so a normal completion does
  // not leak an EventTarget reference to the caller's signal.
  const internalSignal = new AbortController();
  const cleanup = () => {
    if (signal) signal.removeEventListener('abort', abortForwarder);
  };
  const abortForwarder = () => internalSignal.abort();
  if (signal) {
    if (signal.aborted) internalSignal.abort();
    else signal.addEventListener('abort', abortForwarder, { once: true });
  }
  const robots = new RobotsCache(config.userAgent, {
    allowPrivate: config.allowPrivate,
    signal: internalSignal.signal,
  });
  const cache = options.cache ?? new ProbeCache();
  const progress = options.progress;
  const crawledPages: CrawledPage[] = [];
  let pagesScanned = 0;
  let pagesFailed = 0;
  let pagesSkipped = 0;
  let requestsMade = 0;
  let budgetExhausted = false;
  const MAX_ERRORS = 200;

  const originTarget = input.target;

  const initial = normalizeUrl(input.target, input.target);
  if (!initial) {
    const result = {
      target: input.target,
      startedAt,
      finishedAt: Date.now(),
      durationMs: 0,
      pagesScanned: 0,
      pagesFailed: 0,
      pagesSkipped: 0,
      findings: [] as Finding[],
      errors: ['target is not a valid http(s) URL'],
      budgetExhausted: false,
    };
    cleanup();
    return validateAndSanitize(result);
  }
  progress?.emit({ kind: 'started', target: input.target, maxPages: config.maxPages, maxDepth: config.maxDepth });
  frontier.push({ url: initial, depth: 0 });

  while (frontier.length > 0) {
    if (internalSignal.signal.aborted) {
      budgetExhausted = true;
      break;
    }
    if (pagesScanned >= config.maxPages) {
      budgetExhausted = true;
      break;
    }
    if (requestsMade >= config.maxRequests) {
      budgetExhausted = true;
      break;
    }
    if (Date.now() - startedAt > config.maxTimeMs) {
      budgetExhausted = true;
      break;
    }

    const batch: { url: string; depth: number }[] = [];
    while (frontier.length > 0 && batch.length < config.concurrency) {
      const next = frontier.shift();
      if (!next) break;
      if (visited.has(next.url)) continue;
      visited.add(next.url);
      batch.push(next);
    }
    if (batch.length === 0) continue;

    const results = await Promise.all(
      batch.map((item) =>
        limit(async () => {
          if (internalSignal.signal.aborted) {
            return { skipped: true, item } as const;
          }
          // Account for the robots fetch — it happens even when we end up
          // skipping the page itself.
          requestsMade++;
          if (requestsMade >= config.maxRequests) {
            internalSignal.abort();
            return { skipped: true, item } as const;
          }
          if (!(await robots.isAllowed(item.url))) {
            pagesSkipped++;
            return { skipped: true, item } as const;
          }
          // Charge 1 budget unit for the main page fetch (the initial
          // `requestsMade++` above covers the robots attempt). The page
          // fetch itself may include redirects; account for those below.
          requestsMade++;
          if (requestsMade >= config.maxRequests) {
            internalSignal.abort();
            return { skipped: true, item } as const;
          }
          progress?.emit({ kind: 'page-fetching', url: item.url });
          try {
            const page = await fetchPage(item.url, {
              userAgent: config.userAgent,
              timeoutMs: config.timeoutMs,
              maxBytes: config.maxBytesPerPage,
              allowPrivate: config.allowPrivate,
              signal: internalSignal.signal,
            });
            // fetchPage cost 1 request + N redirect hops; the main
            // request was charged above, just add the rest.
            requestsMade += page.locationChain.length;
            if (page.locationChain.length > 0) {
              progress?.emit({ kind: 'redirect-chain', url: item.url, hops: page.locationChain.length });
            }
            return { page, item } as const;
          } catch (e) {
            const code = e instanceof FetchError ? e.code : 'UNKNOWN';
            return {
              error: code,
              item,
              msg: redactErrorMessage((e as Error).message),
            } as const;
          }
        }),
      ),
    );

    for (const r of results) {
      if ('skipped' in r) {
        progress?.emit({ kind: 'page-skipped-robots', url: r.item.url });
        continue;
      }
      if ('error' in r) {
        pagesFailed++;
        const errMsg = `${truncate(r.item.url, 2048)}: ${r.msg}`;
        if (errors.length < MAX_ERRORS) errors.push(errMsg);
        const requestFailure: Finding = {
          id: `reqfail-${shortHash(r.item.url + r.error)}`,
          type: 'request_failed',
          severity: 'error',
          confidence: r.error === 'TIMEOUT' || r.error === 'UNKNOWN' ? 'inconclusive' : 'confirmed',
          message: `Request failed (${r.error}): ${truncate(r.item.url, 2048)}`,
          page: r.item.url,
          detail: { code: r.error },
          explanation:
            r.error === 'TIMEOUT'
              ? 'The host did not respond within the scan timeout. May be transient.'
              : r.error === 'REDIRECT_LOOP'
                ? 'A redirect chain loops. Inspect Location headers along the chain.'
                : r.error === 'PRIVATE_IP' || r.error === 'BLOCKED_HOSTNAME'
                  ? 'The scanner refused to fetch this URL — it resolves to a private/loopback/blocked range (SSRF guard).'
                  : 'The scanner could not complete this request.',
          fix: r.error === 'TIMEOUT'
            ? 'The host is slow or unreachable. Investigate or exclude this URL from scans.'
            : r.error === 'REDIRECT_LOOP'
              ? 'A redirect chain loops. Inspect Location headers along the chain.'
              : r.error === 'PRIVATE_IP' || r.error === 'BLOCKED_HOSTNAME'
                ? 'If the target is intentional, re-run with --allow-private and accept the risk.'
                : 'Check that the host is reachable from the public internet.',
        };
        findings.push(requestFailure);
        progress?.emit({
          kind: 'page-failed',
          url: r.item.url,
          code: r.error,
          pagesScanned,
          pagesFailed,
          queueSize: frontier.length,
        });
        continue;
      }
      pagesScanned++;
      const page: CrawledPage = r.page;
      crawledPages.push(page);
      // Parse the page HTML once per crawl. Every static scanner that
      // needs cheerio (link extraction, image probing rules, meta check,
      // accessibility) reuses this same parsed tree instead of re-parsing
      // the same HTML N times. ~5x reduction in cheerio work per page.
      const $: CheerioAPI | null = page.isHtml
        ? load(page.html, { xml: { decodeEntities: false } })
        : null;
      const staticFindings = await scanOne(page, config, cache, internalSignal.signal, $);
      for (const f of staticFindings) {
        findings.push(f);
        progress?.emit({ kind: 'finding', type: f.type, severity: f.severity, message: f.message });
      }

      progress?.emit({
        kind: 'page-scanned',
        url: r.item.url,
        status: page.status,
        pagesScanned,
        pagesFailed,
        queueSize: frontier.length,
      });

      if ($ && r.item.depth < config.maxDepth) {
        $('a[href]').each((_, el) => {
          const href = $(el).attr('href');
          if (!href) return;
          if (/^(mailto:|tel:|sms:|javascript:|#)/i.test(href)) return;
          const abs = normalizeUrl(href, page.finalUrl);
          if (!abs) return;
          if (visited.has(abs)) return;
          if (!sameOrigin(abs, originTarget)) return;
          frontier.push({ url: abs, depth: r.item.depth + 1 });
        });
      }

      if (config.rateMs > 0) {
        await new Promise((r) => setTimeout(r, config.rateMs));
      }
    }
  }

  const pageMetas = crawledPages
    .map(extractMeta)
    .filter((m): m is NonNullable<typeof m> => m !== null);
  const dupFindings = detectDuplicates(pageMetas);
  for (const f of dupFindings) {
    findings.push(f);
    progress?.emit({ kind: 'finding', type: f.type, severity: f.severity, message: f.message });
  }

  const [jsErrors, mobile] = await Promise.all([
    scanJsErrors(initial, config.userAgent).catch((e) => {
      logger.error({ err: redactErrorMessage((e as Error).message) }, 'js error scanner crashed');
      return [];
    }),
    scanMobile(initial, config.userAgent).catch((e) => {
      logger.error({ err: redactErrorMessage((e as Error).message) }, 'mobile scanner crashed');
      return [];
    }),
  ]);
  for (const f of [...jsErrors, ...mobile]) {
    findings.push(f);
    progress?.emit({ kind: 'finding', type: f.type, severity: f.severity, message: f.message });
  }

  const finishedAt = Date.now();
  const result: ScanResult = {
    target: input.target,
    startedAt,
    finishedAt,
    durationMs: finishedAt - startedAt,
    pagesScanned,
    pagesFailed,
    pagesSkipped,
    findings: dedupeFindings(findings),
    errors,
    budgetExhausted,
    cache: { linkProbes: cache.size().links, assetProbes: cache.size().assets },
    config,
    pages: crawledPages.map((p) => ({
      url: p.requestUrl,
      finalUrl: p.finalUrl,
      status: p.status,
      fetchedAt: p.fetchedAt,
      bytes: p.bytes,
    })),
  };

  progress?.emit({
    kind: 'finished',
    pagesScanned,
    pagesFailed,
    findings: result.findings.length,
    budgetExhausted,
    durationMs: finishedAt - startedAt,
  });

  // Always detach our listener from the caller's signal so we don't
  // hold a long-lived reference into the user's AbortSignal.
  cleanup();

  return validateAndSanitize(result);
}

async function scanOne(
  page: CrawledPage,
  config: ScanConfig,
  cache: ProbeCache,
  signal?: AbortSignal,
  preloadedCheerio?: CheerioAPI | null,
): Promise<Finding[]> {
  const [linkRes, imageRes, metaRes, redirectRes, a11yRes] = await Promise.all([
    scanLinks(page, config, cache, signal, preloadedCheerio).catch((e) => {
      logger.error({ err: redactErrorMessage((e as Error).message), page: page.finalUrl }, 'link scanner crashed');
      return { findings: [], sameOriginLinks: [], records: [] };
    }),
    scanImages(page, config, cache, signal, preloadedCheerio).catch((e) => {
      logger.error({ err: redactErrorMessage((e as Error).message), page: page.finalUrl }, 'image scanner crashed');
      return { findings: [] };
    }),
    Promise.resolve(scanMeta(page, preloadedCheerio)),
    Promise.resolve(scanRedirects(page)),
    Promise.resolve(scanAccessibility(page, preloadedCheerio)),
  ]);
  return [
    ...linkRes.findings,
    ...imageRes.findings,
    ...metaRes,
    ...redirectRes,
    ...a11yRes,
  ];
}

/**
 * Dedupe findings by id. When the same id fires multiple times (e.g. a
 * broken image referenced from N pages, a duplicate-title finding whose
 * id is per-title-value), accumulate the originating pages into
 * `affectedPages` so the operator can see the full impact set in one
 * finding instead of N duplicates.
 */
function dedupeFindings(findings: Finding[]): Finding[] {
  const grouped = new Map<string, Finding[]>();
  for (const f of findings) {
    const list = grouped.get(f.id);
    if (list) list.push(f);
    else grouped.set(f.id, [f]);
  }
  const out: Finding[] = [];
  for (const [, list] of grouped) {
    const first = list[0];
    if (!first) continue;
    if (list.length === 1) {
      out.push(first);
      continue;
    }
    const pageSet = new Set<string>();
    const pages: string[] = [];
    for (const f of list) {
      if (!pageSet.has(f.page)) {
        pageSet.add(f.page);
        pages.push(f.page);
      }
    }
    out.push({
      ...first,
      affectedPages: first.affectedPages && first.affectedPages.length >= pages.length
        ? first.affectedPages
        : pages,
    });
  }
  return out;
}

function shortHash(s: string): string {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h * 33) ^ s.charCodeAt(i)) >>> 0;
  return h.toString(36);
}

/** Cap arbitrary strings (URLs, error messages) before they enter a report. */
function truncate(s: string, max: number): string {
  if (typeof s !== 'string') return '';
  return s.length > max ? s.substring(0, max) + '…' : s;
}

/**
 * Reduce an error message to its safe prefix. Real error strings can
 * include DNS detail that names internal resolvers, server paths, or
 * stack-trace fragments. We strip control characters, drop anything
 * that looks like a file path with line/column numbers, and cap the
 * length. The `code` field is the operator-facing classification; this
 * keeps `message` short and honest.
 */
function redactErrorMessage(msg: string): string {
  if (typeof msg !== 'string') return '';
  let s = msg
    // eslint-disable-next-line no-control-regex
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '')
    .replace(/[  ]/g, '');
  // Strip "    at func (file.js:123:45)" stack frames.
  s = s.replace(/\s+at\s+.+?\(.*?:\d+:\d+\)/g, '');
  if (s.length > 240) s = s.substring(0, 240) + '…';
  return s;
}
