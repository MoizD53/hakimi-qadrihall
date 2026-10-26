/**
 * Hakimi53 Database Usage Metrics & Budget Enforcement Manager
 * 
 * Target: Never exceed 20,000,000 database rows read per calendar month.
 * Target: Strictly control database writes (default 500,000 rows written / month).
 * 
 * Safety Margins & Tier Policy:
 *  - 0–70%: NORMAL operation.
 *  - 70–85%: MONITOR closely and log warnings.
 *  - 85–95%: THROTTLE nonessential reads, increase cache TTL, slow background tasks.
 *  - 95–100%: RESTRICT nonessential operations and alert administrator.
 *  - At Hard Limit (100%+): STOP nonessential reads and writes where safe,
 *    preserving essential operations (auth, conflict check, payment recording, cancellation).
 */

const MAX_MONTHLY_ROWS_READ = parseInt(process.env.DB_MAX_MONTHLY_READS, 10) || 20000000;
const MAX_MONTHLY_ROWS_WRITTEN = parseInt(process.env.DB_MAX_MONTHLY_WRITES, 10) || 500000;
const MAX_ROWS_PER_QUERY = parseInt(process.env.DB_MAX_ROWS_PER_QUERY, 10) || 500;

function getCurrentPeriod() {
  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, '0');
  return `${year}-${month}`;
}

class DbMetricsManager {
  constructor() {
    this.currentPeriod = getCurrentPeriod();
    this.rowsRead = 0;
    this.rowsWritten = 0;
    this.queryCount = 0;
    this.isDirty = false;
    this.initialized = false;
    this.syncInterval = null;

    // Cache hit/miss counters
    this.cacheHits = 0;
    this.cacheMisses = 0;
  }

  getReadPercentage() {
    return (this.rowsRead / MAX_MONTHLY_ROWS_READ) * 100;
  }

  getWritePercentage() {
    return (this.rowsWritten / MAX_MONTHLY_ROWS_WRITTEN) * 100;
  }

  getTier() {
    const readFraction = this.rowsRead / MAX_MONTHLY_ROWS_READ;
    const writeFraction = this.rowsWritten / MAX_MONTHLY_ROWS_WRITTEN;
    const maxFraction = Math.max(readFraction, writeFraction);

    if (maxFraction >= 1.0) return 'HARD_LIMIT';
    if (maxFraction >= 0.95) return 'RESTRICTED';
    if (maxFraction >= 0.85) return 'THROTTLE';
    if (maxFraction >= 0.70) return 'MONITOR';
    return 'NORMAL';
  }

  getTierDescription() {
    const tier = this.getTier();
    switch (tier) {
      case 'HARD_LIMIT':
        return 'Hard budget limit reached (100%+). Non-essential database queries stopped to protect essential booking workflows.';
      case 'RESTRICTED':
        return 'Critical quota usage (95–100%). Non-essential reads restricted, administrator alerted.';
      case 'THROTTLE':
        return 'Elevated usage (85–95%). Cache TTL increased, throttling non-essential reads.';
      case 'MONITOR':
        return 'Moderate usage (70–85%). Monitoring usage closely.';
      default:
        return 'Normal operation (0–70% of monthly budget).';
    }
  }

  getRecommendedCacheTTL() {
    const tier = this.getTier();
    switch (tier) {
      case 'HARD_LIMIT': return 1800; // 30 mins
      case 'RESTRICTED': return 600;  // 10 mins
      case 'THROTTLE':   return 300;  // 5 mins
      case 'MONITOR':    return 120;  // 2 mins
      default:           return 60;   // 1 min
    }
  }

  isEssentialOperation(sql) {
    if (!sql) return false;
    const upper = String(sql).toUpperCase();

    // Critical Auth
    if (upper.includes('FROM USERS') || upper.includes('INTO USERS')) return true;

    // Critical Booking Conflict Check
    if (upper.includes('CHECK_IN') && (upper.includes('SLOT') || upper.includes('STATUS NOT IN'))) return true;

    // Critical Booking Creation & Updates
    if (upper.includes('INSERT INTO BOOKINGS')) return true;
    if (upper.includes('UPDATE BOOKINGS')) return true;

    // Critical Payments
    if (upper.includes('BOOKING_PAYMENTS')) return true;

    // Critical Date Blocks (prevent accidental double bookings)
    if (upper.includes('DATE_BLOCKS')) return true;

    // Database metrics tracking self-queries
    if (upper.includes('DB_USAGE_METRICS')) return true;

    return false;
  }

  canExecute(sql) {
    // Check period roll-over (new month)
    const activePeriod = getCurrentPeriod();
    if (activePeriod !== this.currentPeriod) {
      this.currentPeriod = activePeriod;
      this.rowsRead = 0;
      this.rowsWritten = 0;
      this.queryCount = 0;
      this.isDirty = true;
    }

    const tier = this.getTier();
    if (tier === 'HARD_LIMIT') {
      const isEssential = this.isEssentialOperation(sql);
      if (!isEssential) {
        return {
          allowed: false,
          reason: `DATABASE_QUOTA_EXCEEDED: Monthly row read budget of ${MAX_MONTHLY_ROWS_READ.toLocaleString()} rows reached. Non-essential database query halted to safeguard core booking transactions.`
        };
      }
    }
    return { allowed: true };
  }

