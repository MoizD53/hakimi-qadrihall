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
const memoryCache = require('./cache');
const { dbMetrics } = require('./dbMetrics');

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

  const validUsername = process.env.ADMIN_USERNAME || 'admin';
  const validPassword = process.env.ADMIN_PASSWORD || 'admin2026';

  if (username !== validUsername || password !== validPassword) {
    return res.status(401).json({ error: 'Invalid username or password. Please verify your credentials.' });
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

const CONFIRMED_STATUSES = ['confirmed', 'advance_verified', 'CONFIRMED_PENDING_ADVANCE', 'ADVANCE_PARTIALLY_PAID', 'ADVANCE_PAID', 'FULLY_PAID'];
const ENQUIRY_STATUSES = ['pending', 'NEW_ENQUIRY', 'UNDER_REVIEW', 'waiting', 'hold', 'advance_requested'];
const REJECTED_STATUSES = ['rejected', 'REJECTED', 'cancelled', 'CANCELLED'];

function normalizePhone(phone) {
  if (!phone) return '';
  const digits = String(phone).replace(/\D/g, '');
  if (digits.length === 10) return '91' + digits;
  if (digits.length === 11 && digits.startsWith('0')) return '91' + digits.slice(1);
  if (digits.length === 12 && digits.startsWith('91')) return digits;
  return digits;
}

function generateBookingReference(hall, id, dateStr) {
  const isQadri = String(hall || '').toLowerCase().includes('qadri');
  const prefix = isQadri ? 'QH' : 'EH';
  const year = dateStr ? String(dateStr).split('T')[0].split('-')[0] : '2026';
  const paddedId = String(id || 0).padStart(4, '0');
  return `${prefix}-${year}-${paddedId}`;
}

function formatEventDate(dateStr) {
  if (!dateStr) return 'Event Date';
  const clean = String(dateStr).split('T')[0].trim();
  const parts = clean.split('-');
  if (parts.length === 3) {
    const year = parseInt(parts[0], 10);
    const month = parseInt(parts[1], 10) - 1;
    const day = parseInt(parts[2], 10);
    const months = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
    if (!isNaN(day) && !isNaN(month) && month >= 0 && month < 12 && !isNaN(year)) {
      return `${day} ${months[month]} ${year}`;
    }
  }
  return clean;
}

function formatSlotName(slot) {
  const s = String(slot || '').toLowerCase();
  if (s.includes('majlis')) return 'Majlis Only (Custom Timings)';
  if (s === 'morning' || s.includes('morning')) return 'Morning (10:30 AM – 2:30 PM)';
  if (s === 'evening' || s.includes('evening')) return 'Evening (6:30 PM – 10:30 PM)';
  if (s === 'fullday' || s.includes('full')) return 'Full Day (10:00 AM – 10:00 PM)';
  return slot || 'Morning';
}

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

  // Only Majlis (without jaman, custom timings): 2026: ₹11,000 | 2027: ₹15,000
  if (normalizedSlot === 'majlis') {
    return is2027OrLater ? 15000 : 11000;
  }

  // Morning and Evening slots
  // 2026: ₹15,000 with Jaman, ₹11,000 without Jaman
  // 2027: ₹21,000 with Jaman, ₹15,000 without Jaman
  if (normalizedSlot === 'morning' || normalizedSlot === 'evening') {
    if (pkg === 'without_jaman') {
      return is2027OrLater ? 15000 : 11000;
    }
    return is2027OrLater ? 21000 : 15000;
  }

  return is2027OrLater ? 21000 : 15000;
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
async function assertNoBookingConflict(tx, bookingId, overrideDate, overrideHall, overrideSlot) {
  let target;
  if (bookingId) {
    const current = await tx.query('SELECT * FROM bookings WHERE id = ?', [bookingId]);
    if (!current.rows || current.rows.length === 0) {
      const err = new Error('Booking not found');
      err.status = 404;
      throw err;
    }
    target = current.rows[0];
  } else {
    target = {};
  }

  const rawDate = overrideDate || target.check_in;
  const targetDate = rawDate && rawDate.toISOString 
    ? rawDate.toISOString().split('T')[0] 
    : String(rawDate).split('T')[0];
  const targetHall = (overrideHall || target.hall || 'Evan-e-Hakimi').trim().toLowerCase().includes('qadri') ? 'Qadri Hall' : 'Evan-e-Hakimi';
  const targetSlot = String(overrideSlot || target.slot || 'morning').toLowerCase().trim();

  if (targetHall === 'Qadri Hall' && targetDate < '2026-11-21') {
    const err = new Error('Qadri Hall is available for events starting 21 November 2026. 20 November 2026 and earlier dates are not available.');
    err.status = 400;
    throw err;
  }

  // Check if date is blocked by administration for this hall
  const existingBlock = await tx.query(
    `SELECT * FROM date_blocks WHERE block_date = ? AND hall = ?`,
    [targetDate, targetHall]
  );
  if (existingBlock.rows && existingBlock.rows.length > 0) {
    const blk = existingBlock.rows[0];
    const err = new Error(
      `Date Blocked: ${targetDate} is blocked by administration for ${targetHall}${blk.reason ? ' (' + blk.reason + ')' : ''}. No bookings can be created for this date.`
    );
    err.status = 409;
    throw err;
  }

  // Query existing confirmed bookings inside the write transaction for the SAME hall
  const existingConfirmed = await tx.query(
    `SELECT id, customer_name, slot, status, hall, booking_reference FROM bookings 
     WHERE id != ? AND check_in = ? AND COALESCE(hall, 'Evan-e-Hakimi') = ? 
     AND status IN ('confirmed', 'advance_verified', 'CONFIRMED_PENDING_ADVANCE', 'ADVANCE_PARTIALLY_PAID', 'ADVANCE_PAID', 'FULLY_PAID')`,
    [bookingId || 0, targetDate, targetHall]
  );

  const conflictingBooking = (existingConfirmed.rows || []).find(c => checkSlotConflict(targetSlot, c.slot));
  if (conflictingBooking) {
    const err = new Error(
      `Slot conflict: Booking #${conflictingBooking.id} (${conflictingBooking.customer_name}, slot: ${conflictingBooking.slot}${conflictingBooking.booking_reference ? ', ref: ' + conflictingBooking.booking_reference : ''}) is already confirmed on ${targetDate} for ${targetHall}. Cannot confirm a conflicting slot.`
    );
    err.status = 409;
    throw err;
  }

  return target;
}

// ── CORE AVAILABILITY ENGINE: Independent time slot calculation per hall ──
async function getHallAvailabilityRange(hallName, startDate, endDate) {
  const cleanHall = String(hallName).toLowerCase().includes('qadri') ? 'Qadri Hall' : 'Evan-e-Hakimi';

  // 1. Fetch active bookings (cancelled and rejected bookings NEVER occupy slots)
  const bookingsRes = await db.query(
    `SELECT id, customer_name, phone, check_in as date, slot, status, payment_status, 
            total_amount, advance_paid, balance_amount, booking_reference, occasion
     FROM bookings
     WHERE COALESCE(hall, 'Evan-e-Hakimi') = ?
       AND check_in >= ? AND check_in <= ?
       AND status NOT IN ('cancelled', 'CANCELLED', 'rejected', 'REJECTED')
     ORDER BY check_in ASC, slot ASC`,
    [cleanHall, startDate, endDate]
  );

  // 2. Fetch date blocks in range
  const blocksRes = await db.query(
    `SELECT id, block_date as date, reason, created_by, created_at
     FROM date_blocks
     WHERE hall = ? AND block_date >= ? AND block_date <= ?`,
    [cleanHall, startDate, endDate]
  );

  const blockMap = {};
  (blocksRes.rows || []).forEach(r => {
    const d = String(r.date).split('T')[0];
    blockMap[d] = r;
  });

  const bookingsByDate = {};
  (bookingsRes.rows || []).forEach(r => {
    const d = String(r.date).split('T')[0];
    if (!bookingsByDate[d]) bookingsByDate[d] = [];
    bookingsByDate[d].push({
      ...r,
      date: d,
      slot: String(r.slot || 'morning').toLowerCase().trim()
    });
  });

  const days = {};
  // Parse startDate and endDate safely (YYYY-MM-DD)
  const [sY, sM, sD] = startDate.split('-').map(Number);
  const [eY, eM, eD] = endDate.split('-').map(Number);
  const startDt = new Date(Date.UTC(sY, sM - 1, sD));
  const endDt = new Date(Date.UTC(eY, eM - 1, eD));

  const curr = new Date(startDt);
  while (curr <= endDt) {
    const dateStr = curr.toISOString().split('T')[0];

    // Check if blocked by admin
    if (blockMap[dateStr]) {
      const blk = blockMap[dateStr];
      days[dateStr] = {
        date: dateStr,
        hall: cleanHall,
        color: 'red',
        status: 'booked',
        label: 'Fully Booked (Date Blocked)',
        is_blocked: true,
        block_reason: blk.reason || 'Blocked by administration',
        block_id: blk.id,
        slots: {
          morning: { available: false, label: 'Blocked by Admin' },
          evening: { available: false, label: 'Blocked by Admin' },
          fullday: { available: false, label: 'Blocked by Admin' }
        },
        bookings: []
      };
      curr.setUTCDate(curr.getUTCDate() + 1);
      continue;
    }

    // Check Qadri Hall opening condition (< 21 Nov 2026)
    if (cleanHall === 'Qadri Hall' && dateStr < '2026-11-21') {
      days[dateStr] = {
        date: dateStr,
        hall: cleanHall,
        color: 'red',
        status: 'booked',
        label: 'Opening 21 Nov 2026',
        is_blocked: true,
        block_reason: 'Bookings open from 21 Nov 2026',
        slots: {
          morning: { available: false, label: 'Opens 21 Nov 2026' },
          evening: { available: false, label: 'Opens 21 Nov 2026' },
          fullday: { available: false, label: 'Opens 21 Nov 2026' }
        },
        bookings: []
      };
      curr.setUTCDate(curr.getUTCDate() + 1);
      continue;
    }

    const bList = bookingsByDate[dateStr] || [];
    const morningBooking = bList.find(b => b.slot === 'morning' || b.slot === 'fullday');
    const eveningBooking = bList.find(b => b.slot === 'evening' || b.slot === 'fullday');
    const fulldayBooking = bList.find(b => b.slot === 'fullday');
    const majlisBooking = bList.find(b => b.slot === 'majlis');

    const morningOccupied = !!morningBooking;
    const eveningOccupied = !!eveningBooking;
    const fullDayOccupied = !!fulldayBooking || (morningOccupied && eveningOccupied);

    let color = 'green';
    let status = 'available';
    let label = 'Fully Available';

    if (bList.length === 0) {
      color = 'green';
      status = 'available';
      label = 'Fully Available';
    } else if (fullDayOccupied || (morningOccupied && eveningOccupied)) {
      color = 'red';
      status = 'booked';
      label = 'Fully Booked';
    } else if (morningOccupied && !eveningOccupied) {
      color = 'yellow';
      status = 'partial';
      label = 'Partially Booked (Evening Slot Open)';
    } else if (eveningOccupied && !morningOccupied) {
      color = 'yellow';
      status = 'partial';
      label = 'Partially Booked (Morning Slot Open)';
    } else if (majlisBooking) {
      color = 'yellow';
      status = 'partial';
      label = 'Partially Booked (Majlis Occupied)';
    }

    days[dateStr] = {
      date: dateStr,
      hall: cleanHall,
      color,
      status,
      label,
      is_blocked: false,
      slots: {
        morning: {
          available: !morningOccupied,
          label: morningOccupied ? 'Booked (10:30 AM – 2:30 PM)' : 'Available (10:30 AM – 2:30 PM)'
        },
        evening: {
          available: !eveningOccupied,
          label: eveningOccupied ? 'Booked (6:30 PM – 10:30 PM)' : 'Available (6:30 PM – 10:30 PM)'
        },
        fullday: {
          available: !morningOccupied && !eveningOccupied,
          label: (!morningOccupied && !eveningOccupied) ? 'Available (10:00 AM – 10:00 PM)' : 'Unavailable'
        }
      },
      bookings: bList
    };

    curr.setUTCDate(curr.getUTCDate() + 1);
  }

  return days;
}

/* ═══════════════════════════════════════════
   HALL BOOKING MANAGEMENT API
═══════════════════════════════════════════ */

// GET /api/bookings — List bookings with search & filters (admin only)
app.get('/api/bookings', requireAuth, async (req, res) => {
  try {
    const { hall, status, statusGroup, paymentStatus, search, fromDate, toDate } = req.query;

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

    if (statusGroup && statusGroup.trim() !== '') {
      const sg = statusGroup.trim().toLowerCase();
      if (sg === 'enquiries' || sg === 'new_enquiries') {
        query += ` AND status IN ('NEW_ENQUIRY', 'pending', 'waiting', 'hold', 'UNDER_REVIEW', 'advance_requested')`;
      } else if (sg === 'confirmed') {
        query += ` AND status IN ('confirmed', 'advance_verified', 'CONFIRMED_PENDING_ADVANCE', 'ADVANCE_PARTIALLY_PAID', 'ADVANCE_PAID', 'FULLY_PAID')`;
      } else if (sg === 'pending_advance') {
        query += ` AND status = 'CONFIRMED_PENDING_ADVANCE'`;
      } else if (sg === 'advance_paid') {
        query += ` AND status IN ('ADVANCE_PAID', 'advance_paid', 'advance_verified', 'ADVANCE_PARTIALLY_PAID')`;
      } else if (sg === 'fully_paid') {
        query += ` AND (status = 'FULLY_PAID' OR payment_status = 'fully_paid')`;
      } else if (sg === 'rejected') {
        query += ` AND status IN ('REJECTED', 'rejected', 'cancelled', 'CANCELLED')`;
      }
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
      query += ` AND (LOWER(customer_name) LIKE ? OR phone LIKE ? OR LOWER(occasion) LIKE ? OR id LIKE ? OR LOWER(COALESCE(booking_reference, '')) LIKE ?)`;
      params.push(s, s, s, s, s);
    }

    const limit = Math.min(parseInt(req.query.limit, 10) || 500, 1000);
    const offset = Math.max(parseInt(req.query.offset, 10) || 0, 0);
    query += ` ORDER BY check_in ASC, created_at DESC LIMIT ? OFFSET ?`;
    params.push(limit, offset);

    const result = await db.query(query, params);
    const rows = result.rows || [];

    // Annotate slot conflicts per hall against all confirmed statuses
    const confirmedList = rows.filter(b => CONFIRMED_STATUSES.includes(b.status));
    
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
      const advPaid = parseFloat(b.advancePaid || b.advance_paid || 0);
      const balVal = Math.max(0, totalVal - advPaid);

      const bookingRef = b.booking_reference || (CONFIRMED_STATUSES.includes(b.status) ? generateBookingReference(b.hall, b.id, b.check_in) : null);

      return {
        ...b,
        booking_reference: bookingRef,
        balanceAmount: balVal,
        hasConflict: !!conflictWith,
        conflictDetails: conflictWith ? { id: conflictWith.id, name: conflictWith.customer_name, slot: conflictWith.slot, hall: conflictWith.hall } : null,};
    });

    res.json(annotatedRows);
  } catch (err) {
    sendError(res, 500, 'Failed to fetch bookings', err);
  }
});

