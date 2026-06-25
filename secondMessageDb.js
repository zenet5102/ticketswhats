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
    host: readEnv('SECOND_APP_MYSQL_HOST', readEnv('MYSQL_HOST', '127.0.0.1')),
    port: parsePositiveInteger(process.env.SECOND_APP_MYSQL_PORT || process.env.MYSQL_PORT, 3306),
    user: readEnv('SECOND_APP_MYSQL_USER', readEnv('MYSQL_USER', 'root')),
    password: process.env.SECOND_APP_MYSQL_PASSWORD !== undefined
      ? process.env.SECOND_APP_MYSQL_PASSWORD
      : process.env.MYSQL_PASSWORD || '',
    database: readEnv('SECOND_APP_MYSQL_DATABASE', readEnv('MYSQL_DATABASE', 'wwebjs_second')),
    connectionLimit: parsePositiveInteger(
      process.env.SECOND_APP_MYSQL_CONNECTION_LIMIT || process.env.MYSQL_CONNECTION_LIMIT,
      10
    ),
    createDatabase: parseBoolean(process.env.SECOND_APP_MYSQL_CREATE_DATABASE, true),
    messagesTable: readEnv('SECOND_APP_MYSQL_MESSAGES_TABLE', 'second_whatsapp_messages'),
    queueTable: readEnv('SECOND_APP_MYSQL_QUEUE_TABLE', 'second_message_queue'),
    queueSendingTimeoutMinutes: parsePositiveInteger(
      process.env.SECOND_MESSAGE_QUEUE_SENDING_TIMEOUT_MINUTES,
      15
    )
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
const queueTableSql = escapeIdentifier(settings.queueTable, 'tabla de cola');

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
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      PRIMARY KEY (id),
      KEY idx_second_messages_chat_time (chat_id, timestamp_ts),
      KEY idx_second_messages_time (timestamp_ts),
      KEY idx_second_messages_phone (phone)
    ) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci
  `);

  await databasePool.query(`
    CREATE TABLE IF NOT EXISTS ${queueTableSql} (
      id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
      queue_key VARCHAR(191) NULL,
      target VARCHAR(191) NOT NULL,
      phone VARCHAR(64) NULL,
      status VARCHAR(20) NOT NULL DEFAULT 'pending',
      source VARCHAR(64) NOT NULL DEFAULT 'second-queue',
      variables_json LONGTEXT NOT NULL,
      rendered_body TEXT NULL,
      template_index INT NULL,
      attempts INT NOT NULL DEFAULT 0,
      last_error TEXT NULL,
      scheduled_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      locked_at TIMESTAMP NULL DEFAULT NULL,
      sent_at TIMESTAMP NULL DEFAULT NULL,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      PRIMARY KEY (id),
      UNIQUE KEY uq_second_queue_key (queue_key),
      KEY idx_second_queue_status (status, scheduled_at, id),
      KEY idx_second_queue_phone (phone)
    ) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci
  `);
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

function normalizeChatPhone(value) {
  return String(value || '')
    .replace(/@c\.us$/i, '')
    .replace(/@s\.whatsapp\.net$/i, '')
    .replace(/@lid$/i, '')
    .replace(/@g\.us$/i, '')
    .replace(/\D/g, '');
}

function isLidChatId(value) {
  return /@lid$/i.test(String(value || '').trim());
}

function normalizeMessagePhone(phone, chatId) {
  const normalized = normalizeChatPhone(phone);
  const lidUser = isLidChatId(chatId) ? normalizeChatPhone(chatId) : '';

  if (normalized && lidUser && normalized === lidUser) {
    return '';
  }

  return normalized;
}

async function getWhatsAppMessage(id) {
  const database = await getPool();
  const [rows] = await database.execute(
    `SELECT * FROM ${messagesTableSql} WHERE id = ? LIMIT 1`,
    [id]
  );

  return rows[0] || null;
}

async function saveWhatsAppMessage(message = {}) {
  const chatId = String(message.chatId || '').trim();
  const direction = message.direction === 'incoming' ? 'incoming' : 'outgoing';
  const timestampTs = Number(message.timestampTs || Date.now());
  const timestamp = Number.isFinite(timestampTs) && timestampTs > 0 ? timestampTs : Date.now();
  const body = String(message.body || '').trim();
  const id = String(message.id || `${direction}-${chatId}-${timestamp}`).trim();

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
      source
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
      source = COALESCE(VALUES(source), source)
  `, [
    id,
    chatId,
    normalizeMessagePhone(message.phone || chatId, chatId) || null,
    String(message.contactName || '').trim() || null,
    direction,
    body,
    String(message.mediaMime || '').trim() || null,
    String(message.mediaData || '').trim() || null,
    String(message.mediaFilename || '').trim() || null,
    timestamp,
    new Date(timestamp).toISOString(),
    message.fromMe ? 1 : 0,
    Number.isFinite(Number(message.ack)) ? Number(message.ack) : null,
    String(message.source || '').trim() || null
  ]);

  return getWhatsAppMessage(id);
}

