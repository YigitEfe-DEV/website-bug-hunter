import { load } from 'cheerio';
import type { CrawledPage, Finding } from '../types/index.js';

/**
 * Cross-page duplicate detector. Operates on the full set of crawled
 * pages and emits findings for:
 *   - duplicate <title> across multiple pages
 *   - duplicate meta description
 *   - duplicate canonical URL across distinct page URLs
 *
 * Run AFTER the main scan completes; pass the page array.
 */

export interface PageMeta {
  url: string;
  title: string;
  description: string;
  canonical: string | null;
}

export function extractMeta(page: CrawledPage): PageMeta | null {
  if (!page.isHtml) return null;
  const $ = load(page.html, { xml: { decodeEntities: false } });
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
    // Only flag if the URLs are distinct (same title on different pages).
    const urls = new Set(group.map((p) => p.url));
    if (urls.size < 2) continue;
    out.push({
      id: `dup-title-${shortHash(title)}`,
      type: 'duplicate',
      severity: 'warning',
      message: `Duplicate <title> across ${urls.size} pages: "${trunc(title)}"`,
      page: [...urls].slice(0, 5).join(', ') + (urls.size > 5 ? ` …+${urls.size - 5}` : ''),
      detail: { title, urls: [...urls] },
      fix: 'Give each page a distinct <title>. Titles are a strong SEO and accessibility signal.',
    });
  }

  // Duplicate descriptions
  const byDesc = groupBy(pages.filter((p) => p.description), (p) => p.description);
  for (const [desc, group] of byDesc) {
    if (group.length < 2) continue;
    const urls = new Set(group.map((p) => p.url));
    if (urls.size < 2) continue;
    out.push({
      id: `dup-desc-${shortHash(desc)}`,
      type: 'duplicate',
      severity: 'warning',
      message: `Duplicate meta description across ${urls.size} pages`,
      page: [...urls].slice(0, 5).join(', ') + (urls.size > 5 ? ` …+${urls.size - 5}` : ''),
      detail: { urls: [...urls] },
      fix: 'Each page should have a unique meta description.',
    });
  }

  // Multiple distinct pages pointing to the same canonical
  const byCanonical = groupBy(pages.filter((p) => p.canonical), (p) => p.canonical!);
  for (const [canonical, group] of byCanonical) {
    const urls = new Set(group.map((p) => p.url));
    if (urls.size < 2) continue;
    out.push({
      id: `dup-canonical-${shortHash(canonical)}`,
      type: 'duplicate',
      severity: 'info',
      message: `${urls.size} distinct pages share canonical="${canonical}"`,
      page: [...urls].slice(0, 5).join(', ') + (urls.size > 5 ? ` …+${urls.size - 5}` : ''),
      detail: { canonical, urls: [...urls] },
      fix: 'Multiple pages with the same canonical tells search engines they are duplicates; pick one.',
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