// GET /api/bookings/summary — Summary counts for central dashboard (admin only, SQL aggregated & cached)
app.get('/api/bookings/summary', requireAuth, async (req, res) => {
  try {
    const { hall, fromDate, toDate } = req.query;
    const cleanHall = hall && hall !== 'all' ? (String(hall).toLowerCase().includes('qadri') ? 'Qadri Hall' : 'Evan-e-Hakimi') : 'all';
    const cacheKey = `summary:${cleanHall}:${fromDate || ''}:${toDate || ''}`;
    const cached = memoryCache.get(cacheKey);
    if (cached) {
      return res.json(cached);
    }

    const today = new Date().toISOString().split('T')[0];
    let sql = `
      SELECT 
        COUNT(CASE WHEN status NOT IN ('cancelled', 'CANCELLED', 'rejected', 'REJECTED') THEN 1 END) as totalBookings,
        COUNT(CASE WHEN status NOT IN ('cancelled', 'CANCELLED', 'rejected', 'REJECTED') AND check_in >= ? THEN 1 END) as upcomingEvents,
        COUNT(CASE WHEN status IN ('cancelled', 'CANCELLED', 'rejected', 'REJECTED') THEN 1 END) as cancelledBookings,
        COUNT(CASE WHEN status NOT IN ('cancelled', 'CANCELLED', 'rejected', 'REJECTED') AND (payment_status = 'fully_paid' OR status = 'FULLY_PAID') THEN 1 END) as fullyPaidBookings,
        COUNT(CASE WHEN status NOT IN ('cancelled', 'CANCELLED', 'rejected', 'REJECTED') AND (payment_status = 'advance_paid' OR status IN ('ADVANCE_PAID', 'advance_verified')) THEN 1 END) as advanceCollected,
        COUNT(CASE WHEN status NOT IN ('cancelled', 'CANCELLED', 'rejected', 'REJECTED') AND (payment_status = 'advance_paid' OR status IN ('ADVANCE_PAID', 'advance_verified')) AND total_amount > advance_paid THEN 1 END) as remainingBalancePending,
        COUNT(CASE WHEN status NOT IN ('cancelled', 'CANCELLED', 'rejected', 'REJECTED') AND (payment_status NOT IN ('fully_paid', 'advance_paid') AND status NOT IN ('FULLY_PAID', 'ADVANCE_PAID', 'advance_verified')) THEN 1 END) as awaitingAdvance,
        COALESCE(SUM(CASE WHEN status NOT IN ('cancelled', 'CANCELLED', 'rejected', 'REJECTED') THEN total_amount ELSE 0 END), 0) as totalAmountBooked,
        COALESCE(SUM(CASE WHEN status NOT IN ('cancelled', 'CANCELLED', 'rejected', 'REJECTED') THEN advance_paid ELSE 0 END), 0) as actualPaymentsCollected
      FROM bookings WHERE 1=1
    `;
    const params = [today];

    if (cleanHall !== 'all') {
      sql += ' AND COALESCE(hall, "Evan-e-Hakimi") = ?';
      params.push(cleanHall);
    }
    if (fromDate) {
      sql += ' AND check_in >= ?';
      params.push(fromDate);
    }
    if (toDate) {
      sql += ' AND check_in <= ?';
      params.push(toDate);
    }

    const result = await db.query(sql, params);
    const agg = result.rows && result.rows[0] ? result.rows[0] : {};

    const totalBookings = parseInt(agg.totalBookings || 0, 10);
    const upcomingEvents = parseInt(agg.upcomingEvents || 0, 10);
    const cancelledBookings = parseInt(agg.cancelledBookings || 0, 10);
    const fullyPaidBookings = parseInt(agg.fullyPaidBookings || 0, 10);
    const advanceCollected = parseInt(agg.advanceCollected || 0, 10);
    const remainingBalancePending = parseInt(agg.remainingBalancePending || 0, 10);
    const awaitingAdvance = parseInt(agg.awaitingAdvance || 0, 10);
    const totalAmountBooked = parseFloat(agg.totalAmountBooked || 0);
    const actualPaymentsCollected = parseFloat(agg.actualPaymentsCollected || 0);
    const outstandingBalance = Math.max(0, totalAmountBooked - actualPaymentsCollected);

    const responsePayload = {
      success: true,
      totalBookings,
      upcomingEvents,
      awaitingAdvance,
      advanceCollected,
      remainingBalancePending,
      fullyPaidBookings,
      cancelledBookings,
      totalAmountBooked,
      actualPaymentsCollected,
      outstandingBalance,
      // Backward compatibility aliases
      newEnquiries: awaitingAdvance,
      pendingEnquiries: awaitingAdvance,
      confirmedPendingAdvance: awaitingAdvance,
      advancePaid: advanceCollected,
      fullyPaid: fullyPaidBookings,
      rejected: cancelledBookings,
      totalConfirmed: totalBookings,
      totalCollected: actualPaymentsCollected,
      totalOutstanding: outstandingBalance
    };

    memoryCache.set(cacheKey, responsePayload);
    res.json(responsePayload);
  } catch (err) {
    sendError(res, 500, 'Failed to fetch bookings summary', err);
  }
});

