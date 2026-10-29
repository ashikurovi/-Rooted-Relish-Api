const fs = require('fs');
const path = require('path');
const { Client } = require('pg');
const dotenv = require('dotenv');

dotenv.config({ path: path.join(__dirname, '..', '.env') });

function formatSqlValue(val) {
  if (val === null || val === undefined) return 'NULL';
  if (typeof val === 'boolean') return val ? 'TRUE' : 'FALSE';
  if (typeof val === 'number') return String(val);
  if (val instanceof Date) return `'${val.toISOString()}'`;
  if (typeof val === 'object') {
    return `'${JSON.stringify(val).replace(/'/g, "''")}'`;
  }
  return `'${String(val).replace(/'/g, "''")}'`;
}

async function runBackup() {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    console.error('❌ Error: DATABASE_URL not found in .env');
    process.exit(1);
  }

  const client = new Client({
    connectionString: databaseUrl,
    ssl: { rejectUnauthorized: false },
  });

  console.log('🔄 Connecting to Neon Database...');
  await client.connect();
  console.log('✅ Connected successfully!');

  const now = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  const timestamp = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}_${pad(now.getHours())}-${pad(now.getMinutes())}-${pad(now.getSeconds())}`;
  
  const backupDir = path.join(__dirname, '..', 'backups');
  const targetDir = path.join(backupDir, `backup_${timestamp}`);

  if (!fs.existsSync(backupDir)) fs.mkdirSync(backupDir, { recursive: true });
  fs.mkdirSync(targetDir, { recursive: true });

  // 1. Fetch tables
  const tablesRes = await client.query(`
    SELECT table_name 
    FROM information_schema.tables 
    WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
    ORDER BY table_name;
  `);

  const tables = tablesRes.rows.map((r) => r.table_name);
  console.log(`📋 Found ${tables.length} tables to backup...`);

  let sqlContent = `-- Database Backup Created: ${now.toISOString()}\n-- Database: Neon PostgreSQL\n\nBEGIN;\nSET statement_timeout = 0;\n\n`;
  const jsonBackup = {};
  const summary = {
    timestamp: now.toISOString(),
    totalTables: tables.length,
    tables: {},
  };

  let totalRows = 0;

  for (const table of tables) {
    process.stdout.write(`  ⏳ Backing up table "${table}"... `);

    // Get table columns
    const colsRes = await client.query(`
      SELECT column_name, data_type, is_nullable, column_default
      FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = $1
      ORDER BY ordinal_position;
    `, [table]);

    // Fetch all rows
    const dataRes = await client.query(`SELECT * FROM "${table}"`);
    const rows = dataRes.rows;
    totalRows += rows.length;

    jsonBackup[table] = rows;
    summary.tables[table] = rows.length;

    sqlContent += `-- Table: ${table} (${rows.length} rows)\n`;

    if (rows.length > 0) {
      const colNames = colsRes.rows.map((c) => `"${c.column_name}"`);
      const rawCols = colsRes.rows.map((c) => c.column_name);

      for (const row of rows) {
        const values = rawCols.map((c) => formatSqlValue(row[c]));
        sqlContent += `INSERT INTO "${table}" (${colNames.join(', ')}) VALUES (${values.join(', ')});\n`;
      }
    }
    sqlContent += `\n`;
    console.log(`✓ (${rows.length} rows)`);
  }

  sqlContent += `COMMIT;\n`;

  const sqlFile = path.join(targetDir, 'database_backup.sql');
  const jsonFile = path.join(targetDir, 'database_backup.json');
  const summaryFile = path.join(targetDir, 'summary.json');

  fs.writeFileSync(sqlFile, sqlContent, 'utf8');
  fs.writeFileSync(jsonFile, JSON.stringify(jsonBackup, null, 2), 'utf8');
  fs.writeFileSync(summaryFile, JSON.stringify(summary, null, 2), 'utf8');

  // Also update latest references
  fs.writeFileSync(path.join(backupDir, 'latest.sql'), sqlContent, 'utf8');
  fs.writeFileSync(path.join(backupDir, 'latest.json'), JSON.stringify(jsonBackup, null, 2), 'utf8');

  const sqlStat = fs.statSync(sqlFile);
  const jsonStat = fs.statSync(jsonFile);

  await client.end();

  console.log('\n=============================================');
  console.log('🎉 DATABASE BACKUP COMPLETED SUCCESSFULLY!');
  console.log('=============================================');
  console.log(`📁 Saved to: ${targetDir}`);
  console.log(`📄 SQL Backup: database_backup.sql (${(sqlStat.size / 1024).toFixed(2)} KB)`);
  console.log(`📄 JSON Backup: database_backup.json (${(jsonStat.size / 1024).toFixed(2)} KB)`);
  console.log(`📊 Total Tables: ${tables.length}`);
  console.log(`📊 Total Records: ${totalRows}`);
  console.log('=============================================\n');
}

runBackup().catch((err) => {
  console.error('❌ Backup Failed:', err);
  process.exit(1);
});
