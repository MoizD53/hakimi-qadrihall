const { createClient } = require('@libsql/client');
require('dotenv').config();

const url = process.env.TURSO_DATABASE_URL || 'file:local.db';
const authToken = process.env.TURSO_AUTH_TOKEN;

const client = createClient({
  url,
  authToken,
});

// Query helper compatible with both libSQL and parameterized queries
client.query = async function (sqlOrObj, params = []) {
  const sql = typeof sqlOrObj === 'string' ? sqlOrObj : (sqlOrObj.text || sqlOrObj.sql);
  const args = Array.isArray(params) ? params : (sqlOrObj.values || sqlOrObj.args || []);
  const convertedSql = sql.replace(/\$\d+/g, '?');
  const res = await client.execute({ sql: convertedSql, args });
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
  tx.query = async function (sqlOrObj, params = []) {
    const sql = typeof sqlOrObj === 'string' ? sqlOrObj : (sqlOrObj.text || sqlOrObj.sql);
    const args = Array.isArray(params) ? params : (sqlOrObj.values || sqlOrObj.args || []);
    const convertedSql = sql.replace(/\$\d+/g, '?');
    const res = await tx.execute({ sql: convertedSql, args });
    return {
      rows: res.rows,
      rowCount: res.rowsAffected,
      lastInsertRowid: res.lastInsertRowid,
    };
  };
  return tx;
};

module.exports = client;