async function listWhatsAppConversations(limit = 100) {
  const safeLimit = Math.min(Math.max(Number(limit) || 100, 1), 1000);
  const database = await getPool();
  const [rows] = await database.query(`
    SELECT
      latest.id,
      latest.chat_id,
      COALESCE(
        (
          SELECT latest_phone.phone
          FROM ${messagesTableSql} latest_phone
          WHERE latest_phone.chat_id = latest.chat_id
            AND latest_phone.phone IS NOT NULL
            AND latest_phone.phone <> ''
          ORDER BY latest_phone.timestamp_ts DESC, latest_phone.created_at DESC, latest_phone.id DESC
          LIMIT 1
        ),
        latest.phone
      ) AS phone,
      COALESCE(
        (
          SELECT latest_contact.contact_name
          FROM ${messagesTableSql} latest_contact
          WHERE latest_contact.chat_id = latest.chat_id
            AND latest_contact.contact_name IS NOT NULL
            AND latest_contact.contact_name <> ''
          ORDER BY latest_contact.timestamp_ts DESC, latest_contact.created_at DESC, latest_contact.id DESC
          LIMIT 1
        ),
        latest.contact_name
      ) AS contact_name,
      latest.direction,
      latest.body,
      latest.media_mime,
      latest.media_filename,
      latest.timestamp_ts,
      latest.timestamp_iso,
      latest.from_me,
      latest.ack,
      latest.source,
      latest.created_at,
      counts.total_messages,
      counts.incoming_messages,
      counts.outgoing_messages,
      counts.last_incoming_ts
    FROM ${messagesTableSql} latest
    JOIN (
      SELECT
        chat_id,
        COUNT(*) AS total_messages,
        SUM(CASE WHEN direction = 'incoming' THEN 1 ELSE 0 END) AS incoming_messages,
        SUM(CASE WHEN direction = 'outgoing' THEN 1 ELSE 0 END) AS outgoing_messages,
        MAX(CASE WHEN direction = 'incoming' THEN timestamp_ts ELSE NULL END) AS last_incoming_ts
      FROM ${messagesTableSql}
      GROUP BY chat_id
    ) counts ON counts.chat_id = latest.chat_id
    WHERE latest.id = (
      SELECT ranked.id
      FROM ${messagesTableSql} ranked
      WHERE ranked.chat_id = latest.chat_id
      ORDER BY ranked.timestamp_ts DESC, ranked.created_at DESC, ranked.id DESC
      LIMIT 1
    )
    ORDER BY latest.timestamp_ts DESC, latest.created_at DESC, latest.id DESC
    LIMIT ${safeLimit}
  `);

  return rows;
}

