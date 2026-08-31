const path = require('path');
const {
  isMainThread,
  parentPort,
  workerData,
  Worker,
  MessageChannel,
  receiveMessageOnPort
} = require('worker_threads');

function parsePositiveInteger(value, fallback) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function parseBoolean(value, fallback) {
  if (value === undefined || value === null || value === '') {
    return fallback;
  }

  return !['0', 'false', 'no', 'off'].includes(String(value).trim().toLowerCase());
}

function readEnv(name, fallback = '') {
  return String(process.env[name] || fallback).trim();
}

function getPrimaryMysqlSettings() {
  return {
    host: readEnv('APP_MYSQL_HOST', readEnv('MYSQL_HOST', readEnv('SECOND_APP_MYSQL_HOST', '127.0.0.1'))),
    port: parsePositiveInteger(process.env.APP_MYSQL_PORT || process.env.MYSQL_PORT || process.env.SECOND_APP_MYSQL_PORT, 3306),
    user: readEnv('APP_MYSQL_USER', readEnv('MYSQL_USER', readEnv('SECOND_APP_MYSQL_USER', 'root'))),
    password: process.env.APP_MYSQL_PASSWORD !== undefined
      ? process.env.APP_MYSQL_PASSWORD
      : process.env.MYSQL_PASSWORD !== undefined
        ? process.env.MYSQL_PASSWORD
        : process.env.SECOND_APP_MYSQL_PASSWORD || '',
    database: readEnv('APP_MYSQL_DATABASE', readEnv('MYSQL_DATABASE', readEnv('SECOND_APP_MYSQL_DATABASE', 'wwebjs'))),
    connectionLimit: parsePositiveInteger(
      process.env.APP_MYSQL_CONNECTION_LIMIT || process.env.MYSQL_CONNECTION_LIMIT || process.env.SECOND_APP_MYSQL_CONNECTION_LIMIT,
      10
    ),
    createDatabase: parseBoolean(
      process.env.APP_MYSQL_CREATE_DATABASE || process.env.MYSQL_CREATE_DATABASE || process.env.SECOND_APP_MYSQL_CREATE_DATABASE,
      true
    )
  };
}

function escapeIdentifier(value, label = 'identificador') {
  const identifier = String(value || '').trim();

  if (!/^[A-Za-z0-9_]+$/.test(identifier)) {
    throw new Error(`Nombre de ${label} invalido: ${identifier}`);
  }

  return `\`${identifier}\``;
}

function splitSqlStatements(sql) {
  const statements = [];
  let current = '';
  let quote = '';

  for (let index = 0; index < sql.length; index += 1) {
    const char = sql[index];
    const previous = sql[index - 1];

    if ((char === '\'' || char === '"' || char === '`') && previous !== '\\') {
      quote = quote === char ? '' : (quote || char);
    }

    if (char === ';' && !quote) {
      if (current.trim()) {
        statements.push(current.trim());
      }
      current = '';
      continue;
    }

    current += char;
  }

  if (current.trim()) {
    statements.push(current.trim());
  }

  return statements;
}

function translateSql(sql) {
  let output = String(sql || '').trim();

  output = output
    .replace(/^BEGIN$/i, 'START TRANSACTION')
    .replace(/CREATE INDEX IF NOT EXISTS\s+([A-Za-z0-9_]+)\s+ON/gi, 'CREATE INDEX $1 ON');

  return output;
}

function normalizeRows(rows) {
  return JSON.parse(JSON.stringify(rows || []));
}

