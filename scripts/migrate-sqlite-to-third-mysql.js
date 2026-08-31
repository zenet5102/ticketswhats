require('../config');

const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');
const { config } = require('../config');
const thirdDb = require('../thirdDb');

const sourcePath = process.env.THIRD_APP_SQLITE_SOURCE ||
  process.env.TICKETS_DB_PATH ||
  config.dbPath;
const batchSize = Math.min(Math.max(Number.parseInt(process.env.THIRD_APP_MIGRATION_BATCH_SIZE || '250', 10), 1), 2000);

function tableExists(database, tableName) {
  const row = database.prepare(`
    SELECT name
    FROM sqlite_master
    WHERE type = 'table'
      AND name = ?
  `).get(tableName);

  return Boolean(row);
}

function getSqliteColumns(database, tableName) {
  return database.prepare(`PRAGMA table_info(${tableName})`).all().map(column => column.name);
}

function normalizeSourcePath(value) {
  const cleanPath = String(value || '').trim();

  if (!cleanPath) {
    return config.dbPath;
  }

  if (cleanPath === ':memory:' || path.isAbsolute(cleanPath)) {
    return cleanPath;
  }

  return path.join(__dirname, '..', cleanPath);
}

async function migrateTable(sqlite, tableName) {
  if (!tableExists(sqlite, tableName)) {
    return {
      table: tableName,
      skipped: true,
      reason: 'No existe en SQLite',
      rows: 0
    };
  }

  const targetColumns = thirdDb.tableColumns[tableName];
  const sourceColumns = getSqliteColumns(sqlite, tableName)
    .filter(column => targetColumns.includes(column));

  if (!sourceColumns.length) {
    return {
      table: tableName,
      skipped: true,
      reason: 'Sin columnas compatibles',
      rows: 0
    };
  }

  const countRow = sqlite.prepare(`SELECT COUNT(*) AS total FROM ${tableName}`).get();
  const total = Number(countRow && countRow.total || 0);
  let migrated = 0;

  for (let offset = 0; offset < total; offset += batchSize) {
    const rows = sqlite.prepare(`
      SELECT ${sourceColumns.join(', ')}
      FROM ${tableName}
      ORDER BY rowid ASC
      LIMIT ?
      OFFSET ?
    `).all(batchSize, offset);

    migrated += await thirdDb.upsertRows(tableName, rows);
  }

  return {
    table: tableName,
    skipped: false,
    rows: migrated
  };
}

async function main() {
  const sqlitePath = normalizeSourcePath(sourcePath);

  if (!fs.existsSync(sqlitePath)) {
    throw new Error(`No existe SQLite origen: ${sqlitePath}`);
  }

  const sqlite = new DatabaseSync(sqlitePath, { readOnly: true });
  const results = [];

  try {
    for (const tableName of Object.keys(thirdDb.tableColumns)) {
      results.push(await migrateTable(sqlite, tableName));
    }
  } finally {
    sqlite.close();
    await thirdDb.closePool();
  }

  console.log(JSON.stringify({
    success: true,
    source: sqlitePath,
    target: thirdDb.getMysqlSettings(),
    results
  }, null, 2));
}

main().catch(async error => {
  await thirdDb.closePool().catch(() => {});
  console.error(JSON.stringify({
    success: false,
    error: error.message
  }, null, 2));
  process.exitCode = 1;
});
