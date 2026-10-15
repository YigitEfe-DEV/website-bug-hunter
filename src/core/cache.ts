/**
 * Bounded LRU cache for HTTP probe results. Scanners (links, images) use
 * this so the same URL appearing on N pages is only probed once per scan.
 *
 * Why a cache: with 500 pages and 20 outbound links each, that's 10k
 * probes if dedup is missed. Caching drops the fan-out by 10-100x for
 * sites with shared navigation / footer / asset URLs.
 *
 * Bounded by count (default 50k entries). Each entry is small (~200 B)
 * so worst-case memory ≈ 10 MB.
 */

interface CacheEntry<T> {
  value: T;
  insertedAt: number;
}

export interface LinkRecord {
  href: string;
  finalUrl: string;
  status: number | null;
  errorCode: string | null;
  sameOrigin: boolean;
  probedAt: number;
}

export interface AssetRecord {
  src: string;
  status: number | null;
  errorCode: string | null;
  contentType: string;
  bytes: number | null;
  probedAt: number;
}

export type LinkProbe = LinkRecord;
export type AssetProbe = AssetRecord;

export class ProbeCache {
  private links = new Map<string, CacheEntry<LinkRecord>>();
  private assets = new Map<string, CacheEntry<AssetRecord>>();
  private readonly capacity: number;

  constructor(capacity = 50_000) {
    if (capacity <= 0) throw new Error('cache capacity must be positive');
    this.capacity = capacity;
  }

  getLink(url: string): LinkRecord | null {
    const e = this.links.get(url);
    if (!e) return null;
    // LRU: re-insert to move to MRU end.
    this.links.delete(url);
    this.links.set(url, e);
    return e.value;
  }

  putLink(url: string, value: Omit<LinkRecord, 'probedAt'>): void {
    if (this.links.has(url)) this.links.delete(url);
    this.links.set(url, { value: { ...value, probedAt: Date.now() }, insertedAt: Date.now() });
    this.evict(this.links);
  }

  getAsset(url: string): AssetRecord | null {
    const e = this.assets.get(url);
    if (!e) return null;
    this.assets.delete(url);
    this.assets.set(url, e);
    return e.value;
  }

  putAsset(url: string, value: Omit<AssetRecord, 'probedAt'>): void {
    if (this.assets.has(url)) this.assets.delete(url);
    this.assets.set(url, { value: { ...value, probedAt: Date.now() }, insertedAt: Date.now() });
    this.evict(this.assets);
  }

  /** Number of link probes in cache. */
  size(): { links: number; assets: number } {
    return { links: this.links.size, assets: this.assets.size };
  }

  private evict<K, V>(map: Map<K, V>): void {
    while (map.size > this.capacity) {
      const oldest = map.keys().next().value;
      if (oldest === undefined) break;
      map.delete(oldest);
    }
  }
}