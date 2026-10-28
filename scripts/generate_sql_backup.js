const fs = require('fs');
const path = require('path');

const jsonPath = path.join(__dirname, '..', 'backups', 'backup_1793206006363.json');
const b = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));

let sql = `-- HAKIMI53 PRODUCTION DATABASE DUMP\n-- Timestamp: ${b.timestamp}\n-- Verified Backup\n\n`;

for (const [table, data] of Object.entries(b.tables)) {
  if (data.schema) {
    sql += `${data.schema};\n`;
  }
  for (const r of data.rows) {
    const cols = Object.keys(r);
    const vals = Object.values(r).map(v => {
      if (v === null || v === undefined) return 'NULL';
      if (typeof v === 'number' || typeof v === 'bigint') return v;
      return `'${String(v).replace(/'/g, "''")}'`;
    });
    sql += `INSERT INTO "${table}" (${cols.map(c => `"${c}"`).join(', ')}) VALUES (${vals.join(', ')});\n`;
  }
  sql += '\n';
}

const sqlPath = path.join(__dirname, '..', 'backups', 'backup_verified.sql');
fs.writeFileSync(sqlPath, sql, 'utf8');
console.log(`SQL backup written to ${sqlPath} (${fs.statSync(sqlPath).size} bytes)`);
