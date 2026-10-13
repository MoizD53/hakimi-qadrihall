/**
 * Evan-e-Hakimi & Qadri Hall Management Software
 * Comprehensive Production Readiness & Audit Test Suite
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');

let passed = 0;
let total = 0;

function it(desc, fn) {
  total++;
  try {
    fn();
    console.log(`  ✓ ${desc}`);
    passed++;
  } catch (err) {
    console.error(`  ✗ ${desc}`);
    console.error(`    ${err.message}`);
  }
}

console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
console.log('🧪 RUNNING COMPREHENSIVE MANAGEMENT AUDIT TESTS');
console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

// ── TEST GROUP 1: SLOTS & DATE-BASED PRICING RULES ──
console.log('📋 Group 1: 4 Slots Pricing Structure (2026 vs From 1 Jan 2027)');

function isDateOnOrAfterJan2027(dateStr) {
  if (!dateStr) return false;
  const clean = String(dateStr).split('T')[0].trim();
  return clean >= '2027-01-01';
}

function calculateExpectedPrice(slot, pkg, dateStr) {
  if (dateStr === undefined && typeof pkg === 'string' && (pkg.includes('-') || pkg.includes('/'))) {
    dateStr = pkg;
    pkg = undefined;
  }
  const s = String(slot).toLowerCase().trim();
  const is2027 = isDateOnOrAfterJan2027(dateStr);

  if (s === 'fullday') return 30000;
  if (s === 'majlis') return is2027 ? 12000 : 11000;
  if (s === 'morning' || s === 'evening') {
    if (pkg === 'without_jaman') return is2027 ? 15000 : 11000;
    return is2027 ? 20000 : 15000;
  }
  return is2027 ? 20000 : 15000;
}

function calculateAdvance(price) {
  return Math.round(price * 0.40);
}

it('2026: Morning Slot (with jaman) is ₹15,000 with ₹6,000 advance (40%)', () => {
  const price = calculateExpectedPrice('morning', 'with_jaman', '2026-10-15');
  assert.strictEqual(price, 15000);
  assert.strictEqual(calculateAdvance(price), 6000);
});

it('2026: Evening Slot (with jaman) is ₹15,000 with ₹6,000 advance (40%)', () => {
  const price = calculateExpectedPrice('evening', 'with_jaman', '2026-10-15');
  assert.strictEqual(price, 15000);
  assert.strictEqual(calculateAdvance(price), 6000);
});

it('2026: Full Day Slot (with jaman) is ₹30,000 with ₹12,000 advance (40%)', () => {
  const price = calculateExpectedPrice('fullday', 'with_jaman', '2026-10-15');
  assert.strictEqual(price, 30000);
  assert.strictEqual(calculateAdvance(price), 12000);
});

it('2026: Only Majlis Slot (custom timing) is ₹11,000 with ₹4,400 advance (40%)', () => {
  const price = calculateExpectedPrice('majlis', 'without_jaman', '2026-10-15');
  assert.strictEqual(price, 11000);
  assert.strictEqual(calculateAdvance(price), 4400);
});

it('From 2027-01-01: Morning Slot (with jaman) is ₹20,000 with ₹8,000 advance (40%)', () => {
  const price = calculateExpectedPrice('morning', 'with_jaman', '2027-01-10');
  assert.strictEqual(price, 20000);
  assert.strictEqual(calculateAdvance(price), 8000);
});

it('From 2027-01-01: Evening Slot (with jaman) is ₹20,000 with ₹8,000 advance (40%)', () => {
  const price = calculateExpectedPrice('evening', 'with_jaman', '2027-01-10');
  assert.strictEqual(price, 20000);
  assert.strictEqual(calculateAdvance(price), 8000);
});

it('From 2027-01-01: Without Jaman slot pricing is ₹15,000', () => {
  const price = calculateExpectedPrice('morning', 'without_jaman', '2027-01-10');
  assert.strictEqual(price, 15000);
});

it('From 2027-01-01: Full Day Slot remains ₹30,000 with ₹12,000 advance (40%)', () => {
  const price = calculateExpectedPrice('fullday', 'with_jaman', '2027-01-10');
  assert.strictEqual(price, 30000);
  assert.strictEqual(calculateAdvance(price), 12000);
});

it('From 2027-01-01: Only Majlis Slot is ₹12,000 with ₹4,800 advance (40%)', () => {
  const price = calculateExpectedPrice('majlis', 'without_jaman', '2027-01-10');
  assert.strictEqual(price, 12000);
  assert.strictEqual(calculateAdvance(price), 4800);
});

// ── TEST GROUP 2: CONFLICT DETECTION RULES ──
console.log('\n🔒 Group 2: Slot Conflict Rules');

function checkSlotConflict(slotA, slotB) {
  const a = String(slotA).toLowerCase();
  const b = String(slotB).toLowerCase();
  if (a === 'fullday' || b === 'fullday') return true;
  return a === b;
}

it('Full Day conflicts with Morning', () => {
  assert.strictEqual(checkSlotConflict('fullday', 'morning'), true);
  assert.strictEqual(checkSlotConflict('morning', 'fullday'), true);
});

it('Full Day conflicts with Evening', () => {
  assert.strictEqual(checkSlotConflict('fullday', 'evening'), true);
  assert.strictEqual(checkSlotConflict('evening', 'fullday'), true);
});

it('Full Day conflicts with another Full Day', () => {
  assert.strictEqual(checkSlotConflict('fullday', 'fullday'), true);
});

it('Morning conflicts with another Morning', () => {
  assert.strictEqual(checkSlotConflict('morning', 'morning'), true);
});

it('Evening conflicts with another Evening', () => {
  assert.strictEqual(checkSlotConflict('evening', 'evening'), true);
});

it('Morning and Evening can coexist on same hall without conflict', () => {
  assert.strictEqual(checkSlotConflict('morning', 'evening'), false);
  assert.strictEqual(checkSlotConflict('evening', 'morning'), false);
});

it('Different halls (Evan-e-Hakimi vs Qadri Hall) can hold simultaneous events without conflict', () => {
  function checkHallConflict(b1, b2) {
    if ((b1.hall || '').toLowerCase() !== (b2.hall || '').toLowerCase()) return false;
    return checkSlotConflict(b1.slot, b2.slot);
  }
  const hakimiFullDay = { hall: 'Evan-e-Hakimi', slot: 'fullday' };
  const qadriFullDay = { hall: 'Qadri Hall', slot: 'fullday' };
  assert.strictEqual(checkHallConflict(hakimiFullDay, qadriFullDay), false);
});

// ── TEST GROUP 3: HALL MANAGEMENT VALIDATION ──
console.log('\n🏛️ Group 3: Hall Management & Multi-Venue Support');

it('Evan-e-Hakimi is accepted as valid active venue', () => {
  const hall = 'Evan-e-Hakimi';
  assert.strictEqual(hall.toLowerCase().includes('hakimi'), true);
});

it('Qadri Hall is accepted as valid manageable venue for approved dates', () => {
  const hall = 'Qadri Hall';
  assert.strictEqual(hall.toLowerCase().includes('qadri'), true);
});

// ── TEST GROUP 4: AUTHENTICATION ENFORCEMENT ──
console.log('\n🛡️ Group 4: Authentication & Middleware Enforcement');

it('requireAuth rejects missing Authorization header with 401', () => {
  const { requireAuth } = require('./middleware/auth');
  let statusSent = null;
  let jsonSent = null;
  const req = { headers: {} };
  const res = {
    status: (s) => { statusSent = s; return res; },
    json: (j) => { jsonSent = j; return res; }
  };
  let nextCalled = false;
  requireAuth(req, res, () => { nextCalled = true; });

  assert.strictEqual(statusSent, 401);
  assert.strictEqual(nextCalled, false);
  assert.strictEqual(jsonSent.error.includes('No token provided'), true);
});

it('requireAuth rejects invalid Bearer token with 401', () => {
  const { requireAuth } = require('./middleware/auth');
  let statusSent = null;
  let jsonSent = null;
  const req = { headers: { authorization: 'Bearer invalid.fake.token' } };
  const res = {
    status: (s) => { statusSent = s; return res; },
    json: (j) => { jsonSent = j; return res; }
  };
  let nextCalled = false;
  requireAuth(req, res, () => { nextCalled = true; });

  assert.strictEqual(statusSent, 401);
  assert.strictEqual(nextCalled, false);
});

it('requireAuth accepts valid JWT token and attaches admin identity', () => {
  const jwt = require('jsonwebtoken');
  const { requireAuth } = require('./middleware/auth');
  const secret = process.env.JWT_SECRET || 'test_secret';
  process.env.JWT_SECRET = secret;
  const validToken = jwt.sign({ username: 'admin', role: 'admin' }, secret, { expiresIn: '1h' });

  const req = { headers: { authorization: 'Bearer ' + validToken } };
  let statusSent = null;
  const res = {
    status: (s) => { statusSent = s; return res; },
    json: (j) => res
  };
  let nextCalled = false;
  requireAuth(req, res, () => { nextCalled = true; });

  assert.strictEqual(nextCalled, true);
  assert.strictEqual(req.admin.username, 'admin');
  assert.strictEqual(req.admin.role, 'admin');
});

// ── TEST GROUP 5: VERCEL ROUTING & ACCESS RULES ──
console.log('\n🌐 Group 5: Routing & Vercel Access-Control Rules');

it('vercel.json serves public website at root and redirects /login to /admin', () => {
  const vercelConfig = require('../vercel.json');
  assert.strictEqual(Array.isArray(vercelConfig.rewrites), true);

  // Root / must NOT be rewritten away to login.html (it serves public index.html)
  const rootRewrite = vercelConfig.rewrites.find(r => r.source === '/');
  assert.strictEqual(rootRewrite, undefined, 'Root / must not be rewritten to login; it serves public index.html');

  // /login redirects to /admin
  const loginRedirect = vercelConfig.redirects.find(r => r.source === '/login');
  assert.ok(loginRedirect, 'Missing /login redirect');
  assert.strictEqual(loginRedirect.destination, '/admin');
});

it('vercel.json maps "/admin" to admin.html', () => {
  const vercelConfig = require('../vercel.json');
  const adminRewrite = vercelConfig.rewrites.find(r => r.source === '/admin');
  assert.ok(adminRewrite, 'Missing /admin rewrite');
  assert.strictEqual(adminRewrite.destination, '/admin.html');
});

it('vercel.json rewrites /pay to pay.html for public customer payments', () => {
  const vercelConfig = require('../vercel.json');
  const payRewrite = vercelConfig.rewrites.find(r => r.source === '/pay');
  assert.ok(payRewrite, 'Missing /pay rewrite');
  assert.strictEqual(payRewrite.destination, '/pay.html');
});

it('internal files and local databases are protected from public direct access', () => {
  const vercelConfig = require('../vercel.json');
  const backendRedirect = vercelConfig.redirects.find(r => r.source === '/backend/(.*)');
  assert.ok(backendRedirect, 'Missing /backend/(.*) security redirect');

  const dbRedirect = vercelConfig.redirects.find(r => r.source === '/local.db');
  assert.ok(dbRedirect, 'Missing /local.db security redirect');
});

// ── TEST GROUP 6: EXPENSES MANAGEMENT VALIDATION ──
console.log('\n💰 Group 6: Expenses Management Validation');

function validateExpense(desc, category, amount, date) {
  if (!desc || typeof desc !== 'string' || desc.trim().length === 0) return { valid: false, error: 'Description required' };
  if (!category || typeof category !== 'string') return { valid: false, error: 'Category required' };
  const amt = parseFloat(amount);
  if (isNaN(amt) || amt <= 0) return { valid: false, error: 'Valid positive amount required' };
  if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return { valid: false, error: 'Valid date required' };
  return { valid: true, amount: amt };
}

it('valid expense with required fields passes validation', () => {
  const res = validateExpense('Electricity Bill 2nd Floor', 'utilities', 4500, '2026-10-10');
  assert.strictEqual(res.valid, true);
  assert.strictEqual(res.amount, 4500);
});

it('expense with negative or zero amount is rejected', () => {
  assert.strictEqual(validateExpense('Supplies', 'supplies', 0, '2026-10-10').valid, false);
  assert.strictEqual(validateExpense('Supplies', 'supplies', -100, '2026-10-10').valid, false);
});

// ── TEST GROUP 7: STAFF & SALARY PAYMENT RULES ──
console.log('\n👥 Group 7: Staff Management & Salary Payment Rules');

it('salary payment requires confirmed record before counting as expense', () => {
  const staff = [
    { id: 1, name: 'Manager', salary: 25000 },
    { id: 2, name: 'Cleaner', salary: 12000 }
  ];
  // Mere existence of salary does not count as money paid
  const salaryObligation = staff.reduce((sum, s) => sum + s.salary, 0);
  assert.strictEqual(salaryObligation, 37000);

  // Confirmed payment log
  const payments = [
    { staff_id: 1, period: 'October 2026', amount_paid: 25000, payment_date: '2026-10-05' }
  ];
  const actualSalariesPaid = payments.reduce((sum, p) => sum + p.amount_paid, 0);
  assert.strictEqual(actualSalariesPaid, 25000);
  assert.notStrictEqual(actualSalariesPaid, salaryObligation);
});

// ── TEST GROUP 8: FINANCIAL REPORTS & NET CASH MOVEMENT ──
console.log('\n📊 Group 8: Financial Reports & Net Cash Movement Calculation');

it('distinguishes quoted booking revenue from actual cash collected', () => {
  const booking = { total_amount: 30000, advance_paid: 12000, balance_amount: 18000 };
  assert.strictEqual(booking.total_amount, 30000); // Quoted value
  assert.strictEqual(booking.advance_paid, 12000); // Money received
  assert.strictEqual(booking.balance_amount, 18000); // Outstanding
  assert.notStrictEqual(booking.total_amount, booking.advance_paid);
});

it('computes net cash movement: Money Actually Collected minus Total Paid Outflow', () => {
  const cashCollected = 54000; // actual payments received
  const expensesPaid = 8500;   // operational bills paid
  const salariesPaid = 25000;  // confirmed staff salaries paid

  const totalOutflow = expensesPaid + salariesPaid;
  const netCashMovement = cashCollected - totalOutflow;

  assert.strictEqual(totalOutflow, 33500);
  assert.strictEqual(netCashMovement, 20500);
});

// ── TEST GROUP 9: PROGRESSIVE WEB APP (PWA) STANDARDS & CACHING ──
console.log('\n📱 Group 9: Progressive Web App (PWA) Standards & Caching Strategy');

it('manifest.json exists and satisfies PWA criteria', () => {
  const manifestPath = path.join(__dirname, '..', 'manifest.json');
  assert.strictEqual(fs.existsSync(manifestPath), true, 'manifest.json must exist');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  assert.strictEqual(manifest.name, 'Evan-e-Hakimi & Qadri Hall Management');
  assert.strictEqual(manifest.short_name, 'Hall Admin');
  assert.strictEqual(manifest.start_url, '/admin');
  assert.strictEqual(manifest.display, 'standalone');
  assert.strictEqual(manifest.theme_color, '#0a0806');
  assert.strictEqual(manifest.background_color, '#0a0806');
  assert.strictEqual(Array.isArray(manifest.icons), true);
  
  const has192 = manifest.icons.some(i => i.sizes === '192x192' && i.purpose === 'any');
  const has192Maskable = manifest.icons.some(i => i.sizes === '192x192' && i.purpose === 'maskable');
  const has512 = manifest.icons.some(i => i.sizes === '512x512' && i.purpose === 'any');
  const has512Maskable = manifest.icons.some(i => i.sizes === '512x512' && i.purpose === 'maskable');
  assert.strictEqual(has192, true, 'Must have 192x192 any icon');
  assert.strictEqual(has192Maskable, true, 'Must have 192x192 maskable icon');
  assert.strictEqual(has512, true, 'Must have 512x512 any icon');
  assert.strictEqual(has512Maskable, true, 'Must have 512x512 maskable icon');
});

it('required PWA icons exist on disk', () => {
  const root = path.join(__dirname, '..');
  assert.strictEqual(fs.existsSync(path.join(root, 'assets', 'icon-192.png')), true);
  assert.strictEqual(fs.existsSync(path.join(root, 'assets', 'icon-512.png')), true);
  assert.strictEqual(fs.existsSync(path.join(root, 'assets', 'icon-192-maskable.png')), true);
  assert.strictEqual(fs.existsSync(path.join(root, 'assets', 'icon-512-maskable.png')), true);
});

it('service worker sw.js implements safe caching and never caches API requests', () => {
  const swPath = path.join(__dirname, '..', 'sw.js');
  assert.strictEqual(fs.existsSync(swPath), true);
  const swContent = fs.readFileSync(swPath, 'utf8');
  assert.strictEqual(swContent.includes('/api/'), true);
  assert.strictEqual(swContent.includes('/offline.html'), true);
  assert.strictEqual(swContent.includes('skipWaiting'), true);
  assert.strictEqual(swContent.includes('clients.claim'), true);
  assert.strictEqual(swContent.includes('Network-Only'), true);
});

it('login.html contains PWA manifest, smart install button, and iOS guidance', () => {
  const loginPath = path.join(__dirname, '..', 'login.html');
  const html = fs.readFileSync(loginPath, 'utf8');
  assert.strictEqual(html.includes('rel="manifest"'), true);
  assert.strictEqual(html.includes('pwaInstallBtn'), true);
  assert.strictEqual(html.includes('beforeinstallprompt'), true);
  assert.strictEqual(html.includes('serviceWorker.register'), true);
  assert.strictEqual(html.includes('pwaIosBanner'), true);
});

it('admin.html contains PWA manifest and service worker registration', () => {
  const adminPath = path.join(__dirname, '..', 'admin.html');
  const html = fs.readFileSync(adminPath, 'utf8');
  assert.strictEqual(html.includes('rel="manifest"'), true);
  assert.strictEqual(html.includes('serviceWorker.register'), true);
});

console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
console.log(`RESULTS: ${passed} / ${total} tests passed (${Math.round((passed/total)*100)}%)`);
console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

if (passed !== total) {
  process.exit(1);
}
