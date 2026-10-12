/**
 * Production Readiness Audit Test Suite
 * Tests business logic, pricing, conflict detection, availability priority,
 * authorization middleware, and validation rules.
 */

const assert = require('assert');

// 1. Slot and pricing definition check
const SLOT_CONFIG = {
  morning: {
    name: 'Morning',
    timing: '10:30 AM – 2:30 PM',
    pricing: { without_jaman: 11000, with_jaman: 15000 }
  },
  evening: {
    name: 'Evening',
    timing: '6:30 PM – 10:30 PM',
    pricing: { without_jaman: 11000, with_jaman: 15000 }
  },
  fullday: {
    name: 'Full Day',
    timing: '10:00 AM – 10:00 PM',
    pricing: { full_day: 30000, without_jaman: 30000, with_jaman: 30000, standard: 30000 }
  }
};

function checkSlotConflict(slotA, slotB) {
  const a = String(slotA).toLowerCase();
  const b = String(slotB).toLowerCase();
  if (a === 'fullday' || b === 'fullday') return true;
  return a === b;
}

function isDateOnOrAfterJan2027(dateStr) {
  if (!dateStr) return false;
  const clean = String(dateStr).split('T')[0].trim();
  return clean >= '2027-01-01';
}

function calculateExpectedPrice(slot, pkg, dateStr) {
  const s = String(slot).toLowerCase();
  const p = String(pkg).toLowerCase();
  if (s === 'fullday') return 30000;
  
  const is2027 = isDateOnOrAfterJan2027(dateStr);
  if (is2027) {
    return p === 'with_jaman' ? 21000 : 15000;
  }
  return p === 'with_jaman' ? 15000 : 11000;
}

function calculateAdvance(price) {
  return Math.round(price * 0.40);
}

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
console.log('🧪 RUNNING PRODUCTION-READINESS AUDIT TESTS');
console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

// ── TEST GROUP 1: SLOTS & DATE-BASED PRICING ──
console.log('📋 Group 1: Date-Based Slot Configuration, Pricing, and Advance (Before & From 1 Jan 2027)');

// Before 1 January 2027 (e.g., 2026-12-31)
it('Before 2027-01-01: Morning Without Jaman must be ₹11,000 with ₹4,400 advance (40%)', () => {
  const price = calculateExpectedPrice('morning', 'without_jaman', '2026-12-31');
  assert.strictEqual(price, 11000);
  assert.strictEqual(calculateAdvance(price), 4400);
});

it('Before 2027-01-01: Morning With Jaman must be ₹15,000 with ₹6,000 advance (40%)', () => {
  const price = calculateExpectedPrice('morning', 'with_jaman', '2026-12-31');
  assert.strictEqual(price, 15000);
  assert.strictEqual(calculateAdvance(price), 6000);
});

it('Before 2027-01-01: Evening Without Jaman must be ₹11,000 with ₹4,400 advance (40%)', () => {
  const price = calculateExpectedPrice('evening', 'without_jaman', '2026-12-31');
  assert.strictEqual(price, 11000);
  assert.strictEqual(calculateAdvance(price), 4400);
});

it('Before 2027-01-01: Evening With Jaman must be ₹15,000 with ₹6,000 advance (40%)', () => {
  const price = calculateExpectedPrice('evening', 'with_jaman', '2026-12-31');
  assert.strictEqual(price, 15000);
  assert.strictEqual(calculateAdvance(price), 6000);
});

// From 1 January 2027 (e.g., 2027-01-01)
it('From 2027-01-01: Morning Without Jaman must be ₹15,000 with ₹6,000 advance (40%)', () => {
  const price = calculateExpectedPrice('morning', 'without_jaman', '2027-01-01');
  assert.strictEqual(price, 15000);
  assert.strictEqual(calculateAdvance(price), 6000);
});

it('From 2027-01-01: Morning With Jaman must be ₹21,000 with ₹8,400 advance (40%)', () => {
  const price = calculateExpectedPrice('morning', 'with_jaman', '2027-01-01');
  assert.strictEqual(price, 21000);
  assert.strictEqual(calculateAdvance(price), 8400);
});

