require('./config');

const mysql = require('mysql2/promise');

let pool = null;
let initPromise = null;

const tableColumns = {
  tickets: [
    'external_id',
    'delegacion',
    'start',
    'start_ts',
    'start_date',
    'start_time',
    'status',
    'phone',
    'phones_json',
    'razon_social',
    'response_action',
    'response_label',
    'response_body',
    'response_received_at',
    'automatic_message_disabled_at',
    'automatic_message_disabled_reason',
    'payload_json',
    'message_sent_at',
    'message_error',
    'last_status_check_at',
    'created_at',
    'updated_at'
  ],
  whatsapp_messages: [
    'id',
    'chat_id',
    'phone',
    'contact_name',
    'direction',
    'body',
    'media_mime',
    'media_data',
    'media_filename',
    'timestamp_ts',
    'timestamp_iso',
    'from_me',
    'ack',
    'source',
    'sent_by_username',
    'sent_by_name',
    'whatsapp_account',
    'created_at'
  ],
  users: [
    'id',
    'username',
    'name',
    'role',
    'groups_json',
    'whatsapp_account',
    'whatsapp_accounts_json',
    'password_hash',
    'password_salt',
    'created_at',
    'updated_at'
  ],
  ticket_response_actions: [
    'id',
    'ticket_external_id',
    'chat_id',
    'phone',
    'question',
    'options_json',
    'delivery_mode',
    'sent_message_id',
    'status',
    'selected_key',
    'selected_label',
    'selected_action',
    'response_message_id',
    'response_body',
    'action_result',
    'completed_at',
    'created_at',
    'updated_at'
  ],
  app_state: ['key', 'value', 'updated_at'],
  automatic_message_templates: ['id', 'name', 'body', 'active', 'sort_order', 'created_at', 'updated_at'],
  whatsapp_chat_aliases: ['alias_chat_id', 'canonical_chat_id', 'phone', 'created_at', 'updated_at'],
  whatsapp_conversation_bucket_overrides: ['whatsapp_account', 'chat_id', 'bucket', 'updated_by', 'created_at', 'updated_at']
};

const primaryKeys = {
  tickets: ['external_id'],
  whatsapp_messages: ['id'],
  users: ['id'],
  ticket_response_actions: ['id'],
  app_state: ['key'],
  automatic_message_templates: ['id'],
  whatsapp_chat_aliases: ['alias_chat_id'],
  whatsapp_conversation_bucket_overrides: ['whatsapp_account', 'chat_id']
};

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

function getMysqlSettings() {
  return {
    host: readEnv('THIRD_APP_MYSQL_HOST', readEnv('MYSQL_HOST', '127.0.0.1')),
    port: parsePositiveInteger(process.env.THIRD_APP_MYSQL_PORT || process.env.MYSQL_PORT, 3306),
    user: readEnv('THIRD_APP_MYSQL_USER', readEnv('MYSQL_USER', 'root')),
    password: process.env.THIRD_APP_MYSQL_PASSWORD !== undefined
      ? process.env.THIRD_APP_MYSQL_PASSWORD
      : process.env.MYSQL_PASSWORD || '',
    database: readEnv('THIRD_APP_MYSQL_DATABASE', readEnv('MYSQL_DATABASE', 'wwebjs_third')),
    connectionLimit: parsePositiveInteger(
      process.env.THIRD_APP_MYSQL_CONNECTION_LIMIT || process.env.MYSQL_CONNECTION_LIMIT,
      10
    ),
    createDatabase: parseBoolean(process.env.THIRD_APP_MYSQL_CREATE_DATABASE, true)
  };
}

const settings = getMysqlSettings();

function escapeIdentifier(value, label = 'identificador') {
  const identifier = String(value || '').trim();

  if (!/^[A-Za-z0-9_]+$/.test(identifier)) {
    throw new Error(`Nombre de ${label} invalido: ${identifier}`);
  }

  return `\`${identifier}\``;
}

function createConnectionConfig(includeDatabase = true) {
  const config = {
    host: settings.host,
    port: settings.port,
    user: settings.user,
    password: settings.password,
    waitForConnections: true,
    connectionLimit: settings.connectionLimit,
    charset: 'utf8mb4',
    timezone: 'Z'
  };

  if (includeDatabase) {
    config.database = settings.database;
  }

  return config;
}

