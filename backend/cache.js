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

  invalidateAll() {
    this.store.clear();
  }

  size() {
    return this.store.size;
  }
}

const memoryCache = new MemoryCache();

module.exports = memoryCache;
