require('../config');

const {
  closeDb,
  getDb,
  saveWhatsAppMessage
} = require('../db');
const secondDb = require('../secondMessageDb');

function parsePositiveInteger(value, fallback) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function normalizeTimestamp(value) {
  const numeric = Number(value || 0);

  if (Number.isFinite(numeric) && numeric > 0) {
    return numeric;
  }

  const parsed = Date.parse(String(value || ''));
  return Number.isFinite(parsed) ? parsed : Date.now();
}

function normalizeSource(value) {
  const source = String(value || '').trim();
  return source || 'whatsapp-second';
}

function escapeIdentifier(value, label = 'identificador') {
  const identifier = String(value || '').trim();

  if (!/^[A-Za-z0-9_]+$/.test(identifier)) {
    throw new Error(`Nombre de ${label} invalido: ${identifier}`);
  }

  return `\`${identifier}\``;
}

function getTargetMessageId(sourceMessage) {
  const sourceId = String(sourceMessage.id || '').trim();

  if (!sourceId) {
    return '';
  }

  const existing = getDb().prepare(`
    SELECT whatsapp_account
    FROM whatsapp_messages
    WHERE id = ?
    LIMIT 1
  `).get(sourceId);

  if (!existing || String(existing.whatsapp_account || 'bot-1') === 'bot-2') {
    return sourceId;
  }

  return `bot-2:${sourceId}`;
}

async function importBatch(database, tableName, limit, offset) {
  const tableSql = escapeIdentifier(tableName, 'tabla de mensajes del segundo server');

  const [rows] = await database.query(`
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
      owner_username
    FROM ${tableSql}
    ORDER BY timestamp_ts ASC, created_at ASC, id ASC
    LIMIT ?
    OFFSET ?
  `, [limit, offset]);

  let imported = 0;
  let skipped = 0;

  for (const row of rows) {
    const id = getTargetMessageId(row);

    if (!id || !row.chat_id || !row.body) {
      skipped += 1;
      continue;
    }

    saveWhatsAppMessage({
      id,
      chatId: row.chat_id,
      phone: row.phone,
      contactName: row.contact_name,
      direction: row.direction,
      body: row.body,
      mediaMime: row.media_mime,
      mediaData: row.media_data,
      mediaFilename: row.media_filename,
      timestampTs: normalizeTimestamp(row.timestamp_ts || row.timestamp_iso),
      fromMe: Boolean(row.from_me),
      ack: row.ack,
      source: normalizeSource(row.source),
      sentByUsername: row.owner_username,
      whatsappAccount: 'bot-2'
    });
    imported += 1;
  }

  return {
    rows: rows.length,
    imported,
    skipped
  };
}

async function main() {
  const batchSize = parsePositiveInteger(process.env.MIGRATE_SECOND_MESSAGES_BATCH_SIZE, 500);
  const settings = secondDb.getMysqlSettings();
  const database = await secondDb.getPool();
  const messagesTableSql = escapeIdentifier(settings.messagesTable, 'tabla de mensajes del segundo server');
  const [[countRow]] = await database.query(`SELECT COUNT(*) AS total FROM ${messagesTableSql}`);
  const total = Number(countRow && countRow.total || 0);
  let imported = 0;
  let skipped = 0;

  for (let offset = 0; offset < total; offset += batchSize) {
    const result = await importBatch(database, settings.messagesTable, batchSize, offset);
    imported += result.imported;
    skipped += result.skipped;
    console.log(`Importados ${Math.min(offset + result.rows, total)}/${total}`);
  }

  console.log(JSON.stringify({
    success: true,
    sourceDatabase: settings.database,
    sourceTable: settings.messagesTable,
    targetTable: 'whatsapp_messages',
    whatsappAccount: 'bot-2',
    total,
    imported,
    skipped
  }, null, 2));
}

main()
  .catch(error => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await secondDb.closePool().catch(() => {});
    closeDb();
  });
