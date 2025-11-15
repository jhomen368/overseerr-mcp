// ... existing code ...

interface CacheEntry<T> {
  data: T;
  timestamp: number;
  accessCount: number;
}

interface CacheConfig {
  enabled: boolean;
  ttl: {
    search: number;
    mediaDetails: number;
    requests: number;
  };
  maxSize: number;
}

export class CacheManager {
  private cache: Map<string, CacheEntry<any>>;
  private config: CacheConfig;
  private hits: Map<string, number>;
  private misses: Map<string, number>;

  constructor() {
    this.cache = new Map();
    this.hits = new Map(['search', 'mediaDetails', 'requests'].map(k => [k, 0]));
    this.misses = new Map(['search', 'mediaDetails', 'requests'].map(k => [k, 0]));
    
    this.config = {
      enabled: process.env.CACHE_ENABLED !== 'false',
      ttl: {
        search: parseInt(process.env.CACHE_SEARCH_TTL || '300000'), // 5 min
        mediaDetails: parseInt(process.env.CACHE_MEDIA_TTL || '1800000'), // 30 min
        requests: parseInt(process.env.CACHE_REQUESTS_TTL || '60000'), // 1 min
      },
      maxSize: parseInt(process.env.CACHE_MAX_SIZE || '1000'),
    };
  }

  private getCacheKey(type: string, params: any): string {
    return `${type}:${JSON.stringify(params)}`;
  }

  private isExpired(entry: CacheEntry<any>, ttl: number): boolean {
    return Date.now() - entry.timestamp > ttl;
  }

  private evictLRU(): void {
    if (this.cache.size < this.config.maxSize) return;

    let lruKey: string | null = null;
    let lruAccessCount = Infinity;

    for (const [key, entry] of this.cache.entries()) {
      if (entry.accessCount < lruAccessCount) {
        lruAccessCount = entry.accessCount;
        lruKey = key;
      }
    }

    if (lruKey) {
      this.cache.delete(lruKey);
    }
  }

  get<T>(type: keyof CacheConfig['ttl'], params: any): T | null {
    if (!this.config.enabled) return null;

    const key = this.getCacheKey(type, params);
    const entry = this.cache.get(key);

    if (!entry) {
      this.misses.set(type, (this.misses.get(type) || 0) + 1);
      return null;
    }

    const ttl = this.config.ttl[type];
    if (this.isExpired(entry, ttl)) {
      this.cache.delete(key);
      this.misses.set(type, (this.misses.get(type) || 0) + 1);
      return null;
    }

    entry.accessCount++;
    this.hits.set(type, (this.hits.get(type) || 0) + 1);
    return entry.data as T;
  }

  set<T>(type: keyof CacheConfig['ttl'], params: any, data: T): void {
    if (!this.config.enabled) return;

    this.evictLRU();

    const key = this.getCacheKey(type, params);
    this.cache.set(key, {
      data,
      timestamp: Date.now(),
      accessCount: 0,
    });
  }

  invalidate(type?: keyof CacheConfig['ttl']): void {
    if (type) {
      // Invalidate specific type
      const prefix = `${type}:`;
      for (const key of this.cache.keys()) {
        if (key.startsWith(prefix)) {
          this.cache.delete(key);
        }
      }
    } else {
      // Clear all cache
      this.cache.clear();
    }
  }

  getStats() {
    const stats = {
      enabled: this.config.enabled,
      size: this.cache.size,
      maxSize: this.config.maxSize,
      types: {} as Record<string, any>,
    };

    for (const type of ['search', 'mediaDetails', 'requests']) {
      const hits = this.hits.get(type) || 0;
      const misses = this.misses.get(type) || 0;
      const total = hits + misses;
      
      stats.types[type] = {
        hits,
        misses,
        hitRate: total > 0 ? ((hits / total) * 100).toFixed(1) + '%' : '0%',
      };
    }

    return stats;
  }
}