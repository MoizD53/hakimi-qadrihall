const db = require('../backend/db');

(async () => {
  try {
    // Measure 1: Ping / query
    const t0 = Date.now();
    await db.query('SELECT 1');
    const pingMs = Date.now() - t0;

    // Measure 2: Batched summary (single round trip for 4 queries)
    const t1 = Date.now();
    const batchRes = await db.batch([
      { sql: 'SELECT COUNT(*) FROM bookings', args: [] },
      { sql: 'SELECT COUNT(*) FROM expenses', args: [] },
      { sql: 'SELECT COUNT(*) FROM staff', args: [] },
      { sql: 'SELECT domain, version FROM app_revisions', args: [] }
    ], 'read');
    const batchMs = Date.now() - t1;

    // Measure 3: Sequential 4 queries (old approach)
    const t2 = Date.now();
    await db.query('SELECT COUNT(*) FROM bookings');
    await db.query('SELECT COUNT(*) FROM expenses');
    await db.query('SELECT COUNT(*) FROM staff');
    await db.query('SELECT domain, version FROM app_revisions');
    const seqMs = Date.now() - t2;

    // Measure 4: Revision bump
    const t3 = Date.now();
    await db.batch([
      {
        sql: `INSERT INTO app_revisions (domain, version, updated_at) VALUES ('global', 1, CURRENT_TIMESTAMP)
              ON CONFLICT(domain) DO UPDATE SET version = version + 1, updated_at = CURRENT_TIMESTAMP`,
        args: []
      }
    ], 'write');
    const bumpMs = Date.now() - t3;

    console.log(JSON.stringify({
      pingMs,
      batchMs,
      seqMs,
      bumpMs,
      reductionPct: Math.round(((seqMs - batchMs) / seqMs) * 100) + '%'
    }, null, 2));
    process.exit(0);
  } catch (err) {
    console.error('Measurement error:', err);
    process.exit(1);
  }
})();
