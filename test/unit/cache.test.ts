import { describe, it, expect } from 'vitest';
import { ProbeCache } from '../../src/core/cache.js';

describe('ProbeCache', () => {
  it('returns null on miss', () => {
    const c = new ProbeCache();
    expect(c.getLink('http://x/y')).toBeNull();
    expect(c.getAsset('http://x/y')).toBeNull();
  });

  it('round-trips link records', () => {
    const c = new ProbeCache();
    c.putLink('http://x/y', {
      href: 'http://x/y',
      finalUrl: 'http://x/y',
      status: 200,
      errorCode: null,
      sameOrigin: true,
    });
    const got = c.getLink('http://x/y');
    expect(got?.status).toBe(200);
    expect(got?.probedAt).toBeTypeOf('number');
  });

  it('round-trips asset records', () => {
    const c = new ProbeCache();
    c.putAsset('http://x/img.png', {
      src: 'http://x/img.png',
      status: 200,
      errorCode: null,
      contentType: 'image/png',
      bytes: 1234,
    });
    expect(c.getAsset('http://x/img.png')?.contentType).toBe('image/png');
  });

  it('updates LRU order on get', () => {
    const c = new ProbeCache(3);
    c.putLink('a', { href: 'a', finalUrl: 'a', status: 200, errorCode: null, sameOrigin: true });
    c.putLink('b', { href: 'b', finalUrl: 'b', status: 200, errorCode: null, sameOrigin: true });
    c.putLink('c', { href: 'c', finalUrl: 'c', status: 200, errorCode: null, sameOrigin: true });
    c.getLink('a'); // a is now MRU
    c.putLink('d', { href: 'd', finalUrl: 'd', status: 200, errorCode: null, sameOrigin: true });
    // b is the oldest and should have been evicted
    expect(c.getLink('b')).toBeNull();
    expect(c.getLink('a')).not.toBeNull();
    expect(c.getLink('c')).not.toBeNull();
    expect(c.getLink('d')).not.toBeNull();
  });

  it('evicts oldest entries when over capacity', () => {
    const c = new ProbeCache(2);
    c.putLink('a', { href: 'a', finalUrl: 'a', status: 200, errorCode: null, sameOrigin: true });
    c.putLink('b', { href: 'b', finalUrl: 'b', status: 200, errorCode: null, sameOrigin: true });
    c.putLink('c', { href: 'c', finalUrl: 'c', status: 200, errorCode: null, sameOrigin: true });
    expect(c.size().links).toBe(2);
    expect(c.getLink('a')).toBeNull();
  });

  it('rejects non-positive capacity', () => {
    expect(() => new ProbeCache(0)).toThrow();
    expect(() => new ProbeCache(-1)).toThrow();
  });

  it('tracks link and asset sizes independently', () => {
    const c = new ProbeCache();
    c.putLink('http://x/1', { href: '1', finalUrl: '1', status: 200, errorCode: null, sameOrigin: true });
    c.putAsset('http://x/2', { src: '2', status: 200, errorCode: null, contentType: 'image/png', bytes: 10 });
    const s = c.size();
    expect(s.links).toBe(1);
    expect(s.assets).toBe(1);
  });
});