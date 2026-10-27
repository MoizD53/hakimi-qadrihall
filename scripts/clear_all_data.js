const db = require('../backend/db');

(async () => {
  console.log('--- CLEARING ALL APPLICATION BUSINESS DATA ---');
  try {
    const tables = [
      'bookings',
      'booking_payments',
      'expenses',
      'staff',
      'staff_salary_payments',
      'date_blocks',
      'calendar_sync_outbox',
      'idempotency_keys',
      'audit_logs'
    ];

    console.log('\nRow counts before wipe:');
    for (const t of tables) {
      try {
        const cnt = await db.query(`SELECT COUNT(*) as count FROM ${t}`);
        console.log(`- ${t}: ${cnt.rows[0].count} rows`);
      } catch (err) {
        console.log(`- ${t}: (table does not exist or empty: ${err.message})`);
      }
    }

    console.log('\nDeleting all rows...');
    for (const t of tables) {
      try {
        await db.query(`DELETE FROM ${t}`);
        console.log(`✓ Cleared ${t}`);
      } catch (err) {
        console.warn(`! Could not clear ${t}:`, err.message);
      }
    }

    // Reset sqlite autoincrement sequence counters
    try {
      await db.query(`DELETE FROM sqlite_sequence WHERE name IN (${tables.map(t => `'${t}'`).join(',')})`);
      console.log('✓ Reset autoincrement sequences');
    } catch (_) {}

    // Reset app_revisions
    console.log('\nResetting app_revisions to version 1...');
    const defaultDomains = ['global', 'bookings', 'calendar_hakimi', 'calendar_qadri', 'expenses', 'staff', 'date_blocks'];
    for (const d of defaultDomains) {
      await db.query(
        `INSERT INTO app_revisions (domain, version, updated_at) VALUES (?, 1, CURRENT_TIMESTAMP)
         ON CONFLICT(domain) DO UPDATE SET version = 1, updated_at = CURRENT_TIMESTAMP`,
        [d]
      );
    }
    console.log('✓ Revisions reset to version 1');

    console.log('\nRow counts after wipe:');
    for (const t of tables) {
      const cnt = await db.query(`SELECT COUNT(*) as count FROM ${t}`);
      console.log(`- ${t}: ${cnt.rows[0].count} rows`);
    }

    console.log('\n🎉 ALL APPLICATION DATA SUCCESSFULLY REMOVED!');
    process.exit(0);
  } catch (err) {
    console.error('❌ Data wipe failed:', err);
    process.exit(1);
  }
})();