async function listWhatsAppMessages(chatId, limit = 200) {
  const cleanChatId = String(chatId || '').trim();
  const safeLimit = Math.min(Math.max(Number(limit) || 200, 1), 500);

  if (!cleanChatId) {
    return [];
  }

  const database = await getPool();
  const [rows] = await database.execute(`
    SELECT *
    FROM (
      SELECT
        id,
        chat_id,
        CASE
          WHEN LOWER(chat_id) LIKE '%@lid'
            AND phone = REPLACE(LOWER(chat_id), '@lid', '')
          THEN NULL
          ELSE phone
        END AS phone,
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
        created_at
      FROM ${messagesTableSql}
      WHERE chat_id = ?
      ORDER BY timestamp_ts DESC, created_at DESC, id DESC
      LIMIT ${safeLimit}
    ) recent_messages
    ORDER BY timestamp_ts ASC, created_at ASC, id ASC
  `, [cleanChatId]);

  return rows;
}

async function listWhatsAppChatPhones(chatId) {
  const cleanChatId = String(chatId || '').trim();

  if (!cleanChatId) {
    return [];
  }

  const database = await getPool();
  const [rows] = await database.execute(`
    SELECT DISTINCT phone
    FROM ${messagesTableSql}
    WHERE chat_id = ?
      AND phone IS NOT NULL
      AND phone <> ''
  `, [cleanChatId]);

  return rows.map(row => row.phone);
}

function parseQueueRow(row) {
  if (!row) {
    return null;
  }

  let variables = {};

  try {
    variables = JSON.parse(row.variables_json || '{}') || {};
  } catch (error) {
    variables = {};
  }

  return {
    ...row,
    variables
  };
}

async function getMessageQueueItem(id) {
  const database = await getPool();
  const [rows] = await database.execute(
    `SELECT * FROM ${queueTableSql} WHERE id = ? LIMIT 1`,
    [Number(id)]
  );

  return parseQueueRow(rows[0]);
}

async function enqueueMessageQueueItem(item = {}) {
  const target = String(item.target || item.chatId || item.phone || '').trim();
  const phone = normalizeChatPhone(item.phone || target);
  const variables = item.variables && typeof item.variables === 'object' ? item.variables : {};
  const queueKey = String(item.queueKey || '').trim() || null;
  const source = String(item.source || 'second-queue').trim() || 'second-queue';

  if (!target) {
    throw new Error('Falta destino para encolar mensaje');
  }

  const database = await getPool();
  const [result] = await database.execute(`
    INSERT INTO ${queueTableSql} (
      queue_key,
      target,
      phone,
      source,
      variables_json
    )
    VALUES (?, ?, ?, ?, ?)
    ON DUPLICATE KEY UPDATE
      id = LAST_INSERT_ID(id),
      target = IF(status = 'sent', target, VALUES(target)),
      phone = IF(status = 'sent', phone, VALUES(phone)),
      source = IF(status = 'sent', source, VALUES(source)),
      variables_json = IF(status = 'sent', variables_json, VALUES(variables_json)),
      status = IF(status = 'sent', status, 'pending'),
      last_error = IF(status = 'sent', last_error, NULL),
      locked_at = IF(status = 'sent', locked_at, NULL),
      updated_at = CURRENT_TIMESTAMP
  `, [
    queueKey,
    target,
    phone || null,
    source,
    JSON.stringify(variables)
  ]);

  return getMessageQueueItem(result.insertId);
}

async function enqueueMessageQueueItems(items = []) {
  const results = [];

  for (const item of items) {
    results.push(await enqueueMessageQueueItem(item));
  }

  return results;
}

async function markStaleMessageQueueErrors(timeoutMinutes = settings.queueSendingTimeoutMinutes) {
  const safeMinutes = Math.min(Math.max(Number(timeoutMinutes) || 15, 1), 1440);
  const database = await getPool();
  const [result] = await database.query(`
    UPDATE ${queueTableSql}
    SET status = 'error',
        last_error = COALESCE(last_error, ?),
        locked_at = NULL,
        updated_at = CURRENT_TIMESTAMP
    WHERE status = 'sending'
      AND locked_at IS NOT NULL
      AND locked_at < DATE_SUB(CURRENT_TIMESTAMP, INTERVAL ${safeMinutes} MINUTE)
  `, [`Envio sin confirmacion por mas de ${safeMinutes} minutos`]);

  return Number(result.affectedRows || 0);
}

