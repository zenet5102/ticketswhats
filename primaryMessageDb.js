require('./config');

const mysql = require('mysql2/promise');

let pool = null;
let initPromise = null;

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
    host: readEnv('FIRST_SERVER_MYSQL_HOST', readEnv('MYSQL_HOST', readEnv('SECOND_APP_MYSQL_HOST', '127.0.0.1'))),
    port: parsePositiveInteger(
      process.env.FIRST_SERVER_MYSQL_PORT || process.env.MYSQL_PORT || process.env.SECOND_APP_MYSQL_PORT,
      3306
    ),
    user: readEnv('FIRST_SERVER_MYSQL_USER', readEnv('MYSQL_USER', readEnv('SECOND_APP_MYSQL_USER', 'root'))),
    password: process.env.FIRST_SERVER_MYSQL_PASSWORD !== undefined
      ? process.env.FIRST_SERVER_MYSQL_PASSWORD
      : process.env.MYSQL_PASSWORD !== undefined
        ? process.env.MYSQL_PASSWORD
        : process.env.SECOND_APP_MYSQL_PASSWORD || '',
    database: readEnv(
      'FIRST_SERVER_MYSQL_DATABASE',
      readEnv('MYSQL_DATABASE', readEnv('SECOND_APP_MYSQL_DATABASE', 'wwebjs_second'))
    ),
    connectionLimit: parsePositiveInteger(
      process.env.FIRST_SERVER_MYSQL_CONNECTION_LIMIT ||
        process.env.MYSQL_CONNECTION_LIMIT ||
        process.env.SECOND_APP_MYSQL_CONNECTION_LIMIT,
      10
    ),
    createDatabase: parseBoolean(
      process.env.FIRST_SERVER_MYSQL_CREATE_DATABASE ||
        process.env.MYSQL_CREATE_DATABASE ||
        process.env.SECOND_APP_MYSQL_CREATE_DATABASE,
      true
    ),
    messagesTable: readEnv('FIRST_SERVER_MYSQL_MESSAGES_TABLE', 'primary_whatsapp_messages')
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

const databaseNameSql = escapeIdentifier(settings.database, 'base de datos');
const messagesTableSql = escapeIdentifier(settings.messagesTable, 'tabla');

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
      `CREATE DATABASE IF NOT EXISTS ${databaseNameSql} CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`
    );
  } finally {
    await connection.end();
  }
}

async function ensureTableColumn(databasePool, tableSql, columnName, definition) {
  const [rows] = await databasePool.query(
    `SHOW COLUMNS FROM ${tableSql} LIKE ?`,
    [columnName]
  );

  if (!rows.length) {
    await databasePool.query(
      `ALTER TABLE ${tableSql} ADD COLUMN ${escapeIdentifier(columnName, 'columna')} ${definition}`
    );
  }
}

async function ensureTableIndex(databasePool, tableSql, indexName, definition) {
  const [rows] = await databasePool.query(
    `SHOW INDEX FROM ${tableSql} WHERE Key_name = ?`,
    [indexName]
  );

  if (!rows.length) {
    await databasePool.query(`ALTER TABLE ${tableSql} ADD ${definition}`);
  }
}

async function initializeMessageDatabase(databasePool) {
  await databasePool.query(`
    CREATE TABLE IF NOT EXISTS ${messagesTableSql} (
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
      client_id VARCHAR(191) NULL,
      ticket_id VARCHAR(191) NULL,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      PRIMARY KEY (id),
      KEY idx_primary_messages_account_chat_time (whatsapp_account, chat_id, timestamp_ts),
      KEY idx_primary_messages_chat_time (chat_id, timestamp_ts),
      KEY idx_primary_messages_time (timestamp_ts),
      KEY idx_primary_messages_phone (phone),
      KEY idx_primary_messages_client (client_id),
      KEY idx_primary_messages_ticket (ticket_id)
    ) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci
  `);

  await ensureTableColumn(databasePool, messagesTableSql, 'sent_by_username', 'VARCHAR(191) NULL');
  await ensureTableColumn(databasePool, messagesTableSql, 'sent_by_name', 'VARCHAR(255) NULL');
  await ensureTableColumn(databasePool, messagesTableSql, 'whatsapp_account', "VARCHAR(64) NOT NULL DEFAULT 'bot-1'");
  await ensureTableColumn(databasePool, messagesTableSql, 'client_id', 'VARCHAR(191) NULL');
  await ensureTableColumn(databasePool, messagesTableSql, 'ticket_id', 'VARCHAR(191) NULL');
  await ensureTableIndex(
    databasePool,
    messagesTableSql,
    'idx_primary_messages_client',
    'KEY idx_primary_messages_client (client_id)'
  );
  await ensureTableIndex(
    databasePool,
    messagesTableSql,
    'idx_primary_messages_ticket',
    'KEY idx_primary_messages_ticket (ticket_id)'
  );
}

