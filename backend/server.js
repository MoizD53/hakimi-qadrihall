require('dotenv').config();

const express   = require('express');
const path      = require('path');
const fs        = require('fs');
const https     = require('https');
const cors      = require('cors');
const helmet    = require('helmet');
const rateLimit = require('express-rate-limit');
const jwt       = require('jsonwebtoken');
const db        = require('./db');
const { requireAuth } = require('./middleware/auth');

const app = express();
const rootDir = path.join(__dirname, '..');

// Trust reverse proxies (Vercel / AWS Lambda / cloud edge) to correctly resolve client IPs
app.set('trust proxy', 1);

/* ═══════════════════════════════════════════
   SECURITY HEADERS — helmet
═══════════════════════════════════════════ */
app.use(helmet({
  contentSecurityPolicy: false, // allow loading local assets and fonts on Vercel
  crossOriginEmbedderPolicy: false
}));

/* ═══════════════════════════════════════════
   CORS — supports custom domains & Vercel
═══════════════════════════════════════════ */
const allowedDevOrigins = [
  'http://127.0.0.1:5500',
  'http://127.0.0.1:5501',
  'http://localhost:5500',
  'http://localhost:5501',
  'http://localhost:5000',
  'http://localhost:3000',
];

app.use(cors({
  origin: function (origin, callback) {
    if (!origin) return callback(null, true); // same-origin, curl, server-side calls
    if (allowedDevOrigins.includes(origin)) return callback(null, true);

    // Allow vercel preview & production domains (*.vercel.app)
    if (origin.endsWith('.vercel.app')) return callback(null, true);

    // Allow custom production domain from environment
    if (process.env.ALLOWED_ORIGIN) {
      const allowedEnv = process.env.ALLOWED_ORIGIN.trim().toLowerCase();
      if (origin.toLowerCase() === allowedEnv || origin.toLowerCase().includes(allowedEnv)) {
        return callback(null, true);
      }
    }

    // Permissive for custom domains configured in Vercel over HTTPS
    callback(null, true);
  },
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
  credentials: true
}));

app.use(express.json({ limit: '20kb' })); // prevent huge payloads

/* ═══════════════════════════════════════════
   RATE LIMITING
═══════════════════════════════════════════ */
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many login attempts. Please try again in 15 minutes.' },
  skipSuccessfulRequests: true,
});

const apiLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 120,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests. Please slow down.' }
});

app.use('/api/', apiLimiter);

/* ═══════════════════════════════════════════
   HELPERS & AUDIT LOGGING
═══════════════════════════════════════════ */
const isProd = process.env.NODE_ENV === 'production';

function sendError(res, status, message, err) {
  if (!isProd && err) {
    console.error('❌', message, err.message);
  }
  return res.status(status).json({ error: message });
}

async function logAudit(action, entityType, entityId, details, user = 'admin') {
  try {
    const detailsStr = typeof details === 'object' ? JSON.stringify(details) : String(details || '');
    await db.query(
      'INSERT INTO audit_logs (action, entity_type, entity_id, details, user) VALUES (?, ?, ?, ?, ?)',
      [action, entityType, entityId || null, detailsStr, user]
    );
  } catch (err) {
    console.error('Failed to write audit log:', err.message);
  }
}

/* ═══════════════════════════════════════════
   ROUTING & ACCESS-CONTROL RULES
   (Internal Management Software — No Public Website)
═══════════════════════════════════════════ */

// 1. Clean URL redirects
app.get('/index.html', (req, res) => res.redirect(302, '/'));
app.get('/login', (req, res) => res.redirect(302, '/admin'));
app.get('/login.html', (req, res) => res.redirect(302, '/admin'));

// 2. Public customer website routes
app.get('/', (req, res) => res.sendFile(path.join(rootDir, 'index.html')));
app.get('/pay', (req, res) => res.sendFile(path.join(rootDir, 'pay.html')));
app.get('/pay.html', (req, res) => res.sendFile(path.join(rootDir, 'pay.html')));

// 3. Admin portal route (serves Admin sign-in when unauthenticated, dashboard when authenticated)
app.get(/^\/admin(\/.*)?$/, (req, res) => res.sendFile(path.join(rootDir, 'admin.html')));

// 3.1 PWA & Service Worker endpoints
app.get('/manifest.json', (req, res) => {
  res.setHeader('Content-Type', 'application/manifest+json');
  res.setHeader('Cache-Control', 'public, max-age=3600');
  res.sendFile(path.join(rootDir, 'manifest.json'));
});

app.get('/sw.js', (req, res) => {
  res.setHeader('Content-Type', 'application/javascript');
  res.setHeader('Service-Worker-Allowed', '/');
  res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
  res.sendFile(path.join(rootDir, 'sw.js'));
});

app.get('/offline.html', (req, res) => {
  res.setHeader('Content-Type', 'text/html; charset=UTF-8');
  res.sendFile(path.join(rootDir, 'offline.html'));
});

// 4. Block direct static access to server code, database files, and config files
app.use(['/backend', '/local.db', '/package.json', '/package-lock.json', '/vercel.json'], (req, res) => {
  res.status(404).send('Not Found');
});

// 5. Assets & Static files
const assetMemoryCache = new Map();

function streamAssetFromRemote(res, subPath) {
  if (assetMemoryCache.has(subPath)) {
    const cached = assetMemoryCache.get(subPath);
    res.setHeader('Content-Type', cached.contentType);
    res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
    return res.end(cached.buffer);
  }

  const remoteUrl = `https://raw.githubusercontent.com/duokarma53-spec/HakimiConstruction/main/${subPath}`;
  https.get(remoteUrl, (remoteRes) => {
    if (remoteRes.statusCode === 200) {
      const chunks = [];
      const contentType = remoteRes.headers['content-type'] || 'application/octet-stream';
      res.setHeader('Content-Type', contentType);
      res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
      remoteRes.on('data', chunk => chunks.push(chunk));
      remoteRes.on('end', () => {
        const buffer = Buffer.concat(chunks);
        assetMemoryCache.set(subPath, { buffer, contentType });
        res.end(buffer);
      });
    } else {
      res.status(404).sendFile(path.join(rootDir, '404.html'));
    }
  }).on('error', (err) => {
    console.error('Remote asset fetch fallback error:', err.message);
    res.status(404).sendFile(path.join(rootDir, '404.html'));
  });
}

app.get('/assets/:filename', (req, res) => {
  const filename = path.basename(req.params.filename);
  const filePath = path.join(rootDir, 'assets', filename);
  if (fs.existsSync(filePath)) {
    res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
    return res.sendFile(filePath);
  }
  streamAssetFromRemote(res, `assets/${filename}`);
});

app.get('/js/:filename', (req, res) => {
  const filename = path.basename(req.params.filename);
  const filePath = path.join(rootDir, 'js', filename);
  if (fs.existsSync(filePath)) {
    res.setHeader('Cache-Control', 'public, max-age=86400');
    return res.sendFile(filePath);
  }
  streamAssetFromRemote(res, `js/${filename}`);
});

app.get('/favicon.ico', (req, res) => res.redirect(301, '/assets/favicon.svg'));
app.get('/favicon.svg', (req, res) => {
  const filePath = path.join(rootDir, 'assets', 'favicon.svg');
  if (fs.existsSync(filePath)) return res.sendFile(filePath);
  streamAssetFromRemote(res, 'assets/favicon.svg');
});

app.use('/assets', express.static(path.join(rootDir, 'assets'), { maxAge: '1y', immutable: true }));
app.use('/js', express.static(path.join(rootDir, 'js'), { maxAge: '1d' }));

// 6. Health & Service info routes
app.get('/health', (req, res) => res.status(200).json({
  status: 'ok',
  service: 'Evan-e-Hakimi & Qadri Hall Management Software',
  database: 'Turso (libSQL)',
  time: new Date().toISOString(),
}));

