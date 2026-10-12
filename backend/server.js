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
  methods: ['GET', 'POST', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
  credentials: true
}));

app.use(express.json({ limit: '10kb' })); // prevent huge payloads

/* ═══════════════════════════════════════════
   RATE LIMITING
═══════════════════════════════════════════ */
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many login attempts. Please try again in 15 minutes.' },
  skipSuccessfulRequests: true,
});

const bookingLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'You have exceeded the maximum number of booking requests. Please try again later.' },
});

/* ═══════════════════════════════════════════
   HELPERS
═══════════════════════════════════════════ */
const isProd = process.env.NODE_ENV === 'production';

function sendError(res, status, message, err) {
  if (!isProd && err) {
    console.error('❌', message, err.message);
  }
  return res.status(status).json({ error: message });
}

/* ═══════════════════════════════════════════
   ROUTING & ACCESS-CONTROL RULES
═══════════════════════════════════════════ */

// 1. Clean URL redirects for legacy file extensions (prevents duplicate URLs & redirect loops)
app.get('/index.html', (req, res) => res.redirect(301, '/'));
app.get('/admin.html', (req, res) => res.redirect(301, '/admin'));
app.get('/pay.html', (req, res) => res.redirect(301, '/pay'));

// 2. Canonical page routes
app.get('/', (req, res) => res.sendFile(path.join(rootDir, 'index.html')));
app.get('/admin', (req, res) => res.sendFile(path.join(rootDir, 'admin.html')));
app.get('/pay', (req, res) => res.sendFile(path.join(rootDir, 'pay.html')));

// 3. Block direct static access to server code, database files, and config files
app.use(['/backend', '/local.db', '/package.json', '/package-lock.json', '/vercel.json'], (req, res) => {
  res.status(404).send('Not Found');
});

// 4. Public static assets & resilient asset streaming
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
app.get('/robots.txt', (req, res) => {
  const filePath = path.join(rootDir, 'robots.txt');
  if (fs.existsSync(filePath)) return res.sendFile(filePath);
  streamAssetFromRemote(res, 'robots.txt');
});
app.get('/sitemap.xml', (req, res) => {
  const filePath = path.join(rootDir, 'sitemap.xml');
  if (fs.existsSync(filePath)) return res.sendFile(filePath);
  streamAssetFromRemote(res, 'sitemap.xml');
});

app.use('/assets', express.static(path.join(rootDir, 'assets'), { maxAge: '1y', immutable: true }));
app.use('/js', express.static(path.join(rootDir, 'js'), { maxAge: '1d' }));
app.use(express.static(rootDir));

// 5. Health & Service info routes
app.get('/health', (req, res) => res.status(200).json({
  status: 'ok',
  service: 'Evan-e-Hakimi & Qadri Hall Banquet Backend',
  database: 'Turso (libSQL)',
  time: new Date().toISOString(),
}));

app.get('/api', (req, res) => res.status(200).json({
  service: 'Evan-e-Hakimi & Qadri Hall Banquet API',
  status: 'active',
  endpoints: {
    health: '/api/health',
    availability: '/api/bookings/availability',
    enquiry: 'POST /api/bookings'
  }
}));

app.get('/api/health', (req, res) => res.status(200).json({
  status: 'ok',
  service: 'Evan-e-Hakimi & Qadri Hall Banquet Backend',
  database: 'Turso (libSQL)',
  time: new Date().toISOString(),
}));

