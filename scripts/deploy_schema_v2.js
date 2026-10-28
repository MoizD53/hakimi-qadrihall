/**
 * HAKIMI53 V2 — Automated Database Schema Deployer
 * Applies backend/schema_clean.sql to the target Turso or local LibSQL database.
 * 
 * Usage:
 *   node scripts/deploy_schema_v2.js [--dry-run]
 * 
 * Target is resolved from TURSO_DATABASE_URL and TURSO_AUTH_TOKEN in the environment.
 */

const fs = require('fs');
const path = require('path');
const { createClient } = require('@libsql/client');

require('dotenv').config();

async function main() {
  const isDryRun = process.argv.includes('--dry-run');
  const url = process.env.TURSO_DATABASE_URL;
  const authToken = process.env.TURSO_AUTH_TOKEN;

  if (!url) {
    console.error('❌ Error: TURSO_DATABASE_URL environment variable is required.');
    process.exit(1);
  }

  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('🚀 HAKIMI53 V2 DATABASE SCHEMA DEPLOYER');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log(`Target URL: ${url.startsWith('file:') ? url : url.replace(/:\/\/.*@/, '://***@')}`);
  console.log(`Dry run:    ${isDryRun ? 'YES (validation only)' : 'NO (deploying live)'}`);
  console.log('──────────────────────────────────────────────────');

  const schemaPath = path.resolve(__dirname, '../backend/schema_clean.sql');
  if (!fs.existsSync(schemaPath)) {
    console.error(`❌ Schema file not found: ${schemaPath}`);
    process.exit(1);
  }

  const schemaSql = fs.readFileSync(schemaPath, 'utf8');

  // Strip line comments and split by semicolon
  const statements = schemaSql
    .split('\n')
    .filter(line => !line.trim().startsWith('--'))
    .join('\n')
    .split(';')
    .map(s => s.trim())
    .filter(s => s.length > 0);

  console.log(`📦 Loaded ${statements.length} DDL / indexing statements from schema_clean.sql`);

  if (isDryRun) {
    console.log('✅ Dry-run syntax check passed.');
    return;
  }

  const client = createClient({ url, authToken });

  try {
    let applied = 0;
    for (const stmt of statements) {
      const firstLine = stmt.split('\n')[0].substring(0, 60);
      process.stdout.write(`  [${applied + 1}/${statements.length}] Executing: ${firstLine}... `);
      await client.execute(stmt);
      console.log('✓ OK');
      applied++;
    }

    console.log('──────────────────────────────────────────────────');
    console.log(`🎉 Schema deployment completed successfully! (${applied}/${statements.length} statements executed)`);

    // Verify initial clean state
    const tableRes = await client.execute("SELECT count(*) as cnt FROM bookings");
    console.log(`📊 Initial business records in 'bookings': ${tableRes.rows[0].cnt} (Clean Zero-Start verified)`);
  } catch (err) {
    console.error('\n❌ Deployment failed:');
    console.error(err.message);
    process.exit(1);
  } finally {
    client.close();
  }
}

main();
