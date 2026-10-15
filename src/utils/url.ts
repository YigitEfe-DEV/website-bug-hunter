/** URL helpers — canonicalization, same-origin, internal link extraction. */

export function normalizeUrl(href: string, base: string): string | null {
  try {
    const u = new URL(href, base);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    u.hash = '';
    // Drop trailing-slash differences for path-only equality.
    if (u.pathname === '/' && !u.search) return u.toString();
    return u.toString();
  } catch {
    return null;
  }
}

export function sameOrigin(a: string, b: string): boolean {
  try {
    const ua = new URL(a);
    const ub = new URL(b);
    return ua.protocol === ub.protocol && ua.hostname === ub.hostname && ua.port === ub.port;
  } catch {
    return false;
  }
}

export function isHttpish(u: string): boolean {
  try {
    const p = new URL(u).protocol;
    return p === 'http:' || p === 'https:';
  } catch {
    return false;
  }
}

export function host(u: string): string | null {
  try {
    return new URL(u).host;
  } catch {
    return null;
  }
}

export function path(u: string): string {
  try {
    return new URL(u).pathname;
  } catch {
    return '';
  }
}

export function origin(u: string): string | null {
  try {
    return new URL(u).origin;
  } catch {
    return null;
  }
}