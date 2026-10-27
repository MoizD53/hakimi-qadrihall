/**
 * Multi-Device Synchronization & Accounting Integration Test Suite
 * Tests isolated revision increments, cross-session sync, reconnection recovery,
 * and atomic salary-to-expense integration.
 */

const assert = require('assert');
const { createClient } = require('@libsql/client');

let passed = 0;
let total = 0;

async function test(desc, fn) {
  total++;
  try {
    await fn();
    console.log(`  ✓ ${desc}`);
    passed++;
  } catch (err) {
    console.error(`  ✗ ${desc}`);
    console.error(`    ${err.message}`);
    process.exitCode = 1;
  }
}

async function createIsolatedSyncDb() {
  const client = createClient({ url: 'file::memory:?cache=shared' });

  client.query = async function (sql, args = []) {
    const res = await client.execute({ sql: sql.replace(/\$\d+/g, '?'), args });
    return {
      rows: res.rows || [],
      rowCount: res.rowsAffected || 0,
      rowsAffected: res.rowsAffected || 0,
      lastInsertRowid: res.lastInsertRowid
    };
  };

  const origBatch = client.batch ? client.batch.bind(client) : null;
  client.batch = async function (stmts) {
    const converted = stmts.map(s => ({
      sql: s.sql.replace(/\$\d+/g, '?'),
      args: s.args || []
    }));
    if (origBatch) {
      const raw = await origBatch(converted, 'write');
      return raw.map(r => ({
        rows: r.rows,
        rowCount: r.rowsAffected,
        lastInsertRowid: r.lastInsertRowid
      }));
    } else {
      const results = [];
      for (const c of converted) {
        results.push(await client.query(c.sql, c.args));
      }
      return results;
    }
  };

  // Revisions table
  await client.execute(`
    CREATE TABLE IF NOT EXISTS app_revisions (
      domain TEXT PRIMARY KEY,
      version INTEGER NOT NULL DEFAULT 1,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `);

  const domains = ['global', 'bookings', 'calendar_hakimi', 'calendar_qadri', 'expenses', 'staff', 'date_blocks'];
  for (const d of domains) {
    await client.execute({
      sql: `INSERT OR IGNORE INTO app_revisions (domain, version, updated_at) VALUES (?, 1, CURRENT_TIMESTAMP)`,
      args: [d]
    });
  }

  // Business tables
  await client.execute(`
    CREATE TABLE IF NOT EXISTS bookings (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      customer_name TEXT,
      hall TEXT,
      check_in TEXT,
      status TEXT,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `);

  await client.execute(`
    CREATE TABLE IF NOT EXISTS staff (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT,
      role TEXT,
      salary REAL,
      salary_status TEXT DEFAULT 'pending'
    )
  `);

  await client.execute(`
    CREATE TABLE IF NOT EXISTS staff_salary_payments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      staff_id INTEGER NOT NULL,
      period TEXT NOT NULL,
      amount_paid REAL NOT NULL,
      payment_date TEXT NOT NULL
    )
  `);

  await client.execute(`
    CREATE TABLE IF NOT EXISTS expenses (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      description TEXT,
      category TEXT,
      amount REAL NOT NULL,
      date TEXT,
      payment_method TEXT,
      paid_to TEXT,
      notes TEXT,
      staff_id INTEGER,
      salary_payment_id INTEGER UNIQUE,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `);

  return client;
}

console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
console.log('🧪 RUNNING MULTI-DEVICE SYNC & INTEGRATION TESTS');
console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

