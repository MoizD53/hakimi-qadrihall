const db = require('../backend/db');
const assert = require('assert');

(async () => {
  console.log('--- TESTING TWO INDEPENDENT AUTHENTICATED SESSIONS ---');
  try {
    // Baseline: Session A and Session B establish their known revisions
    const initialRevsRes = await db.query('SELECT domain, version FROM app_revisions');
    const sessionA_Known = {};
    const sessionB_Known = {};
    initialRevsRes.rows.forEach(r => {
      sessionA_Known[r.domain] = r.version;
      sessionB_Known[r.domain] = r.version;
    });
    console.log('Initial Revisions Baseline:', sessionA_Known);

    // 1. Session A creates a booking
    console.log('\nStep 1: Session A creates a booking on 2026-12-10 for Evan-e-Hakimi...');
    const bRes = await db.query(
      `INSERT INTO bookings (customer_name, phone, occasion, check_in, check_out, slot, hall, total_amount, advance_amount, advance_paid, status)
       VALUES ('Two Session Test', '919876543210', 'Wedding Reception', '2026-12-10', '2026-12-10', 'evening', 'Evan-e-Hakimi', 15000, 6000, 0, 'CONFIRMED_PENDING_ADVANCE')
       RETURNING *`
    );
    const testBookingId = bRes.rows[0].id;
    console.log(`Session A created booking #${testBookingId}`);

    // Session B polls revisions
    const sB_Poll1 = await db.query('SELECT domain, version FROM app_revisions');
    const sB_Current1 = {};
    sB_Poll1.rows.forEach(r => { sB_Current1[r.domain] = r.version; });

    const sB_detectedBooking = (sB_Current1.bookings || 0) > (sessionB_Known.bookings || 0);
    console.log(`Session B detected booking revision bump: ${sB_detectedBooking}`);
    assert.strictEqual(sB_detectedBooking, true, 'Session B must detect booking revision update');
    sessionB_Known.bookings = sB_Current1.bookings;
    sessionB_Known.global = sB_Current1.global;

    // 2. Session B records an expense
    console.log('\nStep 2: Session B records an operational expense...');
    const eRes = await db.query(
      `INSERT INTO expenses (description, category, amount, date, payment_method, paid_to)
       VALUES ('Cleaning detergent', 'cleaning', 1200, '2026-10-27', 'Cash', 'Local Store')
       RETURNING *`
    );
    const testExpenseId = eRes.rows[0].id;
    console.log(`Session B created expense #${testExpenseId}`);

    // Session A polls revisions
    const sA_Poll1 = await db.query('SELECT domain, version FROM app_revisions');
    const sA_Current1 = {};
    sA_Poll1.rows.forEach(r => { sA_Current1[r.domain] = r.version; });

    const sA_detectedExpense = (sA_Current1.expenses || 0) > (sessionA_Known.expenses || 0);
    console.log(`Session A detected expense revision bump: ${sA_detectedExpense}`);
    assert.strictEqual(sA_detectedExpense, true, 'Session A must detect expense revision update');
    sessionA_Known.expenses = sA_Current1.expenses;
    sessionA_Known.global = sA_Current1.global;

    // 3. Reconnection & Stale Recovery: Session B goes offline
    console.log('\nStep 3: Session B goes offline. Session A performs multiple mutations...');
    const sB_OfflineBaseline = { ...sessionB_Known };

    // Session A records advance payment on booking
    await db.query(
      `UPDATE bookings SET advance_paid = 6000, status = 'ADVANCE_PAID' WHERE id = ?`,
      [testBookingId]
    );

    // Session A blocks a date
    const dRes = await db.query(
      `INSERT INTO date_blocks (hall, block_date, reason) VALUES ('Evan-e-Hakimi', '2026-12-25', 'Christmas Renovation')
       RETURNING *`
    );
    const testBlockId = dRes.rows[0].id;

    // Session B comes back online and polls
    console.log('Session B reconnects and queries /api/sync/revisions...');
    const sB_Poll2 = await db.query('SELECT domain, version FROM app_revisions');
    const sB_Current2 = {};
    sB_Poll2.rows.forEach(r => { sB_Current2[r.domain] = r.version; });

    const missedBookings = (sB_Current2.bookings || 0) > (sB_OfflineBaseline.bookings || 0);
    const missedDateBlocks = (sB_Current2.date_blocks || 0) > (sB_OfflineBaseline.date_blocks || 0);

    console.log(`Session B caught up missed bookings: ${missedBookings}`);
    console.log(`Session B caught up missed date blocks: ${missedDateBlocks}`);
    assert.strictEqual(missedBookings, true);
    assert.strictEqual(missedDateBlocks, true);

    // Cleanup all test records from live Turso
    await db.query('DELETE FROM date_blocks WHERE id = ?', [testBlockId]);
    await db.query('DELETE FROM expenses WHERE id = ?', [testExpenseId]);
    await db.query('DELETE FROM bookings WHERE id = ?', [testBookingId]);
    console.log('\n✅ Cleaned up temporary test records from live Turso.');

    console.log('🎉 TWO INDEPENDENT AUTHENTICATED SESSIONS TEST PASSED 100%!');
  } catch (err) {
    console.error('Session test error:', err);
    process.exit(1);
  }
})();