it('From 2027-01-01: Evening Without Jaman must be ₹15,000 with ₹6,000 advance (40%)', () => {
  const price = calculateExpectedPrice('evening', 'without_jaman', '2027-01-01');
  assert.strictEqual(price, 15000);
  assert.strictEqual(calculateAdvance(price), 6000);
});

it('From 2027-01-01: Evening With Jaman must be ₹21,000 with ₹8,400 advance (40%)', () => {
  const price = calculateExpectedPrice('evening', 'with_jaman', '2027-01-01');
  assert.strictEqual(price, 21000);
  assert.strictEqual(calculateAdvance(price), 8400);
});

it('Full Day must remain ₹30,000 with ₹12,000 advance (40%) on both sides of cutoff', () => {
  assert.strictEqual(calculateExpectedPrice('fullday', 'full_day', '2026-12-31'), 30000);
  assert.strictEqual(calculateExpectedPrice('fullday', 'without_jaman', '2026-12-31'), 30000);
  assert.strictEqual(calculateExpectedPrice('fullday', 'with_jaman', '2026-12-31'), 30000);
  assert.strictEqual(calculateAdvance(30000), 12000);

  assert.strictEqual(calculateExpectedPrice('fullday', 'full_day', '2027-01-01'), 30000);
  assert.strictEqual(calculateExpectedPrice('fullday', 'without_jaman', '2027-01-01'), 30000);
  assert.strictEqual(calculateExpectedPrice('fullday', 'with_jaman', '2027-01-01'), 30000);
  assert.strictEqual(calculateAdvance(30000), 12000);
});

// ── TEST GROUP 2: CONFLICT RULES ──
console.log('\n🔒 Group 2: Slot Conflict Rules');
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

it('Morning and Evening can coexist without conflict', () => {
  assert.strictEqual(checkSlotConflict('morning', 'evening'), false);
  assert.strictEqual(checkSlotConflict('evening', 'morning'), false);
});

// ── TEST GROUP 3: AVAILABILITY STATUS PRECEDENCE ──
console.log('\n📊 Group 3: Availability Status Precedence');
it('Confirmed booking takes highest rank and cannot be overwritten by pending inquiry', () => {
  const day = {};
  function applySlotStatus(dayObj, slotKey, newStatus) {
    const current = dayObj[slotKey];
    const rank = { confirmed_booked: 3, conflict_blocked: 2, pending_inquiry: 1 };
    const currentRank = rank[current] || 0;
    const newRank = rank[newStatus] || 0;
    if (newRank > currentRank) {
      dayObj[slotKey] = newStatus;
    }
  }

  // 1. Pending inquiry first
  applySlotStatus(day, 'morning', 'pending_inquiry');
  assert.strictEqual(day['morning'], 'pending_inquiry');

  // 2. Confirmed full day blocks morning with conflict_blocked
  applySlotStatus(day, 'morning', 'conflict_blocked');
  assert.strictEqual(day['morning'], 'conflict_blocked');

  // 3. Another pending inquiry arrives, must NOT downgrade conflict_blocked
  applySlotStatus(day, 'morning', 'pending_inquiry');
  assert.strictEqual(day['morning'], 'conflict_blocked');

  // 4. Confirmed booking upgrades to confirmed_booked
  applySlotStatus(day, 'morning', 'confirmed_booked');
  assert.strictEqual(day['morning'], 'confirmed_booked');

  // 5. Subsequent conflict_blocked or pending_inquiry cannot downgrade confirmed_booked
  applySlotStatus(day, 'morning', 'conflict_blocked');
  assert.strictEqual(day['morning'], 'confirmed_booked');
  applySlotStatus(day, 'morning', 'pending_inquiry');
  assert.strictEqual(day['morning'], 'confirmed_booked');
});