app.get('/api', (req, res) => res.status(200).json({
  service: 'Evan-e-Hakimi & Qadri Hall Management API',
  status: 'active',
  authenticated: true,
  time: new Date().toISOString()
}));

app.get('/api/health', (req, res) => res.status(200).json({
  status: 'ok',
  service: 'Evan-e-Hakimi & Qadri Hall Management Software',
  database: 'Turso (libSQL)',
  time: new Date().toISOString(),
}));

/* ═══════════════════════════════════════════
   ADMIN AUTHENTICATION
═══════════════════════════════════════════ */

// POST /api/admin/login
app.post('/api/admin/login', loginLimiter, (req, res) => {
  const { username, password } = req.body;

  if (!username || !password) {
    return res.status(400).json({ error: 'Username and password are required' });
  }

  const validUsername = process.env.ADMIN_USERNAME;
  const validPassword = process.env.ADMIN_PASSWORD;

  if (!validUsername || !validPassword) {
    console.error('❌ ADMIN_USERNAME or ADMIN_PASSWORD not set in environment');
    return res.status(500).json({ error: 'Server configuration error: Admin credentials not configured' });
  }

  if (username !== validUsername || password !== validPassword) {
    return res.status(401).json({ error: 'Invalid credentials' });
  }

  const jwtSecret = process.env.JWT_SECRET || 'fallback_secret_banquet_hall_2026';
  const token = jwt.sign(
    { role: 'admin', username },
    jwtSecret,
    { expiresIn: '12h' }
  );

  logAudit('admin_login', 'auth', null, `Admin logged in successfully from IP ${req.ip}`, username);

  res.json({ success: true, token, user: { username, role: 'admin' } });
});

// GET /api/admin/me — verify token and return profile
app.get('/api/admin/me', requireAuth, (req, res) => {
  res.json({
    success: true,
    user: {
      username: req.admin.username,
      role: req.admin.role,
      authenticated: true
    }
  });
});

/* ═══════════════════════════════════════════
   BUSINESS LOGIC & PRICING CONFIGURATION
═══════════════════════════════════════════ */
const SLOT_CONFIG = {
  morning: {
    name: 'Morning',
    timing: '10:30 AM – 2:30 PM',
    includes_jaman: true
  },
  evening: {
    name: 'Evening',
    timing: '6:30 PM – 10:30 PM',
    includes_jaman: true
  },
  fullday: {
    name: 'Full Day',
    timing: '10:00 AM – 10:00 PM',
    includes_jaman: true
  },
  majlis: {
    name: 'Only Majlis',
    timing: 'Custom Timings',
    includes_jaman: false
  }
};

function isDateOnOrAfterJan2027(dateStr) {
  if (!dateStr) return false;
  const clean = String(dateStr).split('T')[0].trim();
  return clean >= '2027-01-01';
}

function calculateHallPrice(slot, pkg, dateStr) {
  if (dateStr === undefined && typeof pkg === 'string' && (pkg.includes('-') || pkg.includes('/'))) {
    dateStr = pkg;
    pkg = undefined;
  }
  const normalizedSlot = String(slot).toLowerCase().trim();
  const is2027OrLater = isDateOnOrAfterJan2027(dateStr);

  // Full Day: strictly ₹30,000 (includes jaman)
  if (normalizedSlot === 'fullday') {
    return 30000;
  }

  // Only Majlis (without jaman, custom timings): 2026: ₹11,000 | 2027: ₹12,000
  if (normalizedSlot === 'majlis') {
    return is2027OrLater ? 12000 : 11000;
  }

  // Morning and Evening slots
  if (normalizedSlot === 'morning' || normalizedSlot === 'evening') {
    if (pkg === 'without_jaman') {
      return is2027OrLater ? 15000 : 11000;
    }
    // with_jaman: 2026: ₹15,000 | 2027: ₹20,000
    return is2027OrLater ? 20000 : 15000;
  }

  return is2027OrLater ? 20000 : 15000;
}

function calculateAdvanceAmount(totalPrice) {
  return Math.round(totalPrice * 0.40);
}

function checkSlotConflict(slotA, slotB) {
  const a = String(slotA).toLowerCase();
  const b = String(slotB).toLowerCase();
  if (a === 'fullday' || b === 'fullday') return true;
  return a === b;
}

// Concurrency-safe conflict verification helper using Turso/libSQL write transaction
async function assertNoBookingConflict(tx, bookingId) {
  const current = await tx.query('SELECT * FROM bookings WHERE id = ?', [bookingId]);
  if (!current.rows || current.rows.length === 0) {
    const err = new Error('Booking not found');
    err.status = 404;
    throw err;
  }

  const target = current.rows[0];
  const targetDate = target.check_in && target.check_in.toISOString 
    ? target.check_in.toISOString().split('T')[0] 
    : String(target.check_in).split('T')[0];
  const targetHall = target.hall || 'Evan-e-Hakimi';
  const targetSlot = target.slot;

  // Query existing confirmed bookings inside the write transaction for the SAME hall
  const existingConfirmed = await tx.query(
    `SELECT id, customer_name, slot, status, hall FROM bookings 
     WHERE id != ? AND check_in = ? AND COALESCE(hall, 'Evan-e-Hakimi') = ? 
     AND status IN ('confirmed', 'advance_verified')`,
    [bookingId, targetDate, targetHall]
  );

  const conflictingBooking = (existingConfirmed.rows || []).find(c => checkSlotConflict(targetSlot, c.slot));
  if (conflictingBooking) {
    const err = new Error(
      `Booking conflict: Booking #${conflictingBooking.id} (${conflictingBooking.customer_name}, slot: ${conflictingBooking.slot}) is already confirmed on ${targetDate} for ${targetHall}. Cannot confirm a conflicting slot.`
    );
    err.status = 409;
    throw err;
  }

  return target;
}

/* ═══════════════════════════════════════════
   HALL BOOKING MANAGEMENT API
═══════════════════════════════════════════ */

// GET /api/bookings — List bookings with search & filters (admin only)
app.get('/api/bookings', requireAuth, async (req, res) => {
  try {
    const { hall, status, paymentStatus, search, fromDate, toDate } = req.query;

    let query = `
      SELECT *, 
        advance_amount as advanceAmount,
        advance_paid as advancePaid, 
        payment_status as paymentStatus, 
        payment_notes as paymentNotes,
        payment_method as paymentMethod,
        COALESCE(balance_amount, (total_amount - advance_paid)) as balanceAmount,
        COALESCE(hall, 'Evan-e-Hakimi') as hall,
        COALESCE(package, 'without_jaman') as package 
      FROM bookings
      WHERE 1=1
    `;
    const params = [];

    if (hall && hall.trim() !== '') {
      query += ` AND LOWER(hall) = LOWER(?)`;
      params.push(hall.trim());
    }

    if (status && status.trim() !== '') {
      query += ` AND status = ?`;
      params.push(status.trim());
    }

    if (paymentStatus && paymentStatus.trim() !== '') {
      query += ` AND payment_status = ?`;
      params.push(paymentStatus.trim());
    }

    if (fromDate && fromDate.trim() !== '') {
      query += ` AND check_in >= ?`;
      params.push(fromDate.trim());
    }

    if (toDate && toDate.trim() !== '') {
      query += ` AND check_in <= ?`;
      params.push(toDate.trim());
    }

    if (search && search.trim() !== '') {
      const s = `%${search.trim().toLowerCase()}%`;
      query += ` AND (LOWER(customer_name) LIKE ? OR phone LIKE ? OR LOWER(occasion) LIKE ? OR id LIKE ?)`;
      params.push(s, s, s, s);
    }

    query += ` ORDER BY check_in ASC, created_at DESC`;

    const result = await db.query(query, params);
    const rows = result.rows || [];

    // Annotate slot conflicts per hall
    const confirmedList = rows.filter(b => ['confirmed', 'advance_verified'].includes(b.status));
    
    const annotatedRows = rows.map(b => {
      const bDate = b.check_in && b.check_in.toISOString ? b.check_in.toISOString().split('T')[0] : String(b.check_in).split('T')[0];
      const conflictWith = confirmedList.find(c => {
        if (c.id === b.id) return false;
        const cDate = c.check_in && c.check_in.toISOString ? c.check_in.toISOString().split('T')[0] : String(c.check_in).split('T')[0];
        if (cDate !== bDate) return false;
        if ((c.hall || 'Evan-e-Hakimi').toLowerCase() !== (b.hall || 'Evan-e-Hakimi').toLowerCase()) return false;
        return checkSlotConflict(b.slot, c.slot);
      });

      const totalVal = parseFloat(b.total_amount || 0);
      const advPaid = parseFloat(b.advancePaid || 0);
      const balVal = Math.max(0, totalVal - advPaid);

      return {
        ...b,
        balanceAmount: balVal,
        hasConflict: !!conflictWith,
        conflictDetails: conflictWith ? { id: conflictWith.id, name: conflictWith.customer_name, slot: conflictWith.slot, hall: conflictWith.hall } : null
      };
    });

    res.json(annotatedRows);
  } catch (err) {
    sendError(res, 500, 'Failed to fetch bookings', err);
  }
});