async function ensureDatabaseExists() {
  if (!settings.createDatabase) {
    return;
  }

  const connection = await mysql.createConnection(createConnectionConfig(false));

  try {
    await connection.query(
      `CREATE DATABASE IF NOT EXISTS ${escapeIdentifier(settings.database, 'base de datos')} CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`
    );
  } finally {
    await connection.end();
  }
}

async function initializeDatabase(databasePool) {
  await databasePool.query(`
    CREATE TABLE IF NOT EXISTS tickets (
      external_id VARCHAR(191) NOT NULL,
      delegacion VARCHAR(255) NOT NULL,
      start VARCHAR(64) NOT NULL,
      start_ts BIGINT NOT NULL,
      start_date VARCHAR(32) NOT NULL,
      start_time VARCHAR(32) NOT NULL,
      status VARCHAR(191) NULL,
      phone VARCHAR(64) NULL,
      phones_json LONGTEXT NOT NULL,
      razon_social VARCHAR(255) NULL,
      response_action VARCHAR(191) NULL,
      response_label VARCHAR(255) NULL,
      response_body TEXT NULL,
      response_received_at VARCHAR(32) NULL,
      automatic_message_disabled_at VARCHAR(32) NULL,
      automatic_message_disabled_reason TEXT NULL,
      payload_json LONGTEXT NOT NULL,
      message_sent_at VARCHAR(32) NULL,
      message_error TEXT NULL,
      last_status_check_at VARCHAR(32) NULL,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      PRIMARY KEY (external_id),
      KEY idx_tickets_start_order (start_date, start_ts, external_id),
      KEY idx_tickets_status (status),
      KEY idx_tickets_phone (phone),
      KEY idx_tickets_razon (razon_social)
    ) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci
  `);

  await databasePool.query(`
    CREATE TABLE IF NOT EXISTS whatsapp_messages (
      id VARCHAR(191) NOT NULL,
      chat_id VARCHAR(191) NOT NULL,
      phone VARCHAR(64) NULL,
      contact_name VARCHAR(255) NULL,
      direction VARCHAR(16) NOT NULL,
      body TEXT NOT NULL,
      media_mime VARCHAR(191) NULL,
      media_data LONGTEXT NULL,
      media_filename VARCHAR(255) NULL,
      timestamp_ts BIGINT NOT NULL,
      timestamp_iso VARCHAR(32) NOT NULL,
      from_me TINYINT(1) NOT NULL DEFAULT 0,
      ack INT NULL,
      source VARCHAR(64) NULL,
      sent_by_username VARCHAR(191) NULL,
      sent_by_name VARCHAR(255) NULL,
      whatsapp_account VARCHAR(64) NOT NULL DEFAULT 'bot-1',
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (id),
      KEY idx_whatsapp_messages_chat_time (chat_id, timestamp_ts),
      KEY idx_whatsapp_messages_account_chat_time (whatsapp_account, chat_id, timestamp_ts),
      KEY idx_whatsapp_messages_time (timestamp_ts),
      KEY idx_whatsapp_messages_phone (phone),
      KEY idx_whatsapp_messages_source (source)
    ) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci
  `);

  await databasePool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
      username VARCHAR(191) NOT NULL,
      name VARCHAR(255) NOT NULL,
      role VARCHAR(32) NOT NULL,
      groups_json LONGTEXT NOT NULL,
      whatsapp_account VARCHAR(64) NOT NULL DEFAULT 'bot-1',
      whatsapp_accounts_json LONGTEXT NOT NULL,
      password_hash VARCHAR(255) NOT NULL,
      password_salt VARCHAR(255) NOT NULL,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      PRIMARY KEY (id),
      UNIQUE KEY uq_users_username (username),
      KEY idx_users_role (role)
    ) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci
  `);

  await databasePool.query(`
    CREATE TABLE IF NOT EXISTS ticket_response_actions (
      id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
      ticket_external_id VARCHAR(191) NOT NULL,
      chat_id VARCHAR(191) NOT NULL,
      phone VARCHAR(64) NULL,
      question TEXT NOT NULL,
      options_json LONGTEXT NOT NULL,
      delivery_mode VARCHAR(32) NOT NULL DEFAULT 'text',
      sent_message_id VARCHAR(191) NULL,
      status VARCHAR(32) NOT NULL DEFAULT 'pending',
      selected_key VARCHAR(64) NULL,
      selected_label VARCHAR(255) NULL,
      selected_action VARCHAR(191) NULL,
      response_message_id VARCHAR(191) NULL,
      response_body TEXT NULL,
      action_result LONGTEXT NULL,
      completed_at VARCHAR(32) NULL,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      PRIMARY KEY (id),
      KEY idx_ticket_response_actions_chat (chat_id, status, created_at),
      KEY idx_ticket_response_actions_ticket (ticket_external_id, status)
    ) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci
  `);

  await databasePool.query(`
    CREATE TABLE IF NOT EXISTS app_state (
      \`key\` VARCHAR(191) NOT NULL,
      value LONGTEXT NULL,
      updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      PRIMARY KEY (\`key\`)
    ) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci
  `);

  await databasePool.query(`
    CREATE TABLE IF NOT EXISTS automatic_message_templates (
      id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
      name VARCHAR(255) NOT NULL,
      body TEXT NOT NULL,
      active TINYINT(1) NOT NULL DEFAULT 1,
      sort_order INT NOT NULL DEFAULT 0,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      PRIMARY KEY (id),
      KEY idx_automatic_message_templates_order (active, sort_order, id)
    ) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci
  `);

  await databasePool.query(`
    CREATE TABLE IF NOT EXISTS whatsapp_chat_aliases (
      alias_chat_id VARCHAR(191) NOT NULL,
      canonical_chat_id VARCHAR(191) NOT NULL,
      phone VARCHAR(64) NULL,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      PRIMARY KEY (alias_chat_id),
      KEY idx_whatsapp_chat_aliases_canonical (canonical_chat_id),
      KEY idx_whatsapp_chat_aliases_phone (phone)
    ) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci
  `);

  await databasePool.query(`
    CREATE TABLE IF NOT EXISTS whatsapp_conversation_bucket_overrides (
      whatsapp_account VARCHAR(64) NOT NULL DEFAULT 'bot-1',
      chat_id VARCHAR(191) NOT NULL,
      bucket VARCHAR(16) NOT NULL,
      updated_by VARCHAR(191) NULL,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      PRIMARY KEY (whatsapp_account, chat_id),
      KEY idx_whatsapp_conversation_bucket_overrides_bucket (bucket)
    ) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci
  `);
}

