/**
 * In-Memory High-Speed Cache for Hakimi53 Hall Management
 * Drastically cuts database row reads for public calendars and dashboard totals.
 * Automatically purges on any booking, payment, cancellation, or date-blocking mutation.
 */

const { dbMetrics } = require('./dbMetrics');

class MemoryCache {
  constructor() {
    this.store = new Map();
  }

  get(key) {
    const entry = this.store.get(key);
    if (!entry) {
      dbMetrics.recordCacheMiss();
      return null;
    }

    if (Date.now() > entry.expiry) {
      this.store.delete(key);
      dbMetrics.recordCacheMiss();
      return null;
    }

    dbMetrics.recordCacheHit();
    return entry.value;
  }

  set(key, value, customTtlSeconds) {
    const ttl = customTtlSeconds || dbMetrics.getRecommendedCacheTTL();
    const expiry = Date.now() + (ttl * 1000);
    this.store.set(key, { value, expiry });
  }

  del(key) {
    this.store.delete(key);
  }

  invalidate(prefix) {
    if (!prefix) {
      this.store.clear();
      return;
    }
    for (const key of this.store.keys()) {
      if (key.startsWith(prefix)) {
        this.store.delete(key);
      }
    }
  }

  invalidateDomain(domain, hall) {
    if (domain === 'bookings' || domain === 'calendar' || domain === 'date_blocks') {
      if (hall) {
        this.invalidate(`calendar:${hall}`);
      } else {
        this.invalidate('calendar');
      }
      this.invalidate('bookings');
      this.invalidate('summary');
      this.invalidate('reports');
    } else if (domain === 'expenses') {
      this.invalidate('expenses');
      this.invalidate('summary:expenses');
      this.invalidate('reports');
    } else if (domain === 'staff') {
      this.invalidate('staff');
      this.invalidate('reports');
    } else {
      this.invalidateAll();
    }
  }

  invalidateAll() {
    this.store.clear();
  }

  stats() {
    const total = (dbMetrics.cacheHits || 0) + (dbMetrics.cacheMisses || 0);
    const hitRate = total > 0 ? Number(((dbMetrics.cacheHits / total) * 100).toFixed(1)) : 0;
    return {
      keys: this.store.size,
      hits: dbMetrics.cacheHits || 0,
      misses: dbMetrics.cacheMisses || 0,
      hitRate: `${hitRate}%`
    };
  }

  size() {
    return this.store.size;
  }
}

const memoryCache = new MemoryCache();

module.exports = memoryCache;