/* ═══════════════════════════════════════════
   ADMIN LOGIN
   POST /api/admin/login
═══════════════════════════════════════════ */
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
    { expiresIn: '8h' }
  );

  res.json({ success: true, token });
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
  // Support both (slot, dateStr) and (slot, pkg, dateStr)
  if (dateStr === undefined && typeof pkg === 'string' && (pkg.includes('-') || pkg.includes('/'))) {
    dateStr = pkg;
    pkg = undefined;
  }
  const normalizedSlot = String(slot).toLowerCase().trim();
  const is2027OrLater = isDateOnOrAfterJan2027(dateStr);

  // Full Day is strictly ₹30,000 (includes jaman)
  if (normalizedSlot === 'fullday') {
    return 30000;
  }

  // Only Majlis (without jaman, custom timings): 2026: ₹11,000 | 2027: ₹12,000
  if (normalizedSlot === 'majlis') {
    return is2027OrLater ? 12000 : 11000;
  }

  // Morning and Evening slots (includes jaman): 2026: ₹15,000 | 2027: ₹20,000
  if (normalizedSlot === 'morning' || normalizedSlot === 'evening') {
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

  // Query existing confirmed bookings inside the write transaction
  const existingConfirmed = await tx.query(
    `SELECT id, customer_name, slot, status FROM bookings 
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
   PUBLIC BOOKING ROUTES
═══════════════════════════════════════════ */

// POST /api/bookings — Create new booking enquiry (public)
app.post('/api/bookings', bookingLimiter, async (req, res) => {
  try {
    const { 
      name, 
      phone, 
      email, 
      date, 
      timeSlot, 
      occasion, 
      price, 
      guests, 
      specialRequirements,
      hall = 'Evan-e-Hakimi',
      package: pkg = 'without_jaman'
    } = req.body;

    // ── Hall validation ──
    const normalizedHall = String(hall).trim();
    if (normalizedHall.toLowerCase().includes('qadri')) {
      return res.status(400).json({ 
        error: 'Qadri Hall (3rd Floor) is currently unavailable for booking. Enquiries are only accepted for Evan-e-Hakimi (2nd Floor).' 
      });
    }
    if (normalizedHall.toLowerCase() !== 'evan-e-hakimi' && normalizedHall.toLowerCase() !== 'evan-e-hakimi (2nd floor)') {
      return res.status(400).json({ 
        error: 'Invalid hall selected. Enquiries are only accepted for Evan-e-Hakimi (2nd Floor).' 
      });
    }

    // ── Input validation ──
    if (!name || !phone || !date || !timeSlot || !occasion || price == null) {
      return res.status(400).json({ error: 'Missing required fields: name, phone, date, timeSlot, occasion, price' });
    }
    if (typeof name !== 'string' || name.trim().length < 2 || name.trim().length > 100) {
      return res.status(400).json({ error: 'Name must be between 2 and 100 characters' });
    }
    if (!/^[0-9]{10}$/.test(String(phone).replace(/[\s\-\+]/g, '').slice(-10))) {
      return res.status(400).json({ error: 'Phone number must be a valid 10-digit Indian mobile number' });
    }
    let guestCount = 0;
    if (guests != null && guests !== '') {
      guestCount = parseInt(guests, 10);
      if (isNaN(guestCount) || guestCount < 1 || guestCount > 500) {
        return res.status(400).json({ error: 'Guest count must be between 1 and 500' });
      }
    }
    const bookingDate = new Date(date);
    if (isNaN(bookingDate.getTime()) || bookingDate < new Date(Date.now() - 86400000)) {
      return res.status(400).json({ error: 'Invalid or past booking date' });
    }

    // Validate slot & package pricing strictly against official rates based on selected event date
    const normalizedSlot = String(timeSlot).toLowerCase();
    if (!SLOT_CONFIG[normalizedSlot]) {
      return res.status(400).json({ error: 'Invalid slot selected. Valid options: morning, evening, fullday, majlis' });
    }

    const normalizedPkg = pkg ? String(pkg).toLowerCase() : (normalizedSlot === 'majlis' ? 'without_jaman' : 'with_jaman');
    const expectedPrice = calculateHallPrice(normalizedSlot, normalizedPkg, date);

    const priceNum = parseFloat(price);
    if (isNaN(priceNum) || priceNum !== expectedPrice) {
      return res.status(400).json({ 
        error: `Invalid price amount. Expected ₹${expectedPrice.toLocaleString('en-IN')} for ${normalizedSlot} on ${date}.` 
      });
    }

    const expectedAdvance = calculateAdvanceAmount(expectedPrice);

    let notesCombined = specialRequirements?.trim() || null;
    if (req.body.customTiming && normalizedSlot === 'majlis') {
      notesCombined = `[Custom Majlis Timing: ${req.body.customTiming}] ${notesCombined || ''}`.trim();
    }

    console.log('Booking enquiry submitted:', { 
      name, 
      phone, 
      date, 
      slot: normalizedSlot, 
      hall: 'Evan-e-Hakimi', 
      package: normalizedPkg, 
      price: expectedPrice,
      advance: expectedAdvance,
      customTiming: req.body.customTiming || null
    });

    // Store enquiry in Turso database with advance_amount
    const result = await db.query(
      `INSERT INTO bookings (customer_name, phone, email, check_in, check_out, guests, total_amount, advance_amount, occasion, notes, slot, status, hall, package)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       RETURNING *`,
      [name.trim(), phone.trim(), email?.trim() || null, date, date, guestCount, expectedPrice, expectedAdvance,
       occasion.trim(), notesCombined, normalizedSlot, 'pending', 'Evan-e-Hakimi', normalizedPkg]
    );

    const inserted = result.rows && result.rows[0] ? result.rows[0] : { id: result.lastInsertRowid };
    console.log('Booking enquiry saved, ID:', inserted.id);

    res.json({ success: true, bookingId: inserted.id, booking: inserted });
  } catch (err) {
    console.error('Failed to submit booking:', err);
    sendError(res, 500, 'Failed to create booking', err);
  }
});

// GET /api/bookings/availability — Public slot availability with priority-ranked conflict awareness
app.get('/api/bookings/availability', async (req, res) => {
  try {
    const result = await db.query(
      "SELECT check_in as date, slot, status, COALESCE(hall, 'Evan-e-Hakimi') as hall FROM bookings WHERE status IN ('confirmed', 'pending', 'waiting', 'advance_requested', 'advance_verified')"
    );
    const availability = {};

    function applySlotStatus(dayObj, slotKey, newStatus) {
      const current = dayObj[slotKey];
      // Priority: confirmed_booked (3) > conflict_blocked (2) > pending_inquiry (1) > none (0)
      const rank = { confirmed_booked: 3, conflict_blocked: 2, pending_inquiry: 1 };
      const currentRank = rank[current] || 0;
      const newRank = rank[newStatus] || 0;
      if (newRank > currentRank) {
        dayObj[slotKey] = newStatus;
      }
    }

    (result.rows || []).forEach(r => {
      const d = r.date && r.date.toISOString ? r.date.toISOString().split('T')[0] : String(r.date).split('T')[0];
      if (!availability[d]) availability[d] = {};

      const slot = String(r.slot).toLowerCase();
      const isConfirmed = ['confirmed', 'advance_verified'].includes(r.status);
      const markStatus = isConfirmed ? 'confirmed_booked' : 'pending_inquiry';

      if (slot === 'fullday') {
        applySlotStatus(availability[d], 'fullday', markStatus);
        if (isConfirmed) {
          applySlotStatus(availability[d], 'morning', 'conflict_blocked');
          applySlotStatus(availability[d], 'evening', 'conflict_blocked');
        }
      } else if (slot === 'morning') {
        applySlotStatus(availability[d], 'morning', markStatus);
        if (isConfirmed) {
          applySlotStatus(availability[d], 'fullday', 'conflict_blocked');
        }
      } else if (slot === 'evening') {
        applySlotStatus(availability[d], 'evening', markStatus);
        if (isConfirmed) {
          applySlotStatus(availability[d], 'fullday', 'conflict_blocked');
        }
      }
    });

    res.json({ 
      success: true, 
      availability,
      hallStatus: {
        'Evan-e-Hakimi': { status: 'available', floor: '2nd Floor' },
        'Qadri Hall': { status: 'unavailable', floor: '3rd Floor', notice: 'Currently unavailable for booking' },
        'Evan-e-Qadri': { status: 'unavailable', floor: '3rd Floor', notice: 'Currently unavailable for booking' }
      }
    });
  } catch (err) {
    sendError(res, 500, 'Failed to fetch availability', err);
  }
});

/* ═══════════════════════════════════════════
   PROTECTED ADMIN ROUTES — requireAuth on all
═══════════════════════════════════════════ */

// GET /api/bookings — List all bookings with conflict annotations (admin only)
app.get('/api/bookings', requireAuth, async (req, res) => {
  try {
    const result = await db.query(
      `SELECT *, 
        advance_amount as advanceAmount,
        advance_paid as advancePaid, 
        payment_status as paymentStatus, 
        payment_notes as paymentNotes,
        COALESCE(hall, 'Evan-e-Hakimi') as hall,
        COALESCE(package, 'without_jaman') as package 
       FROM bookings 
       ORDER BY created_at DESC`
    );

    const rows = result.rows || [];
    const confirmedList = rows.filter(b => ['confirmed', 'advance_verified'].includes(b.status));
    
    const annotatedRows = rows.map(b => {
      const bDate = b.check_in && b.check_in.toISOString ? b.check_in.toISOString().split('T')[0] : String(b.check_in).split('T')[0];
      const conflictWith = confirmedList.find(c => {
        if (c.id === b.id) return false;
        const cDate = c.check_in && c.check_in.toISOString ? c.check_in.toISOString().split('T')[0] : String(c.check_in).split('T')[0];
        if (cDate !== bDate) return false;
        if ((c.hall || 'Evan-e-Hakimi') !== (b.hall || 'Evan-e-Hakimi')) return false;
        return checkSlotConflict(b.slot, c.slot);
      });

      return {
        ...b,
        hasConflict: !!conflictWith,
        conflictDetails: conflictWith ? { id: conflictWith.id, name: conflictWith.customer_name, slot: conflictWith.slot } : null
      };
    });

    console.log(`Bookings loaded in admin: ${annotatedRows.length} records`);
    res.json(annotatedRows);
  } catch (err) {
    sendError(res, 500, 'Failed to fetch bookings', err);
  }
});

// GET /api/bookings/:id — Get single booking (admin only)
app.get('/api/bookings/:id', requireAuth, async (req, res) => {
  try {
    const result = await db.query(
      `SELECT *, 
        advance_amount as advanceAmount,
        advance_paid as advancePaid, 
        payment_status as paymentStatus, 
        payment_notes as paymentNotes, 
        COALESCE(hall, 'Evan-e-Hakimi') as hall, 
        COALESCE(package, 'without_jaman') as package 
       FROM bookings WHERE id = ?`,
      [req.params.id]
    );
    if (!result.rows || result.rows.length === 0) return res.status(404).json({ error: 'Booking not found' });
    res.json(result.rows[0]);
  } catch (err) {
    sendError(res, 500, 'Failed to fetch booking', err);
  }
});

// PATCH /api/bookings/:id/status (admin only) — with transactional concurrency enforcement
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

    await tx.query('UPDATE bookings SET status = ? WHERE id = ?', [status, req.params.id]);
    const updated = await tx.query('SELECT * FROM bookings WHERE id = ?', [req.params.id]);
    if (!updated.rows || updated.rows.length === 0) {
      await tx.rollback();
      return res.status(404).json({ error: 'Booking not found' });
    }

    await tx.commit();
    console.log(`Booking ${req.params.id} status updated to: ${status}`);
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

// PATCH /api/bookings/:id/payment (admin only)
app.patch('/api/bookings/:id/payment', requireAuth, async (req, res) => {
  try {
    const { advancePaid, paymentStatus, paymentNotes } = req.body;
    const allowedPayStatus = ['not_paid', 'advance_paid', 'partially_paid', 'fully_paid'];
    if (paymentStatus && !allowedPayStatus.includes(paymentStatus)) {
      return res.status(400).json({ error: 'Invalid payment status' });
    }
    const result = await db.query(
      'UPDATE bookings SET advance_paid = ?, payment_status = ?, payment_notes = ? WHERE id = ? RETURNING *',
      [advancePaid, paymentStatus, paymentNotes, req.params.id]
    );
    if (!result.rows || result.rows.length === 0) return res.status(404).json({ error: 'Booking not found' });
    res.json({ success: true, booking: result.rows[0] });
  } catch (err) {
    sendError(res, 500, 'Failed to update payment', err);
  }
});

// PATCH /api/bookings/:id/verify-advance (admin only) — with transactional conflict enforcement
app.patch('/api/bookings/:id/verify-advance', requireAuth, async (req, res) => {
  let tx;
  try {
    tx = await db.transaction('write');
    const target = await assertNoBookingConflict(tx, req.params.id);

    const total = parseFloat(target.total_amount) || 0;
    const advancePaid = target.advance_amount ? parseFloat(target.advance_amount) : +(total * 0.4).toFixed(2);
    await tx.query(
      'UPDATE bookings SET status = ?, payment_status = ?, advance_paid = ?, advance_verified = 1 WHERE id = ?',
      ['advance_verified', 'advance_paid', advancePaid, req.params.id]
    );
    const updated = await tx.query('SELECT * FROM bookings WHERE id = ?', [req.params.id]);
    await tx.commit();
    console.log(`Booking ${req.params.id} advance verified (status: advance_verified, paid: ${advancePaid})`);
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
    const result = await db.query(
      'UPDATE bookings SET payment_status = ? WHERE id = ? RETURNING *',
      ['fully_paid', req.params.id]
    );
    if (!result.rows || result.rows.length === 0) return res.status(404).json({ error: 'Booking not found' });
    res.json({ success: true, booking: result.rows[0] });
  } catch (err) {
    sendError(res, 500, 'Failed to collect cash', err);
  }
});

// PATCH /api/bookings/:id/paydone (admin only — legacy) — with transactional conflict enforcement
app.patch('/api/bookings/:id/paydone', requireAuth, async (req, res) => {
  let tx;
  try {
    tx = await db.transaction('write');
    await assertNoBookingConflict(tx, req.params.id);
    await tx.query('UPDATE bookings SET status = ? WHERE id = ?', ['confirmed', req.params.id]);
    const updated = await tx.query('SELECT * FROM bookings WHERE id = ?', [req.params.id]);
    await tx.commit();
    res.json({ success: true, booking: updated.rows[0] });
  } catch (err) {
    if (tx) {
      try { await tx.rollback(); } catch (_) {}
    }
    if (err.status) {
      return res.status(err.status).json({ error: err.message });
    }
    sendError(res, 500, 'Failed to update booking', err);
  }
});

/* ── STAFF (admin only) ── */

app.get('/api/staff', requireAuth, async (req, res) => {
  try {
    const result = await db.query(
      'SELECT id as _id, name, role, salary, salary_status as salaryStatus, created_at FROM staff ORDER BY created_at DESC'
    );
    res.json(result.rows || []);
  } catch (err) {
    sendError(res, 500, 'Failed to fetch staff', err);
  }
});

app.post('/api/staff', requireAuth, async (req, res) => {
  try {
    const { name, role, salary, salaryStatus } = req.body;
    if (!name || !role || salary == null) {
      return res.status(400).json({ error: 'Name, role, and salary are required' });
    }
    const result = await db.query(
      'INSERT INTO staff (name, role, salary, salary_status) VALUES (?, ?, ?, ?) RETURNING id as _id, *',
      [name.trim(), role.trim(), salary, salaryStatus || 'pending']
    );
    res.json({ success: true, staff: result.rows[0] });
  } catch (err) {
    sendError(res, 500, 'Failed to add staff', err);
  }
});

app.patch('/api/staff/:id', requireAuth, async (req, res) => {
  try {
    const { salaryStatus } = req.body;
    if (!['paid', 'pending'].includes(salaryStatus)) {
      return res.status(400).json({ error: 'Invalid salary status' });
    }
    const result = await db.query(
      'UPDATE staff SET salary_status = ? WHERE id = ? RETURNING id as _id, *',
      [salaryStatus, req.params.id]
    );
    if (!result.rows || result.rows.length === 0) return res.status(404).json({ error: 'Staff not found' });
    res.json({ success: true, staff: result.rows[0] });
  } catch (err) {
    sendError(res, 500, 'Failed to update staff', err);
  }
});

app.delete('/api/staff/:id', requireAuth, async (req, res) => {
  try {
    const result = await db.query('DELETE FROM staff WHERE id = ?', [req.params.id]);
    res.json({ success: true });
  } catch (err) {
    sendError(res, 500, 'Failed to delete staff', err);
  }
});

/* ── EXPENSES (admin only) ── */

app.get('/api/expenses', requireAuth, async (req, res) => {
  try {
    const result = await db.query(
      'SELECT id as _id, category, amount, date, status, notes, created_at FROM expenses ORDER BY date DESC'
    );
    res.json(result.rows || []);
  } catch (err) {
    sendError(res, 500, 'Failed to fetch expenses', err);
  }
});

app.post('/api/expenses', requireAuth, async (req, res) => {
  try {
    const { category, amount, date, status, notes } = req.body;
    if (!category || amount == null || !date) {
      return res.status(400).json({ error: 'Category, amount, and date are required' });
    }
    const result = await db.query(
      'INSERT INTO expenses (category, amount, date, status, notes) VALUES (?, ?, ?, ?, ?) RETURNING id as _id, *',
      [category, amount, date, status || 'paid', notes?.trim() || null]
    );
    res.json({ success: true, expense: result.rows[0] });
  } catch (err) {
    sendError(res, 500, 'Failed to add expense', err);
  }
});

app.delete('/api/expenses/:id', requireAuth, async (req, res) => {
  try {
    const result = await db.query('DELETE FROM expenses WHERE id = ?', [req.params.id]);
    res.json({ success: true });
  } catch (err) {
    sendError(res, 500, 'Failed to delete expense', err);
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
    console.log(`🚀 Evan-e-Hakimi & Qadri Hall Banquet backend running on port ${PORT}`);
    console.log(`🔒 Security: helmet ✓ | CORS restricted ✓ | Rate limiting ✓ | JWT auth ✓`);
    console.log(`🌍 NODE_ENV: ${process.env.NODE_ENV || 'development'}`);
  });
}

// Export Express app for Vercel Serverless Function
module.exports = app;