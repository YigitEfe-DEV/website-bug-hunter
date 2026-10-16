import { load, type CheerioAPI } from 'cheerio';
import type { Confidence, CrawledPage, Finding } from '../types/index.js';

/**
 * Page metadata scanner. Reports findings for:
 *   - Missing or empty <title> (confirmed: we counted elements)
 *   - <title> length out of range (probable: heuristic — sites can be valid with shorter/longer)
 *   - Missing <meta charset>
 *   - Missing / malformed viewport
 *   - Missing / very short meta description
 *   - Missing og:title, og:image
 *   - Missing canonical
 *   - Multiple conflicting canonical declarations (confirmed)
 *   - Missing <html lang>
 *   - Missing favicon
 *
 * Note: SEO/accessibility findings here are scoped heuristics. We do NOT
 * claim a full SEO audit or accessibility certification.
 */
export function scanMeta(page: CrawledPage, preloadedCheerio?: CheerioAPI | null): Finding[] {
  if (!page.isHtml) return [];
  const $ = preloadedCheerio ?? load(page.html, { xml: { decodeEntities: false } });
  const out: Finding[] = [];

  // <title> — distinguish missing element from empty/whitespace-only.
  const $title = $('head > title').first();
  const hasTitleTag = $title.length > 0;
  const titleText = $title.text().trim();
  if (!hasTitleTag) {
    out.push(
      make(
        'meta_missing',
        'warning',
        'confirmed',
        'Missing <title> element',
        page,
        { tag: 'title' },
        'Browsers show a generic tab name and search engines have no snippet anchor.',
        'Add a <title> element as a direct child of <head>. Recommended length 30-60 characters.',
      ),
    );
  } else if (titleText.length === 0) {
    out.push(
      make(
        'meta_missing',
        'warning',
        'confirmed',
        'Empty <title> element',
        page,
        { tag: 'title' },
        'The tag exists but contains no text. Browsers and search engines have nothing to show.',
        'Put a descriptive title between the opening and closing <title> tags.',
      ),
    );
  } else if (titleText.length < 10) {
    out.push(
      make(
        'meta_invalid',
        'info',
        'probable',
        `<title> is very short (${titleText.length} chars): "${titleText}"`,
        page,
        { tag: 'title', length: titleText.length, value: titleText },
        'Shorter than typical user expectations; may not differentiate the page in search results.',
        'Lengthen the title to 30-60 characters with the page-specific subject.',
      ),
    );
  } else if (titleText.length > 200) {
    out.push(
      make(
        'meta_invalid',
        'info',
        'probable',
        `<title> is very long (${titleText.length} chars)`,
        page,
        { tag: 'title', length: titleText.length },
        'Search engines truncate around 60 chars; long titles lose detail in SERPs.',
        'Trim to <= 60 characters while keeping the page-specific subject first.',
      ),
    );
  }

  // <meta charset> / http-equiv content-type
  const charset = $('meta[charset]').attr('charset');
  const contentTypeMeta = $('meta[http-equiv="Content-Type"]').attr('content');
  if (!charset && !contentTypeMeta) {
    out.push(
      make(
        'meta_missing',
        'warning',
        'confirmed',
        'Missing <meta charset>',
        page,
        { tag: 'charset' },
        'Without an explicit charset declaration, browsers may mis-decode non-ASCII bytes.',
        'Add <meta charset="utf-8"> as the first child of <head>.',
      ),
    );
  }

  // <meta name="viewport">
  const viewport = $('meta[name="viewport"]').attr('content');
  if (!viewport) {
    out.push(
      make(
        'meta_missing',
        'warning',
        'confirmed',
        'Missing <meta name="viewport">',
        page,
        { tag: 'viewport' },
        'Mobile browsers render at a default 980px and zoom out, breaking layouts.',
        'Add <meta name="viewport" content="width=device-width, initial-scale=1">.',
      ),
    );
  } else if (!/width=device-width/i.test(viewport)) {
    out.push(
      make(
        'meta_invalid',
        'warning',
        'probable',
        'Viewport meta lacks "width=device-width"',
        page,
        { tag: 'viewport', value: viewport },
        'Without width=device-width the layout will not adapt to the device width.',
        'Add width=device-width to the viewport content attribute.',
      ),
    );
  }

  // <meta name="description">
  const $desc = $('meta[name="description"]');
  const hasDescTag = $desc.length > 0;
  const descContent = hasDescTag ? ($desc.attr('content') ?? '').trim() : '';
  if (!hasDescTag) {
    out.push(
      make(
        'meta_missing',
        'info',
        'confirmed',
        'Missing <meta name="description">',
        page,
        { tag: 'description' },
        'Search engines may auto-generate a snippet from page content, which is rarely optimal.',
        'Add a meta description that summarises the page in 50-160 characters.',
      ),
    );
  } else if (descContent.length === 0) {
    out.push(
      make(
        'meta_invalid',
        'info',
        'confirmed',
        'Empty meta description content',
        page,
        { tag: 'description' },
        'The tag exists but the content attribute is empty — equivalent to missing for snippet generation.',
        'Set the content attribute to a meaningful 50-160 character summary.',
      ),
    );
  } else if (descContent.length < 50) {
    out.push(
      make(
        'meta_invalid',
        'info',
        'probable',
        `Meta description is short (${descContent.length} chars)`,
        page,
        { tag: 'description', length: descContent.length },
        'Search engines truncate at ~160 chars; very short descriptions leave snippet real-estate unused.',
        'Expand to 50-160 characters.',
      ),
    );
  } else if (descContent.length > 320) {
    out.push(
      make(
        'meta_invalid',
        'info',
        'probable',
        `Meta description is very long (${descContent.length} chars)`,
        page,
        { tag: 'description', length: descContent.length },
        'Search engines truncate around 160 chars; longer text is mostly invisible.',
        'Trim to <= 160 characters.',
      ),
    );
  }

  // og:title
  const ogTitle = $('meta[property="og:title"]').attr('content');
  if (!ogTitle) {
    out.push(
      make(
        'meta_missing',
        'info',
        'confirmed',
        'Missing og:title',
        page,
        { tag: 'og:title' },
        'Social media link previews fall back to the page <title>, which may be wrong or missing.',
        'Add <meta property="og:title" content="...">.',
      ),
    );
  }

  // og:image
  const ogImage = $('meta[property="og:image"]').attr('content');
  if (!ogImage) {
    out.push(
      make(
        'meta_missing',
        'info',
        'confirmed',
        'Missing og:image',
        page,
        { tag: 'og:image' },
        'Without an og:image, social previews show no thumbnail or a low-quality auto-thumb.',
        'Add <meta property="og:image" content="https://example.com/preview.jpg"> with an absolute URL.',
      ),
    );
  }

  // canonical — single declaration expected; multiple is an error.
  const $canonicals = $('link[rel="canonical"]');
  if ($canonicals.length === 0) {
    out.push(
      make(
        'meta_missing',
        'info',
        'confirmed',
        'Missing canonical link',
        page,
        { tag: 'canonical' },
        'Without canonical, the URL used by search engines may include unwanted query parameters or trailing slashes.',
        'Add <link rel="canonical" href="https://example.com/page">.',
      ),
    );
  } else if ($canonicals.length > 1) {
    const hrefs = $canonicals
      .map((_, el) => $(el).attr('href')?.trim() ?? '')
      .get()
      .filter((s) => s.length > 0);
    out.push(
      make(
        'meta_invalid',
        'error',
        'confirmed',
        `Multiple canonical link elements (${$canonicals.length})`,
        page,
        { tag: 'canonical', count: $canonicals.length, hrefs },
        'Search engines may pick arbitrarily or ignore all canonicals when multiple declarations disagree.',
        'Keep exactly one <link rel="canonical"> per page.',
      ),
    );
  }

  // <html lang>
  const htmlLang = $('html').attr('lang');
  if (!htmlLang) {
    out.push(
      make(
        'meta_missing',
        'warning',
        'confirmed',
        'Missing <html lang> attribute',
        page,
        { tag: 'html-lang' },
        'Screen readers cannot reliably choose pronunciation rules without a language tag.',
        'Add lang="en" (or your primary language) to <html>.',
      ),
    );
  } else if (htmlLang.length < 2 || htmlLang.length > 35) {
    // Loose sanity check: BCP-47 tags are 2-35 chars; longer is unusual.
    out.push(
      make(
        'meta_invalid',
        'info',
        'probable',
        `<html lang> value "${htmlLang}" looks unusual`,
        page,
        { tag: 'html-lang', value: htmlLang },
        'BCP-47 language tags are usually 2-8 characters (e.g. "en", "en-US", "zh-Hant").',
        'Use a valid BCP-47 tag — see https://datatracker.ietf.org/doc/html/rfc5646',
      ),
    );
  }

  // favicon
  const favicon = $('link[rel~="icon"]').attr('href');
  if (!favicon) {
    out.push(
      make(
        'meta_missing',
        'info',
        'confirmed',
        'Missing favicon',
        page,
        { tag: 'favicon' },
        'Browsers show a generic icon and may issue a noisy 404 for /favicon.ico.',
        'Add <link rel="icon" href="/favicon.ico"> (or a 32x32 PNG/SVG).',
      ),
    );
  }

  return out;
}

function make(
  type: 'meta_missing' | 'meta_invalid',
  severity: 'error' | 'warning' | 'info',
  confidence: Confidence,
  message: string,
  page: CrawledPage,
  detail: Record<string, unknown>,
  explanation: string,
  fix: string,
): Finding {
  return {
    id: `meta-${type}-${shortHash(page.finalUrl + message)}`,
    type,
    severity,
    confidence,
    message,
    page: page.finalUrl,
    detail,
    explanation,
    fix,
  };
}

function shortHash(s: string): string {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h * 33) ^ s.charCodeAt(i)) >>> 0;
  return h.toString(36);
}