  recordOperation(sql, rowCountRead, rowCountWritten) {
    this.queryCount++;
    this.rowsRead += (rowCountRead || 0);
    this.rowsWritten += (rowCountWritten || 0);
    this.isDirty = true;

    // Check warning threshold
    const readPct = this.getReadPercentage();
    if (readPct >= 70 && !this._warned70) {
      console.warn(`⚠️ [DB BUDGET WARNING] Monthly row read usage reached ${readPct.toFixed(2)}% (${this.rowsRead.toLocaleString()} / ${MAX_MONTHLY_ROWS_READ.toLocaleString()})`);
      this._warned70 = true;
    }
    if (readPct >= 85 && !this._warned85) {
      console.warn(`🚨 [DB BUDGET THROTTLE] Monthly row read usage reached ${readPct.toFixed(2)}%. Extending cache TTL to protect quota.`);
      this._warned85 = true;
    }
    if (readPct >= 95 && !this._warned95) {
      console.error(`🛑 [DB BUDGET RESTRICTED] Monthly row read usage reached ${readPct.toFixed(2)}%. Restricting non-essential operations.`);
      this._warned95 = true;
    }
  }

  recordCacheHit() {
    this.cacheHits++;
  }

  recordCacheMiss() {
    this.cacheMisses++;
  }

  getStats() {
    const totalCacheRequests = this.cacheHits + this.cacheMisses;
    const hitRate = totalCacheRequests > 0 ? ((this.cacheHits / totalCacheRequests) * 100).toFixed(1) + '%' : '0.0%';

    return {
      period: this.currentPeriod,
      rowsRead: this.rowsRead,
      maxRowsRead: MAX_MONTHLY_ROWS_READ,
      readPercentage: Number(this.getReadPercentage().toFixed(3)),
      rowsWritten: this.rowsWritten,
      maxRowsWritten: MAX_MONTHLY_ROWS_WRITTEN,
      writePercentage: Number(this.getWritePercentage().toFixed(3)),
      queryCount: this.queryCount,
      maxRowsPerQuery: MAX_ROWS_PER_QUERY,
      tier: this.getTier(),
      tierDescription: this.getTierDescription(),
      recommendedCacheTTL: this.getRecommendedCacheTTL(),
      cache: {
        hits: this.cacheHits,
        misses: this.cacheMisses,
        hitRate
      },
      lastSync: new Date().toISOString()
    };
  }

  async init(client) {
    if (this.initialized) return;
    this.initialized = true;

    try {
      // 1. Ensure table and missing indexes exist
      await client.execute(`
        CREATE TABLE IF NOT EXISTS db_usage_metrics (
          period TEXT PRIMARY KEY,
          rows_read INTEGER DEFAULT 0,
          rows_written INTEGER DEFAULT 0,
          query_count INTEGER DEFAULT 0,
          updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )
      `);

      // Performance indexes on critical foreign keys and filter fields
      await client.execute(`CREATE INDEX IF NOT EXISTS idx_payments_booking_id ON booking_payments(booking_id)`);
      await client.execute(`CREATE INDEX IF NOT EXISTS idx_payments_date ON booking_payments(payment_date)`);
      await client.execute(`CREATE INDEX IF NOT EXISTS idx_expenses_date_hall ON expenses(date, hall)`);
      await client.execute(`CREATE INDEX IF NOT EXISTS idx_salary_staff_period ON staff_salary_payments(staff_id, period)`);
      await client.execute(`CREATE INDEX IF NOT EXISTS idx_audit_created ON audit_logs(created_at)`);
      await client.execute(`CREATE INDEX IF NOT EXISTS idx_bookings_date_hall ON bookings(check_in, hall)`);
      await client.execute(`CREATE INDEX IF NOT EXISTS idx_bookings_status ON bookings(status)`);

      // 2. Load metrics for current period
      const res = await client.execute({
        sql: `SELECT rows_read, rows_written, query_count FROM db_usage_metrics WHERE period = ?`,
        args: [this.currentPeriod]
      });

      if (res.rows && res.rows.length > 0) {
        const row = res.rows[0];
        this.rowsRead = parseInt(row.rows_read || 0, 10);
        this.rowsWritten = parseInt(row.rows_written || 0, 10);
        this.queryCount = parseInt(row.query_count || 0, 10);
      }

      console.log(`📊 [DB METRICS] Loaded usage for ${this.currentPeriod}: ${this.rowsRead.toLocaleString()} reads (${this.getReadPercentage().toFixed(2)}%), ${this.rowsWritten.toLocaleString()} writes. Tier: ${this.getTier()}`);

      // 3. Setup periodic flush every 60s
      this.syncInterval = setInterval(() => {
        this.flush(client).catch(err => console.error('Error syncing DB metrics:', err.message));
      }, 60000);
      if (this.syncInterval && this.syncInterval.unref) {
        this.syncInterval.unref();
      }

      // 4. Ensure process flush on exit
      const exitHandler = () => {
        this.flush(client).catch(() => {});
      };
      process.on('SIGINT', exitHandler);
      process.on('SIGTERM', exitHandler);
      process.on('beforeExit', exitHandler);
    } catch (err) {
      console.warn('⚠️ [DB METRICS] Table or index init skipped:', err.message);
    }
  }

  async flush(client) {
    if (!this.isDirty) return;
    try {
      this.isDirty = false;
      await client.execute({
        sql: `INSERT INTO db_usage_metrics (period, rows_read, rows_written, query_count, updated_at)
              VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)
              ON CONFLICT(period) DO UPDATE SET
                rows_read = excluded.rows_read,
                rows_written = excluded.rows_written,
                query_count = excluded.query_count,
                updated_at = CURRENT_TIMESTAMP`,
        args: [this.currentPeriod, this.rowsRead, this.rowsWritten, this.queryCount]
      });
    } catch (err) {
      this.isDirty = true; // retry on next tick
      console.warn('⚠️ [DB METRICS] Flush error:', err.message);
    }
  }
}

const dbMetrics = new DbMetricsManager();

module.exports = {
  dbMetrics,
  MAX_MONTHLY_ROWS_READ,
  MAX_MONTHLY_ROWS_WRITTEN,
  MAX_ROWS_PER_QUERY
};