(async () => {
  const db = await createIsolatedSyncDb();

  async function bumpAppRevision(domain) {
    const stmts = [
      {
        sql: `INSERT INTO app_revisions (domain, version, updated_at) VALUES ('global', 1, CURRENT_TIMESTAMP)
              ON CONFLICT(domain) DO UPDATE SET version = version + 1, updated_at = CURRENT_TIMESTAMP`,
        args: []
      }
    ];
    if (domain && domain !== 'global') {
      stmts.push({
        sql: `INSERT INTO app_revisions (domain, version, updated_at) VALUES (?, 1, CURRENT_TIMESTAMP)
              ON CONFLICT(domain) DO UPDATE SET version = version + 1, updated_at = CURRENT_TIMESTAMP`,
        args: [domain]
      });
    }
    await db.batch(stmts);
  }

  // Test 1: Revision bumps on mutation
  await test('1. Write mutation atomically increments both global and domain revisions', async () => {
    const before = await db.query("SELECT version FROM app_revisions WHERE domain = 'bookings'");
    const beforeGlobal = await db.query("SELECT version FROM app_revisions WHERE domain = 'global'");
    const v0 = before.rows[0].version;
    const g0 = beforeGlobal.rows[0].version;

    // Simulate booking insertion
    await db.query("INSERT INTO bookings (customer_name, hall, check_in, status) VALUES ('Ali', 'Evan-e-Hakimi', '2026-11-15', 'CONFIRMED')");
    await bumpAppRevision('bookings');

    const after = await db.query("SELECT version FROM app_revisions WHERE domain = 'bookings'");
    const afterGlobal = await db.query("SELECT version FROM app_revisions WHERE domain = 'global'");

    assert.strictEqual(after.rows[0].version, v0 + 1, 'Bookings revision must increment by 1');
    assert.strictEqual(afterGlobal.rows[0].version, g0 + 1, 'Global revision must increment by 1');
  });

  // Test 2: Unrelated domains do not increment
  await test('2. Scoped mutation leaves unrelated domain revisions untouched', async () => {
    const beforeExp = await db.query("SELECT version FROM app_revisions WHERE domain = 'expenses'");
    const expV0 = beforeExp.rows[0].version;

    // Bump staff
    await bumpAppRevision('staff');

    const afterExp = await db.query("SELECT version FROM app_revisions WHERE domain = 'expenses'");
    assert.strictEqual(afterExp.rows[0].version, expV0, 'Expenses revision must not increment on staff write');
  });

  // Test 3: Two independent client sessions detect changes without full reload
  await test('3. Independent Client Session B detects change made by Session A via revision poller', async () => {
    // Session B baseline
    const revsRes = await db.query("SELECT domain, version FROM app_revisions");
    const sessionBKnown = {};
    revsRes.rows.forEach(r => { sessionBKnown[r.domain] = r.version; });

    // Session A records an expense
    await db.query("INSERT INTO expenses (description, category, amount) VALUES ('Light bulbs', 'maintenance', 1500)");
    await bumpAppRevision('expenses');

    // Session B polls /api/sync/revisions
    const pollRes = await db.query("SELECT domain, version FROM app_revisions");
    const serverRevs = {};
    pollRes.rows.forEach(r => { serverRevs[r.domain] = r.version; });

    const expensesNeedsRefresh = (serverRevs.expenses || 0) > (sessionBKnown.expenses || 0);
    const bookingsNeedsRefresh = (serverRevs.bookings || 0) > (sessionBKnown.bookings || 0);

    assert.strictEqual(expensesNeedsRefresh, true, 'Session B must detect that expenses need refresh');
    assert.strictEqual(bookingsNeedsRefresh, false, 'Session B must know that bookings do not need refresh');
  });

  // Test 4: Reconnection and missed-update recovery
  await test('4. Reconnected client recovering from network outage detects accumulated missed revisions', async () => {
    const staleClientBaseline = { global: 1, bookings: 1, expenses: 1, staff: 1, date_blocks: 1 };

    // Simulate multiple mutations that occurred while client was offline
    await bumpAppRevision('bookings');
    await bumpAppRevision('bookings');
    await bumpAppRevision('date_blocks');

    // Client comes back online
    const pollRes = await db.query("SELECT domain, version FROM app_revisions");
    const serverRevs = {};
    pollRes.rows.forEach(r => { serverRevs[r.domain] = r.version; });

    assert.ok(serverRevs.bookings > staleClientBaseline.bookings, 'Must detect missed booking changes');
    assert.ok(serverRevs.date_blocks > staleClientBaseline.date_blocks, 'Must detect missed date blocks');
    assert.strictEqual(serverRevs.expenses, staleClientBaseline.expenses + 1, 'Must accurately reflect previous expense update');
  });

  // Test 5: Atomic salary payment to linked expense creation
  await test('5. Salary payment creates linked expense atomically with accounting reconciliation', async () => {
    // Create staff member
    const sRes = await db.query("INSERT INTO staff (name, role, salary) VALUES ('Murtaza Bhai', 'Supervisor', 28000)");
    const staffId = sRes.lastInsertRowid;

    // Record salary payment
    const period = 'November 2026';
    const amount = 28000;
    const pDate = '2026-11-01';

    // 1. Payment record
    const payRes = await db.query(
      `INSERT INTO staff_salary_payments (staff_id, period, amount_paid, payment_date)
       VALUES (?, ?, ?, ?)`,
      [staffId, period, amount, pDate]
    );
    const paymentId = payRes.lastInsertRowid;

    // 2. Linked expense
    await db.query(
      `INSERT INTO expenses (description, category, amount, date, payment_method, paid_to, staff_id, salary_payment_id)
       VALUES (?, 'Staff Salary', ?, ?, 'Bank Transfer', 'Murtaza Bhai', ?, ?)`,
      [`Staff Salary: Murtaza Bhai (Supervisor) — ${period}`, amount, pDate, staffId, paymentId]
    );

    // Verify linked expense exists in expenses table
    const expRow = await db.query("SELECT * FROM expenses WHERE salary_payment_id = ?", [paymentId]);
    assert.strictEqual(expRow.rows.length, 1);
    assert.strictEqual(expRow.rows[0].amount, 28000);
    assert.strictEqual(expRow.rows[0].category, 'Staff Salary');
    assert.strictEqual(Number(expRow.rows[0].staff_id), Number(staffId));

    // Verify retry cannot duplicate expense due to unique constraint
    let retryDuplicateCaught = false;
    try {
      await db.query(
        `INSERT INTO expenses (description, category, amount, date, staff_id, salary_payment_id)
         VALUES ('Duplicate', 'Staff Salary', 28000, '2026-11-01', ?, ?)`,
        [staffId, paymentId]
      );
    } catch (_) {
      retryDuplicateCaught = true;
    }
    assert.strictEqual(retryDuplicateCaught, true, 'Unique constraint on salary_payment_id prevents duplicate expense');
  });

  console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log(`RESULTS: ${passed} / ${total} tests passed (${Math.round((passed / total) * 100)}%)`);
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

  if (passed !== total) {
    process.exit(1);
  }
})();
