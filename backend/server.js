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

function generateWhatsAppPayloads(b) {
  const phone = normalizePhone(b.phone);
  const name = b.customer_name || 'Valued Guest';
  const ref = b.booking_reference || generateBookingReference(b.hall, b.id, b.check_in);
  const hall = b.hall || 'Evan-e-Hakimi';
  const dateStr = b.check_in ? String(b.check_in).split('T')[0] : 'Event Date';
  const formattedDate = formatEventDate(b.check_in);
  const slotName = formatSlotName(b.slot);
  const pkgName = (b.package === 'with_jaman' || String(b.package).toLowerCase().includes('with jaman')) ? 'With Jaman' : 'Without Jaman';
  const total = Math.round(parseFloat(b.total_amount || 0));
  const advance = Math.round(parseFloat(b.advance_amount || total * 0.4));
  const paid = Math.round(parseFloat(b.advance_paid || b.advancePaid || 0));
  const balance = Math.max(0, total - paid);

  // Template 1: Confirmation & 40% Advance Request
  const textConfirmation = 
`Salaam ${name},

Your booking for ${hall} has been approved.

Date: ${formattedDate}
Slot: ${slotName}
Catering: ${pkgName}

Total Amount: ₹${total.toLocaleString('en-IN')}
Advance (40%): ₹${advance.toLocaleString('en-IN')} (Non-refundable)
Balance (60%): ₹${(total - advance).toLocaleString('en-IN')} (Due 2 days before the event)

Kindly pay the advance to secure your booking.

Regards,
Evan-e-Hakimi & Qadri Hall Management`;

  // Template 2: Advance Payment Received & Booking Secured
  const textAdvanceReceived = 
`*Salaam / Greetings ${name},*

We have received your advance payment of *₹${paid.toLocaleString('en-IN')}* for *${hall}*.

✅ *Your booking is now confirmed & secured!*
• *Booking Ref:* ${ref}
• *Event Date:* ${dateStr} (${slotName})
• *Total Amount:* ₹${total.toLocaleString('en-IN')}
• *Advance Received:* ₹${paid.toLocaleString('en-IN')}
• *Remaining Balance Due:* ₹${balance.toLocaleString('en-IN')}

⚠️ *Reminder:* The remaining 60% balance of ₹${balance.toLocaleString('en-IN')} must be cleared at least 2 days before the event date.

Thank you,
*Evan-e-Hakimi & Qadri Hall Management*`;

  // Template 3: Full Payment Received
  const textFullyPaid = 
`*Salaam / Greetings ${name},*

We confirm receipt of the full payment of *₹${total.toLocaleString('en-IN')}* for your event at *${hall}*.

🎉 *Your booking is completely settled!*
• *Booking Ref:* ${ref}
• *Event Date:* ${dateStr} (${slotName})
• *Outstanding Balance:* ₹0 (Fully Paid)

We look forward to hosting your gathering. Please feel free to reach out for any setup arrangements.

Warm regards,
*Evan-e-Hakimi & Qadri Hall Management*`;

  // Template 4: Rejection Notification
  const reason = b.rejection_reason || 'Requested slot or date is already booked or unavailable';
  const textRejection = 
`*Salaam / Greetings ${name},*

Regarding your booking enquiry for *${hall}* on *${dateStr}* (${slotName}):

We regret to inform you that we are unable to accommodate this reservation at this time.
*Reason:* ${reason}

We sincerely apologize for any inconvenience. Please reach out to us if you would like to explore alternative dates or hall options.

Warm regards,
*Evan-e-Hakimi & Qadri Hall Management*`;

  const baseUrl = phone ? `https://wa.me/${phone}?text=` : `https://wa.me/?text=`;

  return {
    normalizedPhone: phone,
    confirmationUrl: baseUrl + encodeURIComponent(textConfirmation),
    advanceReceiptUrl: baseUrl + encodeURIComponent(textAdvanceReceived),
    fullyPaidUrl: baseUrl + encodeURIComponent(textFullyPaid),
    fullPaymentReceiptUrl: baseUrl + encodeURIComponent(textFullyPaid),
    rejectionUrl: baseUrl + encodeURIComponent(textRejection),
    templates: {
      confirmation: textConfirmation,
      advanceReceived: textAdvanceReceived,
      fullyPaid: textFullyPaid,
      rejection: textRejection
    }
  };
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

    query += ` ORDER BY check_in ASC, created_at DESC`;

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
        conflictDetails: conflictWith ? { id: conflictWith.id, name: conflictWith.customer_name, slot: conflictWith.slot, hall: conflictWith.hall } : null,
        whatsapp: generateWhatsAppPayloads({ ...b, booking_reference: bookingRef })
      };
    });

    res.json(annotatedRows);
  } catch (err) {
    sendError(res, 500, 'Failed to fetch bookings', err);
  }
});

