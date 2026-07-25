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
    phantomBajaTable: readEnv(
      'SECOND_APP_MYSQL_PHANTOM_CLIENTS_TABLE',
      readEnv('SECOND_APP_MYSQL_PHANTOM_BAJA_TABLE', 'second_phantom_clients')
    ),
    queueSendingTimeoutMinutes: parsePositiveInteger(
      process.env.SECOND_MESSAGE_QUEUE_SENDING_TIMEOUT_MINUTES,
      2
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
const phantomBajaTableSql = escapeIdentifier(settings.phantomBajaTable, 'tabla de clientes Phantom');

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
      owner_username VARCHAR(191) NULL,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      PRIMARY KEY (id),
      KEY idx_second_messages_chat_time (chat_id, timestamp_ts),
      KEY idx_second_messages_time (timestamp_ts),
      KEY idx_second_messages_phone (phone),
      KEY idx_second_messages_owner (owner_username, chat_id, timestamp_ts)
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
      owner_username VARCHAR(191) NULL,
      scheduled_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      locked_at TIMESTAMP NULL DEFAULT NULL,
      sent_at TIMESTAMP NULL DEFAULT NULL,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      PRIMARY KEY (id),
      UNIQUE KEY uq_second_queue_key (queue_key),
      KEY idx_second_queue_status (status, scheduled_at, id),
      KEY idx_second_queue_phone (phone),
      KEY idx_second_queue_owner (owner_username, status)
    ) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci
  `);

  await databasePool.query(`
    CREATE TABLE IF NOT EXISTS ${phantomBajaTableSql} (
      id VARCHAR(191) NOT NULL,
      apellido VARCHAR(255) NULL,
      nombre VARCHAR(255) NULL,
      razon_social VARCHAR(255) NULL,
      documento VARCHAR(64) NULL,
      cuit VARCHAR(64) NULL,
      categoria VARCHAR(64) NULL,
      condicion VARCHAR(64) NULL,
      direccion VARCHAR(255) NULL,
      dir_numero VARCHAR(64) NULL,
      barrio VARCHAR(191) NULL,
      ciudad VARCHAR(191) NULL,
      deuda VARCHAR(64) NULL,
      estado VARCHAR(64) NULL,
      movil VARCHAR(255) NULL,
      telefono VARCHAR(255) NULL,
      email VARCHAR(255) NULL,
      id_externo VARCHAR(191) NULL,
      perfil VARCHAR(191) NULL,
      television VARCHAR(191) NULL,
      telefonia VARCHAR(191) NULL,
      otros VARCHAR(191) NULL,
      bonificaciones TEXT NULL,
      mac VARCHAR(191) NULL,
      usuario VARCHAR(191) NULL,
      router VARCHAR(191) NULL,
      olt VARCHAR(191) NULL,
      fecha_ultimo_cambio VARCHAR(64) NULL,
      fecha_alta VARCHAR(64) NULL,
      fecha_instalacion VARCHAR(64) NULL,
      fecha_ultima_mod VARCHAR(64) NULL,
      detalle_ultimo_cambio TEXT NULL,
      fecha_ultima_factura VARCHAR(64) NULL,
      fecha_ultimo_mov VARCHAR(64) NULL,
      suc_id VARCHAR(64) NULL,
      comprobantes_adeudados VARCHAR(191) NULL,
      raw_json LONGTEXT NOT NULL,
      synced_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      PRIMARY KEY (id),
      KEY idx_second_phantom_baja_estado (estado),
      KEY idx_second_phantom_baja_synced (synced_at),
      KEY idx_second_phantom_baja_razon (razon_social),
      KEY idx_second_phantom_baja_movil (movil)
    ) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci
  `);

  await ensureTableColumn(databasePool, messagesTableSql, 'owner_username', 'VARCHAR(191) NULL');
  await ensureTableColumn(databasePool, queueTableSql, 'owner_username', 'VARCHAR(191) NULL');
  await ensureTableIndex(
    databasePool,
    messagesTableSql,
    'idx_second_messages_owner',
    'KEY idx_second_messages_owner (owner_username, chat_id, timestamp_ts)'
  );
  await ensureTableIndex(
    databasePool,
    queueTableSql,
    'idx_second_queue_owner',
    'KEY idx_second_queue_owner (owner_username, status)'
  );
  await ensureTableColumn(databasePool, phantomBajaTableSql, 'raw_json', 'LONGTEXT NOT NULL');
  await ensureTableColumn(databasePool, phantomBajaTableSql, 'apellido', 'VARCHAR(255) NULL');
  await ensureTableColumn(databasePool, phantomBajaTableSql, 'nombre', 'VARCHAR(255) NULL');
  await ensureTableColumn(databasePool, phantomBajaTableSql, 'documento', 'VARCHAR(64) NULL');
  await ensureTableColumn(databasePool, phantomBajaTableSql, 'cuit', 'VARCHAR(64) NULL');
  await ensureTableColumn(databasePool, phantomBajaTableSql, 'categoria', 'VARCHAR(64) NULL');
  await ensureTableColumn(databasePool, phantomBajaTableSql, 'condicion', 'VARCHAR(64) NULL');
  await ensureTableColumn(databasePool, phantomBajaTableSql, 'direccion', 'VARCHAR(255) NULL');
  await ensureTableColumn(databasePool, phantomBajaTableSql, 'dir_numero', 'VARCHAR(64) NULL');
  await ensureTableColumn(databasePool, phantomBajaTableSql, 'barrio', 'VARCHAR(191) NULL');
  await ensureTableColumn(databasePool, phantomBajaTableSql, 'ciudad', 'VARCHAR(191) NULL');
  await ensureTableColumn(databasePool, phantomBajaTableSql, 'email', 'VARCHAR(255) NULL');
  await ensureTableColumn(databasePool, phantomBajaTableSql, 'id_externo', 'VARCHAR(191) NULL');
  await ensureTableColumn(databasePool, phantomBajaTableSql, 'perfil', 'VARCHAR(191) NULL');
  await ensureTableColumn(databasePool, phantomBajaTableSql, 'television', 'VARCHAR(191) NULL');
  await ensureTableColumn(databasePool, phantomBajaTableSql, 'telefonia', 'VARCHAR(191) NULL');
  await ensureTableColumn(databasePool, phantomBajaTableSql, 'otros', 'VARCHAR(191) NULL');
  await ensureTableColumn(databasePool, phantomBajaTableSql, 'bonificaciones', 'TEXT NULL');
  await ensureTableColumn(databasePool, phantomBajaTableSql, 'mac', 'VARCHAR(191) NULL');
  await ensureTableColumn(databasePool, phantomBajaTableSql, 'usuario', 'VARCHAR(191) NULL');
  await ensureTableColumn(databasePool, phantomBajaTableSql, 'router', 'VARCHAR(191) NULL');
  await ensureTableColumn(databasePool, phantomBajaTableSql, 'olt', 'VARCHAR(191) NULL');
  await ensureTableColumn(databasePool, phantomBajaTableSql, 'fecha_ultimo_cambio', 'VARCHAR(64) NULL');
  await ensureTableColumn(databasePool, phantomBajaTableSql, 'fecha_alta', 'VARCHAR(64) NULL');
  await ensureTableColumn(databasePool, phantomBajaTableSql, 'fecha_instalacion', 'VARCHAR(64) NULL');
  await ensureTableColumn(databasePool, phantomBajaTableSql, 'fecha_ultima_mod', 'VARCHAR(64) NULL');
  await ensureTableColumn(databasePool, phantomBajaTableSql, 'detalle_ultimo_cambio', 'TEXT NULL');
  await ensureTableColumn(databasePool, phantomBajaTableSql, 'fecha_ultimo_mov', 'VARCHAR(64) NULL');
  await ensureTableColumn(databasePool, phantomBajaTableSql, 'suc_id', 'VARCHAR(64) NULL');
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

function normalizeOwnerUsername(value) {
  return String(value || '').trim().toLowerCase().slice(0, 191);
}

function getOwnerScopeWhereSql(columnSql, ownerUsername, includeUnassigned = false) {
  if (!ownerUsername) {
    return '';
  }

  if (includeUnassigned) {
    return ` AND (${columnSql} = ? OR ${columnSql} IS NULL OR ${columnSql} = '')`;
  }

  return ` AND ${columnSql} = ?`;
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

function getMessageVisualDuplicateKeys(message) {
  const direction = String(message.direction || '').trim().toLowerCase();
  const body = String(message.body || '').trim();
  const phone = normalizeMessagePhone(message.phone || message.chat_id, message.chat_id) ||
    normalizeChatPhone(message.phone || message.chat_id);
  const chatId = String(message.chat_id || '').trim().toLowerCase();
  const mediaMime = String(message.media_mime || '').trim();
  const mediaFilename = String(message.media_filename || '').trim();

  if (!direction || !body) {
    return [];
  }

  return [
    phone ? JSON.stringify(['phone', direction, phone, body, mediaMime, mediaFilename]) : '',
    chatId ? JSON.stringify(['chat', direction, chatId, body, mediaMime, mediaFilename]) : ''
  ].filter(Boolean);
}

function preferMessageForVisualDuplicate(current, candidate) {
  if (!current) {
    return candidate;
  }

  const currentAck = Number(current.ack);
  const candidateAck = Number(candidate.ack);

  if (Number.isFinite(candidateAck) && (!Number.isFinite(currentAck) || candidateAck > currentAck)) {
    return candidate;
  }

  const currentDirect = isDirectPhoneChatId(current.chat_id);
  const candidateDirect = isDirectPhoneChatId(candidate.chat_id);

  if (candidateDirect && !currentDirect) {
    return candidate;
  }

  const currentTime = Number(current.timestamp_ts || 0);
  const candidateTime = Number(candidate.timestamp_ts || 0);

  return candidateTime >= currentTime ? candidate : current;
}

function dedupeVisualMessages(rows) {
  const duplicateWindowMs = 10 * 60 * 1000;
  const groups = [];

  for (const row of rows) {
    const keys = getMessageVisualDuplicateKeys(row);
    const timestamp = Number(row.timestamp_ts || 0);
    const existing = keys.length
      ? groups.find(group => keys.some(key => group.keys.has(key)) && Math.abs(group.timestamp - timestamp) <= duplicateWindowMs)
      : null;

    if (!existing) {
      groups.push({
        keys: new Set(keys),
        timestamp,
        row
      });
      continue;
    }

    existing.row = preferMessageForVisualDuplicate(existing.row, row);
    existing.timestamp = Number(existing.row.timestamp_ts || timestamp);
    keys.forEach(key => existing.keys.add(key));
  }

  return groups
    .map(group => group.row)
    .sort((left, right) => {
      const timeDelta = Number(left.timestamp_ts || 0) - Number(right.timestamp_ts || 0);
      return timeDelta || String(left.id || '').localeCompare(String(right.id || ''));
    });
}

async function findDirectChatAliases(database, directChatIds, ownerUsername = '', options = {}) {
  const cleanDirectChatIds = Array.from(new Set(
    (Array.isArray(directChatIds) ? directChatIds : [])
      .map(chatId => String(chatId || '').trim())
      .filter(isDirectPhoneChatId)
  ));

  if (!cleanDirectChatIds.length) {
    return new Map();
  }

  const includeUnassigned = Boolean(options.includeUnassigned || options.include_unassigned);
  const ownerWhereSql = ownerUsername
    ? includeUnassigned
      ? " AND ((lid.owner_username = ? OR lid.owner_username IS NULL OR lid.owner_username = '') OR (direct.owner_username = ? OR direct.owner_username IS NULL OR direct.owner_username = ''))"
      : ' AND (lid.owner_username = ? OR direct.owner_username = ?)'
    : '';
  const params = [...cleanDirectChatIds];

  if (ownerUsername) {
    params.push(ownerUsername, ownerUsername);
  }

  const [rows] = await database.execute(`
    SELECT
      lid.chat_id AS lid_chat_id,
      direct.chat_id AS direct_chat_id,
      COUNT(*) AS matching_messages,
      MAX(direct.timestamp_ts) AS last_match_ts
    FROM ${messagesTableSql} lid
    JOIN ${messagesTableSql} direct
      ON direct.direction = 'outgoing'
      AND lid.direction = 'outgoing'
      AND direct.body = lid.body
      AND direct.chat_id IN (${cleanDirectChatIds.map(() => '?').join(',')})
      AND ABS(direct.timestamp_ts - lid.timestamp_ts) <= 5000
    WHERE LOWER(lid.chat_id) LIKE '%@lid'
      AND lid.chat_id <> 'status@broadcast'
      AND direct.chat_id <> 'status@broadcast'
      ${ownerWhereSql}
    GROUP BY lid.chat_id, direct.chat_id
    HAVING matching_messages >= 2
    ORDER BY matching_messages DESC, last_match_ts DESC
  `, params);

  const aliases = new Map();

  for (const row of rows) {
    const lidChatId = String(row.lid_chat_id || '').trim();
    const directChatId = String(row.direct_chat_id || '').trim();

    if (lidChatId && directChatId && !aliases.has(lidChatId)) {
      aliases.set(lidChatId, directChatId);
    }
  }

  return aliases;
}

function scopeQueueKey(queueKey, ownerUsername) {
  const cleanKey = String(queueKey || '').trim();
  const cleanOwner = normalizeOwnerUsername(ownerUsername);

  if (!cleanKey || !cleanOwner) {
    return cleanKey || null;
  }

  const prefix = `${cleanOwner}:`;
  return cleanKey.startsWith(prefix) ? cleanKey : `${prefix}${cleanKey}`;
}

function getPublicQueueKey(queueKey, ownerUsername) {
  const cleanKey = String(queueKey || '').trim();
  const cleanOwner = normalizeOwnerUsername(ownerUsername);

  if (!cleanKey || !cleanOwner) {
    return cleanKey;
  }

  const prefix = `${cleanOwner}:`;
  return cleanKey.startsWith(prefix) ? cleanKey.slice(prefix.length) : cleanKey;
}

async function getWhatsAppMessage(id) {
  const database = await getPool();
  const [rows] = await database.execute(
    `SELECT * FROM ${messagesTableSql} WHERE id = ? LIMIT 1`,
    [id]
  );

  return rows[0] || null;
}

async function updateWhatsAppMessageAck(id, ack) {
  const cleanId = String(id || '').trim();
  const parsedAck = Number(ack);

  if (!cleanId || !Number.isFinite(parsedAck)) {
    return null;
  }

  const database = await getPool();
  await database.execute(
    `UPDATE ${messagesTableSql} SET ack = ? WHERE id = ?`,
    [parsedAck, cleanId]
  );

  return getWhatsAppMessage(cleanId);
}

async function saveWhatsAppMessage(message = {}) {
  const chatId = String(message.chatId || '').trim();
  const direction = message.direction === 'incoming' ? 'incoming' : 'outgoing';
  const timestampTs = Number(message.timestampTs || Date.now());
  const timestamp = Number.isFinite(timestampTs) && timestampTs > 0 ? timestampTs : Date.now();
  const body = String(message.body || '').trim();
  const id = String(message.id || `${direction}-${chatId}-${timestamp}`).trim();
  const ownerUsername = normalizeOwnerUsername(message.ownerUsername || message.owner_username);

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
      owner_username
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON DUPLICATE KEY UPDATE
      chat_id = VALUES(chat_id),
      phone = COALESCE(VALUES(phone), phone),
      contact_name = COALESCE(VALUES(contact_name), contact_name),
      owner_username = COALESCE(VALUES(owner_username), owner_username),
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
    String(message.source || '').trim() || null,
    ownerUsername || null
  ]);

  return getWhatsAppMessage(id);
}

async function getWhatsAppChatOwner(chatId, phone) {
  const cleanChatId = String(chatId || '').trim();
  const cleanPhone = normalizeChatPhone(phone || chatId);

  if (!cleanChatId && !cleanPhone) {
    return '';
  }

  const database = await getPool();
  const identityWhere = [];
  const params = [];

  if (cleanChatId) {
    identityWhere.push('chat_id = ?');
    params.push(cleanChatId);
  }

  if (cleanPhone) {
    identityWhere.push('phone = ?');
    params.push(cleanPhone);
  }

  const [rows] = await database.execute(`
    SELECT owner_username
    FROM ${messagesTableSql}
    WHERE chat_id <> 'status@broadcast'
      AND owner_username IS NOT NULL
      AND owner_username <> ''
      AND (${identityWhere.join(' OR ')})
    ORDER BY timestamp_ts ASC, created_at ASC, id ASC
    LIMIT 1
  `, params);

  return normalizeOwnerUsername(rows[0] && rows[0].owner_username);
}

async function resolveWhatsAppChatAlias(chatId) {
  const cleanChatId = String(chatId || '').trim();

  if (!isLidChatId(cleanChatId)) {
    return null;
  }

  const database = await getPool();
  const [rows] = await database.execute(`
    SELECT chat_id, phone, contact_name, owner_username
    FROM ${messagesTableSql}
    WHERE id LIKE ?
      AND chat_id <> ?
      AND LOWER(chat_id) NOT LIKE '%@lid'
      AND chat_id <> 'status@broadcast'
    ORDER BY timestamp_ts DESC, created_at DESC, id DESC
    LIMIT 1
  `, [`true_${cleanChatId}_%`, cleanChatId]);

  if (!rows[0] || !rows[0].chat_id) {
    return null;
  }

  return {
    chatId: rows[0].chat_id,
    phone: normalizeMessagePhone(rows[0].phone || rows[0].chat_id, rows[0].chat_id),
    contactName: rows[0].contact_name || '',
    ownerUsername: normalizeOwnerUsername(rows[0].owner_username)
  };
}

async function listWhatsAppConversations(limit = 100, options = {}) {
  const safeLimit = Math.min(Math.max(Number(limit) || 100, 1), 1000);
  const scanLimit = Math.min(safeLimit * 5, 5000);
  const ownerUsername = normalizeOwnerUsername(options.ownerUsername || options.owner_username);
  const includeUnassigned = Boolean(options.includeUnassigned || options.include_unassigned);
  const ownerFilters = ownerUsername
    ? {
      latestPhone: getOwnerScopeWhereSql('latest_phone.owner_username', ownerUsername, includeUnassigned),
      latestContact: getOwnerScopeWhereSql('latest_contact.owner_username', ownerUsername, includeUnassigned),
      counts: getOwnerScopeWhereSql('owner_username', ownerUsername, includeUnassigned),
      ranked: getOwnerScopeWhereSql('ranked.owner_username', ownerUsername, includeUnassigned),
      latest: getOwnerScopeWhereSql('latest.owner_username', ownerUsername, includeUnassigned)
    }
    : {
      latestPhone: '',
      latestContact: '',
      counts: '',
      ranked: '',
      latest: ''
    };
  const params = ownerUsername
    ? [ownerUsername, ownerUsername, ownerUsername, ownerUsername, ownerUsername]
    : [];
  const database = await getPool();
  const [rows] = await database.execute(`
    SELECT
      latest.id,
      latest.chat_id,
      COALESCE(
        (
          SELECT latest_phone.phone
          FROM ${messagesTableSql} latest_phone
          WHERE latest_phone.chat_id = latest.chat_id
            ${ownerFilters.latestPhone}
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
            ${ownerFilters.latestContact}
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
      latest.owner_username,
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
      WHERE chat_id <> 'status@broadcast'
        ${ownerFilters.counts}
      GROUP BY chat_id
    ) counts ON counts.chat_id = latest.chat_id
    WHERE latest.id = (
      SELECT ranked.id
      FROM ${messagesTableSql} ranked
      WHERE ranked.chat_id = latest.chat_id
        AND ranked.chat_id <> 'status@broadcast'
        ${ownerFilters.ranked}
      ORDER BY ranked.timestamp_ts DESC, ranked.created_at DESC, ranked.id DESC
      LIMIT 1
    )
      AND latest.chat_id <> 'status@broadcast'
      ${ownerFilters.latest}
    ORDER BY latest.timestamp_ts DESC, latest.created_at DESC, latest.id DESC
    LIMIT ${scanLimit}
  `, params);

  const directByPhone = new Map();
  const directByChatId = new Map();

  for (const row of rows) {
    const phone = normalizeMessagePhone(row.phone || row.chat_id, row.chat_id);

    if (phone && isDirectPhoneChatId(row.chat_id)) {
      directByPhone.set(phone, row);
      directByChatId.set(row.chat_id, row);
    }
  }

  const directPhones = Array.from(directByPhone.keys());
  const directByLidChatId = new Map();
  const duplicateAliases = await findDirectChatAliases(database, Array.from(directByChatId.keys()), ownerUsername, {
    includeUnassigned
  });

  if (directPhones.length) {
    const ownerAliasWhereSql = getOwnerScopeWhereSql('owner_username', ownerUsername, includeUnassigned);
    const aliasParams = [...directPhones];

    if (ownerUsername) {
      aliasParams.push(ownerUsername);
    }

    const [aliasRows] = await database.execute(`
      SELECT chat_id, phone
      FROM ${messagesTableSql}
      WHERE LOWER(chat_id) LIKE '%@lid'
        AND phone IN (${directPhones.map(() => '?').join(',')})
        AND chat_id <> 'status@broadcast'
        ${ownerAliasWhereSql}
      ORDER BY timestamp_ts DESC, created_at DESC, id DESC
    `, aliasParams);

    for (const aliasRow of aliasRows) {
      const phone = normalizeMessagePhone(aliasRow.phone || '', aliasRow.chat_id);

      if (phone && directByPhone.has(phone) && !directByLidChatId.has(aliasRow.chat_id)) {
        directByLidChatId.set(aliasRow.chat_id, directByPhone.get(phone));
      }
    }
  }

  for (const [lidChatId, directChatId] of duplicateAliases.entries()) {
    const directRow = directByChatId.get(directChatId);

    if (directRow && !directByLidChatId.has(lidChatId)) {
      directByLidChatId.set(lidChatId, directRow);
    }
  }

  const conversationsByChatId = new Map();

  for (const row of rows) {
    const phone = normalizeMessagePhone(row.phone || row.chat_id, row.chat_id);
    const directAlias = isLidChatId(row.chat_id)
      ? directByLidChatId.get(row.chat_id) || (phone ? directByPhone.get(phone) : null)
      : null;
    const canonicalChatId = directAlias ? directAlias.chat_id : row.chat_id;
    const current = conversationsByChatId.get(canonicalChatId);

    if (!current) {
      conversationsByChatId.set(canonicalChatId, {
        ...row,
        chat_id: canonicalChatId,
        phone: directAlias ? directAlias.phone : row.phone,
        contact_name: row.contact_name || (directAlias && directAlias.contact_name) || '',
        total_messages: Number(row.total_messages || 0),
        incoming_messages: Number(row.incoming_messages || 0),
        outgoing_messages: Number(row.outgoing_messages || 0),
        last_incoming_ts: Number(row.last_incoming_ts || 0) || null
      });
      continue;
    }

    current.total_messages += Number(row.total_messages || 0);
    current.incoming_messages += Number(row.incoming_messages || 0);
    current.outgoing_messages += Number(row.outgoing_messages || 0);
    current.last_incoming_ts = Math.max(Number(current.last_incoming_ts || 0), Number(row.last_incoming_ts || 0)) || null;

    const rowTimestamp = Number(row.timestamp_ts || 0);
    const currentTimestamp = Number(current.timestamp_ts || 0);

    if (rowTimestamp > currentTimestamp || (rowTimestamp === currentTimestamp && String(row.id || '') > String(current.id || ''))) {
      Object.assign(current, {
        ...row,
        chat_id: canonicalChatId,
        phone: directAlias ? directAlias.phone : row.phone,
        total_messages: current.total_messages,
        incoming_messages: current.incoming_messages,
        outgoing_messages: current.outgoing_messages,
        last_incoming_ts: current.last_incoming_ts
      });
    }

    if (!current.contact_name && (row.contact_name || (directAlias && directAlias.contact_name))) {
      current.contact_name = row.contact_name || directAlias.contact_name;
    }
  }

  let conversations = Array.from(conversationsByChatId.values());

  if (ownerUsername && includeUnassigned) {
    const scopedConversations = [];

    for (const conversation of conversations) {
      const owner = await getWhatsAppChatOwner(conversation.chat_id, conversation.phone);

      if (owner && owner !== ownerUsername) {
        continue;
      }

      if (owner) {
        conversation.owner_username = owner;
      }

      scopedConversations.push(conversation);
    }

    conversations = scopedConversations;
  }

  return conversations
    .sort((left, right) => {
      const timeDelta = Number(right.timestamp_ts || 0) - Number(left.timestamp_ts || 0);
      return timeDelta || String(right.id || '').localeCompare(String(left.id || ''));
    })
    .slice(0, safeLimit);
}

async function listWhatsAppMessages(chatId, limit = 200, options = {}) {
  const cleanChatId = String(chatId || '').trim();
  const safeLimit = Math.min(Math.max(Number(limit) || 200, 1), 500);
  const ownerUsername = normalizeOwnerUsername(options.ownerUsername || options.owner_username);
  const includeUnassigned = Boolean(options.includeUnassigned || options.include_unassigned);
  const ownerWhereSql = getOwnerScopeWhereSql('owner_username', ownerUsername, includeUnassigned);
  const aliasPhone = isDirectPhoneChatId(cleanChatId) ? normalizeChatPhone(cleanChatId) : '';

  if (!cleanChatId) {
    return [];
  }

  const database = await getPool();
  const chatIds = [cleanChatId];

  if (aliasPhone) {
    const aliasParams = [aliasPhone];

    if (ownerUsername) {
      aliasParams.push(ownerUsername);
    }

    const [aliasRows] = await database.execute(`
      SELECT DISTINCT chat_id
      FROM ${messagesTableSql}
      WHERE LOWER(chat_id) LIKE '%@lid'
        AND phone = ?
        AND chat_id <> 'status@broadcast'
        ${ownerWhereSql}
      ORDER BY chat_id
    `, aliasParams);

    for (const aliasRow of aliasRows) {
      const aliasChatId = String(aliasRow.chat_id || '').trim();

      if (aliasChatId && !chatIds.includes(aliasChatId)) {
        chatIds.push(aliasChatId);
      }
    }

    const duplicateAliases = await findDirectChatAliases(database, [cleanChatId], ownerUsername, {
      includeUnassigned
    });

    for (const aliasChatId of duplicateAliases.keys()) {
      if (aliasChatId && !chatIds.includes(aliasChatId)) {
        chatIds.push(aliasChatId);
      }
    }
  }

  const params = [...chatIds];

  if (ownerUsername) {
    params.push(ownerUsername);
  }

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
        owner_username,
        created_at
      FROM ${messagesTableSql}
      WHERE chat_id IN (${chatIds.map(() => '?').join(',')})
        AND chat_id <> 'status@broadcast'
        ${ownerWhereSql}
      ORDER BY timestamp_ts DESC, created_at DESC, id DESC
      LIMIT ${safeLimit}
    ) recent_messages
    ORDER BY timestamp_ts ASC, created_at ASC, id ASC
  `, params);

  return dedupeVisualMessages(rows);
}

