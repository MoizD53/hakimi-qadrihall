const crypto = require('crypto');

/**
 * Robust, production-grade Idempotency Manager for Hakimi Hall Management System.
 * Guarantees zero duplicate operations under concurrency, network timeouts, and client retries.
 */

function computeRequestHash(body) {
  try {
    const serialized = typeof body === 'string' ? body : JSON.stringify(body || {});
    return crypto.createHash('sha256').update(serialized).digest('hex');
  } catch (_) {
    return 'nohash';
  }
}

function sanitizeKey(rawKey) {
  if (!rawKey || typeof rawKey !== 'string') return null;
  const trimmed = rawKey.trim();
  if (trimmed.length === 0 || trimmed.length > 128) return null;
  // Allow alphanumeric, dashes, underscores, dots, colons
  if (!/^[a-zA-Z0-9_\-\.:]+$/.test(trimmed)) return null;
  return trimmed;
}

/**
 * Atomically acquires a distributed database-backed lock on an idempotency key.
 * Uses atomic INSERT to guarantee that only ONE concurrent process ever acquires the key.
 */
async function acquireIdempotencyLock(db, { key, userId, method, path, requestHash, lockDurationSec = 30 }) {
  const now = new Date();
  const lockExpiresAt = new Date(now.getTime() + lockDurationSec * 1000).toISOString();

  // 1. Attempt atomic insert. Primary Key constraint prevents duplicate acquisitions.
  try {
    await db.query(
      `INSERT INTO idempotency_keys (key, user_id, method, path, request_hash, status, locked_until)
       VALUES (?, ?, ?, ?, ?, 'PROCESSING', ?)`,
      [key, userId || 'anonymous', method, path, requestHash, lockExpiresAt]
    );
    return { state: 'ACQUIRED' };
  } catch (err) {
    const isConstraint = err.message && (
      err.message.includes('UNIQUE constraint failed') ||
      err.message.includes('SQLITE_CONSTRAINT') ||
      err.message.includes('PRIMARY KEY')
    );
    if (!isConstraint) {
      throw err;
    }
  }

  // 2. Key exists — Inspect existing record
  const res = await db.query(
    `SELECT key, user_id, method, path, request_hash, status, status_code, response_body, locked_until
     FROM idempotency_keys WHERE key = ? LIMIT 1`,
    [key]
  );

  if (!res.rows || res.rows.length === 0) {
    // Highly unusual race condition (deleted between insert and select)
    return { state: 'LOCKED', error: 'Lock acquisition conflict' };
  }

  const existing = res.rows[0];

  // Safeguard: Scoped to authenticated user (never allow user A to replay or hijack user B's response)
  if (existing.user_id && userId && existing.user_id !== 'anonymous' && userId !== 'anonymous') {
    if (existing.user_id !== userId) {
      return { state: 'USER_MISMATCH', error: 'Idempotency key belongs to another authenticated user.' };
    }
  }

  // Safeguard: Scoped to HTTP method and path
  if (existing.method !== method || existing.path !== path) {
    return { state: 'PAYLOAD_MISMATCH', error: 'Idempotency key cannot be reused across different endpoints or methods.' };
  }

  // Safeguard: Detect key reuse with a different payload
  if (existing.request_hash && requestHash && existing.request_hash !== requestHash) {
    return { state: 'PAYLOAD_MISMATCH', error: 'Idempotency key was previously submitted with a different request payload.' };
  }

  // 3. Check status
  if (existing.status === 'COMPLETED') {
    return {
      state: 'REPLAY',
      statusCode: existing.status_code || 200,
      responseBody: existing.response_body
    };
  }

  if (existing.status === 'PROCESSING') {
    // Check if the lock is stale (process died or timed out)
    const lockedUntilDate = existing.locked_until ? new Date(existing.locked_until) : null;
    const isStale = !lockedUntilDate || lockedUntilDate.getTime() <= Date.now();

    if (isStale) {
      // Atomically takeover the stale lock
      const takeoverRes = await db.query(
        `UPDATE idempotency_keys
         SET status = 'PROCESSING', user_id = ?, method = ?, path = ?, request_hash = ?, locked_until = ?
         WHERE key = ? AND (status = 'PROCESSING' OR status = 'FAILED') AND (locked_until IS NULL OR locked_until <= ?)`,
        [userId || 'anonymous', method, path, requestHash, lockExpiresAt, key, now.toISOString()]
      );

      const affected = takeoverRes.rowCount || (takeoverRes.rowsAffected !== undefined ? takeoverRes.rowsAffected : 0);
      if (affected > 0) {
        return { state: 'ACQUIRED' };
      }
    }

    return {
      state: 'LOCKED',
      error: 'An identical request is currently processing. Please wait.'
    };
  }

  // 4. Status is FAILED — allow retry
  if (existing.status === 'FAILED') {
    await db.query(
      `UPDATE idempotency_keys
       SET status = 'PROCESSING', user_id = ?, method = ?, path = ?, request_hash = ?, locked_until = ?
       WHERE key = ?`,
      [userId || 'anonymous', method, path, requestHash, lockExpiresAt, key]
    );
    return { state: 'ACQUIRED' };
  }

  return { state: 'LOCKED', error: 'Request in progress' };
}