async function getPool() {
  if (!pool) {
    await ensureDatabaseExists();
    pool = mysql.createPool(createConnectionConfig(true));
  }

  if (!initPromise) {
    initPromise = initializeMessageDatabase(pool);
  }

  try {
    await initPromise;
  } catch (error) {
    initPromise = null;

    if (pool) {
      const failedPool = pool;
      pool = null;
      await failedPool.end().catch(() => {});
    }

    throw error;
  }

  return pool;
}

function normalizeWhatsAppAccount(value) {
  return String(value || 'bot-1').trim() || 'bot-1';
}

function normalizeOptionalId(...values) {
  for (const value of values) {
    const cleanValue = String(value || '').trim();

    if (cleanValue) {
      return cleanValue.slice(0, 191);
    }
  }

  return null;
}

async function saveWhatsAppMessage(message = {}) {
  const id = String(message.id || '').trim();
  const chatId = String(message.chat_id || message.chatId || '').trim();
  const direction = message.direction === 'incoming' ? 'incoming' : 'outgoing';
  const timestampTs = Number(message.timestamp_ts || message.timestampTs || Date.now());
  const timestamp = Number.isFinite(timestampTs) && timestampTs > 0 ? timestampTs : Date.now();
  const body = String(message.body || '').trim();

  if (!id || !chatId || !body) {
    throw new Error('Faltan datos del mensaje');
  }

  const database = await getPool();

  await database.execute(`
    INSERT INTO ${messagesTableSql} (
      id,
      chat_id,
      phone,
      contact_name,
      direction,
      body,
      media_mime,
      media_data,
      media_filename,
      timestamp_ts,
      timestamp_iso,
      from_me,
      ack,
      source,
      sent_by_username,
      sent_by_name,
      whatsapp_account,
      client_id,
      ticket_id
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON DUPLICATE KEY UPDATE
      chat_id = VALUES(chat_id),
      phone = COALESCE(VALUES(phone), phone),
      contact_name = COALESCE(VALUES(contact_name), contact_name),
      body = CASE
        WHEN body LIKE '[% sin texto]' AND VALUES(body) NOT LIKE '[% sin texto]'
        THEN VALUES(body)
        ELSE body
      END,
      media_mime = COALESCE(VALUES(media_mime), media_mime),
      media_data = COALESCE(VALUES(media_data), media_data),
      media_filename = COALESCE(VALUES(media_filename), media_filename),
      timestamp_ts = VALUES(timestamp_ts),
      timestamp_iso = VALUES(timestamp_iso),
      from_me = VALUES(from_me),
      ack = COALESCE(VALUES(ack), ack),
      source = COALESCE(VALUES(source), source),
      sent_by_username = COALESCE(VALUES(sent_by_username), sent_by_username),
      sent_by_name = COALESCE(VALUES(sent_by_name), sent_by_name),
      whatsapp_account = COALESCE(VALUES(whatsapp_account), whatsapp_account),
      client_id = COALESCE(VALUES(client_id), client_id),
      ticket_id = COALESCE(VALUES(ticket_id), ticket_id)
  `, [
    id,
    chatId,
    String(message.phone || '').trim() || null,
    String(message.contact_name || message.contactName || '').trim() || null,
    direction,
    body,
    String(message.media_mime || message.mediaMime || '').trim() || null,
    String(message.media_data || message.mediaData || '').trim() || null,
    String(message.media_filename || message.mediaFilename || '').trim() || null,
    timestamp,
    message.timestamp_iso || message.timestampIso || new Date(timestamp).toISOString(),
    message.from_me || message.fromMe ? 1 : 0,
    Number.isFinite(Number(message.ack)) ? Number(message.ack) : null,
    String(message.source || '').trim() || null,
    String(message.sent_by_username || message.sentByUsername || '').trim() || null,
    String(message.sent_by_name || message.sentByName || '').trim() || null,
    normalizeWhatsAppAccount(message.whatsapp_account || message.whatsappAccount || message.accountId),
    normalizeOptionalId(message.client_id, message.clientId, message.IDA, message.ida),
    normalizeOptionalId(message.ticket_id, message.ticketId, message.ticketExternalId, message.externalId)
  ]);
}

async function updateWhatsAppMessageAck(id, ack) {
  const cleanId = String(id || '').trim();
  const parsedAck = Number(ack);

  if (!cleanId || !Number.isFinite(parsedAck)) {
    return;
  }

  const database = await getPool();
  await database.execute(
    `UPDATE ${messagesTableSql} SET ack = ? WHERE id = ?`,
    [parsedAck, cleanId]
  );
}

async function pingDatabase() {
  const database = await getPool();
  await database.query('SELECT 1');
  return true;
}

function getStatusPayload() {
  return {
    host: settings.host,
    port: settings.port,
    database: settings.database,
    table: settings.messagesTable
  };
}

module.exports = {
  getMysqlSettings,
  getStatusPayload,
  pingDatabase,
  saveWhatsAppMessage,
  updateWhatsAppMessageAck
};
