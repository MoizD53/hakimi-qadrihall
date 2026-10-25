const { createClient } = require('@libsql/client');
const { dbMetrics } = require('./dbMetrics');
const memoryCache = require('./cache');
require('dotenv').config();

const url = process.env.TURSO_DATABASE_URL || 'file:local.db';
const authToken = process.env.TURSO_AUTH_TOKEN;

const client = createClient({
  url,
  authToken,
});

// Initialize database telemetry and indexes in the background
dbMetrics.init(client).catch(err => console.warn('dbMetrics init warning:', err.message));

function checkInvalidation(sql) {
  if (!sql) return;
  const upper = String(sql).toUpperCase().trim();
  if (upper.startsWith('INSERT') || upper.startsWith('UPDATE') || upper.startsWith('DELETE') || upper.startsWith('REPLACE')) {
    if (!upper.includes('DB_USAGE_METRICS')) {
      memoryCache.invalidateAll();
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
  const res = await client.execute({ sql: convertedSql, args });

  const readCount = res.rows ? res.rows.length : 0;
  const writeCount = res.rowsAffected || 0;
  dbMetrics.recordOperation(sql, readCount, writeCount);

  if (writeCount > 0) {
    checkInvalidation(sql);
  }

  return {
    rows: res.rows,
    rowCount: res.rowsAffected,
    lastInsertRowid: res.lastInsertRowid,
  };
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
    const res = await tx.execute({ sql: convertedSql, args });

    const readCount = res.rows ? res.rows.length : 0;
    const writeCount = res.rowsAffected || 0;
    dbMetrics.recordOperation(sql, readCount, writeCount);

    if (writeCount > 0) {
      hasMutation = true;
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
      if (hasMutation) {
        memoryCache.invalidateAll();
      }
      return result;
    };
  }

  return tx;
};

client.dbMetrics = dbMetrics;

module.exports = client;
