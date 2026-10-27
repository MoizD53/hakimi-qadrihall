const { performance } = require('perf_hooks');

(async () => {
  console.log('--- COMPREHENSIVE LATENCY BENCHMARK ---');

  // 1. Cold start measurement
  const tColdStart0 = performance.now();
  const dbMetrics = require('../backend/dbMetrics').dbMetrics;
  const { createClient } = require('@libsql/client');
  require('dotenv').config();
  const client = createClient({
    url: process.env.TURSO_DATABASE_URL || 'file:local.db',
    authToken: process.env.TURSO_AUTH_TOKEN
  });
  await dbMetrics.init(client);
  const coldStartMs = performance.now() - tColdStart0;
  console.log(`1. Server Cold-Start & DB Metrics Init: ${coldStartMs.toFixed(1)} ms`);

  // 2. Raw Network Round-trip to Turso
  const tPing0 = performance.now();
  await client.execute('SELECT 1');
  const pingMs = performance.now() - tPing0;
  console.log(`2. Raw Turso Cloud Round-Trip: ${pingMs.toFixed(1)} ms`);

  // 3. Batched Query vs 4 Sequential Queries
  const tSeq0 = performance.now();
  await client.execute('SELECT COUNT(*) FROM bookings');
  await client.execute('SELECT COUNT(*) FROM expenses');
  await client.execute('SELECT COUNT(*) FROM staff');
  await client.execute('SELECT domain, version FROM app_revisions');
  const seqMs = performance.now() - tSeq0;

  const tBatch0 = performance.now();
  await client.batch([
    { sql: 'SELECT COUNT(*) FROM bookings', args: [] },
    { sql: 'SELECT COUNT(*) FROM expenses', args: [] },
    { sql: 'SELECT COUNT(*) FROM staff', args: [] },
    { sql: 'SELECT domain, version FROM app_revisions', args: [] }
  ], 'read');
  const batchMs = performance.now() - tBatch0;
  console.log(`3. Database Query Latency:`);
  console.log(`   - 4 Sequential Queries: ${seqMs.toFixed(1)} ms (4 round trips)`);
  console.log(`   - 1 Batched Pipeline Query: ${batchMs.toFixed(1)} ms (1 round trip)`);
  console.log(`   - Database Round-Trip Reduction: ${((1 - batchMs/seqMs) * 100).toFixed(0)}%`);

  // 4. API Endpoint Execution Simulation (Processing + DB + Serialization)
  const tApi0 = performance.now();
  const rawBatch = await client.batch([
    { sql: "SELECT COUNT(*) as total FROM bookings WHERE status NOT IN ('cancelled', 'CANCELLED')", args: [] },
    { sql: "SELECT COUNT(*) as total FROM expenses", args: [] }
  ], 'read');
  const payload = JSON.stringify({
    success: true,
    bookingsCount: rawBatch[0].rows[0]?.total || 0,
    expensesCount: rawBatch[1].rows[0]?.total || 0,
    timestamp: new Date().toISOString()
  });
  const apiMs = performance.now() - tApi0;
  console.log(`4. Full API Response Latency (DB + JSON parse/serialize): ${apiMs.toFixed(1)} ms`);

  // 5. Dashboard Rendering Simulation (Parsing payload + Updating 12 KPI variables)
  const tRender0 = performance.now();
  const parsed = JSON.parse(payload);
  const virtualDom = {};
  for (let i = 0; i < 12; i++) {
    virtualDom[`kpiCard_${i}`] = `₹${(i * 15000).toLocaleString('en-IN')}`;
  }
  const renderMs = performance.now() - tRender0;
  console.log(`5. Client-Side Rendering Simulation: ${renderMs.toFixed(3)} ms`);

  console.log('---------------------------------------');
  process.exit(0);
})();