// GET /api/bookings/check-availability — Live slot availability check for enquiry workflow
app.get('/api/bookings/check-availability', async (req, res) => {
  try {
    const queryDate = req.query.date || req.query.event_date || req.query.check_in;
    const { hall = 'Evan-e-Hakimi', slot, excludeBookingId } = req.query;
    if (!queryDate) {
      return res.status(400).json({ error: 'Date is required for availability check' });
    }

    const cleanDate = String(queryDate).split('T')[0].trim();
    const cleanHall = String(hall).toLowerCase().includes('qadri') ? 'Qadri Hall' : 'Evan-e-Hakimi';
    const checkSlot = slot ? String(slot).toLowerCase().trim() : null;
    const excludeId = excludeBookingId ? parseInt(excludeBookingId, 10) : 0;

    // Fetch all confirmed bookings on this date for both halls
    const result = await db.query(
      `SELECT id, customer_name, slot, hall, status, booking_reference FROM bookings 
       WHERE check_in = ? AND id != ?
       AND status IN ('confirmed', 'advance_verified', 'CONFIRMED_PENDING_ADVANCE', 'ADVANCE_PARTIALLY_PAID', 'ADVANCE_PAID', 'FULLY_PAID')`,
      [cleanDate, excludeId]
    );

    const bookingsOnDate = result.rows || [];

    const slotBreakdown = (hallName) => {
      const isQadriTarget = hallName.toLowerCase().includes('qadri');
      if (isQadriTarget && cleanDate < '2026-11-21') {
        return {
          morning: { available: false, status: 'UNAVAILABLE_DATE', label: 'Opens 21 Nov 2026', booking: null },
          evening: { available: false, status: 'UNAVAILABLE_DATE', label: 'Opens 21 Nov 2026', booking: null },
          fullday: { available: false, status: 'UNAVAILABLE_DATE', label: 'Opens 21 Nov 2026', booking: null },
          majlis:  { available: false, status: 'UNAVAILABLE_DATE', label: 'Opens 21 Nov 2026', booking: null }
        };
      }

      const hBookings = bookingsOnDate.filter(b => {
        const isQ = (b.hall || 'Evan-e-Hakimi').toLowerCase().includes('qadri');
        return isQadriTarget ? isQ : !isQ;
      });
      
      const slots = {
        morning: { available: true, status: 'AVAILABLE', label: '10:30 AM – 2:30 PM', booking: null },
        evening: { available: true, status: 'AVAILABLE', label: '6:30 PM – 10:30 PM', booking: null },
        fullday: { available: true, status: 'AVAILABLE', label: '10:00 AM – 10:00 PM', booking: null },
        majlis: { available: true, status: 'AVAILABLE', label: 'Custom Timings', booking: null }
      };

      hBookings.forEach(b => {
        const bs = String(b.slot).toLowerCase();
        const bInfo = { id: b.id, name: b.customer_name, ref: b.booking_reference, slot: b.slot };

        if (bs === 'fullday') {
          slots.fullday = { available: false, status: 'ALREADY_BOOKED', label: 'Full Day Booked', booking: bInfo };
          slots.morning = { available: false, status: 'CONFLICT_BLOCKED', label: 'Blocked by Full Day', booking: bInfo };
          slots.evening = { available: false, status: 'CONFLICT_BLOCKED', label: 'Blocked by Full Day', booking: bInfo };
          slots.majlis = { available: false, status: 'CONFLICT_BLOCKED', label: 'Blocked by Full Day', booking: bInfo };
        } else if (bs === 'morning') {
          slots.morning = { available: false, status: 'ALREADY_BOOKED', label: 'Morning Booked', booking: bInfo };
          slots.fullday = { available: false, status: 'CONFLICT_BLOCKED', label: 'Blocked by Morning', booking: bInfo };
        } else if (bs === 'evening') {
          slots.evening = { available: false, status: 'ALREADY_BOOKED', label: 'Evening Booked', booking: bInfo };
          slots.fullday = { available: false, status: 'CONFLICT_BLOCKED', label: 'Blocked by Evening', booking: bInfo };
        } else if (bs === 'majlis') {
          slots.majlis = { available: false, status: 'ALREADY_BOOKED', label: 'Majlis Booked', booking: bInfo };
          slots.fullday = { available: false, status: 'CONFLICT_BLOCKED', label: 'Blocked by Majlis', booking: bInfo };
        }
      });

      return slots;
    };

    const targetHallSlots = slotBreakdown(cleanHall);
    const otherHallName = cleanHall === 'Evan-e-Hakimi' ? 'Qadri Hall' : 'Evan-e-Hakimi';
    const otherHallSlots = slotBreakdown(otherHallName);

    let isAvailable = true;
    let slotStatus = 'AVAILABLE';
    let conflictBooking = null;

    if (cleanHall === 'Qadri Hall' && cleanDate < '2026-11-21') {
      isAvailable = false;
      slotStatus = 'UNAVAILABLE_DATE';
    } else if (checkSlot) {
      const slotInfo = targetHallSlots[checkSlot];
      if (slotInfo) {
        isAvailable = slotInfo.available;
        slotStatus = slotInfo.status;
        conflictBooking = slotInfo.booking;
      }
    }

    res.json({
      success: true,
      date: cleanDate,
      hall: cleanHall,
      slot: checkSlot,
      available: isAvailable,
      status: slotStatus,
      conflictBooking,
      targetHallSlots,
      slots: targetHallSlots,
      bothHalls: {
        [cleanHall]: targetHallSlots,
        [otherHallName]: otherHallSlots
      }
    });
  } catch (err) {
    sendError(res, 500, 'Failed to check availability', err);
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
        COALESCE(balance_amount, (total_amount - advance_paid)) as balanceAmount,
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
    booking.booking_reference = booking.booking_reference || (CONFIRMED_STATUSES.includes(booking.status) ? generateBookingReference(booking.hall, booking.id, booking.check_in) : null);
res.json(booking);
  } catch (err) {
    sendError(res, 500, 'Failed to fetch booking', err);
  }
});

