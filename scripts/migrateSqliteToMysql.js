require('../config');

const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');
const {
  closeDb,
  getDb
} = require('../db');
const { config } = require('../config');

const tables = [
  'tickets',
  'whatsapp_messages',
  'users',
  'ticket_response_actions',
  'app_state',
  'automatic_message_templates',
  'whatsapp_chat_aliases',
  'whatsapp_conversation_bucket_overrides'
];

function escapeIdentifier(value, label = 'identificador') {
  const identifier = String(value || '').trim();

  if (!/^[A-Za-z0-9_]+$/.test(identifier)) {
    throw new Error(`Nombre de ${label} invalido: ${identifier}`);
  }

  return `\`${identifier}\``;
}

function getSqlitePath() {
  const configuredPath = process.env.SQLITE_MIGRATION_PATH || process.env.TICKETS_SQLITE_PATH || config.dbPath;
  return path.isAbsolute(configuredPath)
    ? configuredPath
    : path.join(__dirname, '..', configuredPath);
}

function sqliteTableExists(database, tableName) {
  return Boolean(database.prepare(`
    SELECT name
    FROM sqlite_master
    WHERE type = 'table' AND name = ?
    LIMIT 1
  `).get(tableName));
}

function getSqliteColumns(database, tableName) {
  return database.prepare(`PRAGMA table_info(${tableName})`)
    .all()
    .map(column => String(column.name || '').trim())
    .filter(Boolean);
}

function importTable(source, target, tableName) {
  if (!sqliteTableExists(source, tableName)) {
    return {
      table: tableName,
      imported: 0,
      skipped: true
    };
  }

  const columns = getSqliteColumns(source, tableName);

  if (!columns.length) {
    return {
      table: tableName,
      imported: 0,
      skipped: true
    };
  }

  const tableSql = escapeIdentifier(tableName, 'tabla');
  const columnsSql = columns.map(column => escapeIdentifier(column, 'columna')).join(', ');
  const placeholders = columns.map(() => '?').join(', ');
  const rows = source.prepare(`SELECT ${columnsSql} FROM ${tableSql}`).all();
  const statement = target.prepare(`
    REPLACE INTO ${tableSql} (${columnsSql})
    VALUES (${placeholders})
  `);

  let imported = 0;
  target.exec('START TRANSACTION');

  try {
    for (const row of rows) {
      statement.run(...columns.map(column => row[column]));
      imported += 1;
    }

    target.exec('COMMIT');
  } catch (error) {
    target.exec('ROLLBACK');
    throw error;
  }

  return {
    table: tableName,
    imported,
    skipped: false
  };
}

function main() {
  const sqlitePath = getSqlitePath();

  if (!fs.existsSync(sqlitePath)) {
    throw new Error(`No existe la base SQLite para migrar: ${sqlitePath}`);
  }

  const source = new DatabaseSync(sqlitePath, { readOnly: true });
  const target = getDb();
  const results = [];

  try {
    for (const tableName of tables) {
      const result = importTable(source, target, tableName);
      results.push(result);
      console.log(`${result.skipped ? 'Saltada' : 'Migrada'} ${tableName}: ${result.imported}`);
    }
  } finally {
    source.close();
  }

  console.log(JSON.stringify({
    success: true,
    source: sqlitePath,
    results
  }, null, 2));
}

try {
  main();
} catch (error) {
  console.error(error);
  process.exitCode = 1;
} finally {
  closeDb();
}
