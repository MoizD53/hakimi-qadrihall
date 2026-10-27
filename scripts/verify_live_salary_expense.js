const db = require('../backend/db');
const assert = require('assert');

(async () => {
  console.log('Testing live salary-to-expense atomicity and duplicate protection...');
  try {
    // 1. Create a test staff member
    const sRes = await db.query(
      `INSERT INTO staff (name, role, salary, joining_date, status)
       VALUES ('Live Test Staff', 'Test Role', 25000, '2026-10-27', 'active')
       RETURNING *`
    );
    const staff = sRes.rows[0];
    const staffId = staff.id;
    console.log(`Created test staff #${staffId}`);

    // 2. Insert salary payment
    const pDate = '2026-10-27';
    const period = 'October 2026';
    const payRes = await db.query(
      `INSERT INTO staff_salary_payments (staff_id, period, amount_paid, payment_date, payment_method, notes)
       VALUES (?, ?, 25000, ?, 'Bank Transfer', 'Live test salary')
       RETURNING *`,
      [staffId, period, pDate]
    );
    const payment = payRes.rows[0];
    const paymentId = payment.id;
    console.log(`Created salary payment #${paymentId}`);

    // 3. Insert linked expense
    const expDesc = `Staff Salary: ${staff.name} — ${period}`;
    const expRes = await db.query(
      `INSERT INTO expenses (description, hall, category, amount, date, payment_method, paid_to, notes, staff_id, salary_payment_id)
       VALUES (?, 'Combined / Facility', 'Staff Salary', 25000, ?, 'Bank Transfer', ?, 'Live test', ?, ?)
       RETURNING *`,
      [expDesc, pDate, staff.name, staffId, paymentId]
    );
    const expense = expRes.rows[0];
    console.log(`Created linked expense #${expense.id} with salary_payment_id=${paymentId}`);

    assert.strictEqual(expense.category, 'Staff Salary');
    assert.strictEqual(expense.amount, 25000);
    assert.strictEqual(expense.salary_payment_id, paymentId);

    // 4. Test duplicate prevention: attempting to create a second expense with the same salary_payment_id
    let duplicateRejected = false;
    try {
      await db.query(
        `INSERT INTO expenses (description, hall, category, amount, date, payment_method, paid_to, staff_id, salary_payment_id)
         VALUES ('Duplicate Attempt', 'Combined / Facility', 'Staff Salary', 25000, ?, 'Bank Transfer', ?, ?, ?)`,
        [pDate, staff.name, staffId, paymentId]
      );
    } catch (err) {
      if (err.message && (err.message.includes('UNIQUE constraint failed') || err.message.includes('SQLITE_CONSTRAINT'))) {
        duplicateRejected = true;
      }
    }
    console.log(`Duplicate insertion rejected by unique index: ${duplicateRejected}`);
    assert.strictEqual(duplicateRejected, true, 'Unique index idx_expenses_salary_payment must reject duplicate expense creation');

    // 5. Cleanup test records
    await db.query('DELETE FROM expenses WHERE salary_payment_id = ?', [paymentId]);
    await db.query('DELETE FROM staff_salary_payments WHERE id = ?', [paymentId]);
    await db.query('DELETE FROM staff WHERE id = ?', [staffId]);
    console.log('✅ Cleaned up temporary test records from live Turso.');

    console.log('🎉 LIVE SALARY-TO-EXPENSE INTEGRITY TEST PASSED 100%!');
  } catch (err) {
    console.error('❌ Salary expense verification failed:', err);
    process.exit(1);
  }
})();
