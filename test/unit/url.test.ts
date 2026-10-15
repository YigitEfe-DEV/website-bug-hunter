import { describe, it, expect } from 'vitest';
import { normalizeUrl, sameOrigin, origin } from '../../src/utils/url.js';

describe('url helpers', () => {
  it('normalizeUrl resolves relative hrefs', () => {
    expect(normalizeUrl('/foo', 'https://example.com/bar')).toBe(
      'https://example.com/foo',
    );
  });

  it('normalizeUrl rejects non-http schemes', () => {
    expect(normalizeUrl('javascript:alert(1)', 'https://example.com')).toBeNull();
    expect(normalizeUrl('mailto:x@y.com', 'https://example.com')).toBeNull();
  });

  it('normalizeUrl strips hash', () => {
    expect(normalizeUrl('https://example.com/foo#bar', 'https://example.com')).toBe(
      'https://example.com/foo',
    );
  });

  it('sameOrigin detects scheme/host/port mismatches', () => {
    expect(sameOrigin('https://example.com/a', 'https://example.com/b')).toBe(true);
    expect(sameOrigin('http://example.com/a', 'https://example.com/b')).toBe(false);
    expect(sameOrigin('https://example.com:443/a', 'https://example.com/b')).toBe(true);
    expect(sameOrigin('https://example.com:8080/a', 'https://example.com/b')).toBe(false);
  });

  it('origin returns canonical origin', () => {
    expect(origin('https://example.com/foo?bar=1')).toBe('https://example.com');
  });
});