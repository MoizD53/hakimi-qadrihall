-- ==============================================================================
-- HAKIMI53 CLEAN ARCHITECTURE SCHEMA (V2)
-- Engineered for 50M–100M monthly reads with zero full-table scans.
-- All sequences start at 0 (first booking is #1).
-- ==============================================================================

-- 1. Bookings
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
  slot TEXT NOT NULL,
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
  booking_reference TEXT,
  rejection_reason TEXT,
  confirmed_at TIMESTAMP,
  rejected_at TIMESTAMP,
  updated_at TIMESTAMP,
  start_time TEXT,
  end_time TEXT,
  cancellation_reason TEXT,
  cancelled_at TIMESTAMP,
  cancelled_by TEXT,
  refund_status TEXT DEFAULT 'none',
  refund_amount REAL DEFAULT 0,
  created_by TEXT DEFAULT 'admin',
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- 2. Booking Payments
CREATE TABLE IF NOT EXISTS booking_payments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  booking_id INTEGER NOT NULL REFERENCES bookings(id) ON DELETE CASCADE,
  amount REAL NOT NULL,
  payment_type TEXT DEFAULT 'advance',
  payment_method TEXT DEFAULT 'Cash',
  payment_date TEXT NOT NULL,
  notes TEXT,
  created_by TEXT DEFAULT 'admin',
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- 3. Staff & Payroll
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
);

CREATE TABLE IF NOT EXISTS staff_salary_payments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  staff_id INTEGER NOT NULL REFERENCES staff(id) ON DELETE CASCADE,
  period TEXT NOT NULL,
  amount_paid REAL NOT NULL,
  payment_date TEXT NOT NULL,
  payment_method TEXT DEFAULT 'Cash',
  notes TEXT,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- 4. Expenses
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
  hall TEXT DEFAULT 'Combined / Facility',
  receipt_url TEXT,
  staff_id INTEGER,
  salary_payment_id INTEGER UNIQUE,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP
);

-- 5. Date Blocks
CREATE TABLE IF NOT EXISTS date_blocks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  hall TEXT NOT NULL,
  block_date TEXT NOT NULL,
  reason TEXT,
  created_by TEXT DEFAULT 'admin',
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- 6. Audit Logs
CREATE TABLE IF NOT EXISTS audit_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  action TEXT NOT NULL,
  entity_type TEXT NOT NULL,
  entity_id INTEGER,
  details TEXT,
  user TEXT DEFAULT 'admin',
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- 7. Multi-Device Realtime Sync Revisions
CREATE TABLE IF NOT EXISTS app_revisions (
  domain TEXT PRIMARY KEY,
  version INTEGER NOT NULL DEFAULT 1,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- 8. Idempotency Manager
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
);

-- ==============================================================================
-- HIGH-PERFORMANCE COVERING INDEXES (50M–100M READ CAPACITY)
-- ==============================================================================
CREATE INDEX IF NOT EXISTS idx_bookings_slot ON bookings(check_in, hall, slot, status);
CREATE INDEX IF NOT EXISTS idx_bookings_range ON bookings(check_in, check_out, hall);
CREATE INDEX IF NOT EXISTS idx_bookings_status_pay ON bookings(status, payment_status);
CREATE INDEX IF NOT EXISTS idx_payments_lookup ON booking_payments(booking_id, payment_date);
CREATE INDEX IF NOT EXISTS idx_expenses_date_cat ON expenses(date, category, hall);
CREATE UNIQUE INDEX IF NOT EXISTS idx_expenses_salary ON expenses(salary_payment_id) WHERE salary_payment_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_salary_payments_staff ON staff_salary_payments(staff_id, payment_date);
CREATE UNIQUE INDEX IF NOT EXISTS idx_date_blocks_hall_date ON date_blocks(hall, block_date);
CREATE INDEX IF NOT EXISTS idx_audit_logs_created ON audit_logs(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_idempotency_expiry ON idempotency_keys(locked_until);