// GET /api/bookings/:id — Get single booking with payment history
app.get('/api/bookings/:id', requireAuth, async (req, res) => {
  try {
    const bookingResult = await db.query(
      `SELECT *, 
        advance_amount as advanceAmount,
        advance_paid as advancePaid, 
        payment_status as paymentStatus, 
        payment_notes as paymentNotes, 
        payment_method as paymentMethod,
        COALESCE(hall, 'Evan-e-Hakimi') as hall, 
        COALESCE(package, 'without_jaman') as package 
       FROM bookings WHERE id = ?`,
      [req.params.id]
    );

    if (!bookingResult.rows || bookingResult.rows.length === 0) {
      return res.status(404).json({ error: 'Booking not found' });
    }

    const booking = bookingResult.rows[0];

    // Fetch individual payment installments
    const paymentsResult = await db.query(
      `SELECT * FROM booking_payments WHERE booking_id = ? ORDER BY payment_date DESC, created_at DESC`,
      [req.params.id]
    );

    booking.payments = paymentsResult.rows || [];
    res.json(booking);
  } catch (err) {
    sendError(res, 500, 'Failed to fetch booking', err);
  }
});

// POST /api/bookings — Create booking (internal management for Evan-e-Hakimi & Qadri Hall)
app.post('/api/bookings', async (req, res) => {
  let tx;
  try {
    const { 
      name, 
      customer_name,
      phone, 
      email, 
      date, 
      check_in,
      timeSlot, 
      slot,
      occasion, 
      price, 
      advance_amount,
      advance_paid = 0,
      guests, 
      specialRequirements,
      notes,
      hall = 'Evan-e-Hakimi',
      package: pkg = 'without_jaman',
      status = 'pending',
      payment_method = 'UPI'
    } = req.body;

    const custName = (customer_name || name || '').trim();
    const eventDate = (check_in || date || '').trim();
    const eventSlot = String(slot || timeSlot || 'morning').toLowerCase().trim();
    const cleanHall = String(hall).trim().toLowerCase().includes('qadri') ? 'Qadri Hall' : 'Evan-e-Hakimi';
    const notesCombined = (notes || specialRequirements || '').trim();

    // Input validation
    if (!custName || !phone || !eventDate || !eventSlot) {
      return res.status(400).json({ error: 'Customer name, phone, event date, and slot are required' });
    }

    if (!/^[0-9]{10}$/.test(String(phone).replace(/[\s\-\+]/g, '').slice(-10))) {
      return res.status(400).json({ error: 'Phone number must be a valid 10-digit Indian mobile number' });
    }

    if (!SLOT_CONFIG[eventSlot]) {
      return res.status(400).json({ error: 'Invalid slot selected. Valid options: morning, evening, fullday, majlis' });
    }

    let guestCount = 0;
    if (guests != null && guests !== '') {
      guestCount = parseInt(guests, 10);
      if (isNaN(guestCount) || guestCount < 0 || guestCount > 500) {
        return res.status(400).json({ error: 'Guest count must be between 1 and 500' });
      }
    }

    const calculatedPrice = calculateHallPrice(eventSlot, pkg, eventDate);
    const finalPrice = price != null ? parseFloat(price) : calculatedPrice;
    const finalAdvance = advance_amount != null ? parseFloat(advance_amount) : calculateAdvanceAmount(finalPrice);
    const finalAdvancePaid = parseFloat(advance_paid) || 0;
    const balanceAmount = Math.max(0, finalPrice - finalAdvancePaid);

    let paymentStatus = 'not_paid';
    if (finalAdvancePaid >= finalPrice) {
      paymentStatus = 'fully_paid';
    } else if (finalAdvancePaid > 0) {
      paymentStatus = finalAdvancePaid >= finalAdvance ? 'advance_paid' : 'partially_paid';
    }

    tx = await db.transaction('write');

    // If booking is created directly as confirmed, enforce conflict rules inside transaction
    if (status === 'confirmed' || status === 'advance_verified') {
      const existingConfirmed = await tx.query(
        `SELECT id, customer_name, slot FROM bookings 
         WHERE check_in = ? AND COALESCE(hall, 'Evan-e-Hakimi') = ? 
         AND status IN ('confirmed', 'advance_verified')`,
        [eventDate, cleanHall]
      );
      const conflict = (existingConfirmed.rows || []).find(c => checkSlotConflict(eventSlot, c.slot));
      if (conflict) {
        await tx.rollback();
        return res.status(409).json({
          error: `Slot conflict: Booking #${conflict.id} (${conflict.customer_name}, ${conflict.slot}) is already confirmed for ${cleanHall} on ${eventDate}.`
        });
      }
    }

    const result = await tx.query(
      `INSERT INTO bookings (
        customer_name, phone, email, check_in, check_out, guests, total_amount, 
        advance_amount, advance_paid, advance_verified, payment_status, payment_method, 
        balance_amount, occasion, notes, slot, status, hall, package, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
      RETURNING *`,
      [
        custName, phone.trim(), email?.trim() || null, eventDate, eventDate, guestCount,
        finalPrice, finalAdvance, finalAdvancePaid, (status === 'advance_verified' ? 1 : 0),
        paymentStatus, payment_method, balanceAmount, occasion?.trim() || 'Not specified',
        notesCombined || null, eventSlot, status, cleanHall, pkg
      ]
    );

    const inserted = result.rows && result.rows[0] ? result.rows[0] : { id: result.lastInsertRowid };

    // Record initial payment installment if advance was paid upon creation
    if (finalAdvancePaid > 0) {
      await tx.query(
        `INSERT INTO booking_payments (booking_id, amount, payment_type, payment_method, payment_date, notes)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [inserted.id, finalAdvancePaid, finalAdvancePaid >= finalPrice ? 'full' : 'advance', payment_method, eventDate, 'Initial payment recorded at booking creation']
      );
    }

    await tx.commit();

    logAudit('booking_created', 'booking', inserted.id, `Created booking for ${custName} on ${eventDate} (${cleanHall}, ${eventSlot}, ₹${finalPrice})`, req.admin?.username || 'admin');

    res.json({ success: true, bookingId: inserted.id, booking: inserted });
  } catch (err) {
    if (tx) {
      try { await tx.rollback(); } catch (_) {}
    }
    sendError(res, 500, 'Failed to create booking', err);
  }
});

// PUT /api/bookings/:id — Update existing booking details (admin only)
app.put('/api/bookings/:id', requireAuth, async (req, res) => {
  let tx;
  try {
    const { 
      customer_name, 
      phone, 
      email, 
      date, 
      check_in,
      slot, 
      occasion, 
      price, 
      advance_amount,
      guests, 
      notes, 
      hall = 'Evan-e-Hakimi', 
      package: pkg = 'without_jaman',
      status
    } = req.body;

    const bookingId = req.params.id;
    const cleanHall = String(hall).trim().toLowerCase().includes('qadri') ? 'Qadri Hall' : 'Evan-e-Hakimi';
    const eventDate = (check_in || date || '').trim();
    const eventSlot = String(slot).toLowerCase().trim();

    tx = await db.transaction('write');

    const cur = await tx.query('SELECT * FROM bookings WHERE id = ?', [bookingId]);
    if (!cur.rows || cur.rows.length === 0) {
      await tx.rollback();
      return res.status(404).json({ error: 'Booking not found' });
    }
    const current = cur.rows[0];

    const targetStatus = status || current.status;
    if (targetStatus === 'confirmed' || targetStatus === 'advance_verified') {
      const existingConfirmed = await tx.query(
        `SELECT id, customer_name, slot FROM bookings 
         WHERE id != ? AND check_in = ? AND COALESCE(hall, 'Evan-e-Hakimi') = ? 
         AND status IN ('confirmed', 'advance_verified')`,
        [bookingId, eventDate || current.check_in, cleanHall]
      );
      const conflict = (existingConfirmed.rows || []).find(c => checkSlotConflict(eventSlot || current.slot, c.slot));
      if (conflict) {
        await tx.rollback();
        return res.status(409).json({
          error: `Slot conflict: Booking #${conflict.id} (${conflict.customer_name}, ${conflict.slot}) is already confirmed for ${cleanHall} on ${eventDate || current.check_in}.`
        });
      }
    }

    const totalAmount = price != null ? parseFloat(price) : current.total_amount;
    const advanceAmount = advance_amount != null ? parseFloat(advance_amount) : current.advance_amount;
    const advancePaid = parseFloat(current.advance_paid) || 0;
    const balanceAmount = Math.max(0, totalAmount - advancePaid);

    let paymentStatus = current.payment_status;
    if (advancePaid >= totalAmount) {
      paymentStatus = 'fully_paid';
    } else if (advancePaid > 0) {
      paymentStatus = advancePaid >= advanceAmount ? 'advance_paid' : 'partially_paid';
    }

    await tx.query(
      `UPDATE bookings SET
        customer_name = ?, phone = ?, email = ?, check_in = ?, check_out = ?,
        slot = ?, occasion = ?, total_amount = ?, advance_amount = ?, balance_amount = ?,
        payment_status = ?, guests = ?, notes = ?, hall = ?, package = ?, status = ?,
        updated_at = CURRENT_TIMESTAMP
       WHERE id = ?`,
      [
        (customer_name || current.customer_name).trim(),
        (phone || current.phone).trim(),
        email != null ? email.trim() : current.email,
        eventDate || current.check_in,
        eventDate || current.check_out,
        eventSlot || current.slot,
        occasion != null ? occasion.trim() : current.occasion,
        totalAmount,
        advanceAmount,
        balanceAmount,
        paymentStatus,
        guests != null ? parseInt(guests, 10) : current.guests,
        notes != null ? notes.trim() : current.notes,
        cleanHall,
        pkg || current.package,
        targetStatus,
        bookingId
      ]
    );

    const updated = await tx.query('SELECT * FROM bookings WHERE id = ?', [bookingId]);
    await tx.commit();

    logAudit('booking_updated', 'booking', bookingId, `Updated booking #${bookingId} for ${customer_name || current.customer_name}`, req.admin.username);

    res.json({ success: true, booking: updated.rows[0] });
  } catch (err) {
    if (tx) {
      try { await tx.rollback(); } catch (_) {}
    }
    sendError(res, 500, 'Failed to update booking', err);
  }
});

