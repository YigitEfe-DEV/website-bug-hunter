import type { CrawledPage, Finding } from '../types/index.js';

/**
 * Detect redirect anomalies based on the status chain we recorded while
 * fetching the page. Findings:
 *   - redirect_loop:    the same URL appears twice in the chain
 *   - redirect_chain_long: more than 3 hops
 *   - redirect_downgrade: http -> https, or vice versa, across the chain
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
        message: `Redirect loop detected (${locs.length} hops)`,
        page: page.finalUrl,
        detail: { chain: locs },
        fix: 'Inspect the redirect chain. Each Location must lead to a unique, terminating URL.',
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
      message: `Long redirect chain (${locs.length} hops)`,
      page: page.finalUrl,
      detail: { chain: locs },
      fix: 'Reduce the redirect chain to 1-2 hops. Each hop adds latency.',
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
        message: 'http -> https upgrade',
        page: page.finalUrl,
        detail: { from: page.requestUrl, to: page.finalUrl },
      });
    } else if (first === 'https:' && last === 'http:') {
      out.push({
        id: `redir-downgrade-${shortHash(page.finalUrl)}`,
        type: 'redirect_downgrade',
        severity: 'error',
        message: 'https -> http downgrade (security regression)',
        page: page.finalUrl,
        detail: { from: page.requestUrl, to: page.finalUrl },
        fix: 'Avoid https -> http redirects. They leak the referrer and break HSTS.',
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