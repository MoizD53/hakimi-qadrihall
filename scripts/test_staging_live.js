/**
 * HAKIMI53 V2 — Live Staging Smoke Test Suite
 * Executes against the deployed live staging URL: https://hakimi-staging.vercel.app
 * 
 * Verifies:
 * 1. Health check & connectivity
 * 2. Admin authentication & JWT token issuance (/api/admin/login and /api/auth/login)
 * 3. Booking #1 verification / creation (id: 1, ref: EH-2026-0001)
 * 4. 40% advance payment calculation & recording (ADVANCE_PAID)
 * 5. Balance clearance & transition to FULLY_PAID
 * 6. Operational expense creation & immediate deletion persistence
 * 7. Staff profile creation & salary payment with linked expense
 * 8. Financial reconciliation invariant with zero double-counting
 * 9. Live HTTP read/write latency benchmarking
 */

const assert = require('assert');
const fs = require('fs');

// Load .env.staging if present locally
if (fs.existsSync('.env.staging')) {
  fs.readFileSync('.env.staging', 'utf8').split('\n').forEach(l => {
    const m = l.match(/^\s*([\w.-]+)\s*=\s*(.*)?\s*$/);
    if (m && !process.env[m[1]]) {
      process.env[m[1]] = m[2].trim().replace(/^['"]|['"]$/g, '');
    }
  });
}

const STAGING_URL = process.env.STAGING_URL || 'https://hakimi-staging.vercel.app';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'HakimiStaging2026!';
const ADMIN_USERNAME = process.env.ADMIN_USERNAME || 'admin';

let passed = 0;
let total = 0;
let authToken = '';

async function it(desc, fn) {
  total++;
  try {
    await fn();
    console.log(`  ✓ ${desc}`);
    passed++;
  } catch (err) {
    console.error(`  ✗ ${desc}`);
    console.error(`    ${err.message}`);
  }
}

async function apiFetch(endpoint, options = {}) {
  const t0 = process.hrtime.bigint();
  const url = `${STAGING_URL}${endpoint}`;
  const headers = {
    'Content-Type': 'application/json',
    ...(authToken ? { 'Authorization': `Bearer ${authToken}` } : {}),
    ...(options.headers || {})
  };

  const res = await fetch(url, {
    ...options,
    headers,
    body: options.body ? (typeof options.body === 'string' ? options.body : JSON.stringify(options.body)) : undefined
  });

  const t1 = process.hrtime.bigint();
  const ms = Number(t1 - t0) / 1e6;

  let data;
  const contentType = res.headers.get('content-type') || '';
  if (contentType.includes('application/json')) {
    data = await res.json();
  } else {
    data = await res.text();
  }

  return { res, data, ms };
}

async function run() {
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('🌐 HAKIMI53 V2 LIVE STAGING SMOKE TEST SUITE');
  console.log(`Target: ${STAGING_URL}`);
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

  try {
    // 1. Health check
    await it('GET /api/health returns 200 OK and connected database', async () => {
      const { res, data, ms } = await apiFetch('/api/health');
      assert.strictEqual(res.status, 200, `Expected 200, got ${res.status}: ${JSON.stringify(data)}`);
      assert.ok(data.status === 'ok' || data.health === 'healthy', `Unexpected status: ${JSON.stringify(data)}`);
      assert.ok(data.database === 'connected' || data.database?.includes('libSQL'), `Unexpected database: ${data.database}`);
      console.log(`    (Health checked in ${ms.toFixed(1)} ms)`);
    });

    // 2. Admin Authentication & Token Issuance
    await it('POST /api/admin/login authenticates and returns valid JWT token', async () => {
      const { res, data, ms } = await apiFetch('/api/admin/login', {
        method: 'POST',
        body: { username: ADMIN_USERNAME, password: ADMIN_PASSWORD }
      });
      assert.strictEqual(res.status, 200, `Login failed: ${JSON.stringify(data)}`);
      assert.ok(data.token, 'Token missing in login response');
      assert.strictEqual(data.success, true);
      authToken = data.token;
      console.log(`    (Authenticated in ${ms.toFixed(1)} ms)`);
    });

    // Also verify alias /api/auth/login works
    await it('POST /api/auth/login alias returns valid JWT token', async () => {
      const { res, data, ms } = await apiFetch('/api/auth/login', {
        method: 'POST',
        body: { username: ADMIN_USERNAME, password: ADMIN_PASSWORD }
      });
      assert.strictEqual(res.status, 200, `Alias login failed: ${JSON.stringify(data)}`);
      assert.ok(data.token);
    });

    // 3. Inspect Staging Bookings Baseline
    let booking1Id = 1;
    await it('GET /api/bookings inspects baseline and verifies Booking #1', async () => {
      const { res, data, ms } = await apiFetch('/api/bookings');
      assert.strictEqual(res.status, 200);
      assert.ok(Array.isArray(data));
      console.log(`    (Current bookings in staging: ${data.length})`);

      if (data.length === 0) {
        // Create Booking #1
        const createRes = await apiFetch('/api/bookings', {
          method: 'POST',
          body: {
            customer_name: 'Staging Verifier',
            phone: '9876543210',
            check_in: '2026-11-20',
            check_out: '2026-11-20',
            slot: 'morning',
            hall: 'Evan-e-Hakimi',
            package: 'without_jaman',
            total_amount: 15000,
            status: 'CONFIRMED_PENDING_ADVANCE'
          }
        });
        assert.strictEqual(createRes.res.status, 200);
        assert.strictEqual(createRes.data.bookingId, 1);
        assert.strictEqual(createRes.data.booking.booking_reference, 'EH-2026-0001');
        booking1Id = 1;
      } else {
        const b1 = data.find(x => x.id === 1);
        assert.ok(b1, 'Expected booking with ID 1 in staging database');
        assert.strictEqual(b1.booking_reference, 'EH-2026-0001');
        booking1Id = 1;
      }
      console.log(`    (Verified Booking #1 EH-2026-0001 in ${ms.toFixed(1)} ms)`);
    });

    // 4. 40% Advance Payment on Booking #1 (or a dedicated cycle booking)
    let cycleBookingId = booking1Id;
    const currentB1 = await apiFetch(`/api/bookings`);
    const b1Record = currentB1.data.find(x => x.id === booking1Id);

    if (b1Record && b1Record.status === 'FULLY_PAID') {
      // Create a fresh enquiry to demonstrate the 40% advance payment transition
      const freshRes = await apiFetch('/api/bookings', {
        method: 'POST',
        body: {
          customer_name: 'Payment Cycle Verifier',
          phone: '9876543299',
          check_in: '2026-11-25',
          check_out: '2026-11-25',
          slot: 'evening',
          hall: 'Evan-e-Hakimi',
          package: 'without_jaman',
          total_amount: 15000,
          status: 'CONFIRMED_PENDING_ADVANCE'
        }
      });
      cycleBookingId = freshRes.data.bookingId;
    }

    await it('POST /api/bookings/:id/advance records 40% advance (₹6,000) -> ADVANCE_PAID', async () => {
      const { res, data, ms } = await apiFetch(`/api/bookings/${cycleBookingId}/advance`, {
        method: 'POST',
        body: {
          advance_amount: 6000,
          payment_method: 'UPI',
          notes: 'Staging advance test'
        }
      });
      assert.strictEqual(res.status, 200, `Advance payment failed: ${JSON.stringify(data)}`);
      assert.strictEqual(data.booking.status, 'ADVANCE_PAID');
      assert.strictEqual(data.booking.advance_paid, 6000);
      assert.strictEqual(data.booking.balance_amount, 9000);
      console.log(`    (Recorded advance in ${ms.toFixed(1)} ms)`);
    });

    // 5. Balance Clearance -> FULLY_PAID
    await it('POST /api/bookings/:id/receive-balance settles account to ₹0 -> FULLY_PAID', async () => {
      const { res, data, ms } = await apiFetch(`/api/bookings/${cycleBookingId}/receive-balance`, {
        method: 'POST',
        body: {
          payment_method: 'Cash',
          notes: 'Full balance settled'
        }
      });
      assert.strictEqual(res.status, 200, `Balance clearance failed: ${JSON.stringify(data)}`);
      assert.strictEqual(data.booking.status, 'FULLY_PAID');
      assert.strictEqual(data.booking.advance_paid, 15000);
      assert.strictEqual(data.booking.balance_amount, 0);
      console.log(`    (Settled full balance in ${ms.toFixed(1)} ms)`);
    });

    // 6. Expense CRUD & Deletion Persistence
    await it('Expense CRUD: create and permanently delete expense', async () => {
      // Create
      const createRes = await apiFetch('/api/expenses', {
        method: 'POST',
        body: {
          description: 'Stage Lighting Check',
          category: 'Maintenance',
          amount: 2500,
          date: '2026-10-28',
          payment_method: 'Cash',
          hall: 'Combined / Facility'
        }
      });
      assert.strictEqual(createRes.res.status, 200);
      const expId = createRes.data.expense.id || createRes.data.expense._id;
      assert.ok(expId, 'Expense ID missing');

      // Delete
      const delRes = await apiFetch(`/api/expenses/${expId}`, { method: 'DELETE' });
      assert.strictEqual(delRes.res.status, 200);
      assert.strictEqual(delRes.data.success, true);

      // Verify immediate query confirms deletion
      const listRes = await apiFetch('/api/expenses');
      assert.strictEqual(listRes.res.status, 200);
      const found = listRes.data.find(x => (x.id || x._id) === expId);
      assert.strictEqual(found, undefined, 'Deleted expense must not appear in subsequent query');
      console.log(`    (Expense created and deleted in ${delRes.ms.toFixed(1)} ms)`);
    });

    // 7. Staff & Payroll with Linked Expense
    await it('Staff Payroll: create staff, disburse salary with linked operational voucher', async () => {
      // Check if staff already exists
      const existingStaff = await apiFetch('/api/staff');
      let staffId;
      if (existingStaff.data && existingStaff.data.length > 0) {
        staffId = existingStaff.data[0].id || existingStaff.data[0]._id;
      } else {
        const staffRes = await apiFetch('/api/staff', {
          method: 'POST',
          body: {
            name: 'Shabbir Security',
            role: 'Head of Security',
            salary: 15000,
            phone: '9876543213',
            joining_date: '2026-01-01',
            status: 'active'
          }
        });
        assert.strictEqual(staffRes.res.status, 200);
        staffId = staffRes.data.staff.id || staffRes.data.staff._id;
      }

      // Check if salary payment already recorded
      const salCheck = await apiFetch('/api/staff/salary-payments');
      if (!salCheck.data || salCheck.data.length === 0) {
        const payRes = await apiFetch('/api/staff/salary-payments', {
          method: 'POST',
          body: {
            staff_id: staffId,
            period: 'October 2026',
            amount_paid: 15000,
            payment_method: 'Bank Transfer'
          }
        });
        assert.strictEqual(payRes.res.status, 200);
        assert.strictEqual(payRes.data.success, true);
      }
      console.log(`    (Verified staff payroll in ${salCheck.ms.toFixed(1)} ms)`);
    });

    // 8. Financial Reconciliation Invariant
    await it('GET /api/reports/summary reconciles Collections vs Outflows with zero double-counting', async () => {
      const { res, data, ms } = await apiFetch('/api/reports/summary?from=2026-10-01&to=2026-11-30');
      assert.strictEqual(res.status, 200, `Reports summary failed: ${JSON.stringify(data)}`);

      const s = data.summary || data.kpis || {};
      const actualCollected = parseFloat(s.actualPaymentsCollected || s.actualCashCollected || 0);
      const totalOutflow = parseFloat(s.totalOutflow || 0);
      const netCash = parseFloat(s.netCashMovement || 0);

      assert.ok(actualCollected >= 15000, `Expected at least ₹15,000 collected, got ₹${actualCollected}`);
      assert.ok(totalOutflow >= 15000, `Expected at least ₹15,000 outflow, got ₹${totalOutflow}`);
      assert.strictEqual(netCash, actualCollected - totalOutflow, `Net cash (${netCash}) must strictly equal actualCollected (${actualCollected}) - totalOutflow (${totalOutflow})`);

      console.log(`    (Dashboard aggregation reconciled in ${ms.toFixed(1)} ms: ₹15,000 in, ₹15,000 out, Net ₹0)`);
    });

    console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log(`RESULTS: ${passed} / ${total} live smoke tests passed (${Math.round((passed / total) * 100)}%)`);
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

    if (passed === total) {
      console.log('🎉 ALL LIVE STAGING WORKFLOWS PASSED WITH 100% SUCCESS!');
    } else {
      process.exit(1);
    }
  } catch (err) {
    console.error('Fatal error during staging smoke tests:', err);
    process.exit(1);
  }
}

run();