// POST /api/bookings — Create booking or enquiry (Public and Admin)
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
      event_date,
      timeSlot, 
      slot,
      occasion, 
      price, 
      total_amount,
      advance_amount,
      advance_paid = 0,
      start_time,
      end_time,
      guests, 
      specialRequirements,
      notes,
      hall = 'Evan-e-Hakimi',
      package: pkg = 'without_jaman',
      jaman_type,
      status = 'NEW_ENQUIRY',
      payment_method = 'UPI'
    } = req.body;

    const custName = (customer_name || name || '').trim();
    const eventDate = (event_date || check_in || date || '').trim();
    const eventSlot = String(slot || timeSlot || 'morning').toLowerCase().trim();
    const cleanHall = String(hall).trim().toLowerCase().includes('qadri') ? 'Qadri Hall' : 'Evan-e-Hakimi';
    const cleanPkg = jaman_type || pkg || 'without_jaman';
    const notesCombined = (notes || specialRequirements || '').trim();

    // Input validation
    if (!custName || !phone || !eventDate || !eventSlot) {
      return res.status(400).json({ error: 'Customer name, phone, event date, and slot are required' });
    }

    if (cleanHall === 'Qadri Hall' && eventDate < '2026-11-21') {
      return res.status(400).json({ error: 'Qadri Hall is available for events starting 21 November 2026. 20 November 2026 and earlier dates are not available.' });
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

    const calculatedPrice = calculateHallPrice(eventSlot, cleanPkg, eventDate);
    const finalPrice = (total_amount != null || price != null) ? parseFloat(total_amount != null ? total_amount : price) : calculatedPrice;
    const finalAdvance = advance_amount != null ? parseFloat(advance_amount) : calculateAdvanceAmount(finalPrice);
    const finalAdvancePaid = parseFloat(advance_paid) || 0;
    const balanceAmount = Math.max(0, finalPrice - finalAdvancePaid);

    let paymentStatus = 'not_paid';
    if (finalAdvancePaid >= finalPrice) {
      paymentStatus = 'fully_paid';
    } else if (finalAdvancePaid > 0) {
      paymentStatus = finalAdvancePaid >= finalAdvance ? 'advance_paid' : 'partially_paid';
    }

    // Default status for customer submissions is NEW_ENQUIRY (does NOT lock slot until admin confirms)
    let initialStatus = status || 'NEW_ENQUIRY';
    const isDirectConfirm = CONFIRMED_STATUSES.includes(initialStatus);

    tx = await db.transaction('write');

    // Recheck availability against existing confirmed bookings inside transaction
    await assertNoBookingConflict(tx, null, eventDate, cleanHall, eventSlot);

    const result = await tx.query(
      `INSERT INTO bookings (
        customer_name, phone, email, check_in, check_out, guests, total_amount, 
        advance_amount, advance_paid, advance_verified, payment_status, payment_method, 
        balance_amount, occasion, notes, slot, status, hall, package, start_time, end_time, created_by, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
      RETURNING *`,
      [
        custName, phone.trim(), email?.trim() || null, eventDate, eventDate, guestCount,
        finalPrice, finalAdvance, finalAdvancePaid, (initialStatus === 'advance_verified' ? 1 : 0),
        paymentStatus, payment_method, balanceAmount, occasion?.trim() || 'Not specified',
        notesCombined || null, eventSlot, initialStatus, cleanHall, cleanPkg,
        start_time || null, end_time || null, req.admin?.username || 'admin'
      ]
    );

    const inserted = result.rows && result.rows[0] ? result.rows[0] : { id: result.lastInsertRowid };

    // If confirmed upon creation, assign booking reference
    if (isDirectConfirm) {
      const ref = generateBookingReference(cleanHall, inserted.id, eventDate);
      await tx.query('UPDATE bookings SET booking_reference = ?, confirmed_at = CURRENT_TIMESTAMP WHERE id = ?', [ref, inserted.id]);
      inserted.booking_reference = ref;
    }

    // Record initial payment installment if advance was paid upon creation
    if (finalAdvancePaid > 0) {
      await tx.query(
        `INSERT INTO booking_payments (booking_id, amount, payment_type, payment_method, payment_date, notes, created_by)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [inserted.id, finalAdvancePaid, finalAdvancePaid >= finalPrice ? 'full' : 'advance', payment_method, eventDate, 'Initial payment recorded at booking creation', req.admin?.username || 'system']
      );
    }

    await tx.commit();
    memoryCache.invalidateAll();

    logAudit('booking_created', 'booking', inserted.id, `Created ${initialStatus} for ${custName} on ${eventDate} (${cleanHall}, ${eventSlot}, ₹${finalPrice})`, req.admin?.username || 'public_enquiry');
res.json({ success: true, bookingId: inserted.id, booking: inserted });
  } catch (err) {
    if (tx) {
      try { await tx.rollback(); } catch (_) {}
    }
    if (err.status) {
      return res.status(err.status).json({ error: err.message });
    }
    sendError(res, 500, 'Failed to create booking', err);
  }
});

// POST /api/bookings/:id/confirm — Confirm an enquiry with concurrency check, reference, & lock slot
app.post('/api/bookings/:id/confirm', requireAuth, async (req, res) => {
  let tx;
  try {
    const bookingId = req.params.id;
    const { 
      hall, 
      date, 
      check_in, 
      slot, 
      package: pkg, 
      price, 
      advance_amount, 
      customer_name, 
      phone, 
      occasion, 
      guests, 
      notes 
    } = req.body;

    tx = await db.transaction('write');

    const cur = await tx.query('SELECT * FROM bookings WHERE id = ?', [bookingId]);
    if (!cur.rows || cur.rows.length === 0) {
      await tx.rollback();
      return res.status(404).json({ error: 'Booking enquiry not found' });
    }
    const current = cur.rows[0];

    const targetDate = (check_in || date || current.check_in || '').split('T')[0].trim();
    const targetHall = (hall || current.hall || 'Evan-e-Hakimi').trim().toLowerCase().includes('qadri') ? 'Qadri Hall' : 'Evan-e-Hakimi';
    const targetSlot = (slot || current.slot || 'morning').toLowerCase().trim();
    const targetPkg = pkg || current.package || 'without_jaman';

    // Concurrency-safe check against any other confirmed bookings inside the write transaction
    await assertNoBookingConflict(tx, bookingId, targetDate, targetHall, targetSlot);

    // Calculate final amounts
    const calculatedPrice = calculateHallPrice(targetSlot, targetPkg, targetDate);
    const finalPrice = price != null ? parseFloat(price) : (current.total_amount > 0 ? parseFloat(current.total_amount) : calculatedPrice);
    const finalAdvance = advance_amount != null ? parseFloat(advance_amount) : calculateAdvanceAmount(finalPrice);
    const advancePaid = parseFloat(current.advance_paid) || 0;
    const balanceAmount = Math.max(0, finalPrice - advancePaid);

    // Generate unique reference if missing
    const bookingRef = current.booking_reference || generateBookingReference(targetHall, bookingId, targetDate);

    // Status transition: if already fully paid keep fully_paid, otherwise CONFIRMED_PENDING_ADVANCE
    const targetStatus = advancePaid >= finalPrice ? 'FULLY_PAID' : (advancePaid >= finalAdvance ? 'ADVANCE_PAID' : 'CONFIRMED_PENDING_ADVANCE');

    await tx.query(
      `UPDATE bookings SET
        customer_name = ?,
        phone = ?,
        check_in = ?,
        check_out = ?,
        slot = ?,
        hall = ?,
        package = ?,
        total_amount = ?,
        advance_amount = ?,
        balance_amount = ?,
        booking_reference = ?,
        status = ?,
        occasion = ?,
        guests = ?,
        notes = ?,
        confirmed_at = CURRENT_TIMESTAMP,
        updated_at = CURRENT_TIMESTAMP
       WHERE id = ?`,
      [
        (customer_name || current.customer_name).trim(),
        (phone || current.phone).trim(),
        targetDate,
        targetDate,
        targetSlot,
        targetHall,
        targetPkg,
        finalPrice,
        finalAdvance,
        balanceAmount,
        bookingRef,
        targetStatus,
        (occasion || current.occasion || 'Not specified').trim(),
        guests != null ? parseInt(guests, 10) : current.guests,
        (notes || current.notes || null),
        bookingId
      ]
    );

    const updated = await tx.query('SELECT * FROM bookings WHERE id = ?', [bookingId]);
    await tx.commit();

    const bookingRow = updated.rows[0];
logAudit('enquiry_confirmed', 'booking', bookingId, `Enquiry #${bookingId} confirmed as ${bookingRef} for ${bookingRow.customer_name} (${targetHall}, ${targetDate}, ${targetSlot})`, req.admin.username);

    res.json({
      success: true,
      message: `Booking #${bookingId} successfully confirmed with reference ${bookingRef}. Slot is now reserved.`,
      booking: {
        ...bookingRow,
}
    });
  } catch (err) {
    if (tx) {
      try { await tx.rollback(); } catch (_) {}
    }
    if (err.status) {
      return res.status(err.status).json({ error: err.message });
    }
    sendError(res, 500, 'Failed to confirm booking enquiry', err);
  }
});

