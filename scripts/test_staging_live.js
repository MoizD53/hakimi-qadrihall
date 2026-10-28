/**
 * HAKIMI53 V2 — Live Staging Smoke Test Suite
 * Executes against the deployed live staging URL: https://hakimi-staging.vercel.app
 * 
 * Verifies:
 * 1. Health check & connectivity
 * 2. Admin authentication & JWT token issuance
 * 3. Zero initial baseline (0 bookings, 0 expenses, 0 staff)
 * 4. Booking #1 sequence (id: 1, ref: EH-2026-0001)
 * 5. 40% advance payment calculation & recording
 * 6. Balance clearance & transition to FULLY_PAID
 * 7. Operational expense creation & deletion persistence
 * 8. Staff profile creation & salary payment with linked expense
 * 9. Financial reconciliation invariant with zero double-counting
 * 10. Live HTTP read/write latency benchmarking
 */

const assert = require('assert');

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
    await it('GET /api/health returns 200 OK and database connected', async () => {
      const { res, data, ms } = await apiFetch('/api/health');
      assert.strictEqual(res.status, 200, `Expected 200, got ${res.status}: ${JSON.stringify(data)}`);
      assert.strictEqual(data.status, 'healthy');
      assert.strictEqual(data.database, 'connected');
      console.log(`    (Latency: ${ms.toFixed(1)} ms)`);
    });

    // 2. Admin Authentication
    await it('POST /api/auth/login returns valid JWT token', async () => {
      const { res, data, ms } = await apiFetch('/api/auth/login', {
        method: 'POST',
        body: { username: ADMIN_USERNAME, password: ADMIN_PASSWORD }
      });
      assert.strictEqual(res.status, 200, `Login failed: ${JSON.stringify(data)}`);
      assert.ok(data.token, 'Token missing in login response');
      authToken = data.token;
      console.log(`    (Latency: ${ms.toFixed(1)} ms)`);
    });

    // 3. Zero Baseline Verification
    await it('GET /api/bookings confirms initial zero baseline (0 bookings)', async () => {
      const { res, data, ms } = await apiFetch('/api/bookings');
      assert.strictEqual(res.status, 200);
      assert.ok(Array.isArray(data));
      assert.strictEqual(data.length, 0, `Expected 0 initial bookings, found ${data.length}`);
      console.log(`    (Latency: ${ms.toFixed(1)} ms)`);
    });

    // 4. Booking #1 Creation
    let booking1Id;
    await it('POST /api/bookings creates Booking #1 with reference EH-2026-0001', async () => {
      const { res, data, ms } = await apiFetch('/api/bookings', {
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
      assert.strictEqual(res.status, 200, `Booking creation failed: ${JSON.stringify(data)}`);
      assert.strictEqual(data.success, true);
      assert.strictEqual(data.bookingId, 1, `Expected booking ID to be 1, got ${data.bookingId}`);
      assert.strictEqual(data.booking.booking_reference, 'EH-2026-0001');
      booking1Id = data.bookingId;
      console.log(`    (Created Booking #${booking1Id} in ${ms.toFixed(1)} ms)`);
    });

    // 5. 40% Advance Payment
    await it('POST /api/bookings/1/advance records 40% advance (₹6,000) -> ADVANCE_PAID', async () => {
      const { res, data, ms } = await apiFetch(`/api/bookings/${booking1Id}/advance`, {
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
      console.log(`    (Latency: ${ms.toFixed(1)} ms)`);
    });

    // 6. Balance Clearance -> FULLY_PAID
    await it('POST /api/bookings/1/receive-balance settles account to ₹0 -> FULLY_PAID', async () => {
      const { res, data, ms } = await apiFetch(`/api/bookings/${booking1Id}/receive-balance`, {
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
      console.log(`    (Latency: ${ms.toFixed(1)} ms)`);
    });

    // 7. Expense Creation & Immediate Deletion Persistence
    await it('Expense CRUD: create, verify immediate deletion persistence across requests', async () => {
      // Create
      const createRes = await apiFetch('/api/expenses', {
        method: 'POST',
        body: {
          description: 'Temporary Test Expense',
          category: 'Miscellaneous',
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
      console.log(`    (Expense created and permanently deleted in ${delRes.ms.toFixed(1)} ms)`);
    });

    // 8. Staff & Payroll with Linked Expense
    let staffId;
    await it('Staff Payroll: create staff, disburse salary with linked operational voucher', async () => {
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
      assert.ok(staffId, 'Staff ID missing');

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
      console.log(`    (Salary recorded in ${payRes.ms.toFixed(1)} ms)`);
    });

    // 9. Financial Reconciliation Invariant
    await it('GET /api/reports/summary reconciles: Collections - Outflow with zero double-counting', async () => {
      const { res, data, ms } = await apiFetch('/api/reports/summary?from=2026-10-01&to=2026-11-30');
      assert.strictEqual(res.status, 200, `Reports summary failed: ${JSON.stringify(data)}`);

      const actualCollected = parseFloat(data.kpis.actualPaymentsCollected || 0);
      const totalOutflow = parseFloat(data.kpis.totalOutflow || 0);
      const netCash = parseFloat(data.kpis.netCashMovement || 0);

      // Inflow: 15,000 from Booking #1
      assert.strictEqual(actualCollected, 15000, `Expected ₹15,000 collected, got ₹${actualCollected}`);

      // Outflow: 15,000 from Shabbir Security Salary (operational expense was deleted!)
      assert.strictEqual(totalOutflow, 15000, `Expected ₹15,000 outflow, got ₹${totalOutflow}`);

      // Net Cash: 15,000 - 15,000 = 0
      assert.strictEqual(netCash, 0, `Expected ₹0 net cash, got ₹${netCash}`);

      console.log(`    (Dashboard aggregation completed in ${ms.toFixed(1)} ms, Zero Double-Counting Verified)`);
    });

    console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log(`RESULTS: ${passed} / ${total} live smoke tests passed (${Math.round((passed / total) * 100)}%)`);
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

    if (passed === total) {
      console.log('🎉 LIVE STAGING DEPLOYMENT IS 100% OPERATIONAL AND VERIFIED!');
    } else {
      process.exit(1);
    }
  } catch (err) {
    console.error('Fatal error during staging smoke tests:', err);
    process.exit(1);
  }
}

run();