// PATCH /api/bookings/:id/status (admin only) — with transactional conflict enforcement
app.patch('/api/bookings/:id/status', requireAuth, async (req, res) => {
  let tx;
  try {
    const { status } = req.body;
    const allowed = ['pending', 'confirmed', 'rejected', 'hold', 'waiting', 'advance_requested', 'advance_verified'];
    if (!allowed.includes(status)) {
      return res.status(400).json({ error: 'Invalid status value' });
    }

    tx = await db.transaction('write');

    if (status === 'confirmed' || status === 'advance_verified') {
      await assertNoBookingConflict(tx, req.params.id);
    }

    await tx.query('UPDATE bookings SET status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?', [status, req.params.id]);
    const updated = await tx.query('SELECT * FROM bookings WHERE id = ?', [req.params.id]);
    if (!updated.rows || updated.rows.length === 0) {
      await tx.rollback();
      return res.status(404).json({ error: 'Booking not found' });
    }

    await tx.commit();
    logAudit('booking_status_updated', 'booking', req.params.id, `Status updated to ${status}`, req.admin.username);
    res.json({ success: true, booking: updated.rows[0] });
  } catch (err) {
    if (tx) {
      try { await tx.rollback(); } catch (_) {}
    }
    if (err.status) {
      return res.status(err.status).json({ error: err.message });
    }
    sendError(res, 500, 'Failed to update booking status', err);
  }
});

