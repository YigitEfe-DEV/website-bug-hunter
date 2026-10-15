import { load } from 'cheerio';
import type { CrawledPage, Finding } from '../types/index.js';

export function scanMeta(page: CrawledPage): Finding[] {
  if (!page.isHtml) return [];
  const $ = load(page.html, { xml: { decodeEntities: false } });
  const out: Finding[] = [];

  // <title>
  const title = $('head > title').first().text().trim();
  if (!title) {
    out.push(
      make(
        'meta_missing',
        'warning',
        'Missing <title>',
        page,
        { tag: 'title' },
        'Add a <title> element inside <head>. Recommended length 30-60 characters.',
      ),
    );
  } else if (title.length < 10) {
    out.push(
      make(
        'meta_invalid',
        'info',
        `<title> is too short (${title.length} chars)`,
        page,
        { tag: 'title', value: title },
        'A longer, descriptive <title> helps users and search engines understand the page.',
      ),
    );
  } else if (title.length > 200) {
    out.push(
      make(
        'meta_invalid',
        'info',
        `<title> is too long (${title.length} chars)`,
        page,
        { tag: 'title', length: title.length },
        'Trim <title> to <= 200 characters. Search engines truncate around 60.',
      ),
    );
  }

  // <meta charset>
  const charset = $('meta[charset]').attr('charset');
  const contentTypeMeta = $('meta[http-equiv="Content-Type"]').attr('content');
  if (!charset && !contentTypeMeta) {
    out.push(
      make(
        'meta_missing',
        'warning',
        'Missing <meta charset>',
        page,
        { tag: 'charset' },
        'Add <meta charset="utf-8"> as the first element inside <head>.',
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
        'Missing <meta name="viewport">',
        page,
        { tag: 'viewport' },
        'Required for mobile. Add <meta name="viewport" content="width=device-width, initial-scale=1">.',
      ),
    );
  } else if (!/width=device-width/i.test(viewport)) {
    out.push(
      make(
        'meta_invalid',
        'warning',
        'Viewport meta lacks "width=device-width"',
        page,
        { tag: 'viewport', value: viewport },
        'Add width=device-width to your viewport meta tag for proper mobile rendering.',
      ),
    );
  }

  // <meta name="description">
  const desc = $('meta[name="description"]').attr('content');
  if (!desc) {
    out.push(
      make(
        'meta_missing',
        'info',
        'Missing <meta name="description">',
        page,
        { tag: 'description' },
        'Add a meta description summarizing the page. Recommended 50-160 characters.',
      ),
    );
  } else if (desc.length < 50) {
    out.push(
      make(
        'meta_invalid',
        'info',
        'Meta description too short',
        page,
        { tag: 'description', length: desc.length },
        'Expand the meta description to 50-160 characters for better SEO snippets.',
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
        'Missing og:title',
        page,
        { tag: 'og:title' },
        'Add <meta property="og:title"> for better social media link previews.',
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
        'Missing og:image',
        page,
        { tag: 'og:image' },
        'Add <meta property="og:image"> with an absolute image URL for social previews.',
      ),
    );
  }

  // canonical
  const canonical = $('link[rel="canonical"]').attr('href');
  if (!canonical) {
    out.push(
      make(
        'meta_missing',
        'info',
        'Missing canonical link',
        page,
        { tag: 'canonical' },
        'Add <link rel="canonical" href="https://example.com/page"> to declare the preferred URL.',
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
        'Missing <html lang> attribute',
        page,
        { tag: 'html-lang' },
        'Add lang="en" (or your language) to <html> for screen-reader pronunciation.',
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
        'Missing favicon',
        page,
        { tag: 'favicon' },
        'Add <link rel="icon" href="/favicon.ico"> so the tab gets an icon.',
      ),
    );
  }

  return out;
}

function make(
  type: 'meta_missing' | 'meta_invalid',
  severity: 'warning' | 'info',
  message: string,
  page: CrawledPage,
  detail: Record<string, unknown>,
  fix: string,
): Finding {
  return {
    id: `meta-${type}-${shortHash(page.finalUrl + message)}`,
    type,
    severity,
    message,
    page: page.finalUrl,
    detail,
    fix,
  };
}

function shortHash(s: string): string {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h * 33) ^ s.charCodeAt(i)) >>> 0;
  return h.toString(36);
}