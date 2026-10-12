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
        guests INTEGER NOT NULL,
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
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    // 1.1 Safely ensure all columns exist (idempotent for existing SQLite / Turso databases)
    const tableInfo = await db.execute("PRAGMA table_info(bookings)");
    const existingCols = (tableInfo.rows || []).map(r => r.name);

    if (!existingCols.includes('advance_amount')) {
      console.log('Adding advance_amount column to bookings...');
      await db.execute("ALTER TABLE bookings ADD COLUMN advance_amount REAL DEFAULT 0");
    }
    if (!existingCols.includes('advance_paid')) {
      console.log('Adding advance_paid column to bookings...');
      await db.execute("ALTER TABLE bookings ADD COLUMN advance_paid REAL DEFAULT 0");
    }
    if (!existingCols.includes('advance_verified')) {
      console.log('Adding advance_verified column to bookings...');
      await db.execute("ALTER TABLE bookings ADD COLUMN advance_verified INTEGER DEFAULT 0");
    }
    if (!existingCols.includes('payment_status')) {
      console.log('Adding payment_status column to bookings...');
      await db.execute("ALTER TABLE bookings ADD COLUMN payment_status TEXT DEFAULT 'not_paid'");
    }
    if (!existingCols.includes('payment_notes')) {
      console.log('Adding payment_notes column to bookings...');
      await db.execute("ALTER TABLE bookings ADD COLUMN payment_notes TEXT");
    }
    if (!existingCols.includes('hall')) {
      console.log('Adding hall column to bookings...');
      await db.execute("ALTER TABLE bookings ADD COLUMN hall TEXT DEFAULT 'Evan-e-Hakimi'");
    }
    if (!existingCols.includes('package')) {
      console.log('Adding package column to bookings...');
      await db.execute("ALTER TABLE bookings ADD COLUMN package TEXT DEFAULT 'without_jaman'");
    }

    // Backfill any legacy records with null hall, package, or advance_amount
    await db.execute("UPDATE bookings SET hall = 'Evan-e-Hakimi' WHERE hall IS NULL OR hall = ''");
    await db.execute("UPDATE bookings SET package = 'without_jaman' WHERE package IS NULL OR package = ''");
    await db.execute("UPDATE bookings SET advance_amount = ROUND(total_amount * 0.40) WHERE advance_amount IS NULL OR advance_amount = 0");

    // 2. Create staff table
    console.log('Ensuring staff table exists...');
    await db.execute(`
      CREATE TABLE IF NOT EXISTS staff (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        role TEXT NOT NULL,
        salary REAL DEFAULT 0,
        salary_status TEXT DEFAULT 'pending',
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    // 3. Create expenses table
    console.log('Ensuring expenses table exists...');
    await db.execute(`
      CREATE TABLE IF NOT EXISTS expenses (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        category TEXT NOT NULL,
        amount REAL NOT NULL,
        date TEXT NOT NULL,
        status TEXT DEFAULT 'unpaid',
        notes TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

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