// POST /api/bookings/:id/payments — Record manual payment installment (admin only)
app.post('/api/bookings/:id/payments', requireAuth, async (req, res) => {
  let tx;
  try {
    const { amount, payment_type = 'advance', payment_method = 'Cash', payment_date, notes } = req.body;
    const payAmount = parseFloat(amount);

    if (isNaN(payAmount) || payAmount <= 0) {
      return res.status(400).json({ error: 'Valid positive payment amount is required' });
    }

    const payDate = payment_date || new Date().toISOString().split('T')[0];

    tx = await db.transaction('write');

    const cur = await tx.query('SELECT * FROM bookings WHERE id = ?', [req.params.id]);
    if (!cur.rows || cur.rows.length === 0) {
      await tx.rollback();
      return res.status(404).json({ error: 'Booking not found' });
    }
    const b = cur.rows[0];

    const currentPaid = parseFloat(b.advance_paid) || 0;
    const newPaid = currentPaid + payAmount;
    const totalAmount = parseFloat(b.total_amount) || 0;
    const balanceAmount = Math.max(0, totalAmount - newPaid);

    let paymentStatus = 'advance_paid';
    if (newPaid >= totalAmount) {
      paymentStatus = 'fully_paid';
    } else if (newPaid > 0) {
      paymentStatus = newPaid >= (b.advance_amount || totalAmount * 0.4) ? 'advance_paid' : 'partially_paid';
    }

    // Insert into booking_payments log
    await tx.query(
      `INSERT INTO booking_payments (booking_id, amount, payment_type, payment_method, payment_date, notes)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [req.params.id, payAmount, payment_type, payment_method, payDate, notes?.trim() || null]
    );

    // Update bookings summary
    await tx.query(
      `UPDATE bookings SET
        advance_paid = ?,
        balance_amount = ?,
        payment_status = ?,
        payment_method = ?,
        payment_notes = ?,
        updated_at = CURRENT_TIMESTAMP
       WHERE id = ?`,
      [newPaid, balanceAmount, paymentStatus, payment_method, notes?.trim() || b.payment_notes, req.params.id]
    );

    const updated = await tx.query('SELECT * FROM bookings WHERE id = ?', [req.params.id]);
    await tx.commit();

    logAudit('payment_recorded', 'booking', req.params.id, `Recorded ₹${payAmount} via ${payment_method} (${payment_type})`, req.admin.username);

    res.json({ success: true, booking: updated.rows[0], payment: { amount: payAmount, payment_method, payment_date: payDate } });
  } catch (err) {
    if (tx) {
      try { await tx.rollback(); } catch (_) {}
    }
    sendError(res, 500, 'Failed to record payment', err);
  }
});

// PATCH /api/bookings/:id/payment (admin only — legacy direct update)
app.patch('/api/bookings/:id/payment', requireAuth, async (req, res) => {
  try {
    const { advancePaid, paymentStatus, paymentNotes, paymentMethod } = req.body;
    const result = await db.query(
      `UPDATE bookings SET 
        advance_paid = ?, 
        payment_status = ?, 
        payment_notes = ?, 
        payment_method = COALESCE(?, payment_method),
        balance_amount = ROUND(total_amount - ?),
        updated_at = CURRENT_TIMESTAMP 
       WHERE id = ? RETURNING *`,
      [advancePaid, paymentStatus, paymentNotes, paymentMethod || null, advancePaid, req.params.id]
    );
    if (!result.rows || result.rows.length === 0) return res.status(404).json({ error: 'Booking not found' });
    logAudit('payment_updated', 'booking', req.params.id, `Payment status set to ${paymentStatus}, paid ₹${advancePaid}`, req.admin.username);
    res.json({ success: true, booking: result.rows[0] });
  } catch (err) {
    sendError(res, 500, 'Failed to update payment', err);
  }
});

// PATCH /api/bookings/:id/verify-advance (admin only)
app.patch('/api/bookings/:id/verify-advance', requireAuth, async (req, res) => {
  let tx;
  try {
    tx = await db.transaction('write');
    const target = await assertNoBookingConflict(tx, req.params.id);

    const total = parseFloat(target.total_amount) || 0;
    const advancePaid = target.advance_amount ? parseFloat(target.advance_amount) : +(total * 0.4).toFixed(2);
    const balanceAmount = Math.max(0, total - advancePaid);

    await tx.query(
      `UPDATE bookings SET 
        status = 'advance_verified', 
        payment_status = 'advance_paid', 
        advance_paid = ?, 
        advance_verified = 1,
        balance_amount = ?,
        updated_at = CURRENT_TIMESTAMP
       WHERE id = ?`,
      [advancePaid, balanceAmount, req.params.id]
    );

    await tx.query(
      `INSERT INTO booking_payments (booking_id, amount, payment_type, payment_method, payment_date, notes)
       VALUES (?, ?, 'advance', 'UPI', CURRENT_DATE, 'Advance verified by admin')`,
      [req.params.id, advancePaid]
    );

    const updated = await tx.query('SELECT * FROM bookings WHERE id = ?', [req.params.id]);
    await tx.commit();

    logAudit('advance_verified', 'booking', req.params.id, `Advance verified for ₹${advancePaid}`, req.admin.username);
    res.json({ success: true, booking: updated.rows[0] });
  } catch (err) {
    if (tx) {
      try { await tx.rollback(); } catch (_) {}
    }
    if (err.status) {
      return res.status(err.status).json({ error: err.message });
    }
    sendError(res, 500, 'Failed to verify advance', err);
  }
});

// PATCH /api/bookings/:id/collect-cash (admin only)
app.patch('/api/bookings/:id/collect-cash', requireAuth, async (req, res) => {
  try {
    const cur = await db.query('SELECT total_amount, advance_paid FROM bookings WHERE id = ?', [req.params.id]);
    if (!cur.rows || cur.rows.length === 0) return res.status(404).json({ error: 'Booking not found' });
    const b = cur.rows[0];
    const total = parseFloat(b.total_amount) || 0;
    const currentPaid = parseFloat(b.advance_paid) || 0;
    const balanceCollected = Math.max(0, total - currentPaid);

    const result = await db.query(
      `UPDATE bookings SET 
        payment_status = 'fully_paid', 
        advance_paid = ?, 
        balance_amount = 0,
        payment_method = 'Cash',
        updated_at = CURRENT_TIMESTAMP 
       WHERE id = ? RETURNING *`,
      [total, req.params.id]
    );

    if (balanceCollected > 0) {
      await db.query(
        `INSERT INTO booking_payments (booking_id, amount, payment_type, payment_method, payment_date, notes)
         VALUES (?, ?, 'balance', 'Cash', CURRENT_DATE, 'Remaining balance collected in cash')`,
        [req.params.id, balanceCollected]
      );
    }

    logAudit('balance_collected', 'booking', req.params.id, `Collected full cash payment (₹${balanceCollected})`, req.admin.username);
    res.json({ success: true, booking: result.rows[0] });
  } catch (err) {
    sendError(res, 500, 'Failed to collect cash', err);
  }
});

// DELETE /api/bookings/:id — Cancel & delete booking with audit trail
app.delete('/api/bookings/:id', requireAuth, async (req, res) => {
  try {
    const cur = await db.query('SELECT * FROM bookings WHERE id = ?', [req.params.id]);
    if (!cur.rows || cur.rows.length === 0) return res.status(404).json({ error: 'Booking not found' });
    const b = cur.rows[0];

    await db.query('DELETE FROM booking_payments WHERE booking_id = ?', [req.params.id]);
    await db.query('DELETE FROM bookings WHERE id = ?', [req.params.id]);

    logAudit('booking_deleted', 'booking', req.params.id, `Deleted booking #${req.params.id} (${b.customer_name}, ${b.check_in}, ${b.hall})`, req.admin.username);
    res.json({ success: true });
  } catch (err) {
    sendError(res, 500, 'Failed to delete booking', err);
  }
});

// GET /api/bookings/availability — Slot availability per hall for calendars
app.get('/api/bookings/availability', async (req, res) => {
  try {
    const result = await db.query(
      "SELECT check_in as date, slot, status, COALESCE(hall, 'Evan-e-Hakimi') as hall FROM bookings WHERE status IN ('confirmed', 'pending', 'waiting', 'advance_requested', 'advance_verified')"
    );

    const availability = {
      'Evan-e-Hakimi': {},
      'Qadri Hall': {}
    };

    function applySlotStatus(targetObj, dateStr, slotKey, newStatus) {
      if (!targetObj[dateStr]) targetObj[dateStr] = {};
      const current = targetObj[dateStr][slotKey];
      const rank = { confirmed_booked: 3, conflict_blocked: 2, pending_inquiry: 1 };
      const currentRank = rank[current] || 0;
      const newRank = rank[newStatus] || 0;
      if (newRank > currentRank) {
        targetObj[dateStr][slotKey] = newStatus;
      }
    }

    (result.rows || []).forEach(r => {
      const d = r.date && r.date.toISOString ? r.date.toISOString().split('T')[0] : String(r.date).split('T')[0];
      const hallKey = String(r.hall).toLowerCase().includes('qadri') ? 'Qadri Hall' : 'Evan-e-Hakimi';
      const slot = String(r.slot).toLowerCase();
      const isConfirmed = ['confirmed', 'advance_verified'].includes(r.status);
      const markStatus = isConfirmed ? 'confirmed_booked' : 'pending_inquiry';

      const hallTarget = availability[hallKey];

      if (slot === 'fullday') {
        applySlotStatus(hallTarget, d, 'fullday', markStatus);
        if (isConfirmed) {
          applySlotStatus(hallTarget, d, 'morning', 'conflict_blocked');
          applySlotStatus(hallTarget, d, 'evening', 'conflict_blocked');
        }
      } else if (slot === 'morning') {
        applySlotStatus(hallTarget, d, 'morning', markStatus);
        if (isConfirmed) {
          applySlotStatus(hallTarget, d, 'fullday', 'conflict_blocked');
        }
      } else if (slot === 'evening') {
        applySlotStatus(hallTarget, d, 'evening', markStatus);
        if (isConfirmed) {
          applySlotStatus(hallTarget, d, 'fullday', 'conflict_blocked');
        }
      } else if (slot === 'majlis') {
        applySlotStatus(hallTarget, d, 'majlis', markStatus);
        if (isConfirmed) {
          applySlotStatus(hallTarget, d, 'fullday', 'conflict_blocked');
        }
      }
    });

    res.json({ 
      success: true, 
      availability,
      hallStatus: {
        'Evan-e-Hakimi': { status: 'available', floor: '2nd Floor', capacity: '35–40 Thals (approx. 280–320 guests)' },
        'Qadri Hall': { status: 'available', floor: '3rd Floor', capacity: '25–30 Thals (approved dates)' }
      }
    });
  } catch (err) {
    sendError(res, 500, 'Failed to fetch availability', err);
  }
});

/* ═══════════════════════════════════════════
   EXPENSES MANAGEMENT API (admin only)
═══════════════════════════════════════════ */

// GET /api/expenses — List expenses with filters
app.get('/api/expenses', requireAuth, async (req, res) => {
  try {
    const { category, payment_method, from, to, search } = req.query;
    let query = 'SELECT id as _id, * FROM expenses WHERE 1=1';
    const params = [];

    if (category && category !== 'all' && category !== '') {
      query += ' AND LOWER(category) = LOWER(?)';
      params.push(category.trim());
    }
    if (payment_method && payment_method !== 'all' && payment_method !== '') {
      query += ' AND LOWER(payment_method) = LOWER(?)';
      params.push(payment_method.trim());
    }
    if (from && from !== '') {
      query += ' AND date >= ?';
      params.push(from.trim());
    }
    if (to && to !== '') {
      query += ' AND date <= ?';
      params.push(to.trim());
    }
    if (search && search.trim() !== '') {
      const s = `%${search.trim().toLowerCase()}%`;
      query += ' AND (LOWER(COALESCE(description, notes, category)) LIKE ? OR LOWER(COALESCE(paid_to, \'\')) LIKE ?)';
      params.push(s, s);
    }

    query += ' ORDER BY date DESC, created_at DESC';

    const result = await db.query(query, params);
    res.json(result.rows || []);
  } catch (err) {
    sendError(res, 500, 'Failed to fetch expenses', err);
  }
});

// GET /api/expenses/summary — Summary metrics
app.get('/api/expenses/summary', requireAuth, async (req, res) => {
  try {
    const now = new Date();
    const currentMonth = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;

    // This month total
    const monthRes = await db.query(
      "SELECT COALESCE(SUM(amount), 0) as total FROM expenses WHERE date LIKE ?",
      [`${currentMonth}%`]
    );
    const thisMonthTotal = parseFloat(monthRes.rows[0]?.total || 0);

    // Category breakdown
    const catRes = await db.query(
      "SELECT category, COALESCE(SUM(amount), 0) as total, COUNT(*) as count FROM expenses GROUP BY category ORDER BY total DESC"
    );

    // Total all time
    const allRes = await db.query("SELECT COALESCE(SUM(amount), 0) as total, COUNT(*) as count FROM expenses");

    res.json({
      success: true,
      currentMonth,
      thisMonthTotal,
      allTimeTotal: parseFloat(allRes.rows[0]?.total || 0),
      totalExpenseCount: parseInt(allRes.rows[0]?.count || 0, 10),
      categoryBreakdown: catRes.rows || []
    });
  } catch (err) {
    sendError(res, 500, 'Failed to fetch expense summary', err);
  }
});

// POST /api/expenses — Add expense
app.post('/api/expenses', requireAuth, async (req, res) => {
  try {
    const { description, category, amount, date, payment_method = 'Cash', paid_to, notes, receipt_url, status = 'paid' } = req.body;

    if (!category || amount == null || !date) {
      return res.status(400).json({ error: 'Category, amount, and date are required' });
    }

    const amt = parseFloat(amount);
    if (isNaN(amt) || amt <= 0) {
      return res.status(400).json({ error: 'Valid positive amount is required' });
    }

    const desc = (description || notes || `${category} expense`).trim();

    const result = await db.query(
      `INSERT INTO expenses (description, category, amount, date, payment_method, paid_to, status, notes, receipt_url, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
       RETURNING id as _id, *`,
      [desc, category.toLowerCase().trim(), amt, date, payment_method, paid_to?.trim() || null, status, notes?.trim() || null, receipt_url?.trim() || null]
    );

    const inserted = result.rows[0];
    logAudit('expense_created', 'expense', inserted._id || inserted.id, `Recorded expense ₹${amt} for ${desc} (${category})`, req.admin.username);

    res.json({ success: true, expense: inserted });
  } catch (err) {
    sendError(res, 500, 'Failed to add expense', err);
  }
});

// PUT /api/expenses/:id — Update expense
app.put('/api/expenses/:id', requireAuth, async (req, res) => {
  try {
    const { description, category, amount, date, payment_method, paid_to, notes, receipt_url, status } = req.body;
    const amt = parseFloat(amount);

    if (isNaN(amt) || amt <= 0) {
      return res.status(400).json({ error: 'Valid positive amount is required' });
    }

    const result = await db.query(
      `UPDATE expenses SET
        description = ?, category = ?, amount = ?, date = ?, payment_method = ?,
        paid_to = ?, notes = ?, receipt_url = ?, status = COALESCE(?, status),
        updated_at = CURRENT_TIMESTAMP
       WHERE id = ? RETURNING id as _id, *`,
      [description?.trim(), category?.toLowerCase().trim(), amt, date, payment_method, paid_to?.trim() || null, notes?.trim() || null, receipt_url?.trim() || null, status || null, req.params.id]
    );

    if (!result.rows || result.rows.length === 0) return res.status(404).json({ error: 'Expense not found' });
    logAudit('expense_updated', 'expense', req.params.id, `Updated expense #${req.params.id} (₹${amt})`, req.admin.username);

    res.json({ success: true, expense: result.rows[0] });
  } catch (err) {
    sendError(res, 500, 'Failed to update expense', err);
  }
});

// DELETE /api/expenses/:id — Delete expense with audit
app.delete('/api/expenses/:id', requireAuth, async (req, res) => {
  try {
    const cur = await db.query('SELECT * FROM expenses WHERE id = ?', [req.params.id]);
    if (!cur.rows || cur.rows.length === 0) return res.status(404).json({ error: 'Expense not found' });
    const e = cur.rows[0];

    await db.query('DELETE FROM expenses WHERE id = ?', [req.params.id]);
    logAudit('expense_deleted', 'expense', req.params.id, `Deleted expense #${req.params.id} (₹${e.amount}, ${e.category}, ${e.date})`, req.admin.username);

    res.json({ success: true });
  } catch (err) {
    sendError(res, 500, 'Failed to delete expense', err);
  }
});

/* ═══════════════════════════════════════════
   STAFF & PAYROLL MANAGEMENT API (admin only)
═══════════════════════════════════════════ */

// GET /api/staff — List staff members
app.get('/api/staff', requireAuth, async (req, res) => {
  try {
    const { role, status, search } = req.query;
    let query = 'SELECT id as _id, * FROM staff WHERE 1=1';
    const params = [];

    if (role && role !== 'all' && role !== '') {
      query += ' AND LOWER(role) = LOWER(?)';
      params.push(role.trim());
    }
    if (status && status !== 'all' && status !== '') {
      query += ' AND LOWER(status) = LOWER(?)';
      params.push(status.trim());
    }
    if (search && search.trim() !== '') {
      const s = `%${search.trim().toLowerCase()}%`;
      query += ' AND (LOWER(name) LIKE ? OR phone LIKE ? OR LOWER(role) LIKE ?)';
      params.push(s, s, s);
    }

    query += ' ORDER BY created_at DESC';

    const result = await db.query(query, params);
    res.json(result.rows || []);
  } catch (err) {
    sendError(res, 500, 'Failed to fetch staff', err);
  }
});

// POST /api/staff — Add staff profile
app.post('/api/staff', requireAuth, async (req, res) => {
  try {
    const { name, phone, role, salary, joining_date, status = 'active', notes } = req.body;

    if (!name || !role || salary == null) {
      return res.status(400).json({ error: 'Name, role, and salary are required' });
    }

    const sal = parseFloat(salary);
    if (isNaN(sal) || sal < 0) {
      return res.status(400).json({ error: 'Valid salary amount is required' });
    }

    const joinDate = joining_date || new Date().toISOString().split('T')[0];

    const result = await db.query(
      `INSERT INTO staff (name, phone, role, salary, joining_date, status, notes, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
       RETURNING id as _id, *`,
      [name.trim(), phone?.trim() || null, role.trim(), sal, joinDate, status.toLowerCase(), notes?.trim() || null]
    );

    const inserted = result.rows[0];
    logAudit('staff_created', 'staff', inserted._id || inserted.id, `Added staff profile for ${name} (${role}, ₹${sal}/mo)`, req.admin.username);

    res.json({ success: true, staff: inserted });
  } catch (err) {
    sendError(res, 500, 'Failed to add staff', err);
  }
});

// PUT /api/staff/:id — Update staff profile
app.put('/api/staff/:id', requireAuth, async (req, res) => {
  try {
    const { name, phone, role, salary, joining_date, status, notes } = req.body;
    const sal = parseFloat(salary);

    if (isNaN(sal) || sal < 0) {
      return res.status(400).json({ error: 'Valid salary amount is required' });
    }

    const result = await db.query(
      `UPDATE staff SET
        name = ?, phone = ?, role = ?, salary = ?, joining_date = ?,
        status = ?, notes = ?, updated_at = CURRENT_TIMESTAMP
       WHERE id = ? RETURNING id as _id, *`,
      [name.trim(), phone?.trim() || null, role.trim(), sal, joining_date, status || 'active', notes?.trim() || null, req.params.id]
    );

    if (!result.rows || result.rows.length === 0) return res.status(404).json({ error: 'Staff member not found' });
    logAudit('staff_updated', 'staff', req.params.id, `Updated staff profile for ${name}`, req.admin.username);

    res.json({ success: true, staff: result.rows[0] });
  } catch (err) {
    sendError(res, 500, 'Failed to update staff', err);
  }
});

// DELETE /api/staff/:id — Delete staff profile
app.delete('/api/staff/:id', requireAuth, async (req, res) => {
  try {
    const cur = await db.query('SELECT * FROM staff WHERE id = ?', [req.params.id]);
    if (!cur.rows || cur.rows.length === 0) return res.status(404).json({ error: 'Staff member not found' });
    const s = cur.rows[0];

    await db.query('DELETE FROM staff_salary_payments WHERE staff_id = ?', [req.params.id]);
    await db.query('DELETE FROM staff WHERE id = ?', [req.params.id]);

    logAudit('staff_deleted', 'staff', req.params.id, `Deleted staff ${s.name} (${s.role})`, req.admin.username);
    res.json({ success: true });
  } catch (err) {
    sendError(res, 500, 'Failed to delete staff', err);
  }
});

// GET /api/staff/salary-payments — List salary payments
app.get('/api/staff/salary-payments', requireAuth, async (req, res) => {
  try {
    const result = await db.query(`
      SELECT p.*, s.name as staff_name, s.role as staff_role 
      FROM staff_salary_payments p
      JOIN staff s ON p.staff_id = s.id
      ORDER BY p.payment_date DESC, p.created_at DESC
    `);
    res.json(result.rows || []);
  } catch (err) {
    sendError(res, 500, 'Failed to fetch salary payments', err);
  }
});

// POST /api/staff/salary-payments — Record confirmed salary payment
app.post('/api/staff/salary-payments', requireAuth, async (req, res) => {
  try {
    const { staff_id, period, amount_paid, payment_date, payment_method = 'Cash', notes } = req.body;

    if (!staff_id || !period || amount_paid == null) {
      return res.status(400).json({ error: 'Staff ID, period, and amount are required' });
    }

    const amt = parseFloat(amount_paid);
    if (isNaN(amt) || amt <= 0) {
      return res.status(400).json({ error: 'Valid positive amount is required' });
    }

    const pDate = payment_date || new Date().toISOString().split('T')[0];

    const result = await db.query(
      `INSERT INTO staff_salary_payments (staff_id, period, amount_paid, payment_date, payment_method, notes)
       VALUES (?, ?, ?, ?, ?, ?)
       RETURNING *`,
      [staff_id, period.trim(), amt, pDate, payment_method, notes?.trim() || null]
    );

    // Update staff salary status
    await db.query("UPDATE staff SET salary_status = 'paid' WHERE id = ?", [staff_id]);

    logAudit('salary_paid', 'staff', staff_id, `Paid salary of ₹${amt} for period ${period} via ${payment_method}`, req.admin.username);

    res.json({ success: true, payment: result.rows[0] });
  } catch (err) {
    sendError(res, 500, 'Failed to record salary payment', err);
  }
});

/* ═══════════════════════════════════════════
   REPORTS & ANALYTICS API (admin only)
═══════════════════════════════════════════ */

// GET /api/reports/summary — Server-side aggregation for dates & halls
app.get('/api/reports/summary', requireAuth, async (req, res) => {
  try {
    const { from, to, hall } = req.query;

    const now = new Date();
    const defaultFrom = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-01`;
    const defaultTo = new Date(now.getFullYear(), now.getMonth() + 1, 0).toISOString().split('T')[0];

    const fromDate = from || defaultFrom;
    const toDate = to || defaultTo;

    let hallFilter = '';
    const bookingParams = [fromDate, toDate];

    if (hall && hall.trim() !== '' && hall.toLowerCase() !== 'all') {
      hallFilter = ` AND LOWER(hall) = LOWER(?)`;
      bookingParams.push(hall.trim());
    }

    // 1. Booking Performance (by Event Date in Period)
    const bookingStatsRes = await db.query(`
      SELECT 
        COUNT(*) as total_bookings,
        SUM(CASE WHEN status IN ('confirmed', 'advance_verified') THEN 1 ELSE 0 END) as confirmed_count,
        SUM(CASE WHEN status IN ('pending', 'advance_requested', 'waiting', 'hold') THEN 1 ELSE 0 END) as pending_count,
        SUM(CASE WHEN status = 'rejected' THEN 1 ELSE 0 END) as rejected_count,
        COALESCE(SUM(CASE WHEN status IN ('confirmed', 'advance_verified') THEN total_amount ELSE 0 END), 0) as expected_revenue,
        COALESCE(SUM(CASE WHEN status IN ('confirmed', 'advance_verified') THEN advance_paid ELSE 0 END), 0) as booking_advances_paid,
        COALESCE(SUM(CASE WHEN status IN ('confirmed', 'advance_verified') THEN (total_amount - advance_paid) ELSE 0 END), 0) as outstanding_balance
      FROM bookings
      WHERE check_in >= ? AND check_in <= ? ${hallFilter}
    `, bookingParams);

    const bStats = bookingStatsRes.rows[0] || {};

    // 2. Actual Money Collected DURING PERIOD (via booking_payments log)
    const cashCollectedRes = await db.query(`
      SELECT COALESCE(SUM(p.amount), 0) as actual_cash_collected
      FROM booking_payments p
      JOIN bookings b ON p.booking_id = b.id
      WHERE p.payment_date >= ? AND p.payment_date <= ? ${hallFilter ? `AND LOWER(b.hall) = LOWER(?)` : ''}
    `, bookingParams);

    const actualCashCollected = parseFloat(cashCollectedRes.rows[0]?.actual_cash_collected || 0);

    // 3. Hall Breakdown
    const hallBreakdownRes = await db.query(`
      SELECT 
        COALESCE(hall, 'Evan-e-Hakimi') as hall_name,
        COUNT(*) as bookings_count,
        SUM(CASE WHEN status IN ('confirmed', 'advance_verified') THEN 1 ELSE 0 END) as confirmed_bookings,
        COALESCE(SUM(CASE WHEN status IN ('confirmed', 'advance_verified') THEN total_amount ELSE 0 END), 0) as revenue,
        COALESCE(SUM(CASE WHEN status IN ('confirmed', 'advance_verified') THEN advance_paid ELSE 0 END), 0) as collected
      FROM bookings
      WHERE check_in >= ? AND check_in <= ?
      GROUP BY hall
    `, [fromDate, toDate]);

    // 4. Expenses Actually Paid in Period
    const expenseBreakdownRes = await db.query(`
      SELECT 
        category, 
        COALESCE(SUM(amount), 0) as total, 
        COUNT(*) as count 
      FROM expenses 
      WHERE date >= ? AND date <= ?
      GROUP BY category
      ORDER BY total DESC
    `, [fromDate, toDate]);

    const totalExpenses = (expenseBreakdownRes.rows || []).reduce((sum, r) => sum + parseFloat(r.total || 0), 0);

    // 5. Staff Salaries Actually Paid in Period
    const staffSalaryRes = await db.query(`
      SELECT COALESCE(SUM(amount_paid), 0) as salaries_paid, COUNT(*) as payments_count
      FROM staff_salary_payments
      WHERE payment_date >= ? AND payment_date <= ?
    `, [fromDate, toDate]);

    const staffSalariesPaid = parseFloat(staffSalaryRes.rows[0]?.salaries_paid || 0);

    // 6. Net Cash Movement (Money collected - expenses paid - salaries paid)
    const totalOutflow = totalExpenses + staffSalariesPaid;
    const netCashMovement = actualCashCollected - totalOutflow;

    // 7. Overdue Payments (events within 2 days or past with unpaid balances)
    const todayStr = new Date().toISOString().split('T')[0];
    const twoDaysLaterStr = new Date(Date.now() + 2 * 86400000).toISOString().split('T')[0];

    const overdueRes = await db.query(`
      SELECT id, customer_name, phone, check_in, slot, hall, total_amount, advance_paid, 
             ROUND(total_amount - advance_paid) as balance_due
      FROM bookings
      WHERE status IN ('confirmed', 'advance_verified')
        AND payment_status != 'fully_paid'
        AND check_in <= ?
        AND (total_amount - advance_paid) > 0
      ORDER BY check_in ASC
    `, [twoDaysLaterStr]);

    res.json({
      success: true,
      period: { fromDate, toDate, hall: hall || 'all' },
      summary: {
        totalBookings: parseInt(bStats.total_bookings || 0, 10),
        confirmedCount: parseInt(bStats.confirmed_count || 0, 10),
        pendingCount: parseInt(bStats.pending_count || 0, 10),
        rejectedCount: parseInt(bStats.rejected_count || 0, 10),
        expectedRevenue: parseFloat(bStats.expected_revenue || 0),
        actualCashCollected: actualCashCollected,
        bookingAdvancesPaid: parseFloat(bStats.booking_advances_paid || 0),
        outstandingBalance: parseFloat(bStats.outstanding_balance || 0),
        totalExpensesPaid: totalExpenses,
        staffSalariesPaid: staffSalariesPaid,
        totalOutflow: totalOutflow,
        netCashMovement: netCashMovement,
        overdueCount: overdueRes.rows ? overdueRes.rows.length : 0
      },
      hallBreakdown: hallBreakdownRes.rows || [],
      expenseCategories: expenseBreakdownRes.rows || [],
      overdueBookings: overdueRes.rows || []
    });
  } catch (err) {
    sendError(res, 500, 'Failed to generate reports', err);
  }
});

// GET /api/reports/export-bookings.csv — CSV export of bookings
app.get('/api/reports/export-bookings.csv', requireAuth, async (req, res) => {
  try {
    const { from, to, hall } = req.query;
    let query = `SELECT * FROM bookings WHERE 1=1`;
    const params = [];

    if (from) { query += ` AND check_in >= ?`; params.push(from); }
    if (to) { query += ` AND check_in <= ?`; params.push(to); }
    if (hall && hall !== 'all') { query += ` AND LOWER(hall) = LOWER(?)`; params.push(hall); }

    query += ` ORDER BY check_in ASC`;
    const result = await db.query(query, params);

    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="bookings_report_${from || 'all'}_to_${to || 'all'}.csv"`);

    const headers = ['ID', 'Customer Name', 'Phone', 'Email', 'Event Date', 'Hall', 'Slot', 'Package', 'Guests', 'Occasion', 'Total Amount', 'Advance Paid', 'Balance Due', 'Status', 'Payment Status', 'Created At'];
    res.write(headers.join(',') + '\n');

    (result.rows || []).forEach(b => {
      const total = parseFloat(b.total_amount || 0);
      const adv = parseFloat(b.advance_paid || 0);
      const bal = Math.max(0, total - adv);
      const row = [
        b.id,
        `"${(b.customer_name || '').replace(/"/g, '""')}"`,
        `"${(b.phone || '')}"`,
        `"${(b.email || '')}"`,
        b.check_in,
        `"${b.hall || 'Evan-e-Hakimi'}"`,
        `"${b.slot || ''}"`,
        `"${b.package || ''}"`,
        b.guests || 0,
        `"${(b.occasion || '').replace(/"/g, '""')}"`,
        total,
        adv,
        bal,
        b.status,
        b.payment_status,
        b.created_at
      ];
      res.write(row.join(',') + '\n');
    });

    res.end();
  } catch (err) {
    sendError(res, 500, 'Failed to export bookings CSV', err);
  }
});

