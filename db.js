const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');
const { config } = require('./config');

let db;
let fallbackAutomaticMessageTemplateCursor = null;

function getDb() {
  if (db) {
    return db;
  }

  const dbDirectory = path.dirname(config.dbPath);
  fs.mkdirSync(dbDirectory, { recursive: true });

  db = new DatabaseSync(config.dbPath);
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA foreign_keys = ON');
  initializeDatabase(db);

  return db;
}

function initializeDatabase(database = getDb()) {
  database.exec(`
    CREATE TABLE IF NOT EXISTS tickets (
      external_id TEXT PRIMARY KEY,
      delegacion TEXT NOT NULL,
      start TEXT NOT NULL,
      start_ts INTEGER NOT NULL,
      start_date TEXT NOT NULL,
      start_time TEXT NOT NULL,
      status TEXT,
      phone TEXT,
      phones_json TEXT NOT NULL DEFAULT '[]',
      razon_social TEXT,
      response_action TEXT,
      response_label TEXT,
      response_body TEXT,
      response_received_at TEXT,
      automatic_message_disabled_at TEXT,
      automatic_message_disabled_reason TEXT,
      payload_json TEXT NOT NULL DEFAULT '{}',
      message_sent_at TEXT,
      message_error TEXT,
      last_status_check_at TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE INDEX IF NOT EXISTS idx_tickets_start_order
      ON tickets (start_date, start_ts, external_id);

    CREATE INDEX IF NOT EXISTS idx_tickets_status
      ON tickets (status);

    CREATE TABLE IF NOT EXISTS whatsapp_messages (
      id TEXT PRIMARY KEY,
      chat_id TEXT NOT NULL,
      phone TEXT,
      contact_name TEXT,
      direction TEXT NOT NULL,
      body TEXT NOT NULL,
      media_mime TEXT,
      media_data TEXT,
      media_filename TEXT,
      timestamp_ts INTEGER NOT NULL,
      timestamp_iso TEXT NOT NULL,
      from_me INTEGER NOT NULL DEFAULT 0,
      ack INTEGER,
      source TEXT,
      sent_by_username TEXT,
      sent_by_name TEXT,
      whatsapp_account TEXT NOT NULL DEFAULT 'bot-1',
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE INDEX IF NOT EXISTS idx_whatsapp_messages_chat_time
      ON whatsapp_messages (chat_id, timestamp_ts);

    CREATE INDEX IF NOT EXISTS idx_whatsapp_messages_time
      ON whatsapp_messages (timestamp_ts);

    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT NOT NULL UNIQUE COLLATE NOCASE,
      name TEXT NOT NULL,
      role TEXT NOT NULL,
      groups_json TEXT NOT NULL DEFAULT '[]',
      password_hash TEXT NOT NULL,
      password_salt TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE INDEX IF NOT EXISTS idx_users_role
      ON users (role);

    CREATE TABLE IF NOT EXISTS ticket_response_actions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ticket_external_id TEXT NOT NULL,
      chat_id TEXT NOT NULL,
      phone TEXT,
      question TEXT NOT NULL,
      options_json TEXT NOT NULL,
      delivery_mode TEXT NOT NULL DEFAULT 'text',
      sent_message_id TEXT,
      status TEXT NOT NULL DEFAULT 'pending',
      selected_key TEXT,
      selected_label TEXT,
      selected_action TEXT,
      response_message_id TEXT,
      response_body TEXT,
      action_result TEXT,
      completed_at TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE INDEX IF NOT EXISTS idx_ticket_response_actions_chat
      ON ticket_response_actions (chat_id, status, created_at);

    CREATE TABLE IF NOT EXISTS app_state (
      key TEXT PRIMARY KEY,
      value TEXT,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS automatic_message_templates (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      body TEXT NOT NULL,
      active INTEGER NOT NULL DEFAULT 1,
      sort_order INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE INDEX IF NOT EXISTS idx_automatic_message_templates_order
      ON automatic_message_templates (active, sort_order, id);

    CREATE TABLE IF NOT EXISTS whatsapp_chat_aliases (
      alias_chat_id TEXT PRIMARY KEY,
      canonical_chat_id TEXT NOT NULL,
      phone TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE INDEX IF NOT EXISTS idx_whatsapp_chat_aliases_canonical
      ON whatsapp_chat_aliases (canonical_chat_id);

    CREATE INDEX IF NOT EXISTS idx_whatsapp_chat_aliases_phone
      ON whatsapp_chat_aliases (phone);

    CREATE TABLE IF NOT EXISTS whatsapp_conversation_bucket_overrides (
      whatsapp_account TEXT NOT NULL DEFAULT 'bot-1',
      chat_id TEXT NOT NULL,
      bucket TEXT NOT NULL CHECK (bucket IN ('main', 'other')),
      updated_by TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (whatsapp_account, chat_id)
    );

    CREATE INDEX IF NOT EXISTS idx_whatsapp_conversation_bucket_overrides_bucket
      ON whatsapp_conversation_bucket_overrides (bucket);

  `);

  ensureColumn(database, 'razon_social', 'TEXT');
  ensureColumn(database, 'phones_json', "TEXT NOT NULL DEFAULT '[]'");
  ensureColumn(database, 'response_action', 'TEXT');
  ensureColumn(database, 'response_label', 'TEXT');
  ensureColumn(database, 'response_body', 'TEXT');
  ensureColumn(database, 'response_received_at', 'TEXT');
  ensureColumn(database, 'automatic_message_disabled_at', 'TEXT');
  ensureColumn(database, 'automatic_message_disabled_reason', 'TEXT');
  ensureWhatsAppMessageColumn(database, 'media_mime', 'TEXT');
  ensureWhatsAppMessageColumn(database, 'media_data', 'TEXT');
  ensureWhatsAppMessageColumn(database, 'media_filename', 'TEXT');
  ensureWhatsAppMessageColumn(database, 'sent_by_username', 'TEXT');
  ensureWhatsAppMessageColumn(database, 'sent_by_name', 'TEXT');
  ensureWhatsAppMessageColumn(database, 'whatsapp_account', "TEXT NOT NULL DEFAULT 'bot-1'");
  database.exec(`
    CREATE INDEX IF NOT EXISTS idx_whatsapp_messages_account_chat_time
      ON whatsapp_messages (whatsapp_account, chat_id, timestamp_ts);
  `);
  ensureWhatsAppConversationBucketOverrideSchema(database);
  ensureUserColumn(database, 'groups_json', "TEXT NOT NULL DEFAULT '[]'");
  ensureUserColumn(database, 'whatsapp_account', "TEXT NOT NULL DEFAULT 'bot-1'");
  ensureUserColumn(database, 'whatsapp_accounts_json', "TEXT NOT NULL DEFAULT '[\"bot-1\"]'");
  ensureAutomaticMessageTemplateColumn(database, 'active', 'INTEGER NOT NULL DEFAULT 1');
  ensureAutomaticMessageTemplateColumn(database, 'sort_order', 'INTEGER NOT NULL DEFAULT 0');
}

