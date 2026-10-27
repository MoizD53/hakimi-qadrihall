const { createClient } = require('@libsql/client');
const { dbMetrics } = require('./dbMetrics');
const memoryCache = require('./cache');
const { AsyncLocalStorage } = require('async_hooks');
require('dotenv').config();

const url = process.env.TURSO_DATABASE_URL || 'file:local.db';
const authToken = process.env.TURSO_AUTH_TOKEN;

const client = createClient({
  url,
  authToken,
});

// Request-scoped performance tracker using AsyncLocalStorage
const perfStorage = new AsyncLocalStorage();

// Initialize database telemetry and indexes in the background
dbMetrics.init(client).catch(err => console.warn('dbMetrics init warning:', err.message));

async function checkInvalidation(sql) {
  if (!sql) return;
  const upper = String(sql).toUpperCase().trim();
  if (!upper.startsWith('INSERT') && !upper.startsWith('UPDATE') && !upper.startsWith('DELETE') && !upper.startsWith('REPLACE')) {
    return;
  }

  // Never invalidate cache or bump revisions for internal telemetry, audit logs, idempotency, or revisions
  if (upper.includes('DB_USAGE_METRICS') || upper.includes('AUDIT_LOGS') || upper.includes('CALENDAR_SYNC_OUTBOX') || upper.includes('IDEMPOTENCY_KEYS') || upper.includes('APP_REVISIONS')) {
    return;
  }

  // Domain-specific granular cache invalidation
  let domain = 'global';
  if (upper.includes('EXPENSES')) {
    domain = 'expenses';
    memoryCache.invalidateDomain('expenses');
  } else if (upper.includes('STAFF') || upper.includes('STAFF_SALARY_PAYMENTS')) {
    domain = 'staff';
    memoryCache.invalidateDomain('staff');
  } else if (upper.includes('DATE_BLOCKS')) {
    domain = 'date_blocks';
    memoryCache.invalidateDomain('bookings');
  } else if (upper.includes('BOOKINGS') || upper.includes('BOOKING_PAYMENTS')) {
    domain = 'bookings';
    memoryCache.invalidateDomain('bookings');
  } else {
    memoryCache.invalidateAll();
  }

  // Synchronous atomic revision bump for real-time multi-device sync
  try {
    await bumpRevision(domain);
  } catch (_) {}
}

async function bumpRevision(domain) {
  try {
    const stmts = [
      {
        sql: "INSERT INTO app_revisions (domain, version, updated_at) VALUES ('global', 1, CURRENT_TIMESTAMP) ON CONFLICT(domain) DO UPDATE SET version = version + 1, updated_at = CURRENT_TIMESTAMP",
        args: []
      }
    ];
    if (domain && domain !== 'global') {
      stmts.push({
        sql: "INSERT INTO app_revisions (domain, version, updated_at) VALUES (?, 1, CURRENT_TIMESTAMP) ON CONFLICT(domain) DO UPDATE SET version = version + 1, updated_at = CURRENT_TIMESTAMP",
        args: [domain]
      });
    }
    await client.batch(stmts, 'write');
  } catch (_) {
    // Non-blocking revision telemetry
  }
}

function recordQueryPerf(sql, durationMs, readCount, writeCount) {
  const store = perfStorage.getStore();
  if (store) {
    store.queryCount = (store.queryCount || 0) + 1;
    store.dbDurationMs = (store.dbDurationMs || 0) + durationMs;
    store.rowsRead = (store.rowsRead || 0) + readCount;
    store.rowsWritten = (store.rowsWritten || 0) + writeCount;
    if (store.queries) {
      store.queries.push({
        sql: sql.substring(0, 100),
        durationMs,
        readCount,
        writeCount
      });
    }
  }
}