async function listWhatsAppCommunicationTickets(options = {}) {
  const cleanChatId = String(options.chatId || options.chat_id || '').trim();
  const cleanPhone = normalizeChatPhone(options.phone || cleanChatId);
  const safeLimit = Math.min(Math.max(Number(options.limit) || 5, 1), 25);
  const whereParts = ["source = 'phantom-ticket'"];
  const params = [];

  if (cleanChatId) {
    whereParts.push('chat_id = ?');
    params.push(cleanChatId);
  }

  if (cleanPhone) {
    whereParts.push('phone = ?');
    params.push(cleanPhone);
  }

  if (!cleanChatId && !cleanPhone) {
    return [];
  }

  const database = await getPool();
  const [rows] = await database.execute(`
    SELECT
      id,
      chat_id,
      phone,
      contact_name,
      body,
      timestamp_ts,
      timestamp_iso,
      owner_username,
      created_at
    FROM ${messagesTableSql}
    WHERE (${whereParts.slice(1).join(' OR ')})
      AND ${whereParts[0]}
      AND chat_id <> 'status@broadcast'
    ORDER BY timestamp_ts DESC, created_at DESC, id DESC
    LIMIT ${safeLimit}
  `, params);

  return rows;
}

async function listWhatsAppChatPhones(chatId, options = {}) {
  const cleanChatId = String(chatId || '').trim();
  const ownerUsername = normalizeOwnerUsername(options.ownerUsername || options.owner_username);
  const ownerWhereSql = ownerUsername ? ' AND owner_username = ?' : '';
  const params = ownerUsername ? [cleanChatId, ownerUsername] : [cleanChatId];

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
      ${ownerWhereSql}
  `, params);

  return rows.map(row => row.phone);
}

async function transferWhatsAppChatOwner(chatId, ownerUsername, options = {}) {
  const cleanChatId = String(chatId || '').trim();
  const cleanOwner = normalizeOwnerUsername(ownerUsername);
  const cleanPhone = normalizeChatPhone(options.phone || cleanChatId);
  const phoneCandidates = getClientLookupPhones(cleanPhone);
  const chatIds = [cleanChatId].filter(Boolean);

  if (!cleanChatId) {
    throw new Error('Falta chat');
  }

  if (!cleanOwner) {
    throw new Error('Falta operador');
  }

  const database = await getPool();

  if (phoneCandidates.length) {
    const [aliasRows] = await database.execute(`
      SELECT DISTINCT chat_id
      FROM ${messagesTableSql}
      WHERE chat_id <> 'status@broadcast'
        AND (
          phone IN (${phoneCandidates.map(() => '?').join(',')})
          OR REPLACE(REPLACE(REPLACE(LOWER(chat_id), '@c.us', ''), '@s.whatsapp.net', ''), '@lid', '') IN (${phoneCandidates.map(() => '?').join(',')})
        )
    `, [...phoneCandidates, ...phoneCandidates]);

    for (const aliasRow of aliasRows) {
      const aliasChatId = String(aliasRow.chat_id || '').trim();

      if (aliasChatId && !chatIds.includes(aliasChatId)) {
        chatIds.push(aliasChatId);
      }
    }
  }

  const [result] = await database.execute(`
    UPDATE ${messagesTableSql}
    SET owner_username = ?
    WHERE chat_id IN (${chatIds.map(() => '?').join(',')})
      AND chat_id <> 'status@broadcast'
  `, [cleanOwner, ...chatIds]);

  return {
    chatIds,
    ownerUsername: cleanOwner,
    updated: Number(result.affectedRows || 0)
  };
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

  const ownerUsername = normalizeOwnerUsername(row.owner_username);

  return {
    ...row,
    owner_username: ownerUsername,
    internal_queue_key: row.queue_key || '',
    queue_key: getPublicQueueKey(row.queue_key, ownerUsername),
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
  const storageQueueKey = scopeQueueKey(queueKey, item.ownerUsername || item.owner_username);
  const ownerUsername = normalizeOwnerUsername(item.ownerUsername || item.owner_username);
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
      variables_json,
      owner_username
    )
    VALUES (?, ?, ?, ?, ?, ?)
    ON DUPLICATE KEY UPDATE
      id = LAST_INSERT_ID(id),
      target = IF(status = 'sent', target, VALUES(target)),
      phone = IF(status = 'sent', phone, VALUES(phone)),
      source = IF(status = 'sent', source, VALUES(source)),
      variables_json = IF(status = 'sent', variables_json, VALUES(variables_json)),
      owner_username = IF(status = 'sent', owner_username, COALESCE(VALUES(owner_username), owner_username)),
      status = IF(status = 'sent', status, 'pending'),
      last_error = IF(status = 'sent', last_error, NULL),
      locked_at = IF(status = 'sent', locked_at, NULL),
      updated_at = CURRENT_TIMESTAMP
  `, [
    storageQueueKey,
    target,
    phone || null,
    source,
    JSON.stringify(variables),
    ownerUsername || null
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
  const safeMinutes = Math.min(Math.max(Number(timeoutMinutes) || 2, 1), 1440);
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

async function cancelMessageQueueItem(id, options = {}) {
  const database = await getPool();
  const cleanId = Number(id);
  const ownerUsername = normalizeOwnerUsername(options.ownerUsername || options.owner_username);
  const ownerWhereSql = ownerUsername ? ' AND owner_username = ?' : '';
  const params = ownerUsername ? [cleanId, ownerUsername] : [cleanId];

  if (!Number.isFinite(cleanId) || cleanId <= 0) {
    throw new Error('ID de cola invalido');
  }

  const existing = await getMessageQueueItem(cleanId);

  if (!existing || (ownerUsername && existing.owner_username !== ownerUsername)) {
    throw new Error('Mensaje de cola no encontrado');
  }

  if (existing.status !== 'pending') {
    throw new Error('Solo se pueden cancelar mensajes pendientes');
  }

  const [result] = await database.execute(`
    UPDATE ${queueTableSql}
    SET status = 'cancelled',
        last_error = ?,
        locked_at = NULL,
        updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
      AND status = 'pending'
      ${ownerWhereSql}
  `, [
    'Cancelado manualmente',
    ...params
  ]);

  if (!result.affectedRows) {
    throw new Error('No se pudo cancelar el mensaje');
  }

  return getMessageQueueItem(cleanId);
}

async function getMessageQueueStats(options = {}) {
  const ownerUsername = normalizeOwnerUsername(options.ownerUsername || options.owner_username);
  const params = [];
  const whereSql = ownerUsername ? 'WHERE owner_username = ?' : '';

  if (ownerUsername) {
    params.push(ownerUsername);
  }

  const database = await getPool();
  const [rows] = await database.execute(`
    SELECT status, COUNT(*) AS count
    FROM ${queueTableSql}
    ${whereSql}
    GROUP BY status
  `, params);
  const stats = {
    pending: 0,
    sending: 0,
    sent: 0,
    error: 0,
    cancelled: 0,
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
  const ownerUsername = normalizeOwnerUsername(options.ownerUsername || options.owner_username);
  const database = await getPool();
  const params = [];
  const whereParts = [];

  if (status) {
    whereParts.push('status = ?');
    params.push(status);
  }

  if (ownerUsername) {
    whereParts.push('owner_username = ?');
    params.push(ownerUsername);
  }

  const whereSql = whereParts.length ? `WHERE ${whereParts.join(' AND ')}` : '';

  const [rows] = await database.execute(`
    SELECT *
    FROM ${queueTableSql}
    ${whereSql}
    ORDER BY updated_at DESC, id DESC
    LIMIT ${safeLimit}
  `, params);

  return rows.map(parseQueueRow);
}

function normalizePhantomBajaRow(row = {}, fallbackIndex = 0) {
  const id = getPhantomField(row, ['id', 'ID', 'Id', 'IDA', 'ida', 'ClienteID', 'Cliente_Id', 'Codigo', 'CodigoCliente']) ||
    `row:${fallbackIndex}`;

  return {
    id,
    apellido: getPhantomField(row, ['apellido', 'Apellido']),
    nombre: getPhantomField(row, ['nombre', 'Nombre']),
    razonSocial: getPhantomField(row, ['razonSocial', 'razon_social', 'RS', 'RazonSocial', 'Razon_Social', 'Razon Social', 'Razon']),
    documento: getPhantomField(row, ['documento', 'Documento']),
    cuit: getPhantomField(row, ['cuit', 'CUIT']),
    categoria: getPhantomField(row, ['categoria', 'Categoria']),
    condicion: getPhantomField(row, ['condicion', 'Condicion']),
    direccion: getPhantomField(row, ['direccion', 'Direccion']),
    dirNumero: getPhantomField(row, ['dirNumero', 'dir_numero', 'Dir_Numero']),
    barrio: getPhantomField(row, ['barrio', 'Barrio']),
    ciudad: getPhantomField(row, ['ciudad', 'Ciudad']),
    deuda: getPhantomField(row, ['deuda', 'balance', 'Balance_CC', 'Balance', 'Saldo']),
    estado: getPhantomField(row, ['estado', 'Estado']),
    movil: getPhantomField(row, ['movil', 'Movil', 'Móvil', 'MÃ³vil', 'Celular', 'celular', 'Mobile', 'TelefonoMovil', 'TelMovil', 'Movi', 'movi']),
    telefono: getPhantomField(row, ['telefono', 'Telefono', 'Teléfono', 'TelÃ©fono', 'Tel', 'tel', 'Telefono1', 'Telefono_1']),
    email: getPhantomField(row, ['email', 'Email']),
    idExterno: getPhantomField(row, ['idExterno', 'id_externo', 'IDExterno']),
    perfil: getPhantomField(row, ['perfil', 'Perfil']),
    television: getPhantomField(row, ['television', 'Television']),
    telefonia: getPhantomField(row, ['telefonia', 'Telefonia']),
    otros: getPhantomField(row, ['otros', 'Otros']),
    bonificaciones: getPhantomField(row, ['bonificaciones', 'Bonificaciones']),
    mac: getPhantomField(row, ['mac', 'Mac']),
    usuario: getPhantomField(row, ['usuario', 'Usuario']),
    router: getPhantomField(row, ['router', 'Router']),
    olt: getPhantomField(row, ['olt', 'OLT']),
    fechaUltimaFactura: getPhantomField(row, ['fechaUltimaFactura', 'fecha_ultima_factura', 'Fecha_Ultima_Factura']),
    fechaUltimoCambio: getPhantomField(row, ['fechaUltimoCambio', 'fecha_ultimo_cambio', 'Fecha_Ultimo_Cambio']),
    fechaAlta: getPhantomField(row, ['fechaAlta', 'fecha_alta', 'Fecha_Alta']),
    fechaInstalacion: getPhantomField(row, ['fechaInstalacion', 'fecha_instalacion', 'Fecha_Instalacion']),
    fechaUltimaMod: getPhantomField(row, ['fechaUltimaMod', 'fecha_ultima_mod', 'Fecha_Ultima_Mod']),
    detalleUltimoCambio: getPhantomField(row, ['detalleUltimoCambio', 'detalle_ultimo_cambio', 'Detalle_Ultimo_Cambio']),
    fechaUltimoMov: getPhantomField(row, ['fechaUltimoMov', 'fecha_ultimo_mov', 'Fecha_Ultimo_Mov']),
    sucId: getPhantomField(row, ['sucId', 'suc_id', 'Suc_ID']),
    comprobantesAdeudados: getPhantomField(row, ['comprobantesAdeudados', 'comprobantes_adeudados', 'C_Comprobantes_Adeudados', 'ComprobantesAdeudados', 'Comprobantes_Adeudados']),
    raw: row.raw && typeof row.raw === 'object' ? row.raw : row
  };
}

function getPhantomField(row = {}, keys = []) {
  const sources = [
    row,
    row && row.raw && typeof row.raw === 'object' ? row.raw : null
  ].filter(Boolean);

  for (const key of keys) {
    for (const source of sources) {
      if (source[key] !== undefined && source[key] !== null && source[key] !== '') {
        return String(source[key]).trim();
      }
    }
  }

  return '';
}

function chunkRows(rows = [], size = 500) {
  const chunks = [];

  for (let index = 0; index < rows.length; index += size) {
    chunks.push(rows.slice(index, index + size));
  }

  return chunks;
}

function parsePhantomBajaDbRow(row = {}) {
  let raw = {};

  try {
    raw = JSON.parse(row.raw_json || '{}') || {};
  } catch (error) {
    raw = {};
  }

  return {
    ...raw,
    id: row.id,
    apellido: row.apellido || raw.apellido || raw.Apellido || '',
    nombre: row.nombre || raw.nombre || raw.Nombre || '',
    razonSocial: row.razon_social || raw.razonSocial || raw.razon_social || '',
    documento: row.documento || raw.documento || raw.Documento || '',
    cuit: row.cuit || raw.cuit || raw.CUIT || '',
    categoria: row.categoria || raw.categoria || raw.Categoria || '',
    condicion: row.condicion || raw.condicion || raw.Condicion || '',
    direccion: row.direccion || raw.direccion || raw.Direccion || '',
    dirNumero: row.dir_numero || raw.dirNumero || raw.dir_numero || raw.Dir_Numero || '',
    barrio: row.barrio || raw.barrio || raw.Barrio || '',
    ciudad: row.ciudad || raw.ciudad || raw.Ciudad || '',
    deuda: row.deuda || raw.deuda || '',
    estado: row.estado || raw.estado || raw.Estado || '',
    movil: row.movil || raw.movil || '',
    telefono: row.telefono || raw.telefono || '',
    email: row.email || raw.email || raw.Email || '',
    idExterno: row.id_externo || raw.idExterno || raw.id_externo || raw.IDExterno || '',
    perfil: row.perfil || raw.perfil || raw.Perfil || '',
    television: row.television || raw.television || raw.Television || '',
    telefonia: row.telefonia || raw.telefonia || raw.Telefonia || '',
    otros: row.otros || raw.otros || raw.Otros || '',
    bonificaciones: row.bonificaciones || raw.bonificaciones || raw.Bonificaciones || '',
    mac: row.mac || raw.mac || raw.Mac || '',
    usuario: row.usuario || raw.usuario || raw.Usuario || '',
    router: row.router || raw.router || raw.Router || '',
    olt: row.olt || raw.olt || raw.OLT || '',
    fechaUltimaFactura: row.fecha_ultima_factura || raw.fechaUltimaFactura || raw.fecha_ultima_factura || '',
    fechaUltimoCambio: row.fecha_ultimo_cambio || raw.fechaUltimoCambio || raw.fecha_ultimo_cambio || raw.Fecha_Ultimo_Cambio || '',
    fechaAlta: row.fecha_alta || raw.fechaAlta || raw.fecha_alta || raw.Fecha_Alta || '',
    fechaInstalacion: row.fecha_instalacion || raw.fechaInstalacion || raw.fecha_instalacion || raw.Fecha_Instalacion || '',
    fechaUltimaMod: row.fecha_ultima_mod || raw.fechaUltimaMod || raw.fecha_ultima_mod || raw.Fecha_Ultima_Mod || '',
    detalleUltimoCambio: row.detalle_ultimo_cambio || raw.detalleUltimoCambio || raw.detalle_ultimo_cambio || raw.Detalle_Ultimo_Cambio || '',
    fechaUltimoMov: row.fecha_ultimo_mov || raw.fechaUltimoMov || raw.fecha_ultimo_mov || raw.Fecha_Ultimo_Mov || '',
    sucId: row.suc_id || raw.sucId || raw.suc_id || raw.Suc_ID || '',
    comprobantesAdeudados: row.comprobantes_adeudados || raw.comprobantesAdeudados || raw.comprobantes_adeudados || '',
    syncedAt: row.synced_at
  };
}

async function replacePhantomBajaClients(rows = [], syncedAt = new Date()) {
  const database = await getPool();
  const connection = await database.getConnection();
  const normalizedRows = rows.map(normalizePhantomBajaRow);
  const syncedAtValue = syncedAt instanceof Date ? syncedAt : new Date(syncedAt || Date.now());

  try {
    await connection.beginTransaction();
    await connection.query(`DELETE FROM ${phantomBajaTableSql}`);

    for (const chunk of chunkRows(normalizedRows, 500)) {
      const values = chunk.map(row => [
        row.id,
        row.apellido || null,
        row.nombre || null,
        row.razonSocial || null,
        row.documento || null,
        row.cuit || null,
        row.categoria || null,
        row.condicion || null,
        row.direccion || null,
        row.dirNumero || null,
        row.barrio || null,
        row.ciudad || null,
        row.deuda || null,
        row.estado || null,
        row.movil || null,
        row.telefono || null,
        row.email || null,
        row.idExterno || null,
        row.perfil || null,
        row.television || null,
        row.telefonia || null,
        row.otros || null,
        row.bonificaciones || null,
        row.mac || null,
        row.usuario || null,
        row.router || null,
        row.olt || null,
        row.fechaUltimoCambio || null,
        row.fechaAlta || null,
        row.fechaInstalacion || null,
        row.fechaUltimaMod || null,
        row.detalleUltimoCambio || null,
        row.fechaUltimaFactura || null,
        row.fechaUltimoMov || null,
        row.sucId || null,
        row.comprobantesAdeudados || null,
        JSON.stringify(row.raw || row),
        syncedAtValue
      ]);

      await connection.query(`
        INSERT INTO ${phantomBajaTableSql} (
          id,
          apellido,
          nombre,
          razon_social,
          documento,
          cuit,
          categoria,
          condicion,
          direccion,
          dir_numero,
          barrio,
          ciudad,
          deuda,
          estado,
          movil,
          telefono,
          email,
          id_externo,
          perfil,
          television,
          telefonia,
          otros,
          bonificaciones,
          mac,
          usuario,
          router,
          olt,
          fecha_ultimo_cambio,
          fecha_alta,
          fecha_instalacion,
          fecha_ultima_mod,
          detalle_ultimo_cambio,
          fecha_ultima_factura,
          fecha_ultimo_mov,
          suc_id,
          comprobantes_adeudados,
          raw_json,
          synced_at
        )
        VALUES ?
      `, [values]);
    }

    await connection.commit();
    return normalizedRows.length;
  } catch (error) {
    await connection.rollback();
    throw error;
  } finally {
    connection.release();
  }
}

async function listPhantomBajaClients(options = {}) {
  const safeLimit = Math.min(Math.max(Number(options.limit) || 10, 1), 500);
  const safeOffset = Math.max(Number(options.offset) || 0, 0);
  const sortKey = String(options.sortKey || '').trim();
  const sortDirection = String(options.sortDirection || '').toLowerCase() === 'asc' ? 'ASC' : 'DESC';
  const estado = String(options.estado || '').trim();
  const search = String(options.search || '').trim();
  const excludeEstados = Array.isArray(options.excludeEstados)
    ? options.excludeEstados.map(item => String(item || '').trim()).filter(Boolean)
    : [];
  const sortExpressions = {
    id: 'CAST(id AS UNSIGNED)',
    razonSocial: 'razon_social',
    deuda: 'CAST(REPLACE(REPLACE(deuda, ".", ""), ",", ".") AS DECIMAL(18,2))',
    movil: 'movil',
    telefono: 'telefono',
    fechaUltimaFactura: 'fecha_ultima_factura',
    fechaUltimoCambio: 'COALESCE(JSON_UNQUOTE(JSON_EXTRACT(raw_json, "$.Fecha_Ultimo_Cambio")), JSON_UNQUOTE(JSON_EXTRACT(raw_json, "$.fechaUltimoCambio")), JSON_UNQUOTE(JSON_EXTRACT(raw_json, "$.fecha_ultimo_cambio")))',
    fechaInstalacion: 'COALESCE(JSON_UNQUOTE(JSON_EXTRACT(raw_json, "$.Fecha_Instalacion")), JSON_UNQUOTE(JSON_EXTRACT(raw_json, "$.fechaInstalacion")), JSON_UNQUOTE(JSON_EXTRACT(raw_json, "$.fecha_instalacion")))'
  };
  const orderExpression = sortExpressions[sortKey] || 'CAST(id AS UNSIGNED)';
  const whereParts = [];
  const params = [];

  if (estado) {
    whereParts.push('estado = ?');
    params.push(estado);
  }

  if (excludeEstados.length) {
    whereParts.push(`(estado IS NULL OR estado = '' OR estado NOT IN (${excludeEstados.map(() => '?').join(', ')}))`);
    params.push(...excludeEstados);
  }

  if (search) {
    const terms = search.split(/\s+/).map(item => item.trim()).filter(Boolean).slice(0, 6);

    for (const term of terms) {
      const like = `%${term}%`;
      whereParts.push(`(
        id LIKE ?
        OR razon_social LIKE ?
        OR apellido LIKE ?
        OR nombre LIKE ?
        OR documento LIKE ?
        OR cuit LIKE ?
        OR movil LIKE ?
        OR telefono LIKE ?
        OR email LIKE ?
        OR direccion LIKE ?
        OR ciudad LIKE ?
        OR estado LIKE ?
        OR id_externo LIKE ?
        OR usuario LIKE ?
        OR raw_json LIKE ?
      )`);
      params.push(like, like, like, like, like, like, like, like, like, like, like, like, like, like, like);
    }
  }

  const whereSql = whereParts.length ? `WHERE ${whereParts.join(' AND ')}` : '';
  const database = await getPool();
  const [[countRow]] = await database.query(`SELECT COUNT(*) AS total FROM ${phantomBajaTableSql} ${whereSql}`, params);
  const [rows] = await database.query(`
    SELECT *
    FROM ${phantomBajaTableSql}
    ${whereSql}
    ORDER BY ${orderExpression} ${sortDirection}, CAST(id AS UNSIGNED) DESC, id DESC
    LIMIT ${safeLimit}
    OFFSET ${safeOffset}
  `, params);

  const total = Number(countRow && countRow.total || 0);

  return {
    rows: rows.map(parsePhantomBajaDbRow),
    total,
    limit: safeLimit,
    offset: safeOffset,
    hasNextPage: safeOffset + rows.length < total
  };
}

function getClientLookupPhones(value) {
  const clean = normalizeChatPhone(value);
  const candidates = new Set();

  if (clean) {
    candidates.add(clean);
  }

  if (clean.startsWith('549') && clean.length > 3) {
    candidates.add(clean.slice(3));
  }

  if (clean.startsWith('54') && clean.length > 2) {
    candidates.add(clean.slice(2));
  }

  if (clean.length > 10) {
    candidates.add(clean.slice(-10));
  }

  if (clean.length > 8) {
    candidates.add(clean.slice(-8));
  }

  return Array.from(candidates).filter(item => item.length >= 6);
}

function scorePhantomClientPhoneMatch(row, phones) {
  const values = [
    row.movil,
    row.telefono,
    row.raw && row.raw.Movil,
    row.raw && row.raw.Telefono,
    row.raw && row.raw.Celular
  ].map(normalizeChatPhone).filter(Boolean);
  let score = 0;

  for (const value of values) {
    for (const phone of phones) {
      if (value === phone) {
        score = Math.max(score, 100 + phone.length);
      } else if (value.endsWith(phone) || phone.endsWith(value)) {
        score = Math.max(score, 50 + Math.min(value.length, phone.length));
      }
    }
  }

  return score;
}

async function findPhantomClientsByPhone(phone, limit = 10) {
  const phones = getClientLookupPhones(phone);
  const safeLimit = Math.min(Math.max(Number(limit) || 10, 1), 25);

  if (!phones.length) {
    return [];
  }

  const whereParts = [];
  const params = [];

  for (const candidate of phones) {
    const like = `%${candidate}%`;
    whereParts.push('(movil LIKE ? OR telefono LIKE ? OR raw_json LIKE ?)');
    params.push(like, like, like);
  }

  const database = await getPool();
  const [rows] = await database.query(`
    SELECT *
    FROM ${phantomBajaTableSql}
    WHERE ${whereParts.join(' OR ')}
    ORDER BY synced_at DESC, CAST(id AS UNSIGNED) DESC, id DESC
    LIMIT 25
  `, params);

  const matches = rows
    .map(parsePhantomBajaDbRow)
    .map(row => ({
      row,
      score: scorePhantomClientPhoneMatch(row, phones)
    }))
    .filter(match => match.score > 0)
    .sort((left, right) => right.score - left.score || String(right.row.id || '').localeCompare(String(left.row.id || '')));

  return matches.slice(0, safeLimit).map(match => match.row);
}

async function findPhantomClientByPhone(phone) {
  const matches = await findPhantomClientsByPhone(phone, 1);
  return matches[0] || null;
}

async function getPhantomBajaSyncStatus() {
  const database = await getPool();
  const [[row]] = await database.query(`
    SELECT COUNT(*) AS total, MAX(synced_at) AS last_synced_at
    FROM ${phantomBajaTableSql}
  `);

  return {
    total: Number(row && row.total || 0),
    lastSyncedAt: row && row.last_synced_at ? row.last_synced_at : null
  };
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
  cancelMessageQueueItem,
  claimPendingMessageQueue,
  closePool,
  enqueueMessageQueueItem,
  enqueueMessageQueueItems,
  getMessageQueueItem,
  getMessageQueueStats,
  getMysqlSettings,
  getPool,
  getPhantomBajaSyncStatus,
  findPhantomClientsByPhone,
  findPhantomClientByPhone,
  getWhatsAppChatOwner,
  resolveWhatsAppChatAlias,
  listPhantomBajaClients,
  listMessageQueueItems,
  listWhatsAppChatPhones,
  listWhatsAppCommunicationTickets,
  listWhatsAppConversations,
  listWhatsAppMessages,
  transferWhatsAppChatOwner,
  markMessageQueueError,
  markMessageQueueSent,
  markStaleMessageQueueErrors,
  normalizeChatPhone,
  pingDatabase,
  releaseMessageQueueItem,
  replacePhantomBajaClients,
  saveWhatsAppMessage,
  updateWhatsAppMessageAck
};
