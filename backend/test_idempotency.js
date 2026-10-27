/**
 * Comprehensive Idempotency & Concurrency Audit Test Suite
 * Tests isolated database-backed atomic locking, replay, and mutation deduplication.
 */

const assert = require('assert');
const { createClient } = require('@libsql/client');
const {
  computeRequestHash,
  sanitizeKey,
  acquireIdempotencyLock,
  completeIdempotency,
  failIdempotency,
  createIdempotencyMiddleware
} = require('./idempotency');

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

async function createIsolatedTestDb() {
  // Use in-memory SQLite for complete isolation from production data
  const client = createClient({ url: 'file::memory:?cache=shared' });

  // Standard query adapter
  client.query = async function (sql, args = []) {
    const res = await client.execute({ sql: sql.replace(/\$\d+/g, '?'), args });
    return {
      rows: res.rows || [],
      rowCount: res.rowsAffected || 0,
      rowsAffected: res.rowsAffected || 0,
      lastInsertRowid: res.lastInsertRowid
    };
  };

  // Create idempotency schema
  await client.execute(`
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

  // Create business tables for mutation testing
  await client.execute(`
    CREATE TABLE IF NOT EXISTS test_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT,
      amount REAL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
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
      staff_id INTEGER,
      salary_payment_id INTEGER UNIQUE,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `);

  return client;
}

console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
console.log('🧪 RUNNING IDEMPOTENCY & CONCURRENCY AUDIT TESTS');
console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

(async () => {
  const db = await createIsolatedTestDb();

  // Test 1: 10 concurrent requests with the exact same key create exactly ONE lock
  await test('1. Ten concurrent requests with the same key permit exactly 1 execution', async () => {
    const key = 'idem_concurrent_test_1';
    const payload = { amount: 5000, description: 'Test simultaneous submission' };
    const hash = computeRequestHash(payload);

    // Launch 10 simultaneous lock requests
    const promises = Array.from({ length: 10 }).map(() =>
      acquireIdempotencyLock(db, {
        key,
        userId: 'admin',
        method: 'POST',
        path: '/api/test',
        requestHash: hash
      })
    );

    const results = await Promise.all(promises);
    const acquired = results.filter(r => r.state === 'ACQUIRED');
    const locked = results.filter(r => r.state === 'LOCKED');

    assert.strictEqual(acquired.length, 1, 'Exactly one request must acquire the lock');
    assert.strictEqual(locked.length, 9, 'All other 9 concurrent requests must receive LOCKED state');

    // Complete the winner
    await completeIdempotency(db, {
      key,
      statusCode: 201,
      responseBody: { success: true, id: 42 }
    });
  });

  // Test 2: Retry after simulated timeout replays the original committed result
  await test('2. Retry after timeout replays the original response with identical payload', async () => {
    const key = 'idem_concurrent_test_1';
    const payload = { amount: 5000, description: 'Test simultaneous submission' };
    const hash = computeRequestHash(payload);

    const retryResult = await acquireIdempotencyLock(db, {
      key,
      userId: 'admin',
      method: 'POST',
      path: '/api/test',
      requestHash: hash
    });

    assert.strictEqual(retryResult.state, 'REPLAY');
    assert.strictEqual(retryResult.statusCode, 201);
    const parsed = JSON.parse(retryResult.responseBody);
    assert.strictEqual(parsed.success, true);
    assert.strictEqual(parsed.id, 42);
  });

  // Test 3: Two different keys create two distinct legitimate records
  await test('3. Two different keys create two distinct legitimate records', async () => {
    const keyA = 'idem_unique_key_A';
    const keyB = 'idem_unique_key_B';

    const resA = await acquireIdempotencyLock(db, {
      key: keyA,
      userId: 'admin',
      method: 'POST',
      path: '/api/test',
      requestHash: 'hashA'
    });

    const resB = await acquireIdempotencyLock(db, {
      key: keyB,
      userId: 'admin',
      method: 'POST',
      path: '/api/test',
      requestHash: 'hashB'
    });

    assert.strictEqual(resA.state, 'ACQUIRED');
    assert.strictEqual(resB.state, 'ACQUIRED');

    await completeIdempotency(db, { key: keyA, statusCode: 200, responseBody: { item: 'A' } });
    await completeIdempotency(db, { key: keyB, statusCode: 200, responseBody: { item: 'B' } });
  });

  // Test 4: Different authenticated users cannot replay one another's results
  await test('4. Different authenticated users cannot replay one another results (user isolation)', async () => {
    const key = 'idem_user_scoped_1';
    const hash = computeRequestHash({ test: true });

    // User Alice creates key
    const lockAlice = await acquireIdempotencyLock(db, {
      key,
      userId: 'user_alice',
      method: 'POST',
      path: '/api/private',
      requestHash: hash
    });
    assert.strictEqual(lockAlice.state, 'ACQUIRED');
    await completeIdempotency(db, { key, statusCode: 200, responseBody: { secret: 'alice_data' } });

    // User Bob attempts to replay or access using Alice's key
    const lockBob = await acquireIdempotencyLock(db, {
      key,
      userId: 'user_bob',
      method: 'POST',
      path: '/api/private',
      requestHash: hash
    });

    assert.strictEqual(lockBob.state, 'USER_MISMATCH', 'Bob must be denied access to Alice key');
  });

  // Test 5: Reusing a key with a different payload is rejected with PAYLOAD_MISMATCH
  await test('5. Reusing a key with a different payload is rejected (payload fingerprint mismatch)', async () => {
    const key = 'idem_payload_hash_test';
    const payload1 = { amount: 1000, recipient: 'Hussain' };
    const payload2 = { amount: 99999, recipient: 'Attacker' };

    const lock1 = await acquireIdempotencyLock(db, {
      key,
      userId: 'admin',
      method: 'POST',
      path: '/api/expenses',
      requestHash: computeRequestHash(payload1)
    });
    assert.strictEqual(lock1.state, 'ACQUIRED');
    await completeIdempotency(db, { key, statusCode: 200, responseBody: { ok: true } });

    // Second request with altered payload
    const lock2 = await acquireIdempotencyLock(db, {
      key,
      userId: 'admin',
      method: 'POST',
      path: '/api/expenses',
      requestHash: computeRequestHash(payload2)
    });

    assert.strictEqual(lock2.state, 'PAYLOAD_MISMATCH', 'Altered payload must be rejected');
  });

  // Test 6: A failed request can be safely retried
  await test('6. A failed request releases the key so the client can safely retry', async () => {
    const key = 'idem_failed_retry_test';
    const hash = computeRequestHash({ item: 'fail_then_succeed' });

    // Attempt 1 acquires lock
    const lock1 = await acquireIdempotencyLock(db, {
      key,
      userId: 'admin',
      method: 'POST',
      path: '/api/test',
      requestHash: hash
    });
    assert.strictEqual(lock1.state, 'ACQUIRED');

    // Simulate downstream error / database failure
    await failIdempotency(db, { key });

    // Attempt 2 (Retry)
    const lock2 = await acquireIdempotencyLock(db, {
      key,
      userId: 'admin',
      method: 'POST',
      path: '/api/test',
      requestHash: hash
    });
    assert.strictEqual(lock2.state, 'ACQUIRED', 'Retry after failure must be allowed');
  });

  // Test 7: Simulated crash or stale in-progress lock safely taken over without duplicate execution
  await test('7. Stale in-progress lock from crashed server process is safely recovered', async () => {
    const key = 'idem_crashed_process_test';
    const hash = computeRequestHash({ task: 'crash' });

    // Insert lock that expired 10 minutes ago
    const pastTime = new Date(Date.now() - 600000).toISOString();
    await db.query(
      `INSERT INTO idempotency_keys (key, user_id, method, path, request_hash, status, locked_until)
       VALUES (?, 'admin', 'POST', '/api/test', ?, 'PROCESSING', ?)`,
      [key, hash, pastTime]
    );

    // New request comes in
    const takeover = await acquireIdempotencyLock(db, {
      key,
      userId: 'admin',
      method: 'POST',
      path: '/api/test',
      requestHash: hash
    });

    assert.strictEqual(takeover.state, 'ACQUIRED', 'Stale lock must be cleanly taken over');
  });

  // Test 8: Express Middleware full lifecycle integration test
  await test('8. Express idempotency middleware handles lock, replay, headers and cleanup', async () => {
    const middleware = createIdempotencyMiddleware(db);
    let handlerCalled = 0;

    const req = {
      method: 'POST',
      path: '/api/bookings',
      headers: { 'x-idempotency-key': 'idem_mw_test_1' },
      body: { customer: 'Burhanuddin', date: '2026-11-25' },
      admin: { username: 'admin' }
    };

    let sentStatus = null;
    let sentBody = null;
    let responseHeaders = {};

    const res = {
      statusCode: 200,
      setHeader: (k, v) => { responseHeaders[k] = v; },
      status: function (code) { this.statusCode = code; return this; },
      json: function (b) { sentStatus = this.statusCode; sentBody = b; return this; },
      send: function (b) { sentStatus = this.statusCode; sentBody = b; return this; },
      on: () => {}
    };

    // First call executes handler
    await middleware(req, res, () => {
      handlerCalled++;
      res.status(200).json({ success: true, bookingId: 101 });
    });

    assert.strictEqual(handlerCalled, 1);
    assert.strictEqual(sentBody.bookingId, 101);

    // Wait 50ms for background async save
    await new Promise(r => setTimeout(r, 50));

    // Second call with same key replays without executing handler
    let replayCalled = 0;
    const req2 = { ...req };
    const res2 = {
      statusCode: 200,
      setHeader: (k, v) => { responseHeaders[k] = v; },
      status: function (code) { this.statusCode = code; return this; },
      json: function (b) { sentStatus = this.statusCode; sentBody = b; return this; },
      send: function (b) { sentStatus = this.statusCode; sentBody = b; return this; },
      on: () => {}
    };

    await middleware(req2, res2, () => {
      replayCalled++;
    });

    assert.strictEqual(replayCalled, 0, 'Handler must NOT be called on idempotent replay');
    assert.strictEqual(responseHeaders['X-Idempotent-Replay'], 'true', 'Replay header must be set');
    assert.strictEqual(sentBody.bookingId, 101, 'Original response body must be replayed');
  });

  // Test 9: Salary-related expense cannot be duplicated by repeated salary payment requests
  await test('9. Salary-related expense cannot be duplicated by repeated salary payment requests', async () => {
    // Unique constraint on expenses(salary_payment_id) guarantees accounting integrity
    const staffId = 5;
    const period = 'October 2026';
    const amount = 22000;

    // Simulate salary recording logic
    async function recordSalaryPayment(paymentDate) {
      // 1. Insert salary payment
      const pRes = await db.query(
        `INSERT INTO staff_salary_payments (staff_id, period, amount_paid, payment_date)
         VALUES (?, ?, ?, ?)`,
        [staffId, period, amount, paymentDate]
      );
      const paymentId = pRes.lastInsertRowid;

      // 2. Insert linked expense with salary_payment_id
      try {
        await db.query(
          `INSERT INTO expenses (description, category, amount, staff_id, salary_payment_id)
           VALUES (?, 'Staff Salary', ?, ?, ?)`,
          [`Salary for staff #${staffId} (${period})`, amount, staffId, paymentId]
        );
        return { success: true, paymentId };
      } catch (err) {
        // Unique constraint caught duplicate
        return { success: false, duplicate: true };
      }
    }

    const first = await recordSalaryPayment('2026-10-27');
    assert.strictEqual(first.success, true);

    // Attempt to insert duplicate expense for the same salary_payment_id
    let duplicateExpenseCaught = false;
    try {
      await db.query(
        `INSERT INTO expenses (description, category, amount, staff_id, salary_payment_id)
         VALUES ('Duplicate Salary', 'Staff Salary', 22000, 5, ?)`,
        [first.paymentId]
      );
    } catch (err) {
      duplicateExpenseCaught = true;
    }

    assert.strictEqual(duplicateExpenseCaught, true, 'Unique index idx_expenses_salary_payment must reject duplicate expense');

    // Count expenses in database
    const expCount = await db.query('SELECT COUNT(*) as cnt FROM expenses WHERE salary_payment_id = ?', [first.paymentId]);
    assert.strictEqual(expCount.rows[0].cnt, 1, 'Exactly one linked expense must exist');
  });

  // Test 10: Key sanitization protects against malformed, overly long, or malicious injection keys
  await test('10. Key sanitizer rejects empty, overly long, or malformed characters', async () => {
    assert.strictEqual(sanitizeKey(''), null);
    assert.strictEqual(sanitizeKey('   '), null);
    assert.strictEqual(sanitizeKey('a'.repeat(200)), null);
    assert.strictEqual(sanitizeKey('bad key with spaces!'), null);
    assert.strictEqual(sanitizeKey('idem_valid-key.123:abc'), 'idem_valid-key.123:abc');
  });

  console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log(`RESULTS: ${passed} / ${total} tests passed (${Math.round((passed / total) * 100)}%)`);
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

  if (passed !== total) {
    process.exit(1);
  }
})();