// Query helper compatible with both libSQL and parameterized queries
client.query = async function (sqlOrObj, params = []) {
  const sql = typeof sqlOrObj === 'string' ? sqlOrObj : (sqlOrObj.text || sqlOrObj.sql);
  const args = Array.isArray(params) ? params : (sqlOrObj.values || sqlOrObj.args || []);

  // Budget & quota tier policy enforcement
  const check = dbMetrics.canExecute(sql);
  if (!check.allowed) {
    throw new Error(check.reason);
  }

  const convertedSql = sql.replace(/\$\d+/g, '?');
  const t0 = Date.now();
  const res = await client.execute({ sql: convertedSql, args });
  const dur = Date.now() - t0;

  const readCount = res.rows ? res.rows.length : 0;
  const writeCount = res.rowsAffected || 0;
  dbMetrics.recordOperation(sql, readCount, writeCount);
  recordQueryPerf(sql, dur, readCount, writeCount);

  if (writeCount > 0) {
    await checkInvalidation(sql);
  }

  return {
    rows: res.rows,
    rowCount: res.rowsAffected,
    lastInsertRowid: res.lastInsertRowid,
  };
};

// Fast atomic batch query pipeline (runs all queries in a single network round trip)
const origBatch = client.batch ? client.batch.bind(client) : null;
client.batch = async function (statements, mode = 'write') {
  if (!origBatch) {
    // Fallback for non-libSQL environments
    const results = [];
    for (const s of statements) {
      const q = typeof s === 'string' ? { sql: s, args: [] } : s;
      results.push(await client.query(q.sql, q.args || []));
    }
    return results;
  }

  const converted = statements.map(s => {
    const sql = typeof s === 'string' ? s : (s.text || s.sql);
    const args = Array.isArray(s.params) ? s.params : (s.values || s.args || []);
    const check = dbMetrics.canExecute(sql);
    if (!check.allowed) throw new Error(check.reason);
    return { sql: sql.replace(/\$\d+/g, '?'), args };
  });

  const t0 = Date.now();
  const rawResults = await origBatch(converted, mode);
  const dur = Date.now() - t0;

  let totalRead = 0;
  let totalWritten = 0;
  rawResults.forEach((res, i) => {
    const readCount = res.rows ? res.rows.length : 0;
    const writeCount = res.rowsAffected || 0;
    totalRead += readCount;
    totalWritten += writeCount;
    dbMetrics.recordOperation(converted[i].sql, readCount, writeCount);
    if (writeCount > 0) checkInvalidation(converted[i].sql);
  });

  recordQueryPerf(converted.map(c => c.sql).join('; '), dur, totalRead, totalWritten);

  return rawResults.map(res => ({
    rows: res.rows,
    rowCount: res.rowsAffected,
    lastInsertRowid: res.lastInsertRowid
  }));
};

// Wrap client.transaction to support tx.query alongside tx.execute
const origTx = client.transaction.bind(client);
client.transaction = async function (mode = 'write') {
  const tx = await origTx(mode);
  let hasMutation = false;

  tx.query = async function (sqlOrObj, params = []) {
    const sql = typeof sqlOrObj === 'string' ? sqlOrObj : (sqlOrObj.text || sqlOrObj.sql);
    const args = Array.isArray(params) ? params : (sqlOrObj.values || sqlOrObj.args || []);

    // Budget & quota tier policy enforcement
    const check = dbMetrics.canExecute(sql);
    if (!check.allowed) {
      throw new Error(check.reason);
    }

    const convertedSql = sql.replace(/\$\d+/g, '?');
    const t0 = Date.now();
    const res = await tx.execute({ sql: convertedSql, args });
    const dur = Date.now() - t0;

    const readCount = res.rows ? res.rows.length : 0;
    const writeCount = res.rowsAffected || 0;
    dbMetrics.recordOperation(sql, readCount, writeCount);
    recordQueryPerf(sql, dur, readCount, writeCount);

    if (writeCount > 0) {
      hasMutation = true;
      await checkInvalidation(sql);
    }

    return {
      rows: res.rows,
      rowCount: res.rowsAffected,
      lastInsertRowid: res.lastInsertRowid,
    };
  };

  const origCommit = tx.commit ? tx.commit.bind(tx) : null;
  if (origCommit) {
    tx.commit = async function () {
      const result = await origCommit();
      return result;
    };
  }

  return tx;
};

client.dbMetrics = dbMetrics;
client.perfStorage = perfStorage;

module.exports = client;