async function getPool() {
  if (pool) {
    return pool;
  }

  if (!initPromise) {
    initPromise = (async () => {
      await ensureDatabaseExists();
      const nextPool = mysql.createPool(createConnectionConfig(true));
      await initializeDatabase(nextPool);
      pool = nextPool;
      return pool;
    })();
  }

  return initPromise;
}

function normalizeChatPhone(value) {
  let phone = String(value || '')
    .replace(/@c\.us$/i, '')
    .replace(/@s\.whatsapp\.net$/i, '')
    .replace(/@lid$/i, '')
    .replace(/@g\.us$/i, '')
    .replace(/\D/g, '');

  if (!phone) {
    return '';
  }

  if (phone.startsWith('549')) {
    return phone;
  }

  if (phone.startsWith('54')) {
    return `549${phone.slice(2).replace(/^15/, '')}`;
  }

  phone = phone.replace(/^0+/, '');

  if (/^1115\d{8}$/.test(phone)) {
    phone = `11${phone.slice(4)}`;
  } else if (phone.startsWith('15') && phone.length >= 10) {
    phone = `11${phone.slice(2)}`;
  }

  return `549${phone}`;
}

function getPhoneCandidates(value) {
  const clean = normalizeChatPhone(value);
  const candidates = new Set();

  if (clean) candidates.add(clean);
  if (clean.startsWith('549') && clean.length > 3) candidates.add(clean.slice(3));
  if (clean.startsWith('54') && clean.length > 2) candidates.add(clean.slice(2));
  if (clean.length > 10) candidates.add(clean.slice(-10));
  if (clean.length > 8) candidates.add(clean.slice(-8));

  return Array.from(candidates).filter(item => item.length >= 6);
}

