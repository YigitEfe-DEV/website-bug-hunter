import type { CrawledPage, Finding } from '../types/index.js';

/**
 * Detect redirect anomalies from the status chain recorded during fetch.
 *
 * Confidence: all redirect findings are CONFIRMED — we observed the
 * chain directly via the HTTP client; the redirect chain is not a
 * heuristic.
 */
export function scanRedirects(page: CrawledPage): Finding[] {
  const out: Finding[] = [];
  const chain = page.statusChain;
  const locs = page.locationChain;

  if (chain.length <= 1) return out;

  // Loop detection.
  const seen = new Set<string>();
  for (const u of locs) {
    if (seen.has(u)) {
      out.push({
        id: `redir-loop-${shortHash(page.finalUrl)}`,
        type: 'redirect_loop',
        severity: 'error',
        confidence: 'confirmed',
        message: `Redirect loop detected (${locs.length} hops)`,
        page: page.finalUrl,
        detail: { chain: locs },
        explanation:
          'A URL appeared twice in the redirect chain, so following it never terminates. Browsers will show "redirected too many times".',
        fix: 'Inspect the Location headers along the chain. Each hop must lead to a unique URL that does not point back into the chain.',
      });
      break;
    }
    seen.add(u);
  }

  // Long chain.
  if (locs.length > 3) {
    out.push({
      id: `redir-long-${shortHash(page.finalUrl)}`,
      type: 'redirect_chain_long',
      severity: 'warning',
      confidence: 'confirmed',
      message: `Long redirect chain (${locs.length} hops)`,
      page: page.finalUrl,
      detail: { chain: locs },
      explanation:
        'Each redirect hop adds a round-trip. Long chains are usually unnecessary; aim for 1-2 hops.',
      fix: 'Collapse intermediate hops into a single redirect, or update the source URL to point directly at the destination.',
    });
  }

  // Downgrade: http -> https or https -> http across hops.
  if (locs.length > 0) {
    const first = new URL(page.requestUrl).protocol;
    const last = new URL(page.finalUrl).protocol;
    if (first === 'http:' && last === 'https:') {
      out.push({
        id: `redir-upgrade-${shortHash(page.finalUrl)}`,
        type: 'redirect_downgrade',
        severity: 'info',
        confidence: 'confirmed',
        message: 'http -> https upgrade',
        page: page.finalUrl,
        detail: { from: page.requestUrl, to: page.finalUrl },
        explanation:
          'The user-visible flow starts on http and ends on https. Acceptable, but the http origin should ideally 301 directly to https with HSTS.',
        fix: 'Configure the http origin to 301 directly to the https destination and serve HSTS.',
      });
    } else if (first === 'https:' && last === 'http:') {
      out.push({
        id: `redir-downgrade-${shortHash(page.finalUrl)}`,
        type: 'redirect_downgrade',
        severity: 'error',
        confidence: 'confirmed',
        message: 'https -> http downgrade (security regression)',
        page: page.finalUrl,
        detail: { from: page.requestUrl, to: page.finalUrl },
        explanation:
          'The chain ends on http, defeating TLS for the destination. Referrer headers and any URL parameters are leaked in plaintext.',
        fix: 'Do not redirect https -> http. Update the source link or configuration to point to the https version.',
      });
    }
  }

  return out;
}

function shortHash(s: string): string {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h * 33) ^ s.charCodeAt(i)) >>> 0;
  return h.toString(36);
}