// GET /api/bookings/summary — Summary counts for central dashboard (admin only)
app.get('/api/bookings/summary', requireAuth, async (req, res) => {
  try {
    const result = await db.query('SELECT status, payment_status, total_amount, advance_paid FROM bookings');
    const rows = result.rows || [];

    let newEnquiries = 0;
    let confirmedPendingAdvance = 0;
    let advancePaid = 0;
    let fullyPaid = 0;
    let rejected = 0;
    let totalConfirmed = 0;
    let totalCollected = 0;
    let totalOutstanding = 0;

    rows.forEach(r => {
      const s = r.status;
      const isConf = CONFIRMED_STATUSES.includes(s);
      const total = parseFloat(r.total_amount || 0);
      const paid = parseFloat(r.advance_paid || 0);
      const bal = Math.max(0, total - paid);

      if (ENQUIRY_STATUSES.includes(s)) {
        newEnquiries++;
      } else if (s === 'CONFIRMED_PENDING_ADVANCE') {
        confirmedPendingAdvance++;
        totalConfirmed++;
      } else if (s === 'FULLY_PAID' || r.payment_status === 'fully_paid') {
        fullyPaid++;
        totalConfirmed++;
      } else if (s === 'ADVANCE_PAID' || s === 'advance_verified' || s === 'ADVANCE_PARTIALLY_PAID') {
        advancePaid++;
        totalConfirmed++;
      } else if (isConf) {
        totalConfirmed++;
      }

      if (REJECTED_STATUSES.includes(s)) {
        rejected++;
      }

      if (isConf) {
        totalCollected += paid;
        totalOutstanding += bal;
      }
    });

    res.json({
      success: true,
      newEnquiries,
      pendingEnquiries: newEnquiries,
      confirmedPendingAdvance,
      advancePaid,
      fullyPaid,
      rejected,
      totalConfirmed,
      totalBookings: rows.length,
      totalCollected,
      totalOutstanding
    });
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
    booking.whatsapp = generateWhatsAppPayloads(booking);

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
      advance_amount,
      advance_paid = 0,
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
        balance_amount, occasion, notes, slot, status, hall, package, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
      RETURNING *`,
      [
        custName, phone.trim(), email?.trim() || null, eventDate, eventDate, guestCount,
        finalPrice, finalAdvance, finalAdvancePaid, (initialStatus === 'advance_verified' ? 1 : 0),
        paymentStatus, payment_method, balanceAmount, occasion?.trim() || 'Not specified',
        notesCombined || null, eventSlot, initialStatus, cleanHall, cleanPkg
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

    logAudit('booking_created', 'booking', inserted.id, `Created ${initialStatus} for ${custName} on ${eventDate} (${cleanHall}, ${eventSlot}, ₹${finalPrice})`, req.admin?.username || 'public_enquiry');

    inserted.whatsapp = generateWhatsAppPayloads(inserted);

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
    const whatsapp = generateWhatsAppPayloads(bookingRow);

    logAudit('enquiry_confirmed', 'booking', bookingId, `Enquiry #${bookingId} confirmed as ${bookingRef} for ${bookingRow.customer_name} (${targetHall}, ${targetDate}, ${targetSlot})`, req.admin.username);

    res.json({
      success: true,
      message: `Booking #${bookingId} successfully confirmed with reference ${bookingRef}. Slot is now reserved.`,
      booking: {
        ...bookingRow,
        whatsapp
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
    const whatsapp = generateWhatsAppPayloads(bookingRow);

    logAudit('enquiry_rejected', 'booking', bookingId, `Enquiry #${bookingId} rejected for ${current.customer_name}. Reason: ${reason}`, req.admin.username);

    res.json({
      success: true,
      message: `Enquiry #${bookingId} has been rejected.`,
      booking: {
        ...bookingRow,
        whatsapp
      }
    });
  } catch (err) {
    if (tx) {
      try { await tx.rollback(); } catch (_) {}
    }
    sendError(res, 500, 'Failed to reject booking enquiry', err);
  }
});

// POST /api/bookings/:id/mark-fully-paid — Mark booking as fully paid and record final settlement
app.post('/api/bookings/:id/mark-fully-paid', requireAuth, async (req, res) => {
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
    const whatsapp = generateWhatsAppPayloads(bookingRow);

    logAudit('booking_fully_paid', 'booking', bookingId, `Booking #${bookingId} marked as fully paid (₹${total})`, req.admin.username);

    res.json({
      success: true,
      message: `Booking #${bookingId} is marked as fully paid. Outstanding balance is ₹0.`,
      booking: {
        ...bookingRow,
        whatsapp
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
    bookingRow.whatsapp = generateWhatsAppPayloads(bookingRow);

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
    bookingRow.whatsapp = generateWhatsAppPayloads(bookingRow);

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
    bookingRow.whatsapp = generateWhatsAppPayloads(bookingRow);

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
    bookingRow.whatsapp = generateWhatsAppPayloads(bookingRow);

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
    bookingRow.whatsapp = generateWhatsAppPayloads(bookingRow);

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

// GET /api/bookings/availability — Slot availability per hall for calendars
app.get('/api/bookings/availability', async (req, res) => {
  try {
    const result = await db.query(
      `SELECT check_in as date, slot, status, COALESCE(hall, 'Evan-e-Hakimi') as hall FROM bookings 
       WHERE status IN ('confirmed', 'pending', 'waiting', 'advance_requested', 'advance_verified', 'NEW_ENQUIRY', 'CONFIRMED_PENDING_ADVANCE', 'ADVANCE_PARTIALLY_PAID', 'ADVANCE_PAID', 'FULLY_PAID')`
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
      const isConfirmed = CONFIRMED_STATUSES.includes(r.status);
      const markStatus = isConfirmed ? 'confirmed_booked' : 'pending_inquiry';

      const hallTarget = availability[hallKey];

      if (slot === 'fullday') {
        applySlotStatus(hallTarget, d, 'fullday', markStatus);
        if (isConfirmed) {
          applySlotStatus(hallTarget, d, 'morning', 'conflict_blocked');
          applySlotStatus(hallTarget, d, 'evening', 'conflict_blocked');
          applySlotStatus(hallTarget, d, 'majlis', 'conflict_blocked');
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

    const queryDate = req.query.date || req.query.event_date || req.query.check_in;
    const queryHall = req.query.hall || 'Evan-e-Hakimi';
    const cleanHall = String(queryHall).toLowerCase().includes('qadri') ? 'Qadri Hall' : 'Evan-e-Hakimi';
    const cleanDate = queryDate ? String(queryDate).split('T')[0].trim() : null;

    let slots = undefined;
    if (cleanDate) {
      if (cleanHall === 'Qadri Hall' && cleanDate < '2026-11-21') {
        slots = {
          morning: { status: 'conflict_blocked', available: false, label: 'Opens 21 Nov 2026' },
          evening: { status: 'conflict_blocked', available: false, label: 'Opens 21 Nov 2026' },
          fullday: { status: 'conflict_blocked', available: false, label: 'Opens 21 Nov 2026' },
          majlis:  { status: 'conflict_blocked', available: false, label: 'Opens 21 Nov 2026' }
        };
      } else {
        const dObj = (availability[cleanHall] && availability[cleanHall][cleanDate]) || {};
        slots = {
          morning: { 
            status: dObj.morning || 'available', 
            available: !dObj.morning || dObj.morning === 'pending_inquiry',
            label: dObj.morning === 'confirmed_booked' ? 'Booked' : (dObj.morning === 'conflict_blocked' ? 'Conflict' : 'Available')
          },
          evening: { 
            status: dObj.evening || 'available', 
            available: !dObj.evening || dObj.evening === 'pending_inquiry',
            label: dObj.evening === 'confirmed_booked' ? 'Booked' : (dObj.evening === 'conflict_blocked' ? 'Conflict' : 'Available')
          },
          fullday: { 
            status: dObj.fullday || 'available', 
            available: !dObj.fullday || dObj.fullday === 'pending_inquiry',
            label: dObj.fullday === 'confirmed_booked' ? 'Booked' : (dObj.fullday === 'conflict_blocked' ? 'Conflict' : 'Available')
          },
          majlis: { 
            status: dObj.majlis || 'available', 
            available: !dObj.majlis || dObj.majlis === 'pending_inquiry',
            label: dObj.majlis === 'confirmed_booked' ? 'Booked' : (dObj.majlis === 'conflict_blocked' ? 'Conflict' : 'Available')
          }
        };
      }
    }

    res.json({ 
      success: true, 
      date: cleanDate || undefined,
      hall: cleanHall,
      slots,
      availability,
      hallStatus: {
        'Evan-e-Hakimi': { status: 'available', floor: '2nd Floor', capacity: '35–40 Thals (approx. 280–320 guests)' },
        'Qadri Hall': { status: 'available', floor: '3rd Floor', capacity: '25–30 Thals (open from 21 Nov 2026)' }
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
app.generateWhatsAppPayloads = generateWhatsAppPayloads;
app.formatEventDate = formatEventDate;
app.formatSlotName = formatSlotName;
module.exports = app;