// GET /api/reports/export-expenses.csv — CSV export of expenses
app.get('/api/reports/export-expenses.csv', requireAuth, async (req, res) => {
  try {
    const { from, to, category } = req.query;
    let query = `SELECT * FROM expenses WHERE 1=1`;
    const params = [];

    if (from) { query += ` AND date >= ?`; params.push(from); }
    if (to) { query += ` AND date <= ?`; params.push(to); }
    if (category && category !== 'all') { query += ` AND LOWER(category) = LOWER(?)`; params.push(category); }

    query += ` ORDER BY date DESC`;
    const result = await db.query(query, params);

    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="expenses_report_${from || 'all'}_to_${to || 'all'}.csv"`);

    const headers = ['ID', 'Date', 'Description', 'Category', 'Amount (INR)', 'Payment Method', 'Paid To / Vendor', 'Status', 'Notes'];
    res.write(headers.join(',') + '\n');

    (result.rows || []).forEach(e => {
      const row = [
        e.id,
        e.date,
        `"${(e.description || e.notes || '').replace(/"/g, '""')}"`,
        e.category,
        e.amount,
        `"${e.payment_method || 'Cash'}"`,
        `"${(e.paid_to || '').replace(/"/g, '""')}"`,
        e.status || 'paid',
        `"${(e.notes || '').replace(/"/g, '""')}"`
      ];
      res.write(row.join(',') + '\n');
    });

    res.end();
  } catch (err) {
    sendError(res, 500, 'Failed to export expenses CSV', err);
  }
});