function ensureColumn(database, columnName, definition) {
  const columns = database.prepare('PRAGMA table_info(tickets)').all();
  const exists = columns.some(column => column.name === columnName);

  if (!exists) {
    database.exec(`ALTER TABLE tickets ADD COLUMN ${columnName} ${definition}`);
  }
}

function ensureWhatsAppMessageColumn(database, columnName, definition) {
  const columns = database.prepare('PRAGMA table_info(whatsapp_messages)').all();
  const exists = columns.some(column => column.name === columnName);

  if (!exists) {
    database.exec(`ALTER TABLE whatsapp_messages ADD COLUMN ${columnName} ${definition}`);
  }
}

function ensureUserColumn(database, columnName, definition) {
  const columns = database.prepare('PRAGMA table_info(users)').all();
  const exists = columns.some(column => column.name === columnName);

  if (!exists) {
    database.exec(`ALTER TABLE users ADD COLUMN ${columnName} ${definition}`);
  }
}

function ensureAutomaticMessageTemplateColumn(database, columnName, definition) {
  const columns = database.prepare('PRAGMA table_info(automatic_message_templates)').all();
  const exists = columns.some(column => column.name === columnName);

  if (!exists) {
    database.exec(`ALTER TABLE automatic_message_templates ADD COLUMN ${columnName} ${definition}`);
  }
}

function getAppState(key, fallback = null) {
  const row = getDb().prepare('SELECT value FROM app_state WHERE key = ?').get(String(key || ''));
  return row ? row.value : fallback;
}

function ensureWhatsAppConversationBucketOverrideSchema(database) {
  const columns = database.prepare('PRAGMA table_info(whatsapp_conversation_bucket_overrides)').all();
  const hasAccount = columns.some(column => column.name === 'whatsapp_account');
  const pkColumns = columns
    .filter(column => column.pk)
    .sort((left, right) => left.pk - right.pk)
    .map(column => column.name);

  if (hasAccount && pkColumns.join(',') === 'whatsapp_account,chat_id') {
    return;
  }

  const legacyTable = 'whatsapp_conversation_bucket_overrides_legacy_migration';
  database.exec(`
    DROP TABLE IF EXISTS ${legacyTable};
    ALTER TABLE whatsapp_conversation_bucket_overrides RENAME TO ${legacyTable};
    CREATE TABLE whatsapp_conversation_bucket_overrides (
      whatsapp_account TEXT NOT NULL DEFAULT 'bot-1',
      chat_id TEXT NOT NULL,
      bucket TEXT NOT NULL CHECK (bucket IN ('main', 'other')),
      updated_by TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (whatsapp_account, chat_id)
    );
  `);

  const accountExpression = hasAccount
    ? "COALESCE(NULLIF(whatsapp_account, ''), 'bot-1')"
    : "'bot-1'";

  database.exec(`
    INSERT OR REPLACE INTO whatsapp_conversation_bucket_overrides (
      whatsapp_account,
      chat_id,
      bucket,
      updated_by,
      created_at,
      updated_at
    )
    SELECT
      ${accountExpression},
      chat_id,
      bucket,
      updated_by,
      created_at,
      updated_at
    FROM ${legacyTable}
    WHERE chat_id IS NOT NULL AND TRIM(chat_id) <> '';

    DROP TABLE ${legacyTable};

    CREATE INDEX IF NOT EXISTS idx_whatsapp_conversation_bucket_overrides_bucket
      ON whatsapp_conversation_bucket_overrides (bucket);
  `);
}

function normalizePhoneList(phones) {
  const source = Array.isArray(phones)
    ? phones
    : String(phones || '').split(/[;,/|]+/);
  const seen = new Set();
  const normalized = [];

  for (const value of source) {
    const phone = String(value || '').replace(/\D/g, '');

    if (phone.length >= 8 && !seen.has(phone)) {
      seen.add(phone);
      normalized.push(phone);
    }
  }

  return normalized;
}

function parseTicketPhones(ticket) {
  try {
    return normalizePhoneList(JSON.parse(ticket && ticket.phones_json || '[]'));
  } catch (error) {
    return [];
  }
}

function setAppState(key, value) {
  getDb().prepare(`
    INSERT INTO app_state (key, value, updated_at)
    VALUES (?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(key) DO UPDATE SET
      value = excluded.value,
      updated_at = CURRENT_TIMESTAMP
  `).run(String(key || ''), String(value ?? ''));
}

function normalizeAutomaticTemplateInput(input = {}, fallback = {}) {
  const name = String(input.name ?? fallback.name ?? 'Template').trim().slice(0, 120) || 'Template';
  const body = String(input.body ?? input.template ?? fallback.body ?? '').trim();

  if (!body) {
    throw new Error('El template no puede estar vacio');
  }

  return {
    name,
    body,
    active: input.active === undefined ? (fallback.active !== false) : Boolean(input.active)
  };
}

function listAutomaticMessageTemplates({ includeInactive = true } = {}) {
  const where = includeInactive ? '' : 'WHERE active = 1';
  return getDb().prepare(`
    SELECT id, name, body, active, sort_order, created_at, updated_at
    FROM automatic_message_templates
    ${where}
    ORDER BY sort_order ASC, id ASC
  `).all().map(row => ({
    ...row,
    active: Boolean(row.active)
  }));
}

function createAutomaticMessageTemplate(input = {}) {
  const data = normalizeAutomaticTemplateInput(input);
  const database = getDb();
  const orderRow = database.prepare('SELECT COALESCE(MAX(sort_order), -1) + 1 AS next_order FROM automatic_message_templates').get();
  const result = database.prepare(`
    INSERT INTO automatic_message_templates (name, body, active, sort_order)
    VALUES (?, ?, ?, ?)
  `).run(data.name, data.body, data.active ? 1 : 0, Number(orderRow.next_order || 0));

  return getAutomaticMessageTemplate(Number(result.lastInsertRowid));
}

function getAutomaticMessageTemplate(id) {
  const row = getDb().prepare(`
    SELECT id, name, body, active, sort_order, created_at, updated_at
    FROM automatic_message_templates
    WHERE id = ?
  `).get(Number(id));

  return row ? { ...row, active: Boolean(row.active) } : null;
}

function updateAutomaticMessageTemplate(id, input = {}) {
  const current = getAutomaticMessageTemplate(id);

  if (!current) {
    throw new Error('Template no encontrado');
  }

  const data = normalizeAutomaticTemplateInput(input, current);
  getDb().prepare(`
    UPDATE automatic_message_templates
    SET name = ?,
        body = ?,
        active = ?,
        updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `).run(data.name, data.body, data.active ? 1 : 0, Number(id));

  return getAutomaticMessageTemplate(id);
}

