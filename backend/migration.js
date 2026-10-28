const db = require('./db');

async function migrate() {
  try {
    console.log('🔄 Starting Turso (libSQL) database migration...');

    // 1. Create bookings table if it doesn't exist
    console.log('Ensuring bookings table exists...');
    await db.execute(`
      CREATE TABLE IF NOT EXISTS bookings (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        customer_name TEXT NOT NULL,
        phone TEXT NOT NULL,
        email TEXT,
        check_in TEXT NOT NULL,
        check_out TEXT NOT NULL,
        guests INTEGER DEFAULT 0,
        total_amount REAL NOT NULL,
        occasion TEXT,
        notes TEXT,
        slot TEXT,
        status TEXT DEFAULT 'pending',
        hall TEXT DEFAULT 'Evan-e-Hakimi',
        package TEXT DEFAULT 'without_jaman',
        advance_amount REAL DEFAULT 0,
        advance_paid REAL DEFAULT 0,
        advance_verified INTEGER DEFAULT 0,
        payment_status TEXT DEFAULT 'not_paid',
        payment_notes TEXT,
        payment_method TEXT DEFAULT 'UPI',
        balance_amount REAL DEFAULT 0,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP
      )
    `);

    // 1.1 Safely ensure all columns exist on bookings table
    const bookingsInfo = await db.execute("PRAGMA table_info(bookings)");
    const existingBookingCols = (bookingsInfo.rows || []).map(r => r.name);

    const bookingColsToAdd = [
      { name: 'advance_amount', def: 'REAL DEFAULT 0' },
      { name: 'advance_paid', def: 'REAL DEFAULT 0' },
      { name: 'advance_verified', def: 'INTEGER DEFAULT 0' },
      { name: 'payment_status', def: "TEXT DEFAULT 'not_paid'" },
      { name: 'payment_notes', def: 'TEXT' },
      { name: 'payment_method', def: "TEXT DEFAULT 'UPI'" },
      { name: 'balance_amount', def: 'REAL DEFAULT 0' },
      { name: 'hall', def: "TEXT DEFAULT 'Evan-e-Hakimi'" },
      { name: 'package', def: "TEXT DEFAULT 'without_jaman'" },
      { name: 'booking_reference', def: 'TEXT' },
      { name: 'rejection_reason', def: 'TEXT' },
      { name: 'confirmed_at', def: 'TIMESTAMP' },
      { name: 'rejected_at', def: 'TIMESTAMP' },
      { name: 'updated_at', def: 'TIMESTAMP' },
      { name: 'start_time', def: 'TEXT' },
      { name: 'end_time', def: 'TEXT' },
      { name: 'cancellation_reason', def: 'TEXT' },
      { name: 'cancelled_at', def: 'TIMESTAMP' },
      { name: 'cancelled_by', def: 'TEXT' },
      { name: 'refund_status', def: "TEXT DEFAULT 'none'" },
      { name: 'refund_amount', def: 'REAL DEFAULT 0' },
      { name: 'created_by', def: "TEXT DEFAULT 'admin'" }
    ];

    for (const col of bookingColsToAdd) {
      if (!existingBookingCols.includes(col.name)) {
        console.log(`Adding ${col.name} column to bookings...`);
        await db.execute(`ALTER TABLE bookings ADD COLUMN ${col.name} ${col.def}`);
      }
    }

    // Backfill legacy records
    await db.execute("UPDATE bookings SET hall = 'Evan-e-Hakimi' WHERE hall IS NULL OR hall = ''");
    await db.execute("UPDATE bookings SET package = 'without_jaman' WHERE package IS NULL OR package = ''");
    await db.execute("UPDATE bookings SET advance_amount = ROUND(total_amount * 0.40) WHERE advance_amount IS NULL OR advance_amount = 0");
    await db.execute("UPDATE bookings SET balance_amount = ROUND(total_amount - COALESCE(advance_paid, 0)) WHERE balance_amount IS NULL OR balance_amount = 0");
    await db.execute("UPDATE bookings SET booking_reference = printf('EH-2026-%04d', id) WHERE (booking_reference IS NULL OR booking_reference = '') AND (status IN ('confirmed', 'advance_verified', 'CONFIRMED_PENDING_ADVANCE', 'ADVANCE_PAID', 'FULLY_PAID'))");

    // 2. Create / Expand staff table
    console.log('Ensuring staff table exists...');
    await db.execute(`
      CREATE TABLE IF NOT EXISTS staff (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        role TEXT NOT NULL,
        salary REAL DEFAULT 0,
        salary_status TEXT DEFAULT 'pending',
        phone TEXT,
        joining_date TEXT,
        status TEXT DEFAULT 'active',
        notes TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP
      )
    `);

    const staffInfo = await db.execute("PRAGMA table_info(staff)");
    const existingStaffCols = (staffInfo.rows || []).map(r => r.name);
    const staffColsToAdd = [
      { name: 'phone', def: 'TEXT' },
      { name: 'joining_date', def: 'TEXT' },
      { name: 'status', def: "TEXT DEFAULT 'active'" },
      { name: 'notes', def: 'TEXT' },
      { name: 'updated_at', def: 'TIMESTAMP' }
    ];

    for (const col of staffColsToAdd) {
      if (!existingStaffCols.includes(col.name)) {
        console.log(`Adding ${col.name} column to staff...`);
        await db.execute(`ALTER TABLE staff ADD COLUMN ${col.name} ${col.def}`);
      }
    }

    // 3. Create / Expand expenses table
    console.log('Ensuring expenses table exists...');
    await db.execute(`
      CREATE TABLE IF NOT EXISTS expenses (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        description TEXT,
        category TEXT NOT NULL,
        amount REAL NOT NULL,
        date TEXT NOT NULL,
        payment_method TEXT DEFAULT 'Cash',
        paid_to TEXT,
        status TEXT DEFAULT 'paid',
        notes TEXT,
        hall TEXT DEFAULT 'Evan-e-Hakimi',
        receipt_url TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP
      )
    `);

    const expensesInfo = await db.execute("PRAGMA table_info(expenses)");
    const existingExpenseCols = (expensesInfo.rows || []).map(r => r.name);
    const expenseColsToAdd = [
      { name: 'description', def: 'TEXT' },
      { name: 'payment_method', def: "TEXT DEFAULT 'Cash'" },
      { name: 'paid_to', def: 'TEXT' },
      { name: 'hall', def: "TEXT DEFAULT 'Evan-e-Hakimi'" },
      { name: 'receipt_url', def: 'TEXT' },
      { name: 'staff_id', def: 'INTEGER' },
      { name: 'salary_payment_id', def: 'INTEGER' },
      { name: 'updated_at', def: 'TIMESTAMP' }
    ];

    for (const col of expenseColsToAdd) {
      if (!existingExpenseCols.includes(col.name)) {
        console.log(`Adding ${col.name} column to expenses...`);
        await db.execute(`ALTER TABLE expenses ADD COLUMN ${col.name} ${col.def}`);
      }
    }

    await db.execute("UPDATE expenses SET hall = 'Evan-e-Hakimi' WHERE hall IS NULL OR hall = ''");
    await db.execute(`CREATE UNIQUE INDEX IF NOT EXISTS idx_expenses_salary_payment ON expenses(salary_payment_id) WHERE salary_payment_id IS NOT NULL`);

    // 4. Create staff_salary_payments table
    console.log('Ensuring staff_salary_payments table exists...');
    await db.execute(`
      CREATE TABLE IF NOT EXISTS staff_salary_payments (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        staff_id INTEGER NOT NULL,
        period TEXT NOT NULL,
        amount_paid REAL NOT NULL,
        payment_date TEXT NOT NULL,
        payment_method TEXT DEFAULT 'Cash',
        notes TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    // 5. Create booking_payments table
    console.log('Ensuring booking_payments table exists...');
    await db.execute(`
      CREATE TABLE IF NOT EXISTS booking_payments (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        booking_id INTEGER NOT NULL,
        amount REAL NOT NULL,
        payment_type TEXT DEFAULT 'advance',
        payment_method TEXT DEFAULT 'UPI',
        payment_date TEXT NOT NULL,
        notes TEXT,
        created_by TEXT DEFAULT 'admin',
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    const bpInfo = await db.execute("PRAGMA table_info(booking_payments)");
    const existingBpCols = (bpInfo.rows || []).map(r => r.name);
    if (!existingBpCols.includes('created_by')) {
      console.log('Adding created_by column to booking_payments...');
      await db.execute("ALTER TABLE booking_payments ADD COLUMN created_by TEXT DEFAULT 'admin'");
    }

    // 6. Create audit_logs table
    console.log('Ensuring audit_logs table exists...');
    await db.execute(`
      CREATE TABLE IF NOT EXISTS audit_logs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        action TEXT NOT NULL,
        entity_type TEXT NOT NULL,
        entity_id INTEGER,
        details TEXT,
        user TEXT DEFAULT 'admin',
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    
    await db.execute('CREATE INDEX IF NOT EXISTS idx_audit_created ON audit_logs(created_at)');
    await db.execute('CREATE INDEX IF NOT EXISTS idx_expenses_date_hall ON expenses(date, hall)');
    await db.execute('CREATE INDEX IF NOT EXISTS idx_payments_booking_id ON booking_payments(booking_id)');
    await db.execute('CREATE INDEX IF NOT EXISTS idx_payments_date ON booking_payments(payment_date)');
    await db.execute('CREATE INDEX IF NOT EXISTS idx_salary_staff_period ON staff_salary_payments(staff_id, period)');
    await db.execute('CREATE INDEX IF NOT EXISTS idx_salary_payment_date ON staff_salary_payments(payment_date)');

    // 7. Create date_blocks table for admin full-day blocking
    console.log('Ensuring date_blocks table exists...');
    await db.execute(`
      CREATE TABLE IF NOT EXISTS date_blocks (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        hall TEXT NOT NULL,
        block_date TEXT NOT NULL,
        reason TEXT,
        created_by TEXT DEFAULT 'admin',
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);
    await db.execute(`CREATE UNIQUE INDEX IF NOT EXISTS idx_date_blocks_hall_date ON date_blocks(hall, block_date)`);
    await db.execute(`CREATE INDEX IF NOT EXISTS idx_bookings_date_hall ON bookings(check_in, hall)`);
    await db.execute(`CREATE INDEX IF NOT EXISTS idx_bookings_status ON bookings(status)`);
    await db.execute(`CREATE INDEX IF NOT EXISTS idx_bookings_hall_checkin ON bookings(hall, check_in)`);
    await db.execute(`CREATE INDEX IF NOT EXISTS idx_bookings_checkin_status ON bookings(check_in, status)`);

    // 8. Create calendar_sync_outbox table for asynchronous durable calendar sync jobs
    console.log('Ensuring calendar_sync_outbox table exists...');
    await db.execute(`
      CREATE TABLE IF NOT EXISTS calendar_sync_outbox (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        booking_id INTEGER NOT NULL,
        hall TEXT NOT NULL,
        event_date TEXT NOT NULL,
        slot TEXT NOT NULL,
        action TEXT NOT NULL,
        status TEXT DEFAULT 'pending',
        attempts INTEGER DEFAULT 0,
        last_attempt TIMESTAMP,
        last_error TEXT,
        synced_at TIMESTAMP,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);
    await db.execute(`CREATE INDEX IF NOT EXISTS idx_sync_outbox_status ON calendar_sync_outbox(status)`);
    await db.execute(`CREATE INDEX IF NOT EXISTS idx_sync_outbox_booking ON calendar_sync_outbox(booking_id)`);

    // 9. Create app_revisions table for real-time cross-device synchronization
    console.log('Ensuring app_revisions table exists...');
    await db.execute(`
      CREATE TABLE IF NOT EXISTS app_revisions (
        domain TEXT PRIMARY KEY,
        version INTEGER NOT NULL DEFAULT 1,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    const defaultDomains = ['global', 'bookings', 'calendar_hakimi', 'calendar_qadri', 'expenses', 'staff', 'date_blocks'];
    for (const d of defaultDomains) {
      await db.execute({
        sql: `INSERT OR IGNORE INTO app_revisions (domain, version, updated_at) VALUES (?, 1, CURRENT_TIMESTAMP)`,
        args: [d]
      });
    }

    // 10. Create idempotency_keys table for bulletproof server-side duplicate prevention
    console.log('Ensuring idempotency_keys table exists...');
    await db.execute(`
      CREATE TABLE IF NOT EXISTS idempotency_keys (
        key TEXT PRIMARY KEY,
        user_id TEXT,
        method TEXT NOT NULL,
        path TEXT NOT NULL,
        request_hash TEXT,
        status TEXT DEFAULT 'PROCESSING',
        status_code INTEGER,
        response_body TEXT,
        locked_until TIMESTAMP,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    // Dynamically ensure new columns exist if table was previously created
    const existingIdemColsRes = await db.execute("PRAGMA table_info(idempotency_keys)");
    const existingIdemColNames = existingIdemColsRes.rows.map(r => r.name);
    const idemColsToAdd = [
      { name: 'user_id', def: 'TEXT' },
      { name: 'request_hash', def: 'TEXT' },
      { name: 'status', def: "TEXT DEFAULT 'PROCESSING'" }
    ];
    for (const c of idemColsToAdd) {
      if (!existingIdemColNames.includes(c.name)) {
        await db.execute(`ALTER TABLE idempotency_keys ADD COLUMN ${c.name} ${c.def}`);
      }
    }
    await db.execute(`CREATE INDEX IF NOT EXISTS idx_idempotency_created ON idempotency_keys(created_at)`);

    console.log('✅ Turso migration completed successfully!');
  } catch (err) {
    console.error('❌ Turso migration failed:', err);
    process.exitCode = 1;
  }
}

if (require.main === module) {
  migrate();
}

module.exports = { migrate };