async function claimPendingMessageQueue(limit = 20) {
  const safeLimit = Math.min(Math.max(Number(limit) || 20, 1), 100);
  const database = await getPool();
  const [rows] = await database.query(`
    SELECT *
    FROM ${queueTableSql}
    WHERE status = 'pending'
      AND scheduled_at <= CURRENT_TIMESTAMP
    ORDER BY scheduled_at ASC, id ASC
    LIMIT ${safeLimit}
  `);
  const claimed = [];

  for (const row of rows) {
    const [result] = await database.execute(`
      UPDATE ${queueTableSql}
      SET status = 'sending',
          attempts = attempts + 1,
          locked_at = CURRENT_TIMESTAMP,
          updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
        AND status = 'pending'
    `, [row.id]);

    if (result.affectedRows) {
      claimed.push(await getMessageQueueItem(row.id));
    }
  }

  return claimed;
}

async function markMessageQueueSent(id, body, templateIndex) {
  const database = await getPool();

  await database.execute(`
    UPDATE ${queueTableSql}
    SET status = 'sent',
        rendered_body = ?,
        template_index = ?,
        last_error = NULL,
        sent_at = CURRENT_TIMESTAMP,
        updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `, [
    String(body || '').trim() || null,
    Number.isFinite(Number(templateIndex)) ? Number(templateIndex) : null,
    Number(id)
  ]);

  return getMessageQueueItem(id);
}

async function markMessageQueueError(id, errorMessage) {
  const database = await getPool();

  await database.execute(`
    UPDATE ${queueTableSql}
    SET status = 'error',
        last_error = ?,
        locked_at = NULL,
        updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `, [String(errorMessage || 'Error enviando mensaje'), Number(id)]);

  return getMessageQueueItem(id);
}

async function releaseMessageQueueItem(id, reason) {
  const database = await getPool();

  await database.execute(`
    UPDATE ${queueTableSql}
    SET status = 'pending',
        last_error = ?,
        locked_at = NULL,
        updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
      AND status = 'sending'
  `, [String(reason || '').trim() || null, Number(id)]);

  return getMessageQueueItem(id);
}

async function getMessageQueueStats() {
  const database = await getPool();
  const [rows] = await database.query(`
    SELECT status, COUNT(*) AS count
    FROM ${queueTableSql}
    GROUP BY status
  `);
  const stats = {
    pending: 0,
    sending: 0,
    sent: 0,
    error: 0,
    total: 0
  };

  for (const row of rows) {
    const status = String(row.status || '').trim() || 'unknown';
    const count = Number(row.count || 0);
    stats[status] = count;
    stats.total += count;
  }

  return stats;
}

async function listMessageQueueItems(options = {}) {
  const safeLimit = Math.min(Math.max(Number(options.limit) || 200, 1), 500);
  const status = String(options.status || '').trim();
  const database = await getPool();
  const params = [];
  let whereSql = '';

  if (status) {
    whereSql = 'WHERE status = ?';
    params.push(status);
  }

  const [rows] = await database.execute(`
    SELECT *
    FROM ${queueTableSql}
    ${whereSql}
    ORDER BY updated_at DESC, id DESC
    LIMIT ${safeLimit}
  `, params);

  return rows.map(parseQueueRow);
}

async function pingDatabase() {
  const database = await getPool();
  await database.query('SELECT 1 AS ok');
  return true;
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
  claimPendingMessageQueue,
  closePool,
  enqueueMessageQueueItem,
  enqueueMessageQueueItems,
  getMessageQueueItem,
  getMessageQueueStats,
  getMysqlSettings,
  getPool,
  listMessageQueueItems,
  listWhatsAppChatPhones,
  listWhatsAppConversations,
  listWhatsAppMessages,
  markMessageQueueError,
  markMessageQueueSent,
  markStaleMessageQueueErrors,
  normalizeChatPhone,
  pingDatabase,
  releaseMessageQueueItem,
  saveWhatsAppMessage
};