// POST /api/bookings/:id/reject — Reject an enquiry with reason and audit trail
app.post('/api/bookings/:id/reject', requireAuth, async (req, res) => {
  let tx;
  try {
    const bookingId = req.params.id;
    const { reason = 'Requested slot or date is unavailable' } = req.body;

    tx = await db.transaction('write');

    const cur = await tx.query('SELECT * FROM bookings WHERE id = ?', [bookingId]);
    if (!cur.rows || cur.rows.length === 0) {
      await tx.rollback();
      return res.status(404).json({ error: 'Booking enquiry not found' });
    }
    const current = cur.rows[0];

    await tx.query(
      `UPDATE bookings SET
        status = 'REJECTED',
        rejection_reason = ?,
        rejected_at = CURRENT_TIMESTAMP,
        updated_at = CURRENT_TIMESTAMP
       WHERE id = ?`,
      [reason.trim(), bookingId]
    );

    const updated = await tx.query('SELECT * FROM bookings WHERE id = ?', [bookingId]);
    await tx.commit();

    const bookingRow = updated.rows[0];
logAudit('enquiry_rejected', 'booking', bookingId, `Enquiry #${bookingId} rejected for ${current.customer_name}. Reason: ${reason}`, req.admin.username);

    res.json({
      success: true,
      message: `Enquiry #${bookingId} has been rejected.`,
      booking: {
        ...bookingRow,
}
    });
  } catch (err) {
    if (tx) {
      try { await tx.rollback(); } catch (_) {}
    }
    sendError(res, 500, 'Failed to reject booking enquiry', err);
  }
});

// POST /api/bookings/:id/receive-advance — Record 40% advance payment and mark ADVANCE_PAID
app.post(['/api/bookings/:id/receive-advance', '/api/bookings/:id/verify-advance'], requireAuth, async (req, res) => {
  let tx;
  try {
    const bookingId = req.params.id;
    const { payment_method = 'Cash', notes = '40% advance payment received', payment_date } = req.body;

    tx = await db.transaction('write');

    const cur = await tx.query('SELECT * FROM bookings WHERE id = ?', [bookingId]);
    if (!cur.rows || cur.rows.length === 0) {
      await tx.rollback();
      return res.status(404).json({ error: 'Booking not found' });
    }
    const b = cur.rows[0];

    const total = parseFloat(b.total_amount) || 0;
    const requiredAdvance = b.advance_amount ? parseFloat(b.advance_amount) : Math.round(total * 0.4);
    const currentPaid = parseFloat(b.advance_paid) || 0;
    const advanceToRecord = Math.max(0, requiredAdvance - currentPaid);
    const finalAdvancePaid = currentPaid + advanceToRecord;
    const remainingBalance = Math.max(0, total - finalAdvancePaid);
    const payDate = payment_date || new Date().toISOString().split('T')[0];
    const bookingRef = b.booking_reference || generateBookingReference(b.hall, bookingId, b.check_in);

    if (advanceToRecord > 0) {
      await tx.query(
        `INSERT INTO booking_payments (booking_id, amount, payment_type, payment_method, payment_date, notes, created_by)
         VALUES (?, ?, 'advance', ?, ?, ?, ?)`,
        [bookingId, advanceToRecord, payment_method, payDate, notes?.trim() || '40% advance payment', req.admin.username]
      );
    }

    await tx.query(
      `UPDATE bookings SET
        advance_paid = ?,
        advance_amount = ?,
        balance_amount = ?,
        payment_status = 'advance_paid',
        status = 'ADVANCE_PAID',
        advance_verified = 1,
        booking_reference = ?,
        payment_method = ?,
        payment_notes = ?,
        updated_at = CURRENT_TIMESTAMP
       WHERE id = ?`,
      [finalAdvancePaid, requiredAdvance, remainingBalance, bookingRef, payment_method, notes?.trim() || b.payment_notes, bookingId]
    );

    const updated = await tx.query('SELECT * FROM bookings WHERE id = ?', [bookingId]);
    await tx.commit();

    const bookingRow = updated.rows[0];
logAudit('advance_received', 'booking', bookingId, `Recorded 40% advance of ₹${advanceToRecord} for booking #${bookingId}`, req.admin.username);

    res.json({
      success: true,
      message: `40% advance of ₹${advanceToRecord.toLocaleString('en-IN')} recorded for booking #${bookingId}. Status: ADVANCE_PAID.`,
      booking: {
        ...bookingRow,
}
    });
  } catch (err) {
    if (tx) {
      try { await tx.rollback(); } catch (_) {}
    }
    sendError(res, 500, 'Failed to record advance payment', err);
  }
});

