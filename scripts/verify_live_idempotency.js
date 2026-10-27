const db = require('../backend/db');
const { acquireIdempotencyLock, completeIdempotency, failIdempotency, computeRequestHash } = require('../backend/idempotency');
const assert = require('assert');

(async () => {
  console.log('Testing live Turso idempotency concurrency...');
  const testKey = `test_live_${Date.now()}`;
  const payload1 = { amount: 1500, desc: 'Test Concurrency' };
  const hash1 = computeRequestHash(payload1);

  try {
    // 1. Concurrent Acquisition
    const p1 = acquireIdempotencyLock(db, { key: testKey, userId: 'admin1', method: 'POST', path: '/api/test', requestHash: hash1 });
    const p2 = acquireIdempotencyLock(db, { key: testKey, userId: 'admin1', method: 'POST', path: '/api/test', requestHash: hash1 });
    const [r1, r2] = await Promise.all([p1, p2]);

    const acquiredCount = [r1, r2].filter(r => r.state === 'ACQUIRED').length;
    const lockedCount = [r1, r2].filter(r => r.state === 'LOCKED').length;
    console.log(`Live Concurrency Result: Acquired=${acquiredCount}, Locked=${lockedCount}`);
    assert.strictEqual(acquiredCount, 1, 'Exactly one concurrent request must acquire lock');
    assert.strictEqual(lockedCount, 1, 'Second concurrent request must receive LOCKED');

    // 2. Complete operation
    await completeIdempotency(db, { key: testKey, statusCode: 201, responseBody: { success: true, test: 1 } });

    // 3. Replay after completion (simulating timeout retry)
    const replay = await acquireIdempotencyLock(db, { key: testKey, userId: 'admin1', method: 'POST', path: '/api/test', requestHash: hash1 });
    console.log(`Live Replay Result: State=${replay.state}, StatusCode=${replay.statusCode}`);
    assert.strictEqual(replay.state, 'REPLAY');
    assert.strictEqual(replay.statusCode, 201);

    // 4. Altered Payload Rejection
    const hash2 = computeRequestHash({ amount: 99999, desc: 'Altered' });
    const altered = await acquireIdempotencyLock(db, { key: testKey, userId: 'admin1', method: 'POST', path: '/api/test', requestHash: hash2 });
    console.log(`Live Altered Payload Result: State=${altered.state}`);
    assert.strictEqual(altered.state, 'PAYLOAD_MISMATCH');

    // 5. User Authorization Scoping
    const otherUser = await acquireIdempotencyLock(db, { key: testKey, userId: 'different_user', method: 'POST', path: '/api/test', requestHash: hash1 });
    console.log(`Live User Isolation Result: State=${otherUser.state}`);
    assert.strictEqual(otherUser.state, 'USER_MISMATCH');

    // 6. Stale Lock Recovery
    const staleKey = `test_stale_${Date.now()}`;
    const pastTime = new Date(Date.now() - 60000).toISOString();
    await db.query(
      `INSERT INTO idempotency_keys (key, user_id, method, path, request_hash, status, locked_until)
       VALUES (?, 'admin1', 'POST', '/api/test', ?, 'PROCESSING', ?)`,
      [staleKey, hash1, pastTime]
    );

    const staleTakeover = await acquireIdempotencyLock(db, { key: staleKey, userId: 'admin1', method: 'POST', path: '/api/test', requestHash: hash1 });
    console.log(`Live Stale Lock Takeover Result: State=${staleTakeover.state}`);
    assert.strictEqual(staleTakeover.state, 'ACQUIRED');

    // 7. Cleanup test keys from live Turso
    await db.query(`DELETE FROM idempotency_keys WHERE key IN (?, ?)`, [testKey, staleKey]);
    console.log('✅ Cleaned up temporary test keys from live Turso.');

    console.log('🎉 ALL LIVE TURSO IDEMPOTENCY CHECKS PASSED SUCCESSFULLY!');
  } catch (err) {
    console.error('❌ Live test failed:', err);
    process.exit(1);
  }
})();
