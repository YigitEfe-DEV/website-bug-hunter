import { load, type CheerioAPI } from 'cheerio';
import type { CrawledPage, Finding } from '../types/index.js';

/**
 * Cross-page duplicate detector. Operates on the full set of crawled
 * pages and emits findings for:
 *   - duplicate <title> across multiple pages
 *   - duplicate meta description
 *   - shared canonical URL across distinct page URLs
 *
 * Confidence: all findings here are PROBABLE. Duplicate titles and
 * descriptions are a strong SEO signal of poor quality, but
 * intentionally duplicated content (print views, tag pages) is valid.
 * Treat the report as a starting point for editorial review, not a
 * defect declaration.
 *
 * Note: SEO/accessibility findings here are scoped heuristics. We do NOT
 * claim a full SEO audit.
 */

export interface PageMeta {
  url: string;
  title: string;
  description: string;
  canonical: string | null;
}

export function extractMeta(page: CrawledPage, preloadedCheerio?: CheerioAPI | null): PageMeta | null {
  if (!page.isHtml) return null;
  const $ = preloadedCheerio ?? load(page.html, { xml: { decodeEntities: false } });
  const title = $('head > title').first().text().trim();
  const description = $('meta[name="description"]').attr('content')?.trim() ?? '';
  const canonical = $('link[rel="canonical"]').attr('href')?.trim() ?? null;
  return { url: page.finalUrl, title, description, canonical };
}

export function detectDuplicates(pages: PageMeta[]): Finding[] {
  const out: Finding[] = [];

  // Duplicate titles
  const byTitle = groupBy(pages.filter((p) => p.title), (p) => p.title);
  for (const [title, group] of byTitle) {
    if (group.length < 2) continue;
    const urls = [...new Set(group.map((p) => p.url))];
    if (urls.length < 2) continue;
    out.push({
      id: `dup-title-${shortHash(title)}`,
      type: 'duplicate',
      severity: 'warning',
      confidence: 'probable',
      message: `Duplicate <title> across ${urls.length} pages: "${trunc(title)}"`,
      page: urls[0] ?? '',
      affectedPages: urls,
      detail: { title, urls, count: urls.length },
      explanation:
        'Search engines use titles to differentiate pages. Identical titles on distinct pages usually means low editorial quality or templating leakage.',
      fix: 'Give each page a distinct <title>. Templates that emit static titles are often the root cause.',
    });
  }

  // Duplicate descriptions
  const byDesc = groupBy(pages.filter((p) => p.description), (p) => p.description);
  for (const [desc, group] of byDesc) {
    if (group.length < 2) continue;
    const urls = [...new Set(group.map((p) => p.url))];
    if (urls.length < 2) continue;
    out.push({
      id: `dup-desc-${shortHash(desc)}`,
      type: 'duplicate',
      severity: 'warning',
      confidence: 'probable',
      message: `Duplicate meta description across ${urls.length} pages`,
      page: urls[0] ?? '',
      affectedPages: urls,
      detail: { urls, count: urls.length },
      explanation:
        'Distinct pages sharing one description undermines snippet quality and signals templating leakage.',
      fix: 'Each page should have a unique meta description, ideally with the page-specific subject.',
    });
  }

  // Shared canonical across distinct pages
  const byCanonical = groupBy(pages.filter((p) => p.canonical), (p) => p.canonical!);
  for (const [canonical, group] of byCanonical) {
    const urls = [...new Set(group.map((p) => p.url))];
    if (urls.length < 2) continue;
    out.push({
      id: `dup-canonical-${shortHash(canonical)}`,
      type: 'duplicate',
      severity: 'info',
      confidence: 'probable',
      message: `${urls.length} distinct pages share canonical="${canonical}"`,
      page: urls[0] ?? '',
      affectedPages: urls,
      detail: { canonical, urls, count: urls.length },
      explanation:
        'When multiple distinct URLs declare the same canonical, search engines treat them as duplicates and pick one. This may be intentional (e.g. tag pages) but is often a templating bug.',
      fix: 'Verify the duplicates are intentional. If not, give each page its own canonical (or set a 301 redirect to consolidate).',
    });
  }

  return out;
}

function groupBy<T>(arr: T[], key: (t: T) => string): Map<string, T[]> {
  const m = new Map<string, T[]>();
  for (const x of arr) {
    const k = key(x);
    const list = m.get(k) ?? [];
    list.push(x);
    m.set(k, list);
  }
  return m;
}

function shortHash(s: string): string {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h * 33) ^ s.charCodeAt(i)) >>> 0;
  return h.toString(36);
}

function trunc(s: string, n = 60): string {
  return s.length > n ? s.substring(0, n - 1) + '…' : s;
}