if (!isMainThread) {
  const mysql = require('mysql2/promise');
  let pool = null;

  function createConnectionConfig(includeDatabase = true) {
    const config = {
      host: workerData.host,
      port: workerData.port,
      user: workerData.user,
      password: workerData.password,
      waitForConnections: true,
      connectionLimit: workerData.connectionLimit,
      charset: 'utf8mb4',
      timezone: 'Z',
      dateStrings: true
    };

    if (includeDatabase) {
      config.database = workerData.database;
    }

    return config;
  }

  async function ensurePool() {
    if (pool) {
      return pool;
    }

    if (workerData.createDatabase) {
      const connection = await mysql.createConnection(createConnectionConfig(false));
      try {
        await connection.query(
          `CREATE DATABASE IF NOT EXISTS ${escapeIdentifier(workerData.database, 'base de datos')} CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`
        );
      } finally {
        await connection.end();
      }
    }

    pool = mysql.createPool(createConnectionConfig(true));
    return pool;
  }

  async function runSql(sql, params = []) {
    const database = await ensurePool();
    const cleanSql = translateSql(sql);

    if (/^PRAGMA\s+table_info\(([^)]+)\)$/i.test(cleanSql)) {
      const tableName = cleanSql.match(/^PRAGMA\s+table_info\(([^)]+)\)$/i)[1].replace(/[`'"]/g, '').trim();
      const [columns] = await database.query(`SHOW COLUMNS FROM ${escapeIdentifier(tableName, 'tabla')}`);
      let primaryIndex = 0;

      return columns.map(column => {
        if (column.Key === 'PRI') {
          primaryIndex += 1;
        }

        return {
          name: column.Field,
          type: column.Type,
          notnull: String(column.Null).toUpperCase() === 'NO' ? 1 : 0,
          dflt_value: column.Default,
          pk: column.Key === 'PRI' ? primaryIndex : 0
        };
      });
    }

    const [rows] = await database.execute(cleanSql, params);

    if (Array.isArray(rows)) {
      return normalizeRows(rows);
    }

    return {
      changes: Number(rows && rows.affectedRows || 0),
      lastInsertRowid: Number(rows && rows.insertId || 0)
    };
  }

  async function execSql(sql) {
    const statements = splitSqlStatements(sql);
    let changes = 0;

    for (const statement of statements) {
      if (/^PRAGMA\b/i.test(statement)) {
        continue;
      }

      try {
        const result = await runSql(statement);
        changes += Number(result && result.changes || 0);
      } catch (error) {
        if (error && (error.code === 'ER_DUP_KEYNAME' || error.code === 'ER_DUP_FIELDNAME')) {
          continue;
        }

        throw error;
      }
    }

    return { changes };
  }

  parentPort.on('message', async message => {
    const { port, signal, type, sql, params } = message;

    try {
      const result = type === 'exec'
        ? await execSql(sql)
        : await runSql(sql, params || []);
      port.postMessage({ ok: true, result });
    } catch (error) {
      port.postMessage({
        ok: false,
        error: {
          message: error && error.message || String(error),
          code: error && error.code,
          stack: error && error.stack
        }
      });
    } finally {
      Atomics.store(new Int32Array(signal), 0, 1);
      Atomics.notify(new Int32Array(signal), 0, 1);
      port.close();
    }
  });
} else {
  class MysqlSyncStatement {
    constructor(database, sql) {
      this.database = database;
      this.sql = sql;
    }

    all(...params) {
      return this.database.query(this.sql, params);
    }

    get(...params) {
      const rows = this.all(...params);
      return rows[0];
    }

    run(...params) {
      return this.database.query(this.sql, params);
    }
  }

  class MysqlSyncDatabase {
    constructor(settings = getPrimaryMysqlSettings()) {
      this.settings = settings;
      this.worker = new Worker(__filename, { workerData: settings });
    }

    call(type, payload = {}) {
      const signal = new SharedArrayBuffer(4);
      const { port1, port2 } = new MessageChannel();

      this.worker.postMessage({
        ...payload,
        type,
        signal,
        port: port2
      }, [port2]);

      Atomics.wait(new Int32Array(signal), 0, 0);

      const response = receiveMessageOnPort(port1);
      port1.close();

      if (!response || !response.message) {
        throw new Error('MySQL no devolvio respuesta');
      }

      if (!response.message.ok) {
        const error = new Error(response.message.error && response.message.error.message || 'Error MySQL');
        error.code = response.message.error && response.message.error.code;
        error.stack = response.message.error && response.message.error.stack || error.stack;
        throw error;
      }

      return response.message.result;
    }

    prepare(sql) {
      return new MysqlSyncStatement(this, sql);
    }

    query(sql, params = []) {
      return this.call('query', { sql, params });
    }

    exec(sql) {
      return this.call('exec', { sql });
    }

    close() {
      if (this.worker) {
        this.worker.terminate();
        this.worker = null;
      }
    }
  }

  module.exports = {
    MysqlSyncDatabase,
    getPrimaryMysqlSettings
  };
}
