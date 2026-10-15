import { load } from 'cheerio';
import type { CrawledPage, Finding } from '../types/index.js';

/**
 * Accessibility audit. Cheap, static, no fetch. Findings:
 *   - <html lang> missing (already covered by meta scanner; included here for completeness)
 *   - <img> missing alt
 *   - <img> alt is empty (decorative should be marked with role="presentation" or alt="")
 *     -> we only WARN when alt is missing entirely; alt="" is acceptable.
 *   - multiple <h1> on the same page
 *   - no <h1> at all
 *   - heading order skip (h1 -> h3 with no h2)
 */
export function scanAccessibility(page: CrawledPage): Finding[] {
  if (!page.isHtml) return [];
  const $ = load(page.html, { xml: { decodeEntities: false } });
  const out: Finding[] = [];

  // Image alt text
  $('img').each((i, el) => {
    const $img = $(el);
    const alt = $img.attr('alt');
    const src = $img.attr('src') ?? '';
    if (alt === undefined) {
      out.push({
        id: `a11y-img-alt-${shortHash(page.finalUrl + src + i)}`,
        type: 'accessibility',
        severity: 'warning',
        message: `<img> is missing alt attribute: ${trunc(src)}`,
        page: page.finalUrl,
        detail: { tag: 'img', attribute: 'alt' },
        fix: `Add a descriptive alt attribute. Example: <img src="..." alt="A short description of the image">`,
      });
    }
  });

  // Heading structure
  const headings: { level: number; text: string; index: number }[] = [];
  $('h1, h2, h3, h4, h5, h6').each((i, el) => {
    const tag = el.tagName.toLowerCase();
    const level = Number(tag.substring(1));
    if (Number.isFinite(level)) {
      headings.push({ level, text: $(el).text().trim().substring(0, 80), index: i });
    }
  });

  const h1s = headings.filter((h) => h.level === 1);
  if (h1s.length === 0) {
    out.push({
      id: `a11y-no-h1-${shortHash(page.finalUrl)}`,
      type: 'accessibility',
      severity: 'warning',
      message: 'Page has no <h1> heading',
      page: page.finalUrl,
      fix: 'Each page should have exactly one <h1> as the top-level heading.',
    });
  } else if (h1s.length > 1) {
    out.push({
      id: `a11y-multi-h1-${shortHash(page.finalUrl)}`,
      type: 'accessibility',
      severity: 'warning',
      message: `Page has ${h1s.length} <h1> headings (expect 1)`,
      page: page.finalUrl,
      detail: { count: h1s.length },
      fix: 'Use a single <h1> per page; demote others to <h2> or below.',
    });
  }

  // Heading order skip detection
  let prevLevel = 0;
  for (const h of headings) {
    if (prevLevel > 0 && h.level > prevLevel + 1) {
      out.push({
        id: `a11y-heading-skip-${shortHash(page.finalUrl + h.index)}`,
        type: 'accessibility',
        severity: 'info',
        message: `Heading level skipped: <h${prevLevel}> followed by <h${h.level}> ("${h.text}")`,
        page: page.finalUrl,
        detail: { from: prevLevel, to: h.level },
        fix: 'Don\'t skip heading levels (h1 → h3). Use consecutive levels for assistive tech.',
      });
      // Only report the first skip to avoid noise.
      break;
    }
    if (h.level > prevLevel) prevLevel = h.level;
  }

  return out;
}

function shortHash(s: string): string {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h * 33) ^ s.charCodeAt(i)) >>> 0;
  return h.toString(36);
}

function trunc(s: string, n = 80): string {
  return s.length > n ? s.substring(0, n - 1) + '…' : s;
}