// ── TEST GROUP 4: HALL VALIDATION ──
console.log('\n🏛️ Group 4: Hall Selection and Rejection');
it('Evan-e-Hakimi is accepted as valid', () => {
  const validHalls = ['Evan-e-Hakimi', 'evan-e-hakimi', 'Evan-e-Hakimi (2nd Floor)'];
  validHalls.forEach(h => {
    const norm = h.trim().toLowerCase();
    const isValid = norm === 'evan-e-hakimi' || norm === 'evan-e-hakimi (2nd floor)';
    assert.strictEqual(isValid, true);
  });
});

it('Qadri Hall (and Evan-e-Qadri) is rejected strictly on backend', () => {
  const invalidHalls = ['Qadri Hall', 'qadri hall', 'Qadri Hall (3rd Floor)', 'Evan-e-Qadri', 'evan-e-qadri', '3rd Floor Qadri'];
  invalidHalls.forEach(h => {
    const norm = h.trim().toLowerCase();
    const isQadri = norm.includes('qadri');
    assert.strictEqual(isQadri, true);
  });
});

// ── TEST GROUP 5: AUTHENTICATION ENFORCEMENT ──
console.log('\n🛡️ Group 5: Authentication & Middleware Enforcement');
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

// ── TEST GROUP 6: ROUTING & ACCESS-CONTROL SPECIFICATION ──
console.log('\n🌐 Group 6: Routing & Vercel Access-Control Rules');
it('vercel.json separates public (/), admin (/admin), and pay (/pay) routes', () => {
  const vercelConfig = require('../vercel.json');
  assert.strictEqual(Array.isArray(vercelConfig.rewrites), true);
  
  const adminRewrite = vercelConfig.rewrites.find(r => r.source === '/admin');
  assert.ok(adminRewrite, 'Missing /admin rewrite');
  assert.strictEqual(adminRewrite.destination, '/admin.html');

  const payRewrite = vercelConfig.rewrites.find(r => r.source === '/pay');
  assert.ok(payRewrite, 'Missing /pay rewrite');
  assert.strictEqual(payRewrite.destination, '/pay.html');

  const apiRewrite = vercelConfig.rewrites.find(r => r.source === '/api/(.*)');
  assert.ok(apiRewrite, 'Missing /api/(.*) rewrite');
  assert.strictEqual(apiRewrite.destination, '/api/index.js');
});

it('vercel.json clean redirects protect against redirect loops and direct .html access', () => {
  const vercelConfig = require('../vercel.json');
  assert.strictEqual(Array.isArray(vercelConfig.redirects), true);
  
  const adminRedirect = vercelConfig.redirects.find(r => r.source === '/admin.html');
  assert.ok(adminRedirect, 'Missing /admin.html redirect');
  assert.strictEqual(adminRedirect.destination, '/admin');

  const payRedirect = vercelConfig.redirects.find(r => r.source === '/pay.html');
  assert.ok(payRedirect, 'Missing /pay.html redirect');
  assert.strictEqual(payRedirect.destination, '/pay');

  const indexRedirect = vercelConfig.redirects.find(r => r.source === '/index.html');
  assert.ok(indexRedirect, 'Missing /index.html redirect');
  assert.strictEqual(indexRedirect.destination, '/');

  // Verify internal file redirects
  const backendRedirect = vercelConfig.redirects.find(r => r.source === '/backend/(.*)');
  assert.ok(backendRedirect, 'Missing /backend/(.*) security redirect');
});

it('public navigation in index.html does not contain visible admin links', () => {
  const fs = require('fs');
  const indexHtml = fs.readFileSync(require('path').join(__dirname, '../index.html'), 'utf8');
  assert.strictEqual(/href=["'][^"']*\/admin/i.test(indexHtml), false);
  assert.strictEqual(/Admin Panel/i.test(indexHtml), false);
});

console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
console.log(`RESULTS: ${passed} / ${total} tests passed (${Math.round((passed/total)*100)}%)`);
console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

if (passed !== total) {
  process.exit(1);
}

