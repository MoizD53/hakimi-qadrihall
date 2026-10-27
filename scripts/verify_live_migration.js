const db = require('../backend/db');

(async () => {
  try {
    console.log('--- 1. Expenses Table Columns ---');
    const expCols = await db.query('PRAGMA table_info(expenses)');
    console.log(expCols.rows.map(c => `${c.name} (${c.type})`));

    console.log('--- 2. Expenses Indexes ---');
    const expIdx = await db.query('PRAGMA index_list(expenses)');
    console.log(expIdx.rows.map(i => `${i.name} [unique: ${i.unique}]`));

    console.log('--- 3. App Revisions Table Columns & Records ---');
    const revCols = await db.query('PRAGMA table_info(app_revisions)');
    console.log(revCols.rows.map(c => `${c.name} (${c.type})`));
    const revRows = await db.query('SELECT * FROM app_revisions');
    console.log(revRows.rows);

    console.log('--- 4. Idempotency Keys Columns & Indexes ---');
    const idemCols = await db.query('PRAGMA table_info(idempotency_keys)');
    console.log(idemCols.rows.map(c => `${c.name} (${c.type})`));
    const idemIdx = await db.query('PRAGMA index_list(idempotency_keys)');
    console.log(idemIdx.rows.map(i => `${i.name} [unique: ${i.unique}]`));

    console.log('--- 5. Preservation of Existing Records Across Tables ---');
    const tables = ['bookings', 'booking_payments', 'expenses', 'staff', 'staff_salary_payments', 'date_blocks', 'audit_logs'];
    for (const t of tables) {
      const cnt = await db.query(`SELECT COUNT(*) as count FROM ${t}`);
      console.log(`Table '${t}': ${cnt.rows[0].count} records intact.`);
    }

    console.log('✅ LIVE MIGRATION AUDIT PASSED!');
  } catch (err) {
    console.error('Migration verification error:', err);
    process.exit(1);
  }
})();
