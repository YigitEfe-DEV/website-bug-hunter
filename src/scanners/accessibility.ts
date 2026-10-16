import { load, type CheerioAPI } from 'cheerio';
import type { CrawledPage, Finding } from '../types/index.js';

/**
 * Accessibility audit. Cheap, static, no fetch.
 *
 * Confidence: all findings here are PROBABLE. A missing alt attribute is
 * a strong signal that assistive tech will not announce the image, but
 * the image may legitimately be decorative (role="presentation"). WCAG
 * conformance is a much larger surface than what this scanner checks —
 * treat the report as a starting point, not a certification.
 *
 * Detection:
 *   - <img> with no alt attribute (warning)
 *   - <img> with empty alt is acceptable — not flagged
 *   - Page has no <h1> (warning)
 *   - Page has multiple <h1>s (warning)
 *   - Heading-level skip (h1 -> h3) (info)
 */
export function scanAccessibility(page: CrawledPage, preloadedCheerio?: CheerioAPI | null): Finding[] {
  if (!page.isHtml) return [];
  const $ = preloadedCheerio ?? load(page.html, { xml: { decodeEntities: false } });
  const out: Finding[] = [];

  // Image alt text — only flag absent, not empty (empty is valid for decorative).
  $('img').each((i, el) => {
    const $img = $(el);
    const alt = $img.attr('alt');
    const src = $img.attr('src') ?? '';
    if (alt === undefined) {
      out.push({
        id: `a11y-img-alt-${shortHash(page.finalUrl + src + i)}`,
        type: 'accessibility',
        severity: 'warning',
        confidence: 'probable',
        message: `<img> is missing alt attribute: ${trunc(src)}`,
        page: page.finalUrl,
        detail: { tag: 'img', attribute: 'alt' },
        explanation:
          'Screen readers cannot announce the image. If the image is decorative, mark it with alt="" or role="presentation".',
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
      confidence: 'confirmed',
      message: 'Page has no <h1> heading',
      page: page.finalUrl,
      explanation:
        'Pages without an h1 give assistive tech no top-level landmark. Most accessibility checklists require exactly one h1 per page.',
      fix: 'Add a single <h1> at the start of the main content that summarises the page.',
    });
  } else if (h1s.length > 1) {
    out.push({
      id: `a11y-multi-h1-${shortHash(page.finalUrl)}`,
      type: 'accessibility',
      severity: 'warning',
      confidence: 'confirmed',
      message: `Page has ${h1s.length} <h1> headings (expect 1)`,
      page: page.finalUrl,
      detail: { count: h1s.length },
      explanation:
        'Multiple h1 elements weaken the document outline and confuse screen-reader heading navigation.',
      fix: 'Use a single <h1>; demote others to <h2> or below.',
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
        confidence: 'probable',
        message: `Heading level skipped: <h${prevLevel}> followed by <h${h.level}> ("${h.text}")`,
        page: page.finalUrl,
        detail: { from: prevLevel, to: h.level },
        explanation:
          'Skipping heading levels (e.g. h1 -> h3) breaks the document outline and can disorient assistive-tech users.',
        fix: 'Don\'t skip heading levels. Use consecutive levels (h1, h2, h3, …).',
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