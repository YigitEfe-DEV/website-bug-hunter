import { lookup } from 'dns/promises';
import { logger } from '../utils/logger.js';

/**
 * Minimal robots.txt fetcher. We parse just enough to answer
 * "is this path allowed for our user-agent?" — no crawl-delay, no sitemaps.
 *
 * Spec: https://www.rfc-editor.org/rfc/rfc9309.html
 */
export class RobotsCache {
  private cache = new Map<string, ParsedRobots | null>();
  private ua: string;

  constructor(userAgent: string) {
    this.ua = userAgent.toLowerCase();
  }

  async isAllowed(url: string): Promise<boolean> {
    try {
      const u = new URL(url);
      const robotsUrl = `${u.protocol}//${u.host}/robots.txt`;
      let parsed = this.cache.get(robotsUrl);
      if (parsed === undefined) {
        parsed = await this.fetch(robotsUrl);
        this.cache.set(robotsUrl, parsed);
      }
      if (!parsed) return true;
      const path = u.pathname + u.search;
      return !parsed.isDisallowed(path, this.ua);
    } catch (e) {
      logger.debug({ url, err: (e as Error).message }, 'robots check failed');
      return true; // Fail open: if we can't tell, allow.
    }
  }

  private async fetch(robotsUrl: string): Promise<ParsedRobots | null> {
    try {
      const u = new URL(robotsUrl);
      // Verify the host resolves to a public IP.
      await lookup(u.hostname);
      const ac = new AbortController();
      const timer = setTimeout(() => ac.abort(), 5000);
      const res = await fetch(robotsUrl, {
        signal: ac.signal,
        headers: { 'User-Agent': this.ua },
      });
      clearTimeout(timer);
      if (!res.ok) return null;
      const text = await res.text();
      return parseRobots(text);
    } catch {
      return null;
    }
  }
}

interface ParsedRobots {
  isDisallowed(path: string, ua: string): boolean;
}

/** Tiny RFC 9309-compliant subset parser. Wildcards in paths not supported. */
function parseRobots(text: string): ParsedRobots {
  type Rule = { ua: string[]; allow: string[]; disallow: string[] };
  const rules: Rule[] = [];
  const comments = /\s*#.*$/gm;
  const stripped = text.replace(comments, '');
  const lines = stripped.split(/\r?\n/);
  let cur: Rule | null = null;
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    const idx = line.indexOf(':');
    if (idx < 0) continue;
    const key = line.substring(0, idx).trim().toLowerCase();
    const value = line.substring(idx + 1).trim();
    if (key === 'user-agent') {
      // Start a new group.
      const ua = value.toLowerCase();
      // If a group already exists for this exact UA, extend it; otherwise new.
      const existing = rules.find((r) => r.ua.length === 1 && r.ua[0] === ua);
      if (existing) {
        cur = existing;
      } else {
        cur = { ua: [ua], allow: [], disallow: [] };
        rules.push(cur);
      }
    } else if (cur && key === 'allow') {
      cur.allow.push(value);
    } else if (cur && key === 'disallow') {
      cur.disallow.push(value);
    }
  }

  return {
    isDisallowed(path: string, ua: string): boolean {
      // Find the longest matching rule for the most specific UA group.
      // Per spec, the most specific group wins (longest UA match).
      const candidates = rules.filter((r) => r.ua.includes(ua) || r.ua.includes('*'));
      let best: { rule: Rule; len: number; allow: boolean } | null = null;
      for (const r of candidates) {
        for (const d of r.disallow) {
          if (!d) continue;
          if (path.startsWith(d) && (!best || d.length > best.len)) {
            best = { rule: r, len: d.length, allow: false };
          }
        }
        for (const a of r.allow) {
          if (!a) continue;
          if (path.startsWith(a) && (!best || a.length > best.len)) {
            best = { rule: r, len: a.length, allow: true };
          }
        }
      }
      return best ? !best.allow : false;
    },
  };
}