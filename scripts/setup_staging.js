/**
 * HAKIMI53 V2 — One-Click Staging Provisioner & Verification Pipeline
 * 
 * Usage:
 *   node scripts/setup_staging.js
 * 
 * Reads credentials securely from local `.env.staging` (never committed, never exposed in chat).
 * Automates:
 * 1. Schema DDL & Covering Indexes deployment to fresh Turso staging DB.
 * 2. Secure environment variable injection into Vercel project `hakimi-staging`.
 * 3. Production redeployment of `hakimi-staging`.
 * 4. Full live smoke testing via `scripts/test_staging_live.js`.
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const STAGING_ENV_FILE = path.resolve(__dirname, '../.env.staging');

console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
console.log('🚀 HAKIMI53 V2 STAGING PROVISIONING PIPELINE');
console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

if (!fs.existsSync(STAGING_ENV_FILE)) {
  console.log('⚠️  Notice: Local file .env.staging was not found.');
  console.log('Please create .env.staging with the following format:\n');
  console.log('  TURSO_DATABASE_URL=libsql://<your-staging-db>-<org>.turso.io');
  console.log('  TURSO_AUTH_TOKEN=<your-staging-token>');
  console.log('  ADMIN_PASSWORD=HakimiStaging2026!\n');
  console.log('Once saved, rerun: node scripts/setup_staging.js');
  process.exit(1);
}

// Read .env.staging securely
const stagingEnvContent = fs.readFileSync(STAGING_ENV_FILE, 'utf8');
const stagingEnv = {};
stagingEnvContent.split('\n').forEach(line => {
  const match = line.match(/^\s*([\w.-]+)\s*=\s*(.*)?\s*$/);
  if (match) {
    let value = match[2] || '';
    value = value.trim().replace(/^['"]|['"]$/g, '');
    stagingEnv[match[1]] = value;
  }
});

const url = stagingEnv.TURSO_DATABASE_URL;
const token = stagingEnv.TURSO_AUTH_TOKEN;
const adminPass = stagingEnv.ADMIN_PASSWORD || 'HakimiStaging2026!';

if (!url || !token) {
  console.error('❌ Error: Both TURSO_DATABASE_URL and TURSO_AUTH_TOKEN are required in .env.staging.');
  process.exit(1);
}

console.log(`✓ Staging database URL detected: ${url.replace(/:\/\/.*@/, '://***@')}`);
console.log('✓ Staging token detected securely (length: ' + token.length + ' chars)\n');

// ── STEP 1: DEPLOY CLEAN SCHEMA TO STAGING DB ──
console.log('📦 STEP 1: Deploying Clean Schema & Composite Indexes to Staging DB...');
try {
  execSync('node scripts/deploy_schema_v2.js', {
    env: { ...process.env, TURSO_DATABASE_URL: url, TURSO_AUTH_TOKEN: token },
    stdio: 'inherit'
  });
  console.log('✓ Schema deployed successfully!\n');
} catch (err) {
  console.error('❌ Schema deployment failed:', err.message);
  process.exit(1);
}

// ── STEP 2: PUSH ENVIRONMENT VARIABLES TO VERCEL HAKIMI-STAGING ──
console.log('🔒 STEP 2: Configuring Environment Variables in Vercel hakimi-staging...');
function addVercelEnv(key, value) {
  try {
    execSync(`npx vercel env add ${key} production --project hakimi-staging --yes`, {
      input: value,
      stdio: ['pipe', 'pipe', 'inherit']
    });
    console.log(`  ✓ Configured ${key} in Vercel staging`);
  } catch (err) {
    console.warn(`  ⚠️ Warning setting ${key}:`, err.message);
  }
}

addVercelEnv('TURSO_DATABASE_URL', url);
addVercelEnv('TURSO_AUTH_TOKEN', token);
addVercelEnv('ADMIN_PASSWORD', adminPass);

// ── STEP 3: REDEPLOY VERCEL HAKIMI-STAGING WITH FRESH CREDENTIALS ──
console.log('\n🚀 STEP 3: Redeploying Vercel hakimi-staging with active database credentials...');
try {
  execSync('npx vercel deploy --project hakimi-staging --prod --yes', {
    stdio: 'inherit'
  });
  console.log('✓ Staging deployment ready!\n');
} catch (err) {
  console.error('❌ Vercel redeployment failed:', err.message);
  process.exit(1);
}

// ── STEP 4: RUN LIVE SMOKE TESTS ──
console.log('🧪 STEP 4: Running Live Staging Smoke Tests...');
try {
  execSync('node scripts/test_staging_live.js', {
    env: { ...process.env, STAGING_URL: 'https://hakimi-staging.vercel.app', ADMIN_PASSWORD: adminPass },
    stdio: 'inherit'
  });
  console.log('\n🎉 ALL STAGING PROVISIONING & VERIFICATION STEPS COMPLETE!');
} catch (err) {
  console.error('❌ Live smoke testing failed:', err.message);
  process.exit(1);
}
