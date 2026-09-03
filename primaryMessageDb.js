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

function isDirectPhoneChatId(value) {
  return /@(c\.us|s\.whatsapp\.net)$/i.test(String(value || '').trim());
}

function normalizeMessagePhone(phone, chatId) {
  const normalized = normalizeChatPhone(phone);
  const lidUser = isLidChatId(chatId) ? normalizeChatPhone(chatId) : '';

  if (normalized && lidUser && normalized === lidUser) {
    return '';
  }

  return normalized;
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

async function listRecentWhatsAppMessages(limit = 1000, options = {}) {
  const safeLimit = Math.min(Math.max(Number(limit) || 1000, 1), 2000);
  const accountFilter = String(options.whatsappAccount || options.accountId || '').trim();
  const database = await getPool();
  const params = [];
  const whereParts = [];

  if (accountFilter) {
    whereParts.push('COALESCE(whatsapp_account, ?) = ?');
    params.push('bot-1', accountFilter);
  }

  params.push(safeLimit);

  const [rows] = await database.execute(`
    SELECT
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
      whatsapp_account
    FROM ${messagesTableSql}
    ${whereParts.length ? `WHERE ${whereParts.join(' AND ')}` : ''}
    ORDER BY timestamp_ts DESC, created_at DESC, id DESC
    LIMIT ?
  `, params);

  return rows;
}

async function listWhatsAppConversations(limit = 100, options = {}) {
  const safeLimit = Math.min(Math.max(Number(limit) || 100, 1), 1000);
  const accountFilter = String(options.whatsappAccount || options.accountId || '').trim();
  const database = await getPool();
  const whereClause = accountFilter ? 'WHERE COALESCE(whatsapp_account, ?) = ?' : '';
  const whereParams = accountFilter ? ['bot-1', accountFilter] : [];

  const [rows] = await database.execute(`
    WITH ranked AS (
      SELECT
        ${messagesTableSql}.*,
        ROW_NUMBER() OVER (
          PARTITION BY COALESCE(whatsapp_account, 'bot-1'), chat_id
          ORDER BY timestamp_ts DESC, created_at DESC, id DESC
        ) AS row_number
      FROM ${messagesTableSql}
      ${whereClause}
    ),
    counts AS (
      SELECT
        COALESCE(whatsapp_account, 'bot-1') AS whatsapp_account,
        chat_id,
        COUNT(*) AS total_messages,
        SUM(CASE WHEN direction = 'incoming' THEN 1 ELSE 0 END) AS incoming_messages,
        SUM(CASE WHEN direction = 'outgoing' THEN 1 ELSE 0 END) AS outgoing_messages,
        MAX(CASE WHEN direction = 'incoming' THEN timestamp_ts ELSE NULL END) AS last_incoming_ts,
        SUM(CASE
          WHEN direction = 'outgoing'
            AND source IN ('ticket', 'ticket-response', 'notification-channel', 'manual', 'inbox', 'bot')
          THEN 1
          ELSE 0
        END) AS app_started_messages,
        SUM(CASE
          WHEN direction = 'outgoing'
            AND source IN ('manual', 'inbox', 'bot')
          THEN 1
          ELSE 0
        END) AS manual_started_messages
      FROM ${messagesTableSql}
      ${whereClause}
      GROUP BY COALESCE(whatsapp_account, 'bot-1'), chat_id
    )
    SELECT
      ranked.id,
      COALESCE(ranked.whatsapp_account, 'bot-1') AS whatsapp_account,
      ranked.chat_id,
      COALESCE(
        (
          SELECT latest_phone.phone
          FROM ${messagesTableSql} latest_phone
          WHERE latest_phone.chat_id = ranked.chat_id
            AND COALESCE(latest_phone.whatsapp_account, 'bot-1') = COALESCE(ranked.whatsapp_account, 'bot-1')
            AND latest_phone.phone IS NOT NULL
            AND latest_phone.phone <> ''
            AND NOT (
              LOWER(ranked.chat_id) LIKE '%@lid'
              AND latest_phone.phone = REPLACE(LOWER(ranked.chat_id), '@lid', '')
            )
          ORDER BY latest_phone.timestamp_ts DESC, latest_phone.created_at DESC
          LIMIT 1
        ),
        CASE
          WHEN LOWER(ranked.chat_id) LIKE '%@lid'
            AND ranked.phone = REPLACE(LOWER(ranked.chat_id), '@lid', '')
          THEN NULL
          ELSE ranked.phone
        END
      ) AS phone,
      COALESCE(
        (
          SELECT latest_contact.contact_name
          FROM ${messagesTableSql} latest_contact
          WHERE latest_contact.chat_id = ranked.chat_id
            AND COALESCE(latest_contact.whatsapp_account, 'bot-1') = COALESCE(ranked.whatsapp_account, 'bot-1')
            AND latest_contact.direction = 'incoming'
            AND latest_contact.contact_name IS NOT NULL
            AND latest_contact.contact_name <> ''
          ORDER BY latest_contact.timestamp_ts DESC, latest_contact.created_at DESC
          LIMIT 1
        ),
        ranked.contact_name
      ) AS contact_name,
      ranked.direction,
      ranked.body,
      ranked.timestamp_ts,
      ranked.timestamp_iso,
      ranked.from_me,
      ranked.ack,
      ranked.source,
      ranked.sent_by_username,
      ranked.sent_by_name,
      ranked.created_at,
      counts.total_messages,
      counts.incoming_messages,
      counts.outgoing_messages,
      counts.last_incoming_ts,
      counts.app_started_messages,
      counts.manual_started_messages
    FROM ranked
    JOIN counts
      ON counts.chat_id = ranked.chat_id
      AND counts.whatsapp_account = COALESCE(ranked.whatsapp_account, 'bot-1')
    WHERE ranked.row_number = 1
    ORDER BY ranked.timestamp_ts DESC, ranked.created_at DESC
    LIMIT ?
  `, [...whereParams, ...whereParams, safeLimit]);

  return rows;
}

async function listWhatsAppChatPhones(chatId, options = {}) {
  const cleanChatId = String(chatId || '').trim();
  const accountFilter = String(options.whatsappAccount || options.accountId || '').trim();

  if (!cleanChatId) {
    return [];
  }

  const database = await getPool();
  const params = [cleanChatId];
  const whereParts = [
    'chat_id = ?',
    'phone IS NOT NULL',
    "phone <> ''"
  ];

  if (accountFilter) {
    whereParts.push("COALESCE(whatsapp_account, 'bot-1') = ?");
    params.push(accountFilter);
  }

  const [rows] = await database.execute(`
    SELECT DISTINCT phone
    FROM ${messagesTableSql}
    WHERE ${whereParts.join(' AND ')}
    ORDER BY phone
  `, params);

  return rows.map(row => row.phone);
}

function dedupeVisualMessages(rows) {
  const seen = new Set();
  const output = [];

  for (const row of rows) {
    const direction = String(row.direction || '').trim().toLowerCase();
    const phone = normalizeChatPhone(row.phone || row.chat_id);
    const body = String(row.body || '').trim();
    const key = JSON.stringify([
      normalizeWhatsAppAccount(row.whatsapp_account),
      phone || String(row.chat_id || '').trim().toLowerCase(),
      direction,
      body,
      row.media_mime || '',
      row.media_filename || '',
      Math.floor(Number(row.timestamp_ts || 0) / 5000)
    ]);

    if (seen.has(key)) {
      continue;
    }

    seen.add(key);
    output.push(row);
  }

  return output;
}

async function listWhatsAppMessages(chatId, limit = 200, options = {}) {
  const cleanChatId = String(chatId || '').trim();
  const safeLimit = Math.min(Math.max(Number(limit) || 200, 1), 500);
  const accountFilter = String(options.whatsappAccount || options.accountId || '').trim();

  if (!cleanChatId) {
    return [];
  }

  const database = await getPool();
  const chatIds = [cleanChatId];
  const aliasPhone = isDirectPhoneChatId(cleanChatId) ? normalizeChatPhone(cleanChatId) : '';
  const selectedPhones = (await listWhatsAppChatPhones(cleanChatId, { accountId: accountFilter }))
    .map(phone => normalizeChatPhone(phone))
    .filter(Boolean);

  if (aliasPhone) {
    const params = [aliasPhone];
    const whereParts = [
      "LOWER(chat_id) LIKE '%@lid'",
      'phone = ?',
      "chat_id <> 'status@broadcast'"
    ];

    if (accountFilter) {
      whereParts.push("COALESCE(whatsapp_account, 'bot-1') = ?");
      params.push(accountFilter);
    }

    const [aliasRows] = await database.execute(`
      SELECT DISTINCT chat_id
      FROM ${messagesTableSql}
      WHERE ${whereParts.join(' AND ')}
      ORDER BY chat_id
    `, params);

    for (const aliasRow of aliasRows) {
      const aliasChatId = String(aliasRow.chat_id || '').trim();

      if (aliasChatId && !chatIds.includes(aliasChatId)) {
        chatIds.push(aliasChatId);
      }
    }
  }

  if (isLidChatId(cleanChatId) && selectedPhones.length) {
    const placeholders = selectedPhones.map(() => '?').join(',');
    const params = [...selectedPhones];
    const whereParts = [
      `phone IN (${placeholders})`,
      "LOWER(chat_id) NOT LIKE '%@lid'",
      "chat_id <> 'status@broadcast'"
    ];

    if (accountFilter) {
      whereParts.push("COALESCE(whatsapp_account, 'bot-1') = ?");
      params.push(accountFilter);
    }

    const [directRows] = await database.execute(`
      SELECT DISTINCT chat_id
      FROM ${messagesTableSql}
      WHERE ${whereParts.join(' AND ')}
      ORDER BY chat_id
    `, params);

    for (const directRow of directRows) {
      const directChatId = String(directRow.chat_id || '').trim();

      if (directChatId && !chatIds.includes(directChatId)) {
        chatIds.push(directChatId);
      }
    }
  }

  const chatPlaceholders = chatIds.map(() => '?').join(',');
  const params = [...chatIds];
  const whereParts = [
    `chat_id IN (${chatPlaceholders})`,
    "chat_id <> 'status@broadcast'"
  ];

  if (accountFilter) {
    whereParts.push("COALESCE(whatsapp_account, 'bot-1') = ?");
    params.push(accountFilter);
  }

  params.push(safeLimit);

  const [rows] = await database.execute(`
    SELECT
      id,
      COALESCE(whatsapp_account, 'bot-1') AS whatsapp_account,
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
      sent_by_username,
      sent_by_name,
      created_at
    FROM (
      SELECT *
      FROM ${messagesTableSql}
      WHERE ${whereParts.join(' AND ')}
      ORDER BY timestamp_ts DESC, created_at DESC, id DESC
      LIMIT ?
    ) recent_messages
    ORDER BY timestamp_ts ASC, created_at ASC, id ASC
  `, params);

  return dedupeVisualMessages(rows);
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
  listRecentWhatsAppMessages,
  listWhatsAppChatPhones,
  listWhatsAppConversations,
  listWhatsAppMessages,
  saveWhatsAppMessage,
  updateWhatsAppMessageAck
};