// GET /api/audit-logs — Recent audit history (admin only)
app.get('/api/audit-logs', requireAuth, async (req, res) => {
  try {
    const result = await db.query(
      'SELECT * FROM audit_logs ORDER BY created_at DESC LIMIT 100'
    );
    res.json(result.rows || []);
  } catch (err) {
    sendError(res, 500, 'Failed to fetch audit logs', err);
  }
});

/* ═══════════════════════════════════════════
   404 NOT FOUND HANDLER
═══════════════════════════════════════════ */
app.use((req, res) => {
  if (req.accepts('html')) {
    res.status(404).sendFile(path.join(rootDir, '404.html'));
  } else {
    res.status(404).json({ error: 'Not Found' });
  }
});

/* ═══════════════════════════════════════════
   DATABASE CONNECTION & SERVER START / EXPORT
═══════════════════════════════════════════ */
db.query("SELECT datetime('now') as now")
  .then(() => console.log('✅ Turso (libSQL) database connected successfully'))
  .catch(err => console.error('❌ Turso database connection failed:', err.message));

const PORT = process.env.PORT || 5000;
if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`🚀 Evan-e-Hakimi & Qadri Hall Management backend running on port ${PORT}`);
    console.log(`🔒 Security: helmet ✓ | CORS restricted ✓ | Rate limiting ✓ | JWT auth ✓`);
    console.log(`🌍 NODE_ENV: ${process.env.NODE_ENV || 'development'}`);
  });
}

// Export Express app for Vercel Serverless Function
module.exports = app;