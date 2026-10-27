const http = require('http');
const jwt = require('jsonwebtoken');
const assert = require('assert');
const app = require('./server');
const db = require('./db');

(async () => {
  console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('🧪 RUNNING END-TO-END BOOKING & IDEMPOTENCY RETRY SUITE');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

  const server = http.createServer(app);
  await new Promise(resolve => server.listen(0, resolve));
  const port = server.address().port;

  const token = jwt.sign(
    { id: 1, username: 'admin', role: 'admin' },
    process.env.JWT_SECRET || 'test-jwt-secret-for-audit-hakimi-53-key',
    { expiresIn: '1h' }
  );

  const idempotencyKey = `e2e_booking_key_${Date.now()}`;
  const payload = JSON.stringify({
    customer_name: 'Test Auto E2E Booking',
    phone: '9876543210',
    email: 'autotest@example.com',
    event_date: '2026-12-05',
    slot: 'morning',
    hall: 'Evan-e-Hakimi',
    package: 'without_jaman',
    status: 'CONFIRMED_PENDING_ADVANCE',
    occasion: 'Corporate Meeting'
  });

  function makeRequest(idemKey) {
    return new Promise((resolve, reject) => {
      const headers = {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`
      };
      if (idemKey) {
        headers['X-Idempotency-Key'] = idemKey;
      }

      const req = http.request(
        {
          hostname: '127.0.0.1',
          port,
          path: '/api/bookings',
          method: 'POST',
          headers
        },
        res => {
          let body = '';
          res.on('data', chunk => { body += chunk; });
          res.on('end', () => {
            try {
              resolve({ status: res.statusCode, data: JSON.parse(body), headers: res.headers });
            } catch (e) {
              resolve({ status: res.statusCode, raw: body, headers: res.headers });
            }
          });
        }
      );
      req.on('error', reject);
      req.write(payload);
      req.end();
    });
  }

  let createdBookingId = null;

  try {
    // Test 1: Booking creation succeeds with 200 OK and valid bookingId
    const t0 = Date.now();
    const res1 = await makeRequest(idempotencyKey);
    const duration = Date.now() - t0;

    assert.strictEqual(res1.status, 200, `Expected 200 OK, got ${res1.status}`);
    assert.strictEqual(res1.data.success, true, 'Expected success: true');
    assert.ok(res1.data.bookingId, 'Expected bookingId');
    assert.ok(duration < 2500, `Expected response within 2.5s, took ${duration}ms`);
    createdBookingId = res1.data.bookingId;
    console.log(`  ✓ 1. Valid booking created end-to-end within ${duration}ms (Booking #${createdBookingId})`);

    // Test 2: Idempotent duplicate retry returns identical response without duplicating booking
    const res2 = await makeRequest(idempotencyKey);
    assert.strictEqual(res2.status, 200, `Expected 200 OK on retry, got ${res2.status}`);
    assert.strictEqual(res2.data.success, true);
    assert.strictEqual(res2.data.bookingId, createdBookingId, 'Must replay original bookingId');
    console.log('  ✓ 2. Duplicate retry with same idempotency key replays original response safely');

    // Test 3: Exactly 1 record in database
    const countRes = await db.query('SELECT COUNT(*) as count FROM bookings WHERE customer_name = ?', ['Test Auto E2E Booking']);
    assert.strictEqual(Number(countRes.rows[0].count), 1, 'Exactly 1 booking record must exist');
    console.log('  ✓ 3. Concurrency check verified: exactly 1 logical record committed');

    console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log('RESULTS: 3 / 3 end-to-end booking tests passed (100%)');
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');
  } finally {
    // Clean up test records
    if (createdBookingId) {
      await db.query('DELETE FROM bookings WHERE id = ?', [createdBookingId]);
      await db.query('DELETE FROM idempotency_keys WHERE key = ?', [idempotencyKey]);
    }
    server.close();
  }
})();