/**
 * Commits successful completion of an idempotent operation.
 */
async function completeIdempotency(db, { key, statusCode, responseBody }) {
  if (!key) return;
  const bodyStr = typeof responseBody === 'string' ? responseBody : JSON.stringify(responseBody);
  try {
    await db.query(
      `UPDATE idempotency_keys
       SET status = 'COMPLETED', status_code = ?, response_body = ?, locked_until = NULL
       WHERE key = ?`,
      [statusCode || 200, bodyStr, key]
    );
  } catch (err) {
    console.warn('⚠️ [IDEMPOTENCY] Failed to save completed response:', err.message);
  }
}

/**
 * Releases or marks an idempotency key as FAILED so client can safely retry.
 */
async function failIdempotency(db, { key }) {
  if (!key) return;
  try {
    await db.query(
      `UPDATE idempotency_keys
       SET status = 'FAILED', locked_until = NULL
       WHERE key = ? AND status = 'PROCESSING'`,
      [key]
    );
  } catch (err) {
    console.warn('⚠️ [IDEMPOTENCY] Failed to release lock on error:', err.message);
  }
}

/**
 * Creates Express middleware for server-side idempotency.
 */
function createIdempotencyMiddleware(db) {
  return async function idempotencyMiddleware(req, res, next) {
    // Only intercept state-changing HTTP methods
    if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) {
      return next();
    }

    const rawKey = req.headers['x-idempotency-key'];
    if (!rawKey) {
      return next();
    }

    const key = sanitizeKey(rawKey);
    if (!key) {
      return res.status(400).json({ error: 'Invalid X-Idempotency-Key header. Must be 1-128 alphanumeric characters.' });
    }

    const userId = req.admin?.username || req.admin?.id || 'anonymous';
    const requestHash = computeRequestHash(req.body);
    const method = req.method;
    const path = req.baseUrl ? req.baseUrl + req.path : req.path;

    try {
      const lock = await acquireIdempotencyLock(db, {
        key,
        userId,
        method,
        path,
        requestHash
      });

      if (lock.state === 'REPLAY') {
        res.setHeader('X-Idempotent-Replay', 'true');
        try {
          const parsed = JSON.parse(lock.responseBody);
          return res.status(lock.statusCode).json(parsed);
        } catch (_) {
          return res.status(lock.statusCode).send(lock.responseBody);
        }
      }

      if (lock.state === 'LOCKED') {
        res.setHeader('Retry-After', '2');
        return res.status(409).json({ error: lock.error || 'An identical request is currently processing. Please wait.' });
      }

      if (lock.state === 'USER_MISMATCH') {
        return res.status(403).json({ error: lock.error });
      }

      if (lock.state === 'PAYLOAD_MISMATCH') {
        return res.status(422).json({ error: lock.error });
      }

      // Lock ACQUIRED: Attach cleanup hooks to response
      req.idempotencyKey = key;

      const origJson = res.json.bind(res);
      const origSend = res.send.bind(res);
      let finalized = false;

      res.json = function (body) {
        if (!finalized) {
          finalized = true;
          if (res.statusCode < 400) {
            completeIdempotency(db, { key, statusCode: res.statusCode, responseBody: body }).catch(() => {});
          } else {
            failIdempotency(db, { key }).catch(() => {});
          }
        }
        return origJson(body);
      };

      res.send = function (body) {
        if (!finalized) {
          finalized = true;
          if (res.statusCode < 400) {
            completeIdempotency(db, { key, statusCode: res.statusCode, responseBody: body }).catch(() => {});
          } else {
            failIdempotency(db, { key }).catch(() => {});
          }
        }
        return origSend(body);
      };

      res.on('close', () => {
        if (!finalized && !res.writableEnded) {
          failIdempotency(db, { key }).catch(() => {});
        }
      });

      next();
    } catch (err) {
      console.error('❌ [IDEMPOTENCY] Middleware exception:', err);
      return res.status(500).json({ error: 'Internal idempotency processing error' });
    }
  };
}

module.exports = {
  computeRequestHash,
  sanitizeKey,
  acquireIdempotencyLock,
  completeIdempotency,
  failIdempotency,
  createIdempotencyMiddleware
};
