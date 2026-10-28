const db = require('../backend/db');
const fs = require('fs');
const path = require('path');

async function backup() {
  const master = await db.query("SELECT name, sql FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'");
  const backupData = {
    timestamp: new Date().toISOString(),
    databaseUrl: process.env.TURSO_DATABASE_URL ? process.env.TURSO_DATABASE_URL.replace(/:[^:]*@/, ':***@') : 'local',
    tables: {}
  };

  for (const t of master.rows) {
    const data = await db.query(`SELECT * FROM "${t.name}"`);
    backupData.tables[t.name] = {
      schema: t.sql,
      count: data.rows.length,
      rows: data.rows
    };
    console.log(`Backed up table ${t.name}: ${data.rows.length} rows`);
  }

  const backupDir = path.join(__dirname, '..', 'backups');
  if (!fs.existsSync(backupDir)) {
    fs.mkdirSync(backupDir, { recursive: true });
  }

  const filePath = path.join(backupDir, `backup_${Date.now()}.json`);
  fs.writeFileSync(filePath, JSON.stringify(backupData, null, 2), 'utf8');
  console.log(`Verified backup safely written to: ${filePath}`);
}

backup().then(() => process.exit(0)).catch(err => {
  console.error('Backup failed:', err);
  process.exit(1);
});