// POST /api/bookings/:id/receive-balance / mark-fully-paid — Mark booking as fully paid and record final settlement
app.post(['/api/bookings/:id/receive-balance', '/api/bookings/:id/mark-fully-paid'], requireAuth, async (req, res) => {
  let tx;
  try {
    const bookingId = req.params.id;
    const { payment_method = 'Cash', notes = 'Final settlement recorded by admin', payment_date } = req.body;

    tx = await db.transaction('write');

    const cur = await tx.query('SELECT * FROM bookings WHERE id = ?', [bookingId]);
    if (!cur.rows || cur.rows.length === 0) {
      await tx.rollback();
      return res.status(404).json({ error: 'Booking not found' });
    }
    const b = cur.rows[0];

    const total = parseFloat(b.total_amount) || 0;
    const paid = parseFloat(b.advance_paid) || 0;
    const remainingBalance = Math.max(0, total - paid);
    const payDate = payment_date || new Date().toISOString().split('T')[0];

    // If there is any remaining balance, insert payment record
    if (remainingBalance > 0) {
      await tx.query(
        `INSERT INTO booking_payments (booking_id, amount, payment_type, payment_method, payment_date, notes, created_by)
         VALUES (?, ?, 'full', ?, ?, ?, ?)`,
        [bookingId, remainingBalance, payment_method, payDate, notes?.trim() || 'Final balance clearance', req.admin.username]
      );
    }

    await tx.query(
      `UPDATE bookings SET
        advance_paid = ?,
        balance_amount = 0,
        payment_status = 'fully_paid',
        status = 'FULLY_PAID',
        payment_method = ?,
        payment_notes = ?,
        updated_at = CURRENT_TIMESTAMP
       WHERE id = ?`,
      [total, payment_method, notes?.trim() || b.payment_notes, bookingId]
    );

    const updated = await tx.query('SELECT * FROM bookings WHERE id = ?', [bookingId]);
    await tx.commit();

    const bookingRow = updated.rows[0];
logAudit('booking_fully_paid', 'booking', bookingId, `Booking #${bookingId} marked as fully paid (₹${total})`, req.admin.username);

    res.json({
      success: true,
      message: `Booking #${bookingId} is marked as fully paid. Outstanding balance is ₹0.`,
      booking: {
        ...bookingRow,
}
    });
  } catch (err) {
    if (tx) {
      try { await tx.rollback(); } catch (_) {}
    }
    sendError(res, 500, 'Failed to mark booking as fully paid', err);
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
    if (CONFIRMED_STATUSES.includes(targetStatus)) {
      await assertNoBookingConflict(tx, bookingId, eventDate || current.check_in, cleanHall, eventSlot || current.slot);
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

    const bookingRef = current.booking_reference || (CONFIRMED_STATUSES.includes(targetStatus) ? generateBookingReference(cleanHall, bookingId, eventDate || current.check_in) : null);

    await tx.query(
      `UPDATE bookings SET
        customer_name = ?, phone = ?, email = ?, check_in = ?, check_out = ?,
        slot = ?, occasion = ?, total_amount = ?, advance_amount = ?, balance_amount = ?,
        payment_status = ?, guests = ?, notes = ?, hall = ?, package = ?, status = ?,
        booking_reference = COALESCE(?, booking_reference),
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
        bookingRef,
        bookingId
      ]
    );

    const updated = await tx.query('SELECT * FROM bookings WHERE id = ?', [bookingId]);
    await tx.commit();

    const bookingRow = updated.rows[0];
logAudit('booking_updated', 'booking', bookingId, `Updated booking #${bookingId} for ${customer_name || current.customer_name}`, req.admin.username);

    res.json({ success: true, booking: bookingRow });
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

// PATCH /api/bookings/:id/status (admin only) — with transactional conflict enforcement
app.patch('/api/bookings/:id/status', requireAuth, async (req, res) => {
  let tx;
  try {
    const { status } = req.body;
    const allowed = ['pending', 'NEW_ENQUIRY', 'UNDER_REVIEW', 'confirmed', 'rejected', 'REJECTED', 'hold', 'waiting', 'advance_requested', 'advance_verified', 'CONFIRMED_PENDING_ADVANCE', 'ADVANCE_PARTIALLY_PAID', 'ADVANCE_PAID', 'FULLY_PAID', 'cancelled'];
    if (!allowed.includes(status)) {
      return res.status(400).json({ error: 'Invalid status value' });
    }

    tx = await db.transaction('write');

    if (CONFIRMED_STATUSES.includes(status)) {
      await assertNoBookingConflict(tx, req.params.id);
    }

    const cur = await tx.query('SELECT * FROM bookings WHERE id = ?', [req.params.id]);
    if (!cur.rows || cur.rows.length === 0) {
      await tx.rollback();
      return res.status(404).json({ error: 'Booking not found' });
    }
    const current = cur.rows[0];

    const bookingRef = current.booking_reference || (CONFIRMED_STATUSES.includes(status) ? generateBookingReference(current.hall, current.id, current.check_in) : null);

    await tx.query(
      `UPDATE bookings SET status = ?, booking_reference = COALESCE(?, booking_reference), updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
      [status, bookingRef, req.params.id]
    );

    const updated = await tx.query('SELECT * FROM bookings WHERE id = ?', [req.params.id]);
    await tx.commit();

    const bookingRow = updated.rows[0];
logAudit('booking_status_updated', 'booking', req.params.id, `Status updated to ${status}`, req.admin.username);
    res.json({ success: true, booking: bookingRow });
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
    const totalAmount = parseFloat(b.total_amount) || 0;
    const currentBalance = Math.max(0, totalAmount - currentPaid);

    if (payAmount > currentBalance) {
      await tx.rollback();
      return res.status(400).json({
        error: `Payment amount ₹${payAmount} exceeds the outstanding balance of ₹${currentBalance}.`
      });
    }

    const newPaid = currentPaid + payAmount;
    const balanceAmount = Math.max(0, totalAmount - newPaid);
    const advanceRequired = parseFloat(b.advance_amount) || Math.round(totalAmount * 0.40);

    let paymentStatus = 'partially_paid';
    let bookingStatus = b.status;

    if (newPaid >= totalAmount) {
      paymentStatus = 'fully_paid';
      bookingStatus = 'FULLY_PAID';
    } else if (newPaid >= advanceRequired) {
      paymentStatus = 'advance_paid';
      bookingStatus = 'ADVANCE_PAID';
    } else if (newPaid > 0) {
      paymentStatus = 'partially_paid';
      bookingStatus = 'ADVANCE_PARTIALLY_PAID';
    }

    // Insert into booking_payments log
    await tx.query(
      `INSERT INTO booking_payments (booking_id, amount, payment_type, payment_method, payment_date, notes, created_by)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [req.params.id, payAmount, payment_type, payment_method, payDate, notes?.trim() || null, req.admin.username]
    );

    // Update bookings summary
    await tx.query(
      `UPDATE bookings SET
        advance_paid = ?,
        balance_amount = ?,
        payment_status = ?,
        status = ?,
        payment_method = ?,
        payment_notes = ?,
        updated_at = CURRENT_TIMESTAMP
       WHERE id = ?`,
      [newPaid, balanceAmount, paymentStatus, bookingStatus, payment_method, notes?.trim() || b.payment_notes, req.params.id]
    );

    const updated = await tx.query('SELECT * FROM bookings WHERE id = ?', [req.params.id]);
    await tx.commit();

    const bookingRow = updated.rows[0];
logAudit('payment_recorded', 'booking', req.params.id, `Recorded ₹${payAmount} via ${payment_method} (${payment_type})`, req.admin.username);

    res.json({
      success: true,
      booking: bookingRow,
      payment: {
        amount: payAmount,
        payment_method,
        payment_date: payDate,
        created_by: req.admin.username
      }
    });
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
    const bookingRef = target.booking_reference || generateBookingReference(target.hall, req.params.id, target.check_in);

    await tx.query(
      `UPDATE bookings SET 
        status = 'ADVANCE_PAID', 
        payment_status = 'advance_paid', 
        advance_paid = ?, 
        advance_verified = 1,
        balance_amount = ?,
        booking_reference = ?,
        updated_at = CURRENT_TIMESTAMP
       WHERE id = ?`,
      [advancePaid, balanceAmount, bookingRef, req.params.id]
    );

    await tx.query(
      `INSERT INTO booking_payments (booking_id, amount, payment_type, payment_method, payment_date, notes, created_by)
       VALUES (?, ?, 'advance', 'UPI', CURRENT_DATE, 'Advance verified by admin', ?)`,
      [req.params.id, advancePaid, req.admin.username]
    );

    const updated = await tx.query('SELECT * FROM bookings WHERE id = ?', [req.params.id]);
    await tx.commit();

    const bookingRow = updated.rows[0];
logAudit('advance_verified', 'booking', req.params.id, `Advance verified for ₹${advancePaid}`, req.admin.username);
    res.json({ success: true, booking: bookingRow });
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
    const cur = await db.query('SELECT total_amount, advance_paid, hall, check_in, booking_reference FROM bookings WHERE id = ?', [req.params.id]);
    if (!cur.rows || cur.rows.length === 0) return res.status(404).json({ error: 'Booking not found' });
    const b = cur.rows[0];
    const total = parseFloat(b.total_amount) || 0;
    const currentPaid = parseFloat(b.advance_paid) || 0;
    const balanceCollected = Math.max(0, total - currentPaid);
    const bookingRef = b.booking_reference || generateBookingReference(b.hall, req.params.id, b.check_in);

    const result = await db.query(
      `UPDATE bookings SET 
        payment_status = 'fully_paid',
        status = 'FULLY_PAID',
        advance_paid = ?, 
        balance_amount = 0,
        payment_method = 'Cash',
        booking_reference = ?,
        updated_at = CURRENT_TIMESTAMP 
       WHERE id = ? RETURNING *`,
      [total, bookingRef, req.params.id]
    );

    if (balanceCollected > 0) {
      await db.query(
        `INSERT INTO booking_payments (booking_id, amount, payment_type, payment_method, payment_date, notes, created_by)
         VALUES (?, ?, 'balance', 'Cash', CURRENT_DATE, 'Remaining balance collected in cash', ?)`,
        [req.params.id, balanceCollected, req.admin.username]
      );
    }

    const bookingRow = result.rows[0];
logAudit('balance_collected', 'booking', req.params.id, `Collected full cash payment (₹${balanceCollected})`, req.admin.username);
    res.json({ success: true, booking: bookingRow });
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

// GET /api/public/calendar — Public sanitized real-time calendar availability per hall (cached)
app.get('/api/public/calendar', async (req, res) => {
  try {
    const { hall = 'Evan-e-Hakimi', month, year } = req.query;
    const cleanHall = String(hall).toLowerCase().includes('qadri') ? 'Qadri Hall' : 'Evan-e-Hakimi';

    // Current India time reference
    const nowIndia = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Asia/Kolkata',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit'
    }).format(new Date());
    const [curYear, curMonth] = nowIndia.split('-').map(Number);

    let targetYear, targetMonth;
    if (month && String(month).includes('-')) {
      const parts = String(month).split('-');
      targetYear = parseInt(parts[0], 10);
      targetMonth = parseInt(parts[1], 10);
    } else if (year && month) {
      targetYear = parseInt(year, 10);
      targetMonth = parseInt(month, 10);
    } else {
      targetYear = curYear;
      targetMonth = curMonth;
    }

    // Safety guard: prevent public calendar requests from querying past months
    if (targetYear < curYear || (targetYear === curYear && targetMonth < curMonth)) {
      targetYear = curYear;
      targetMonth = curMonth;
    }

    const cacheKey = `calendar:${cleanHall}:${targetYear}:${targetMonth}`;
    const cached = memoryCache.get(cacheKey);
    if (cached) {
      res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
      return res.json(cached);
    }

    const startDate = `${targetYear}-${String(targetMonth).padStart(2, '0')}-01`;
    const lastDayNum = new Date(Date.UTC(targetYear, targetMonth, 0)).getUTCDate();
    const endDate = `${targetYear}-${String(targetMonth).padStart(2, '0')}-${String(lastDayNum).padStart(2, '0')}`;

    const rawDays = await getHallAvailabilityRange(cleanHall, startDate, endDate);

    // Sanitize: NEVER leak customer details, phones, amounts, or internal notes
    // For past dates in current month, mark is_past to ensure historical slot data is never exposed
    const sanitizedDays = {};
    for (const [d, info] of Object.entries(rawDays)) {
      if (d < nowIndia) {
        sanitizedDays[d] = {
          date: d,
          hall: cleanHall,
          is_past: true
        };
      } else {
        sanitizedDays[d] = {
          date: info.date,
          hall: info.hall,
          color: info.color,
          status: info.status,
          label: info.label,
          is_blocked: info.is_blocked,
          slots: info.slots
        };
      }
    }

    const payload = {
      success: true,
      hall: cleanHall,
      year: targetYear,
      month: targetMonth,
      startDate,
      endDate,
      today: nowIndia,
      days: sanitizedDays
    };

    memoryCache.set(cacheKey, payload);

    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    res.json(payload);
  } catch (err) {
    sendError(res, 500, 'Failed to fetch public calendar availability', err);
  }
});

// GET /api/bookings/availability — Admin calendar availability with slot details
app.get('/api/bookings/availability', async (req, res) => {
  try {
    const { hall = 'Evan-e-Hakimi', month, year, date, fromDate, toDate } = req.query;
    const cleanHall = String(hall).toLowerCase().includes('qadri') ? 'Qadri Hall' : 'Evan-e-Hakimi';

    let startDate, endDate;
    if (fromDate && toDate) {
      startDate = String(fromDate).split('T')[0];
      endDate = String(toDate).split('T')[0];
    } else if (date) {
      startDate = String(date).split('T')[0];
      endDate = startDate;
    } else {
      let targetYear, targetMonth;
      if (month && String(month).includes('-')) {
        const parts = String(month).split('-');
        targetYear = parseInt(parts[0], 10);
        targetMonth = parseInt(parts[1], 10);
      } else if (year && month) {
        targetYear = parseInt(year, 10);
        targetMonth = parseInt(month, 10);
      } else {
        const now = new Date();
        targetYear = now.getFullYear();
        targetMonth = now.getMonth() + 1;
      }
      startDate = `${targetYear}-${String(targetMonth).padStart(2, '0')}-01`;
      const lastDayNum = new Date(Date.UTC(targetYear, targetMonth, 0)).getUTCDate();
      endDate = `${targetYear}-${String(targetMonth).padStart(2, '0')}-${String(lastDayNum).padStart(2, '0')}`;
    }

    const days = await getHallAvailabilityRange(cleanHall, startDate, endDate);

    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    res.json({
      success: true,
      hall: cleanHall,
      startDate,
      endDate,
      days
    });
  } catch (err) {
    sendError(res, 500, 'Failed to fetch availability', err);
  }
});

// POST /api/bookings/:id/cancel — Admin action: Cancel booking and release occupied slot
app.post('/api/bookings/:id/cancel', requireAuth, async (req, res) => {
  let tx;
  try {
    const bookingId = req.params.id;
    const { 
      reason = 'Cancelled by management upon customer request', 
      refund_status = 'none', 
      refund_amount = 0 
    } = req.body;

    tx = await db.transaction('write');
    const cur = await tx.query('SELECT * FROM bookings WHERE id = ?', [bookingId]);
    if (!cur.rows || cur.rows.length === 0) {
      await tx.rollback();
      return res.status(404).json({ error: 'Booking not found' });
    }
    const b = cur.rows[0];

    await tx.query(
      `UPDATE bookings SET
        status = 'cancelled',
        cancellation_reason = ?,
        cancelled_at = CURRENT_TIMESTAMP,
        cancelled_by = ?,
        refund_status = ?,
        refund_amount = ?,
        updated_at = CURRENT_TIMESTAMP
       WHERE id = ?`,
      [reason.trim(), req.admin.username, refund_status, parseFloat(refund_amount) || 0, bookingId]
    );

    await tx.commit();

    logAudit('booking_cancelled', 'booking', bookingId, 
      `Cancelled booking #${bookingId} (${b.customer_name}). Reason: ${reason}. Refund status: ${refund_status}`, 
      req.admin.username
    );

    res.json({
      success: true,
      message: `Booking #${bookingId} for ${b.customer_name} has been cancelled. The time slot (${b.slot} on ${b.check_in}) is now released.`,
      booking: { id: bookingId, status: 'cancelled', refund_status }
    });
  } catch (err) {
    if (tx) {
      try { await tx.rollback(); } catch (_) {}
    }
    sendError(res, 500, 'Failed to cancel booking', err);
  }
});

// GET /api/date-blocks — List all date blocks (admin only)
app.get('/api/date-blocks', requireAuth, async (req, res) => {
  try {
    const { hall } = req.query;
    let sql = 'SELECT * FROM date_blocks WHERE 1=1';
    const params = [];
    if (hall && hall !== 'all') {
      const cleanHall = String(hall).toLowerCase().includes('qadri') ? 'Qadri Hall' : 'Evan-e-Hakimi';
      sql += ' AND hall = ?';
      params.push(cleanHall);
    }
    sql += ' ORDER BY block_date ASC';
    const result = await db.query(sql, params);
    res.json({ success: true, dateBlocks: result.rows || [] });
  } catch (err) {
    sendError(res, 500, 'Failed to fetch date blocks', err);
  }
});

// POST /api/date-blocks — Block a full date for a hall (admin only)
app.post('/api/date-blocks', requireAuth, async (req, res) => {
  try {
    const { hall, block_date, reason } = req.body;
    if (!block_date) {
      return res.status(400).json({ error: 'block_date is required (YYYY-MM-DD)' });
    }
    const cleanHall = String(hall || '').toLowerCase().includes('qadri') ? 'Qadri Hall' : 'Evan-e-Hakimi';
    const cleanDate = String(block_date).split('T')[0].trim();
    const cleanReason = (reason || 'Blocked by management').trim();

    await db.query(
      `INSERT OR REPLACE INTO date_blocks (hall, block_date, reason, created_by, created_at)
       VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)`,
      [cleanHall, cleanDate, cleanReason, req.admin.username]
    );

    logAudit('date_blocked', 'date_block', null, 
      `Blocked date ${cleanDate} for ${cleanHall} (Reason: ${cleanReason})`, 
      req.admin.username
    );

    res.json({
      success: true,
      message: `Date ${cleanDate} has been blocked for ${cleanHall}. It will appear as fully booked (Red).`
    });
  } catch (err) {
    sendError(res, 500, 'Failed to block date', err);
  }
});

// POST /api/date-blocks/unblock — Unblock date (admin only)
app.post('/api/date-blocks/unblock', requireAuth, async (req, res) => {
  try {
    const { hall, block_date, id } = req.body;
    let sql = 'DELETE FROM date_blocks WHERE ';
    const params = [];
    if (id) {
      sql += 'id = ?';
      params.push(id);
    } else if (hall && block_date) {
      const cleanHall = String(hall).toLowerCase().includes('qadri') ? 'Qadri Hall' : 'Evan-e-Hakimi';
      const cleanDate = String(block_date).split('T')[0].trim();
      sql += 'hall = ? AND block_date = ?';
      params.push(cleanHall, cleanDate);
    } else {
      return res.status(400).json({ error: 'Either id or (hall and block_date) is required' });
    }

    await db.query(sql, params);
    logAudit('date_unblocked', 'date_block', id || null, `Unblocked date for ${hall || 'hall'}`, req.admin.username);

    res.json({
      success: true,
      message: `Date has been unblocked. Availability has been restored.`
    });
  } catch (err) {
    sendError(res, 500, 'Failed to unblock date', err);
  }
});

// DELETE /api/date-blocks/:id — Unblock date by ID (admin only)
app.delete('/api/date-blocks/:id', requireAuth, async (req, res) => {
  try {
    const id = req.params.id;
    await db.query('DELETE FROM date_blocks WHERE id = ?', [id]);
    logAudit('date_unblocked', 'date_block', id, `Unblocked date id ${id}`, req.admin.username);
    res.json({ success: true, message: 'Date block removed' });
  } catch (err) {
    sendError(res, 500, 'Failed to remove date block', err);
  }
});

/* ═══════════════════════════════════════════
   EXPENSES MANAGEMENT API (admin only)
═══════════════════════════════════════════ */

// GET /api/expenses — List expenses with filters
app.get('/api/expenses', requireAuth, async (req, res) => {
  try {
    const { category, payment_method, hall, from, to, search } = req.query;
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
    if (hall && hall !== 'all' && hall !== '') {
      query += ' AND (hall = ? OR hall = "Combined / Facility")';
      params.push(hall.trim());
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
    const { description, category, amount, date, payment_method = 'Cash', paid_to, notes, receipt_url, status = 'paid', hall = 'Evan-e-Hakimi' } = req.body;

    if (!category || amount == null || !date) {
      return res.status(400).json({ error: 'Category, amount, and date are required' });
    }

    const amt = parseFloat(amount);
    if (isNaN(amt) || amt <= 0) {
      return res.status(400).json({ error: 'Valid positive amount is required' });
    }

    const desc = (description || notes || `${category} expense`).trim();

    const result = await db.query(
      `INSERT INTO expenses (description, category, amount, date, payment_method, paid_to, status, notes, receipt_url, hall, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
       RETURNING id as _id, *`,
      [desc, category.toLowerCase().trim(), amt, date, payment_method, paid_to?.trim() || null, status, notes?.trim() || null, receipt_url?.trim() || null, (hall || 'Evan-e-Hakimi').trim()]
    );

    const inserted = result.rows[0];
    logAudit('expense_created', 'expense', inserted._id || inserted.id, `Recorded expense ₹${amt} for ${desc} (${category}, ${hall || 'Evan-e-Hakimi'})`, req.admin.username);

    res.json({ success: true, expense: inserted });
  } catch (err) {
    sendError(res, 500, 'Failed to add expense', err);
  }
});

// PUT /api/expenses/:id — Update expense
app.put('/api/expenses/:id', requireAuth, async (req, res) => {
  try {
    const { description, category, amount, date, payment_method, paid_to, notes, receipt_url, status, hall } = req.body;
    const amt = parseFloat(amount);

    if (isNaN(amt) || amt <= 0) {
      return res.status(400).json({ error: 'Valid positive amount is required' });
    }

    const result = await db.query(
      `UPDATE expenses SET
        description = ?, category = ?, amount = ?, date = ?, payment_method = ?,
        paid_to = ?, notes = ?, receipt_url = ?, status = COALESCE(?, status),
        hall = COALESCE(?, hall),
        updated_at = CURRENT_TIMESTAMP
       WHERE id = ? RETURNING id as _id, *`,
      [description?.trim(), category?.toLowerCase().trim(), amt, date, payment_method, paid_to?.trim() || null, notes?.trim() || null, receipt_url?.trim() || null, status || null, hall?.trim() || null, req.params.id]
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
    const { from, to, category, hall } = req.query;
    let query = `SELECT * FROM expenses WHERE 1=1`;
    const params = [];

    if (from) { query += ` AND date >= ?`; params.push(from); }
    if (to) { query += ` AND date <= ?`; params.push(to); }
    if (category && category !== 'all') { query += ` AND LOWER(category) = LOWER(?)`; params.push(category); }
    if (hall && hall !== 'all') { query += ` AND (hall = ? OR hall = "Combined / Facility")`; params.push(hall); }

    query += ` ORDER BY date DESC`;
    const result = await db.query(query, params);

    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="expenses_report_${from || 'all'}_to_${to || 'all'}.csv"`);

    const headers = ['ID', 'Date', 'Description', 'Venue / Hall', 'Category', 'Amount (INR)', 'Payment Method', 'Paid To / Vendor', 'Status', 'Notes'];
    res.write(headers.join(',') + '\n');

    (result.rows || []).forEach(e => {
      const row = [
        e.id,
        e.date,
        `"${(e.description || e.notes || '').replace(/"/g, '""')}"`,
        `"${e.hall || 'Evan-e-Hakimi'}"`,
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

// GET /api/admin/db-usage — Real-time database quota, tier status & cost telemetry (admin only)
app.get('/api/admin/db-usage', requireAuth, async (req, res) => {
  try {
    const stats = dbMetrics.getStats();
    res.json({
      success: true,
      ...stats
    });
  } catch (err) {
    sendError(res, 500, 'Failed to fetch database usage metrics', err);
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
app.formatEventDate = formatEventDate;
app.formatSlotName = formatSlotName;
module.exports = app;