function deleteAutomaticMessageTemplate(id) {
  const template = getAutomaticMessageTemplate(id);

  if (!template) {
    throw new Error('Template no encontrado');
  }

  const count = getDb().prepare('SELECT COUNT(*) AS total FROM automatic_message_templates').get();

  if (Number(count.total || 0) <= 1) {
    throw new Error('Debe quedar al menos un template');
  }

  getDb().prepare('DELETE FROM automatic_message_templates WHERE id = ?').run(Number(id));
  return template;
}

function ensureAutomaticMessageTemplate(defaultBody) {
  const activeTemplates = listAutomaticMessageTemplates({ includeInactive: false });

  if (activeTemplates.length) {
    return activeTemplates;
  }

  const existing = listAutomaticMessageTemplates();

  if (existing.length) {
    const first = existing[0];
    getDb().prepare(`
      UPDATE automatic_message_templates
      SET active = 1,
          updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).run(first.id);
    return listAutomaticMessageTemplates({ includeInactive: false });
  }

  createAutomaticMessageTemplate({
    name: 'Template 1',
    body: defaultBody || config.messageTemplate,
    active: true
  });

  return listAutomaticMessageTemplates({ includeInactive: false });
}

function getNextAutomaticMessageTemplate(defaultBody) {
  const templates = ensureAutomaticMessageTemplate(defaultBody);
  const storedCursor = fallbackAutomaticMessageTemplateCursor !== null
    ? fallbackAutomaticMessageTemplateCursor
    : getAppState('automatic_message_template_cursor', '0');
  const cursor = Number.parseInt(storedCursor, 10);
  const index = (Number.isFinite(cursor) ? cursor : 0) % templates.length;
  const template = templates[index];
  const nextCursor = (index + 1) % templates.length;

  try {
    setAppState('automatic_message_template_cursor', nextCursor);
    fallbackAutomaticMessageTemplateCursor = null;
  } catch (error) {
    fallbackAutomaticMessageTemplateCursor = nextCursor;
    console.warn(`No se pudo guardar el cursor de templates automaticos. Se usa cursor en memoria: ${error.message}`);
  }

  return {
    ...template,
    index,
    total: templates.length
  };
}

function upsertTickets(tickets) {
  if (!tickets.length) {
    return 0;
  }

  const database = getDb();
  const statement = database.prepare(`
    INSERT INTO tickets (
      external_id,
      delegacion,
      start,
      start_ts,
      start_date,
      start_time,
      status,
      phone,
      phones_json,
      razon_social,
      payload_json,
      updated_at
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(external_id) DO UPDATE SET
      delegacion = excluded.delegacion,
      start = excluded.start,
      start_ts = excluded.start_ts,
      start_date = excluded.start_date,
      start_time = excluded.start_time,
      status = COALESCE(excluded.status, tickets.status),
      phone = COALESCE(tickets.phone, excluded.phone),
      phones_json = CASE
        WHEN excluded.phones_json <> '[]' THEN excluded.phones_json
        ELSE tickets.phones_json
      END,
      razon_social = COALESCE(excluded.razon_social, tickets.razon_social),
      payload_json = excluded.payload_json,
      updated_at = CURRENT_TIMESTAMP
  `);

  let saved = 0;
  database.exec('BEGIN');

  try {
    for (const ticket of tickets) {
      const phones = normalizePhoneList(ticket.phones && ticket.phones.length ? ticket.phones : ticket.phone);
      statement.run(
        ticket.externalId,
        ticket.delegacion,
        ticket.startRaw,
        ticket.startTs,
        ticket.startDate,
        ticket.startTime,
        ticket.status || null,
        ticket.phone || phones[0] || null,
        JSON.stringify(phones),
        ticket.razonSocial || null,
        JSON.stringify(ticket.raw || {})
      );
      saved += 1;
    }

    database.exec('COMMIT');
  } catch (error) {
    database.exec('ROLLBACK');
    throw error;
  }

  return saved;
}

function pruneTicketsForDate(date, externalIds = []) {
  const database = getDb();
  const ids = externalIds
    .map(value => String(value || '').trim())
    .filter(Boolean);

  if (!ids.length) {
    const result = database.prepare(`
      DELETE FROM tickets
      WHERE start_date = ?
    `).run(date);
    return result.changes;
  }

  const placeholders = ids.map(() => '?').join(', ');
  const result = database.prepare(`
    DELETE FROM tickets
    WHERE start_date = ?
      AND external_id NOT IN (${placeholders})
  `).run(date, ...ids);

  return result.changes;
}

function normalizeGroupName(value) {
  return String(value || '').trim();
}

function parseTicketPayload(ticket) {
  try {
    return JSON.parse(ticket && ticket.payload_json || '{}') || {};
  } catch (error) {
    return {};
  }
}

function getTicketGroupName(ticket) {
  const payload = parseTicketPayload(ticket);

  return normalizeGroupName(
    payload.Grupo ||
    payload.grupo ||
    payload.Grupo_Tecnico ||
    payload.grupo_tecnico ||
    ticket.delegacion ||
    'Sin grupo'
  ) || 'Sin grupo';
}

function normalizeGroupList(groups) {
  const source = Array.isArray(groups)
    ? groups
    : String(groups || '').split(',');
  const seen = new Set();
  const cleanGroups = [];

  for (const group of source) {
    const cleanGroup = normalizeGroupName(group);
    const key = cleanGroup.toLowerCase();

    if (cleanGroup && !seen.has(key)) {
      seen.add(key);
      cleanGroups.push(cleanGroup);
    }
  }

  return cleanGroups;
}

function filterTicketsByGroups(tickets, groups) {
  if (groups === null) {
    return tickets;
  }

  const allowedGroups = new Set(normalizeGroupList(groups).map(group => group.toLowerCase()));

  if (!allowedGroups.size) {
    return [];
  }

  return tickets.filter(ticket => allowedGroups.has(getTicketGroupName(ticket).toLowerCase()));
}

function listTickets(date) {
  const database = getDb();

  if (date) {
    return database.prepare(`
      SELECT *
      FROM tickets
      WHERE start_date = ?
      ORDER BY start_ts ASC, external_id ASC
    `).all(date);
  }

  return database.prepare(`
    SELECT *
    FROM tickets
    ORDER BY start_ts ASC, external_id ASC
  `).all();
}

function listTicketGroups() {
  const rows = getDb().prepare(`
    SELECT delegacion, payload_json
    FROM tickets
    ORDER BY delegacion ASC
  `).all();
  const groups = normalizeGroupList(rows.map(getTicketGroupName));

  return groups.sort((left, right) => left.localeCompare(right));
}

function getTicket(externalId) {
  return getDb().prepare(`
    SELECT *
    FROM tickets
    WHERE external_id = ?
  `).get(externalId);
}

function getNextTicket(ticket, minimumStartTs = Date.now()) {
  if (!ticket) {
    return null;
  }

  const currentStartTs = Number(ticket.start_ts || 0);
  const thresholdStartTs = Math.max(currentStartTs, Number(minimumStartTs || 0));

  if (thresholdStartTs === currentStartTs) {
    return getDb().prepare(`
      SELECT *
      FROM tickets
      WHERE start_date = ?
        AND delegacion = ?
        AND (
          start_ts > ?
          OR (start_ts = ? AND external_id > ?)
        )
      ORDER BY start_ts ASC, external_id ASC
      LIMIT 1
    `).get(ticket.start_date, ticket.delegacion, thresholdStartTs, thresholdStartTs, ticket.external_id);
  }

  return getDb().prepare(`
    SELECT *
    FROM tickets
    WHERE start_date = ?
      AND delegacion = ?
      AND start_ts > ?
    ORDER BY start_ts ASC, external_id ASC
    LIMIT 1
  `).get(ticket.start_date, ticket.delegacion, thresholdStartTs);
}

function updateTicketStatus(externalId, status) {
  getDb().prepare(`
    UPDATE tickets
    SET status = ?,
        last_status_check_at = CURRENT_TIMESTAMP,
        updated_at = CURRENT_TIMESTAMP
    WHERE external_id = ?
  `).run(status || null, externalId);
}

function updateTicketPhone(externalId, phone) {
  const cleanPhone = normalizePhoneList(phone)[0] || null;
  const ticket = getTicket(externalId);
  const phones = normalizePhoneList([
    ...parseTicketPhones(ticket),
    cleanPhone
  ]);

  getDb().prepare(`
    UPDATE tickets
    SET phone = ?,
        phones_json = ?,
        updated_at = CURRENT_TIMESTAMP
    WHERE external_id = ?
  `).run(cleanPhone, JSON.stringify(phones), externalId);

  return getTicket(externalId);
}

function updateTicketClientInfo(externalId, clientInfo = {}) {
  const ticket = getTicket(externalId);
  const phones = normalizePhoneList([
    ...parseTicketPhones(ticket),
    ...(clientInfo.phones || []),
    clientInfo.phone
  ]);

  getDb().prepare(`
    UPDATE tickets
    SET phone = COALESCE(phone, ?),
        phones_json = CASE
          WHEN ? <> '[]' THEN ?
          ELSE phones_json
        END,
        razon_social = COALESCE(?, razon_social),
        updated_at = CURRENT_TIMESTAMP
    WHERE external_id = ?
  `).run(
    clientInfo.phone || phones[0] || null,
    JSON.stringify(phones),
    JSON.stringify(phones),
    clientInfo.razonSocial || null,
    externalId
  );
}

function markMessageSent(externalId) {
  getDb().prepare(`
    UPDATE tickets
    SET message_sent_at = CURRENT_TIMESTAMP,
        message_error = NULL,
        updated_at = CURRENT_TIMESTAMP
    WHERE external_id = ?
  `).run(externalId);
}

function markMessageError(externalId, errorMessage) {
  getDb().prepare(`
    UPDATE tickets
    SET message_error = ?,
        updated_at = CURRENT_TIMESTAMP
    WHERE external_id = ?
  `).run(String(errorMessage || 'Error enviando mensaje'), externalId);
}

function disableTicketAutomaticMessage(externalId, reason = 'Mensaje manual enviado') {
  const cleanExternalId = String(externalId || '').trim();

  if (!cleanExternalId) {
    throw new Error('Falta ticket');
  }

  getDb().prepare(`
    UPDATE tickets
    SET automatic_message_disabled_at = COALESCE(automatic_message_disabled_at, CURRENT_TIMESTAMP),
        automatic_message_disabled_reason = ?,
        message_error = NULL,
        updated_at = CURRENT_TIMESTAMP
    WHERE external_id = ?
  `).run(String(reason || 'Mensaje manual enviado').trim(), cleanExternalId);

  return getTicket(cleanExternalId);
}

function createTicketResponseAction(action = {}) {
  const ticketExternalId = String(action.ticketExternalId || '').trim();
  const chatId = String(action.chatId || '').trim();
  const phone = normalizeChatPhone(action.phone || chatId);
  const question = String(action.question || '').trim();
  const options = Array.isArray(action.options) ? action.options : [];

  if (!ticketExternalId || !chatId || !question || !options.length) {
    throw new Error('Faltan datos de la pregunta del ticket');
  }

  const database = getDb();

  database.prepare(`
    UPDATE ticket_response_actions
    SET status = 'superseded',
        updated_at = CURRENT_TIMESTAMP
    WHERE ticket_external_id = ?
      AND status = 'pending'
  `).run(ticketExternalId);

  const result = database.prepare(`
    INSERT INTO ticket_response_actions (
      ticket_external_id,
      chat_id,
      phone,
      question,
      options_json,
      delivery_mode,
      sent_message_id
    )
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(
    ticketExternalId,
    chatId,
    phone || null,
    question,
    JSON.stringify(options),
    String(action.deliveryMode || 'text').trim() || 'text',
    String(action.sentMessageId || '').trim() || null
  );

  return getTicketResponseAction(result.lastInsertRowid);
}

function parseTicketResponseAction(row) {
  if (!row) {
    return null;
  }

  let options = [];

  try {
    options = JSON.parse(row.options_json || '[]');
  } catch (error) {
    options = [];
  }

  return {
    ...row,
    options
  };
}

function getTicketResponseAction(id) {
  return parseTicketResponseAction(getDb().prepare(`
    SELECT *
    FROM ticket_response_actions
    WHERE id = ?
  `).get(Number(id)));
}

function getPendingTicketResponseActionByChat(chatId, phone) {
  const cleanChatId = String(chatId || '').trim();
  const cleanPhone = normalizeChatPhone(phone || chatId);

  if (!cleanChatId && !cleanPhone) {
    return null;
  }

  return parseTicketResponseAction(getDb().prepare(`
    SELECT *
    FROM ticket_response_actions
    WHERE status = 'pending'
      AND (
        chat_id = ?
        OR phone = ?
      )
    ORDER BY created_at DESC, id DESC
    LIMIT 1
  `).get(cleanChatId, cleanPhone || null));
}

function getLatestTicketResponseActionByChat(chatId, phone) {
  const cleanChatId = String(chatId || '').trim();
  const cleanPhone = normalizeChatPhone(phone || chatId);

  if (!cleanChatId && !cleanPhone) {
    return null;
  }

  return parseTicketResponseAction(getDb().prepare(`
    SELECT *
    FROM ticket_response_actions
    WHERE chat_id = ?
      OR phone = ?
    ORDER BY
      COALESCE(completed_at, updated_at, created_at) DESC,
      id DESC
    LIMIT 1
  `).get(cleanChatId, cleanPhone || null));
}

function completeTicketResponseAction(id, response = {}) {
  const action = getTicketResponseAction(id);

  if (!action) {
    throw new Error('Pregunta pendiente no encontrada');
  }

  const selectedKey = String(response.selectedKey || '').trim();
  const selectedLabel = String(response.selectedLabel || '').trim();
  const selectedAction = String(response.selectedAction || '').trim();
  const responseBody = String(response.responseBody || '').trim();
  const responseMessageId = String(response.responseMessageId || '').trim();
  const actionResult = String(response.actionResult || '').trim();

  getDb().prepare(`
    UPDATE ticket_response_actions
    SET status = 'completed',
        selected_key = ?,
        selected_label = ?,
        selected_action = ?,
        response_message_id = ?,
        response_body = ?,
        action_result = ?,
        completed_at = CURRENT_TIMESTAMP,
        updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `).run(
    selectedKey || null,
    selectedLabel || null,
    selectedAction || null,
    responseMessageId || null,
    responseBody || null,
    actionResult || null,
    Number(id)
  );

  getDb().prepare(`
    UPDATE tickets
    SET response_action = ?,
        response_label = ?,
        response_body = ?,
        response_received_at = CURRENT_TIMESTAMP,
        updated_at = CURRENT_TIMESTAMP
    WHERE external_id = ?
  `).run(
    selectedAction || null,
    selectedLabel || null,
    responseBody || selectedLabel || null,
    action.ticket_external_id
  );

  return getTicketResponseAction(id);
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

function isLidChatId(value) {
  return /@lid$/i.test(String(value || '').trim());
}

function isDirectPhoneChatId(value) {
  return /@(c\.us|s\.whatsapp\.net)$/i.test(String(value || '').trim());
}

function upsertWhatsAppChatAlias(aliasChatId, canonicalChatId, phone = '') {
  const cleanAliasChatId = String(aliasChatId || '').trim();
  const cleanCanonicalChatId = String(canonicalChatId || '').trim();
  const cleanPhone = normalizeChatPhone(phone || cleanCanonicalChatId) || null;

  if (!isLidChatId(cleanAliasChatId) || !isDirectPhoneChatId(cleanCanonicalChatId)) {
    return null;
  }

  getDb().prepare(`
    INSERT INTO whatsapp_chat_aliases (
      alias_chat_id,
      canonical_chat_id,
      phone,
      updated_at
    )
    VALUES (?, ?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(alias_chat_id) DO UPDATE SET
      canonical_chat_id = excluded.canonical_chat_id,
      phone = COALESCE(excluded.phone, whatsapp_chat_aliases.phone),
      updated_at = CURRENT_TIMESTAMP
  `).run(cleanAliasChatId, cleanCanonicalChatId, cleanPhone);

  return {
    aliasChatId: cleanAliasChatId,
    canonicalChatId: cleanCanonicalChatId,
    phone: cleanPhone || ''
  };
}

function listPersistedWhatsAppChatAliases(database = getDb(), directChatIds = []) {
  const cleanDirectChatIds = Array.from(new Set(
    (Array.isArray(directChatIds) ? directChatIds : [])
      .map(chatId => String(chatId || '').trim())
      .filter(Boolean)
  ));

  if (!cleanDirectChatIds.length) {
    return database.prepare(`
      SELECT alias_chat_id, canonical_chat_id, phone
      FROM whatsapp_chat_aliases
    `).all();
  }

  return database.prepare(`
    SELECT alias_chat_id, canonical_chat_id, phone
    FROM whatsapp_chat_aliases
    WHERE canonical_chat_id IN (${cleanDirectChatIds.map(() => '?').join(',')})
  `).all(...cleanDirectChatIds);
}

function refreshWhatsAppChatAliases(database = getDb()) {
  const rows = database.prepare(`
    SELECT
      lid.chat_id AS alias_chat_id,
      direct.chat_id AS canonical_chat_id,
      direct.phone AS phone,
      COUNT(*) AS matching_messages,
      MAX(direct.timestamp_ts) AS last_match_ts
    FROM whatsapp_messages lid
    JOIN whatsapp_messages direct
      ON direct.direction = 'outgoing'
      AND lid.direction = 'outgoing'
      AND direct.body = lid.body
      AND direct.chat_id <> lid.chat_id
      AND LOWER(direct.chat_id) NOT LIKE '%@lid'
      AND LOWER(lid.chat_id) LIKE '%@lid'
      AND direct.chat_id <> 'status@broadcast'
      AND lid.chat_id <> 'status@broadcast'
      AND ABS(direct.timestamp_ts - lid.timestamp_ts) <= 5000
    GROUP BY lid.chat_id, direct.chat_id, direct.phone
    HAVING matching_messages >= 1
    ORDER BY matching_messages DESC, last_match_ts DESC
  `).all();

  const seen = new Set();

  for (const row of rows) {
    const aliasChatId = String(row.alias_chat_id || '').trim();

    if (!aliasChatId || seen.has(aliasChatId)) {
      continue;
    }

    const saved = upsertWhatsAppChatAlias(
      aliasChatId,
      row.canonical_chat_id,
      row.phone
    );

    if (saved) {
      seen.add(aliasChatId);
    }
  }

  return seen.size;
}

function listWhatsAppConversationBucketOverrides() {
  return getDb().prepare(`
    SELECT whatsapp_account, chat_id, bucket, updated_by, updated_at
    FROM whatsapp_conversation_bucket_overrides
  `).all();
}

function getWhatsAppConversationBucketOverride(chatId, accountId = 'bot-1') {
  const cleanChatId = String(chatId || '').trim();
  const whatsappAccount = normalizeWhatsAppAccount(accountId);

  if (!cleanChatId) {
    return null;
  }

  return getDb().prepare(`
    SELECT whatsapp_account, chat_id, bucket, updated_by, updated_at
    FROM whatsapp_conversation_bucket_overrides
    WHERE whatsapp_account = ? AND chat_id = ?
  `).get(whatsappAccount, cleanChatId) || null;
}

function setWhatsAppConversationBucketOverride(chatId, bucket, updatedBy = '', accountId = 'bot-1') {
  const cleanChatId = String(chatId || '').trim();
  const cleanBucket = String(bucket || '').trim().toLowerCase();
  const cleanUpdatedBy = String(updatedBy || '').trim() || null;
  const whatsappAccount = normalizeWhatsAppAccount(accountId);

  if (!cleanChatId || !['main', 'other'].includes(cleanBucket)) {
    throw new Error('Faltan datos del cambio de bandeja');
  }

  getDb().prepare(`
    INSERT INTO whatsapp_conversation_bucket_overrides (
      whatsapp_account,
      chat_id,
      bucket,
      updated_by,
      updated_at
    )
    VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(whatsapp_account, chat_id) DO UPDATE SET
      bucket = excluded.bucket,
      updated_by = excluded.updated_by,
      updated_at = CURRENT_TIMESTAMP
  `).run(whatsappAccount, cleanChatId, cleanBucket, cleanUpdatedBy);

  return getWhatsAppConversationBucketOverride(cleanChatId, whatsappAccount);
}

function normalizeMessagePhone(phone, chatId) {
  const normalized = normalizeChatPhone(phone);
  const lidUser = isLidChatId(chatId) ? normalizeChatPhone(chatId) : '';

  if (normalized && lidUser && normalized === lidUser) {
    return '';
  }

  return normalized;
}

function getWhatsAppMessage(id) {
  return getDb().prepare(`
    SELECT *
    FROM whatsapp_messages
    WHERE id = ?
  `).get(id);
}

function updateWhatsAppMessageAck(id, ack) {
  const cleanId = String(id || '').trim();
  const parsedAck = Number(ack);

  if (!cleanId || !Number.isFinite(parsedAck)) {
    return null;
  }

  getDb().prepare(`
    UPDATE whatsapp_messages
    SET ack = ?
    WHERE id = ?
  `).run(parsedAck, cleanId);

  return getWhatsAppMessage(cleanId);
}

function normalizeWhatsAppAccount(value) {
  return String(value || 'bot-1').trim() || 'bot-1';
}

function saveWhatsAppMessage(message = {}) {
  const chatId = String(message.chatId || '').trim();
  const direction = message.direction === 'incoming' ? 'incoming' : 'outgoing';
  const timestampTs = Number(message.timestampTs || Date.now());
  const timestamp = Number.isFinite(timestampTs) && timestampTs > 0 ? timestampTs : Date.now();
  const body = String(message.body || '').trim();
  const id = String(message.id || `${direction}-${chatId}-${timestamp}`).trim();
  const whatsappAccount = normalizeWhatsAppAccount(message.whatsappAccount || message.accountId);

  if (!id || !chatId || !body) {
    throw new Error('Faltan datos del mensaje');
  }

  getDb().prepare(`
    INSERT INTO whatsapp_messages (
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
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      chat_id = CASE
        WHEN excluded.source = 'whatsapp'
          AND whatsapp_messages.source IN ('ticket', 'ticket-response', 'notification-channel', 'manual', 'inbox', 'bot')
        THEN whatsapp_messages.chat_id
        ELSE excluded.chat_id
      END,
      phone = CASE
        WHEN excluded.source = 'whatsapp'
          AND whatsapp_messages.source IN ('ticket', 'ticket-response', 'notification-channel', 'manual', 'inbox', 'bot')
        THEN whatsapp_messages.phone
        ELSE COALESCE(excluded.phone, whatsapp_messages.phone)
      END,
      contact_name = COALESCE(excluded.contact_name, whatsapp_messages.contact_name),
      body = CASE
        WHEN whatsapp_messages.body LIKE '[% sin texto]' AND excluded.body NOT LIKE '[% sin texto]'
        THEN excluded.body
        ELSE whatsapp_messages.body
      END,
      media_mime = COALESCE(excluded.media_mime, whatsapp_messages.media_mime),
      media_data = COALESCE(excluded.media_data, whatsapp_messages.media_data),
      media_filename = COALESCE(excluded.media_filename, whatsapp_messages.media_filename),
      ack = COALESCE(excluded.ack, whatsapp_messages.ack),
      sent_by_username = COALESCE(excluded.sent_by_username, whatsapp_messages.sent_by_username),
      sent_by_name = COALESCE(excluded.sent_by_name, whatsapp_messages.sent_by_name),
      whatsapp_account = COALESCE(excluded.whatsapp_account, whatsapp_messages.whatsapp_account),
      source = CASE
        WHEN excluded.source = 'whatsapp'
          AND whatsapp_messages.source IN ('ticket', 'ticket-response', 'notification-channel', 'manual', 'inbox', 'bot')
        THEN whatsapp_messages.source
        ELSE COALESCE(excluded.source, whatsapp_messages.source)
      END
  `).run(
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
    String(message.sentByUsername || '').trim() || null,
    String(message.sentByName || '').trim() || null,
    whatsappAccount
  );

  return getWhatsAppMessage(id);
}

function listWhatsAppConversations(limit = 100, options = {}) {
  const safeLimit = Math.min(Math.max(Number(limit) || 100, 1), 1000);
  const accountFilter = String(options.whatsappAccount || options.accountId || '').trim();
  const database = getDb();

  refreshWhatsAppChatAliases(database);

  const whereClause = accountFilter ? 'WHERE COALESCE(whatsapp_account, ?) = ?' : '';
  const whereParams = accountFilter ? ['bot-1', accountFilter] : [];

  const rows = database.prepare(`
    WITH ranked AS (
      SELECT
        *,
        ROW_NUMBER() OVER (
          PARTITION BY COALESCE(whatsapp_account, 'bot-1'), chat_id
          ORDER BY timestamp_ts DESC, created_at DESC, id DESC
        ) AS row_number
      FROM whatsapp_messages
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
      FROM whatsapp_messages
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
          FROM whatsapp_messages latest_phone
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
          FROM whatsapp_messages latest_contact
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
  `).all(...whereParams, ...whereParams, safeLimit);

  const chatKeys = new Set(rows.map(row => {
    const chatId = String(row.chat_id || '').trim();
    return chatId ? `${normalizeWhatsAppAccount(row.whatsapp_account)}:${chatId}` : '';
  }).filter(Boolean));
  const aliasRows = listPersistedWhatsAppChatAliases(database);
  const aliasToCanonical = new Map(
    aliasRows.map(row => [
      String(row.alias_chat_id || '').trim(),
      String(row.canonical_chat_id || '').trim()
    ])
  );

  return rows.filter(row => {
    const chatId = String(row.chat_id || '').trim();
    const canonicalChatId = aliasToCanonical.get(chatId);
    const account = normalizeWhatsAppAccount(row.whatsapp_account);

    return !(canonicalChatId && chatKeys.has(`${account}:${canonicalChatId}`));
  });
}

function getMessageVisualDuplicateKeys(message) {
  const direction = String(message.direction || '').trim().toLowerCase();
  const body = String(message.body || '').trim();
  const phone = normalizeChatPhone(message.phone || message.chat_id);
  const chatId = String(message.chat_id || '').trim().toLowerCase();
  const mediaMime = String(message.media_mime || '').trim();
  const mediaFilename = String(message.media_filename || '').trim();
  const whatsappAccount = normalizeWhatsAppAccount(message.whatsapp_account || message.whatsappAccount);
  const contentKey = direction === 'outgoing'
    ? JSON.stringify([whatsappAccount, 'outgoing-content', body, mediaMime, mediaFilename])
    : '';

  if (!direction || !body) {
    return [];
  }

  return [
    phone ? JSON.stringify([whatsappAccount, 'phone', direction, phone, body, mediaMime, mediaFilename]) : '',
    chatId ? JSON.stringify([whatsappAccount, 'chat', direction, chatId, body, mediaMime, mediaFilename]) : '',
    contentKey
  ].filter(Boolean);
}

function getMessageSourcePriority(message) {
  const source = String(message && message.source || '').trim();

  if (['ticket', 'ticket-response', 'notification-channel', 'manual', 'inbox', 'bot'].includes(source)) {
    return 2;
  }

  if (source === 'whatsapp') {
    return 0;
  }

  return 1;
}

function preferMessageForVisualDuplicate(current, candidate) {
  if (!current) {
    return candidate;
  }

  const currentSourcePriority = getMessageSourcePriority(current);
  const candidateSourcePriority = getMessageSourcePriority(candidate);

  let preferred = current;

  if (candidateSourcePriority !== currentSourcePriority) {
    preferred = candidateSourcePriority > currentSourcePriority ? candidate : current;
    return mergeMessageSenderDetails(preferred, preferred === candidate ? current : candidate);
  }

  const currentAck = Number(current.ack);
  const candidateAck = Number(candidate.ack);

  if (Number.isFinite(candidateAck) && (!Number.isFinite(currentAck) || candidateAck > currentAck)) {
    return mergeMessageSenderDetails(candidate, current);
  }

  const currentTime = Number(current.timestamp_ts || 0);
  const candidateTime = Number(candidate.timestamp_ts || 0);

  preferred = candidateTime >= currentTime ? candidate : current;
  return mergeMessageSenderDetails(preferred, preferred === candidate ? current : candidate);
}

function mergeMessageSenderDetails(preferred, fallback) {
  if (!preferred || !fallback) {
    return preferred;
  }

  return {
    ...preferred,
    sent_by_username: preferred.sent_by_username || fallback.sent_by_username,
    sent_by_name: preferred.sent_by_name || fallback.sent_by_name
  };
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

function findDirectChatAliases(database, directChatIds) {
  const cleanDirectChatIds = Array.from(new Set(
    (Array.isArray(directChatIds) ? directChatIds : [])
      .map(chatId => String(chatId || '').trim())
      .filter(isDirectPhoneChatId)
  ));
  const aliases = new Map();

  if (!cleanDirectChatIds.length) {
    return aliases;
  }

  for (const row of listPersistedWhatsAppChatAliases(database, cleanDirectChatIds)) {
    const aliasChatId = String(row.alias_chat_id || '').trim();
    const canonicalChatId = String(row.canonical_chat_id || '').trim();

    if (aliasChatId && canonicalChatId && !aliases.has(aliasChatId)) {
      aliases.set(aliasChatId, canonicalChatId);
    }
  }

  const rows = database.prepare(`
    SELECT
      lid.chat_id AS lid_chat_id,
      direct.chat_id AS direct_chat_id,
      direct.phone AS phone,
      COUNT(*) AS matching_messages,
      MAX(direct.timestamp_ts) AS last_match_ts
    FROM whatsapp_messages lid
    JOIN whatsapp_messages direct
      ON direct.direction = 'outgoing'
      AND lid.direction = 'outgoing'
      AND direct.body = lid.body
      AND direct.chat_id IN (${cleanDirectChatIds.map(() => '?').join(',')})
      AND ABS(direct.timestamp_ts - lid.timestamp_ts) <= 5000
    WHERE LOWER(lid.chat_id) LIKE '%@lid'
      AND lid.chat_id <> 'status@broadcast'
      AND direct.chat_id <> 'status@broadcast'
    GROUP BY lid.chat_id, direct.chat_id
    HAVING matching_messages >= 1
    ORDER BY matching_messages DESC, last_match_ts DESC
  `).all(...cleanDirectChatIds);

  for (const row of rows) {
    const lidChatId = String(row.lid_chat_id || '').trim();
    const directChatId = String(row.direct_chat_id || '').trim();

    if (lidChatId && directChatId && !aliases.has(lidChatId)) {
      upsertWhatsAppChatAlias(lidChatId, directChatId, row.phone);
      aliases.set(lidChatId, directChatId);
    }
  }

  return aliases;
}

function listWhatsAppMessages(chatId, limit = 200, options = {}) {
  const cleanChatId = String(chatId || '').trim();
  const safeLimit = Math.min(Math.max(Number(limit) || 200, 1), 500);
  const aliasPhone = isDirectPhoneChatId(cleanChatId) ? normalizeChatPhone(cleanChatId) : '';
  const accountFilter = String(options.whatsappAccount || options.accountId || '').trim();

  if (!cleanChatId) {
    return [];
  }

  const database = getDb();
  const chatIds = [cleanChatId];
  const selectedPhones = listWhatsAppChatPhones(cleanChatId)
    .map(phone => normalizeChatPhone(phone))
    .filter(Boolean);

  if (aliasPhone) {
    const aliasRows = database.prepare(`
      SELECT DISTINCT chat_id
      FROM whatsapp_messages
      WHERE LOWER(chat_id) LIKE '%@lid'
        AND phone = ?
        AND chat_id <> 'status@broadcast'
      ORDER BY chat_id
    `).all(aliasPhone);

    for (const aliasRow of aliasRows) {
      const aliasChatId = String(aliasRow.chat_id || '').trim();

      if (aliasChatId && !chatIds.includes(aliasChatId)) {
        chatIds.push(aliasChatId);
      }
    }

    const duplicateAliases = findDirectChatAliases(database, [cleanChatId]);

    for (const aliasChatId of duplicateAliases.keys()) {
      if (aliasChatId && !chatIds.includes(aliasChatId)) {
        chatIds.push(aliasChatId);
      }
    }
  }

  if (isLidChatId(cleanChatId) && selectedPhones.length) {
    const placeholders = selectedPhones.map(() => '?').join(',');
    const directRows = database.prepare(`
      SELECT DISTINCT chat_id
      FROM whatsapp_messages
      WHERE phone IN (${placeholders})
        AND LOWER(chat_id) NOT LIKE '%@lid'
        AND chat_id <> 'status@broadcast'
      ORDER BY chat_id
    `).all(...selectedPhones);

    for (const directRow of directRows) {
      const directChatId = String(directRow.chat_id || '').trim();

      if (directChatId && !chatIds.includes(directChatId)) {
        chatIds.push(directChatId);
      }
    }
  }

  if (isLidChatId(cleanChatId)) {
    const aliasRow = database.prepare(`
      SELECT canonical_chat_id
      FROM whatsapp_chat_aliases
      WHERE alias_chat_id = ?
    `).get(cleanChatId);
    const canonicalChatId = String(aliasRow && aliasRow.canonical_chat_id || '').trim();

    if (canonicalChatId && !chatIds.includes(canonicalChatId)) {
      chatIds.push(canonicalChatId);
    }
  }

  const rows = database.prepare(`
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
      FROM whatsapp_messages
      WHERE chat_id IN (${chatIds.map(() => '?').join(',')})
        ${accountFilter ? "AND COALESCE(whatsapp_account, 'bot-1') = ?" : ''}
        AND chat_id <> 'status@broadcast'
      ORDER BY timestamp_ts DESC, created_at DESC, id DESC
      LIMIT ?
    )
    ORDER BY timestamp_ts ASC, created_at ASC, id ASC
  `).all(...chatIds, ...(accountFilter ? [accountFilter] : []), safeLimit);

  return dedupeVisualMessages(rows);
}

function getAuditPhoneCandidates(value) {
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

function listWhatsAppMessagesByPhone(phone, limit = 200, options = {}) {
  const phoneCandidates = getAuditPhoneCandidates(phone);
  const safeLimit = Math.min(Math.max(Number(limit) || 200, 1), 1000);
  const accountFilter = String(options.whatsappAccount || options.accountId || '').trim();
  const fromTs = Number(options.fromTs || 0);
  const toTs = Number(options.toTs || 0);

  if (!phoneCandidates.length) {
    return [];
  }

  const database = getDb();
  const phoneWhere = phoneCandidates.map(() => 'phone LIKE ?').join(' OR ');
  const chatWhere = phoneCandidates.map(() => 'chat_id LIKE ?').join(' OR ');
  const whereParts = [
    `(${phoneWhere} OR ${chatWhere})`,
    "chat_id <> 'status@broadcast'"
  ];
  const params = [
    ...phoneCandidates.map(candidate => `%${candidate}%`),
    ...phoneCandidates.map(candidate => `%${candidate}%`)
  ];

  if (accountFilter) {
    whereParts.push("COALESCE(whatsapp_account, 'bot-1') = ?");
    params.push(accountFilter);
  }

  if (Number.isFinite(fromTs) && fromTs > 0) {
    whereParts.push('timestamp_ts >= ?');
    params.push(fromTs);
  }

  if (Number.isFinite(toTs) && toTs > 0) {
    whereParts.push('timestamp_ts <= ?');
    params.push(toTs);
  }

  const rows = database.prepare(`
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
      NULL AS media_data,
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
      FROM whatsapp_messages
      WHERE ${whereParts.join(' AND ')}
      ORDER BY timestamp_ts DESC, created_at DESC, id DESC
      LIMIT ?
    ) recent_messages
    ORDER BY timestamp_ts ASC, created_at ASC, id ASC
  `).all(...params, safeLimit);

  return dedupeVisualMessages(rows);
}
function listWhatsAppChatPhones(chatId) {
  const cleanChatId = String(chatId || '').trim();

  if (!cleanChatId) {
    return [];
  }

  const database = getDb();
  const phones = database.prepare(`
    SELECT DISTINCT phone
    FROM whatsapp_messages
    WHERE chat_id = ?
      AND phone IS NOT NULL
      AND phone <> ''
  `).all(cleanChatId).map(row => row.phone);

  const aliasRows = database.prepare(`
    SELECT phone
    FROM whatsapp_chat_aliases
    WHERE (alias_chat_id = ? OR canonical_chat_id = ?)
      AND phone IS NOT NULL
      AND phone <> ''
  `).all(cleanChatId, cleanChatId);

  for (const row of aliasRows) {
    if (row.phone && !phones.includes(row.phone)) {
      phones.push(row.phone);
    }
  }

  return phones;
}

function getRecentTicketNotificationByPhone(phone, sinceTs) {
  const cleanPhone = normalizeChatPhone(phone);
  const cleanSinceTs = Number(sinceTs || 0);

  if (!cleanPhone || !Number.isFinite(cleanSinceTs) || cleanSinceTs <= 0) {
    return null;
  }

  return getDb().prepare(`
    SELECT id, chat_id, phone, body, timestamp_ts, timestamp_iso, source
    FROM whatsapp_messages
    WHERE direction = 'outgoing'
      AND source = 'ticket'
      AND phone = ?
      AND timestamp_ts >= ?
    ORDER BY timestamp_ts DESC
    LIMIT 1
  `).get(cleanPhone, cleanSinceTs) || null;
}

function getRecentOutgoingMessageBySource(chatId, source, sinceTs) {
  const cleanChatId = String(chatId || '').trim();
  const cleanSource = String(source || '').trim();
  const cleanSinceTs = Number(sinceTs || 0);

  if (!cleanChatId || !cleanSource || !Number.isFinite(cleanSinceTs) || cleanSinceTs <= 0) {
    return null;
  }

  return getDb().prepare(`
    SELECT id, chat_id, phone, body, timestamp_ts, timestamp_iso, source
    FROM whatsapp_messages
    WHERE direction = 'outgoing'
      AND source = ?
      AND chat_id = ?
      AND timestamp_ts >= ?
    ORDER BY timestamp_ts DESC
    LIMIT 1
  `).get(cleanSource, cleanChatId, cleanSinceTs) || null;
}

function getRecentOutgoingMessage(chatId, sinceTs) {
  const cleanChatId = String(chatId || '').trim();
  const cleanSinceTs = Number(sinceTs || 0);

  if (!cleanChatId || !Number.isFinite(cleanSinceTs) || cleanSinceTs <= 0) {
    return null;
  }

  return getDb().prepare(`
    SELECT id, chat_id, phone, body, timestamp_ts, timestamp_iso, source
    FROM whatsapp_messages
    WHERE direction = 'outgoing'
      AND chat_id = ?
      AND timestamp_ts >= ?
    ORDER BY timestamp_ts DESC
    LIMIT 1
  `).get(cleanChatId, cleanSinceTs) || null;
}

function closeDb() {
  if (db) {
    db.close();
    db = null;
  }
}

module.exports = {
  closeDb,
  completeTicketResponseAction,
  createTicketResponseAction,
  createAutomaticMessageTemplate,
  deleteAutomaticMessageTemplate,
  disableTicketAutomaticMessage,
  ensureAutomaticMessageTemplate,
  getAutomaticMessageTemplate,
  getAppState,
  getDb,
  getNextAutomaticMessageTemplate,
  getNextTicket,
  getRecentTicketNotificationByPhone,
  getRecentOutgoingMessage,
  getRecentOutgoingMessageBySource,
  getLatestTicketResponseActionByChat,
  getPendingTicketResponseActionByChat,
  getTicket,
  getTicketGroupName,
  getAuditPhoneCandidates,
  filterTicketsByGroups,
  getWhatsAppConversationBucketOverride,
  listTicketGroups,
  listAutomaticMessageTemplates,
  listWhatsAppConversationBucketOverrides,
  listWhatsAppChatPhones,
  listWhatsAppConversations,
  listWhatsAppMessages,
  listTickets,
  listWhatsAppMessagesByPhone,
  markMessageError,
  markMessageSent,
  normalizeChatPhone,
  pruneTicketsForDate,
  saveWhatsAppMessage,
  setAppState,
  setWhatsAppConversationBucketOverride,
  updateAutomaticMessageTemplate,
  updateWhatsAppMessageAck,
  updateTicketClientInfo,
  updateTicketStatus,
  updateTicketPhone,
  upsertTickets
};