async function pingDatabase() {
  const database = await getPool();
  await database.query('SELECT 1 AS ok');
  return true;
}

async function getCounts() {
  const database = await getPool();
  const result = {};

  for (const tableName of Object.keys(tableColumns)) {
    const [[row]] = await database.query(`SELECT COUNT(*) AS total FROM ${escapeIdentifier(tableName, 'tabla')}`);
    result[tableName] = Number(row && row.total || 0);
  }

  return result;
}

async function listUsers({ limit = 100, offset = 0 } = {}) {
  const safeLimit = Math.min(Math.max(Number(limit) || 100, 1), 500);
  const safeOffset = Math.max(Number(offset) || 0, 0);
  const database = await getPool();
  const [rows] = await database.execute(`
    SELECT id, username, name, role, groups_json, whatsapp_account, whatsapp_accounts_json, created_at, updated_at
    FROM users
    ORDER BY role = 'admin' DESC, username ASC
    LIMIT ${safeLimit} OFFSET ${safeOffset}
  `);
  return rows;
}

async function listTickets({ date, phone, ticket, externalId, client, limit = 100, offset = 0 } = {}) {
  const safeLimit = Math.min(Math.max(Number(limit) || 100, 1), 1000);
  const safeOffset = Math.max(Number(offset) || 0, 0);
  const where = [];
  const params = [];
  const cleanTicket = String(ticket || externalId || '').trim();

  if (date) {
    where.push('start_date = ?');
    params.push(String(date).trim());
  }

  if (cleanTicket) {
    where.push('external_id = ?');
    params.push(cleanTicket);
  }

  if (phone) {
    const candidates = getPhoneCandidates(phone);
    if (candidates.length) {
      where.push(`(${candidates.map(() => 'phone LIKE ? OR phones_json LIKE ? OR payload_json LIKE ?').join(' OR ')})`);
      for (const candidate of candidates) {
        params.push(`%${candidate}%`, `%${candidate}%`, `%${candidate}%`);
      }
    }
  }

  if (client) {
    const terms = String(client).split(/\s+/).map(term => term.trim()).filter(Boolean).slice(0, 6);
    for (const term of terms) {
      const like = `%${term}%`;
      where.push('(razon_social LIKE ? OR delegacion LIKE ? OR payload_json LIKE ?)');
      params.push(like, like, like);
    }
  }

  const database = await getPool();
  const [rows] = await database.execute(`
    SELECT *
    FROM tickets
    ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
    ORDER BY start_ts DESC, external_id DESC
    LIMIT ${safeLimit} OFFSET ${safeOffset}
  `, params);

  return rows;
}

async function listMessages({ phone, chatId, ticket, client, limit = 200, offset = 0 } = {}) {
  const safeLimit = Math.min(Math.max(Number(limit) || 200, 1), 1000);
  const safeOffset = Math.max(Number(offset) || 0, 0);
  const where = ["chat_id <> 'status@broadcast'"];
  const params = [];
  const phoneCandidates = new Set(getPhoneCandidates(phone));

  if (ticket || client) {
    for (const row of await listTickets({ phone, ticket, client, limit: 50 })) {
      try {
        for (const item of JSON.parse(row.phones_json || '[]')) {
          for (const candidate of getPhoneCandidates(item)) phoneCandidates.add(candidate);
        }
      } catch (error) {
        // Ignore malformed legacy JSON during migration reads.
      }
      for (const candidate of getPhoneCandidates(row.phone)) phoneCandidates.add(candidate);
    }
  }

  if (chatId) {
    where.push('chat_id = ?');
    params.push(String(chatId).trim());
  }

  if (phoneCandidates.size) {
    const candidates = Array.from(phoneCandidates);
    where.push(`(${candidates.map(() => 'phone LIKE ? OR chat_id LIKE ?').join(' OR ')})`);
    for (const candidate of candidates) {
      params.push(`%${candidate}%`, `%${candidate}%`);
    }
  }

  const database = await getPool();
  const [rows] = await database.execute(`
    SELECT id, chat_id, phone, contact_name, direction, body, media_mime, media_filename,
      timestamp_ts, timestamp_iso, from_me, ack, source, sent_by_username, sent_by_name,
      whatsapp_account, created_at
    FROM whatsapp_messages
    WHERE ${where.join(' AND ')}
    ORDER BY timestamp_ts DESC, created_at DESC, id DESC
    LIMIT ${safeLimit} OFFSET ${safeOffset}
  `, params);

  return rows.reverse();
}

async function upsertRows(tableName, rows = []) {
  const columns = tableColumns[tableName];
  const keys = primaryKeys[tableName];

  if (!columns || !keys) {
    throw new Error(`Tabla no soportada para migracion: ${tableName}`);
  }

  if (!Array.isArray(rows) || !rows.length) {
    return 0;
  }

  const database = await getPool();
  let saved = 0;

  for (const row of rows) {
    const normalizedRow = normalizeMigrationRow(tableName, row);
    const values = columns.map(column => {
      const value = normalizedRow[column];
      if (value === undefined) return null;
      if (typeof value === 'boolean') return value ? 1 : 0;
      return value;
    });
    const updateColumns = columns.filter(column => !keys.includes(column));
    const sql = `
      INSERT INTO ${escapeIdentifier(tableName, 'tabla')} (${columns.map(column => escapeIdentifier(column, 'columna')).join(', ')})
      VALUES (${columns.map(() => '?').join(', ')})
      ON DUPLICATE KEY UPDATE ${updateColumns.map(column => `${escapeIdentifier(column, 'columna')} = VALUES(${escapeIdentifier(column, 'columna')})`).join(', ')}
    `;

    await database.execute(sql, values);
    saved += 1;
  }

  return saved;
}

function normalizeMigrationRow(tableName, row = {}) {
  const normalized = { ...row };

  if (tableName === 'tickets') {
    normalized.delegacion = normalized.delegacion || 'Sin delegacion';
    normalized.start = normalized.start || '';
    normalized.start_ts = Number(normalized.start_ts || 0);
    normalized.start_date = normalized.start_date || '';
    normalized.start_time = normalized.start_time || '';
    normalized.phones_json = normalized.phones_json || '[]';
    normalized.payload_json = normalized.payload_json || '{}';
  }

  if (tableName === 'whatsapp_messages') {
    normalized.direction = normalized.direction || 'incoming';
    normalized.body = normalized.body || '[mensaje sin texto]';
    normalized.timestamp_ts = Number(normalized.timestamp_ts || Date.now());
    normalized.timestamp_iso = normalized.timestamp_iso || new Date(normalized.timestamp_ts).toISOString();
    normalized.from_me = normalized.from_me ? 1 : 0;
    normalized.whatsapp_account = normalized.whatsapp_account || 'bot-1';
  }

  if (tableName === 'users') {
    normalized.groups_json = normalized.groups_json || '[]';
    normalized.whatsapp_account = normalized.whatsapp_account || 'bot-1';
    normalized.whatsapp_accounts_json = normalized.whatsapp_accounts_json || '["bot-1"]';
  }

  if (tableName === 'ticket_response_actions') {
    normalized.options_json = normalized.options_json || '[]';
    normalized.delivery_mode = normalized.delivery_mode || 'text';
    normalized.status = normalized.status || 'pending';
  }

  if (tableName === 'automatic_message_templates') {
    normalized.active = normalized.active === undefined || normalized.active === null ? 1 : normalized.active;
    normalized.sort_order = normalized.sort_order === undefined || normalized.sort_order === null ? 0 : normalized.sort_order;
  }

  if (tableName === 'whatsapp_conversation_bucket_overrides') {
    normalized.whatsapp_account = normalized.whatsapp_account || 'bot-1';
  }

  return normalized;
}

async function closePool() {
  if (pool) {
    const currentPool = pool;
    pool = null;
    initPromise = null;
    await currentPool.end();
  }
}

module.exports = {
  closePool,
  getCounts,
  getMysqlSettings,
  getPhoneCandidates,
  getPool,
  listMessages,
  listTickets,
  listUsers,
  normalizeChatPhone,
  pingDatabase,
  tableColumns,
  upsertRows
};
