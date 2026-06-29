const { Client, LocalAuth, MessageMedia } = require('whatsapp-web.js');
const express = require('express');
const qrcode = require('qrcode-terminal');
const QRCode = require('qrcode-terminal/vendor/QRCode');
const QRErrorCorrectLevel = require('qrcode-terminal/vendor/QRCode/QRErrorCorrectLevel');
const cors = require('cors');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { config } = require('./config');

process.env.AUTH_COOKIE_NAME = process.env.SECOND_APP_AUTH_COOKIE_NAME || 'wwebjs_second_session';

const {
  handleLogin,
  handleLogout,
  handleMe,
  redirectIfAuthenticated,
  requireAuth
} = require('./auth');
const {
  allowedRoles,
  createUser,
  deleteUser,
  listAssignedUserGroups,
  listUsers: listAppUsers,
  updateUser
} = require('./users');
const {
  cancelMessageQueueItem,
  claimPendingMessageQueue,
  enqueueMessageQueueItems,
  getMessageQueueStats,
  getMysqlSettings,
  getPhantomBajaSyncStatus,
  getWhatsAppChatOwner,
  listPhantomBajaClients,
  listMessageQueueItems,
  listWhatsAppConversations,
  listWhatsAppMessages,
  markMessageQueueError,
  markMessageQueueSent,
  markStaleMessageQueueErrors,
  normalizeChatPhone,
  pingDatabase,
  releaseMessageQueueItem,
  replacePhantomBajaClients,
  saveWhatsAppMessage
} = require('./secondMessageDb');

const app = express();
const secondAppPort = parsePositiveInteger(
  process.env.SECOND_APP_PORT || process.env.WHATSAPP_SECOND_PORT,
  3001
);
const whatsappClientId = String(process.env.SECOND_WHATSAPP_CLIENT_ID || 'bot-2').trim();
const whatsappAuthRoot = path.resolve(__dirname, '.wwebjs_auth');
const whatsappAuthSessionDir = path.resolve(whatsappAuthRoot, `session-${whatsappClientId}`);
const maxStoredMediaBytes = parsePositiveInteger(process.env.SECOND_APP_MAX_STORED_MEDIA_MB, 15) * 1024 * 1024;
const maxRequestBodyMb = parsePositiveInteger(process.env.SECOND_APP_JSON_LIMIT_MB, 25);
const messageQueueIntervalMinutes = parsePositiveInteger(process.env.SECOND_MESSAGE_QUEUE_INTERVAL_MINUTES, 10);
const messageQueueBatchSize = parsePositiveInteger(process.env.SECOND_MESSAGE_QUEUE_BATCH_SIZE, 20);
const whatsappSendTimeoutMs = parsePositiveInteger(process.env.SECOND_WHATSAPP_SEND_TIMEOUT_SECONDS, 60) * 1000;
const secondMessageSettingsPath = path.join(__dirname, 'data', 'second-message-settings.json');
const phantomBajaSyncHour = Math.min(parseNonNegativeInteger(process.env.PHANTOM_BAJA_SYNC_HOUR, 3), 23);
const phantomBajaSyncMinute = Math.min(parseNonNegativeInteger(process.env.PHANTOM_BAJA_SYNC_MINUTE, 0), 59);
const phantomBajaSyncLimit = Math.min(parsePositiveInteger(process.env.PHANTOM_BAJA_SYNC_LIMIT, 500), 500);

let whatsappReady = false;
let whatsappState = 'starting';
let whatsappLastEventAt = null;
let whatsappLastError = null;
let whatsappQr = null;
let whatsappQrText = null;
let whatsappQrSvg = null;
let whatsappRestarting = false;
let whatsappReconnectTimer = null;
let client = null;
let messageQueueRunning = false;
let phantomBajaSyncRunning = false;
let phantomBajaSyncTimer = null;
const phantomBajaSyncState = {
  active: false,
  running: false,
  lastRunStartedAt: null,
  lastRunFinishedAt: null,
  nextRunAt: null,
  lastResult: null,
  lastError: null
};
const messageQueueState = {
  active: false,
  intervalMinutes: messageQueueIntervalMinutes,
  batchSize: messageQueueBatchSize,
  startedAt: null,
  lastRunStartedAt: null,
  lastRunFinishedAt: null,
  nextRunAt: null,
  lastResult: null,
  lastError: null,
  runCount: 0
};

app.use(cors());
app.use(express.json({ limit: `${maxRequestBodyMb}mb` }));

const requireLoggedIn = requireAuth();
const requirePrivileged = requireLoggedIn;
const requireAdmin = requireAuth(['admin']);
const requireTemplateEditor = requireAuth(['admin', 'usuario']);

function parsePositiveInteger(value, fallback) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function parseNonNegativeInteger(value, fallback) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

function nowIso() {
  return new Date().toISOString();
}

function normalizeOwnerUsername(value) {
  return String(value || '').trim().toLowerCase();
}

function getUserOwnerUsername(user) {
  return normalizeOwnerUsername(user && user.username);
}

function canSeeAllOwnedChats(user) {
  return Boolean(user && (user.isAdmin || user.role === 'admin'));
}

function getScopedOwnerUsername(user) {
  return canSeeAllOwnedChats(user) ? '' : getUserOwnerUsername(user);
}

function readSecondMessageSettings() {
  if (!fs.existsSync(secondMessageSettingsPath)) {
    return {};
  }

  try {
    return JSON.parse(fs.readFileSync(secondMessageSettingsPath, 'utf8')) || {};
  } catch (error) {
    console.warn('No se pudo leer data/second-message-settings.json. Se usan valores por defecto.');
    return {};
  }
}

function writeSecondMessageSettings(settings) {
  fs.mkdirSync(path.dirname(secondMessageSettingsPath), { recursive: true });
  fs.writeFileSync(secondMessageSettingsPath, JSON.stringify(settings, null, 2), 'utf8');
}

function parseSecondMessageTemplates(value) {
  const source = Array.isArray(value)
    ? value
    : String(value || '').split(/^\s*---+\s*$/m);

  return source
    .map(template => {
      if (template && typeof template === 'object' && !Array.isArray(template)) {
        return String(template.body ?? template.template ?? template.text ?? '').trim();
      }

      return String(template || '').trim();
    })
    .filter(Boolean);
}

const secondMessageTemplatePlaceholders = [
  'id',
  'razon_social',
  'cliente',
  'deuda',
  'estado',
  'movil',
  'telefono',
  'fecha_ultima_factura',
  'comprobantes_adeudados'
];

function getDefaultSecondMessageTemplate() {
  return String(
    process.env.SECOND_MESSAGE_TEMPLATE ||
    'Hola {razon_social}, registramos deuda pendiente por {deuda}. Por favor comunicate con administracion para regularizarla.'
  ).trim();
}

function normalizeSecondMessageTemplateName(value, fallback) {
  return String(value || fallback || 'Template').trim().slice(0, 120) || 'Template';
}

function isValidSecondMessageTemplateId(value) {
  return /^[a-zA-Z0-9_-]{1,80}$/.test(String(value || '').trim());
}

function createSecondMessageTemplateId() {
  return `tpl_${Date.now().toString(36)}_${crypto.randomBytes(3).toString('hex')}`;
}

function createFallbackSecondMessageTemplateId(index, usedIds) {
  let id = `tpl_${index + 1}`;
  let suffix = 2;

  while (usedIds.has(id)) {
    id = `tpl_${index + 1}_${suffix}`;
    suffix += 1;
  }

  return id;
}

function normalizeSecondMessageTemplateRecords(value) {
  const source = Array.isArray(value)
    ? value
    : parseSecondMessageTemplates(value).map(body => ({ body }));
  const usedIds = new Set();
  const records = [];
  const now = nowIso();

  source.forEach((item, index) => {
    const record = item && typeof item === 'object' && !Array.isArray(item)
      ? item
      : { body: item };
    const body = String(record.body ?? record.template ?? record.text ?? '').trim();

    if (!body) {
      return;
    }

    let id = String(record.id || '').trim();

    if (!isValidSecondMessageTemplateId(id) || usedIds.has(id)) {
      id = createFallbackSecondMessageTemplateId(index, usedIds);
    }

    usedIds.add(id);
    records.push({
      id,
      name: normalizeSecondMessageTemplateName(record.name ?? record.title, `Template ${records.length + 1}`),
      body,
      createdAt: String(record.createdAt || record.created_at || now),
      updatedAt: String(record.updatedAt || record.updated_at || now)
    });
  });

  return records;
}

function getSecondMessageTemplateSource(settings = readSecondMessageSettings()) {
  if (Array.isArray(settings.messageTemplates)) {
    return settings.messageTemplates;
  }

  if (Array.isArray(settings.templates)) {
    return settings.templates;
  }

  return settings.template || getDefaultSecondMessageTemplate();
}

function getSecondMessageTemplateRecords(settings = readSecondMessageSettings()) {
  const configured = normalizeSecondMessageTemplateRecords(getSecondMessageTemplateSource(settings));

  if (configured.length) {
    return configured;
  }

  return normalizeSecondMessageTemplateRecords([{
    id: 'tpl_default',
    name: 'Mensaje principal',
    body: getDefaultSecondMessageTemplate()
  }]);
}

function persistSecondMessageTemplateRecords(records, settings = readSecondMessageSettings()) {
  const cleanRecords = normalizeSecondMessageTemplateRecords(records);

  if (!cleanRecords.length) {
    throw new Error('Debe quedar al menos un template');
  }

  const cursor = Number.isFinite(Number(settings.cursor))
    ? Number(settings.cursor) % cleanRecords.length
    : 0;

  settings.template = cleanRecords[0].body;
  settings.templates = cleanRecords.map(record => record.body);
  settings.messageTemplates = cleanRecords;
  settings.cursor = cursor;
  settings.updatedAt = nowIso();
  writeSecondMessageSettings(settings);

  return cleanRecords;
}

function getSecondMessageTemplates(settings = readSecondMessageSettings()) {
  return getSecondMessageTemplateRecords(settings).map(record => record.body);
}

function getSecondMessageTemplateText() {
  return getSecondMessageTemplates().join('\n---\n');
}

function setSecondMessageTemplates(value) {
  const templates = normalizeSecondMessageTemplateRecords(value);

  if (!templates.length) {
    throw new Error('El mensaje no puede estar vacio');
  }

  return persistSecondMessageTemplateRecords(templates).map(record => record.body);
}

function findSecondMessageTemplate(id, records = getSecondMessageTemplateRecords()) {
  const cleanId = String(id || '').trim();
  return records.find(record => record.id === cleanId) || null;
}

function normalizeSecondMessageTemplateInput(input = {}, fallback = {}) {
  const hasBody = Object.prototype.hasOwnProperty.call(input, 'body') ||
    Object.prototype.hasOwnProperty.call(input, 'template') ||
    Object.prototype.hasOwnProperty.call(input, 'text');
  const body = hasBody
    ? String(input.body ?? input.template ?? input.text ?? '').trim()
    : String(fallback.body || '').trim();
  const name = Object.prototype.hasOwnProperty.call(input, 'name') ||
    Object.prototype.hasOwnProperty.call(input, 'title')
    ? normalizeSecondMessageTemplateName(input.name ?? input.title, fallback.name)
    : normalizeSecondMessageTemplateName(fallback.name, 'Template');

  if (!body) {
    throw new Error('El mensaje no puede estar vacio');
  }

  return {
    name,
    body
  };
}

function createSecondMessageTemplate(input = {}) {
  const settings = readSecondMessageSettings();
  const records = getSecondMessageTemplateRecords(settings);
  const now = nowIso();
  const data = normalizeSecondMessageTemplateInput(input, {
    name: `Template ${records.length + 1}`
  });
  const nextRecord = {
    id: createSecondMessageTemplateId(),
    name: data.name,
    body: data.body,
    createdAt: now,
    updatedAt: now
  };

  persistSecondMessageTemplateRecords([...records, nextRecord], settings);
  return nextRecord;
}

function updateSecondMessageTemplate(id, input = {}) {
  const settings = readSecondMessageSettings();
  const records = getSecondMessageTemplateRecords(settings);
  const index = records.findIndex(record => record.id === String(id || '').trim());

  if (index === -1) {
    throw new Error('Template no encontrado');
  }

  const currentRecord = records[index];
  const data = normalizeSecondMessageTemplateInput(input, currentRecord);
  const nextRecord = {
    ...currentRecord,
    name: data.name,
    body: data.body,
    updatedAt: nowIso()
  };
  const nextRecords = records.slice();
  nextRecords[index] = nextRecord;

  persistSecondMessageTemplateRecords(nextRecords, settings);
  return nextRecord;
}

function deleteSecondMessageTemplate(id) {
  const settings = readSecondMessageSettings();
  const records = getSecondMessageTemplateRecords(settings);
  const cleanId = String(id || '').trim();
  const template = records.find(record => record.id === cleanId);

  if (!template) {
    throw new Error('Template no encontrado');
  }

  if (records.length === 1) {
    throw new Error('Debe quedar al menos un template');
  }

  persistSecondMessageTemplateRecords(records.filter(record => record.id !== cleanId), settings);
  return template;
}

function getNextSecondMessageTemplate() {
  const settings = readSecondMessageSettings();
  const records = getSecondMessageTemplateRecords(settings);
  const safeTemplates = records.length ? records : getSecondMessageTemplateRecords({});
  const cursor = Number.isFinite(Number(settings.cursor)) ? Number(settings.cursor) : 0;
  const index = cursor % safeTemplates.length;
  const template = safeTemplates[index];

  settings.template = safeTemplates[0].body;
  settings.templates = safeTemplates.map(record => record.body);
  settings.messageTemplates = safeTemplates;
  settings.cursor = (index + 1) % safeTemplates.length;
  settings.updatedAt = nowIso();
  writeSecondMessageSettings(settings);

  return {
    id: template.id,
    name: template.name,
    template: template.body,
    index,
    total: safeTemplates.length
  };
}

function renderStringTemplate(template, variables = {}) {
  return String(template || '').replace(/\{([a-zA-Z0-9_]+)\}/g, (match, key) => {
    const value = variables[key];
    return value === undefined || value === null ? match : String(value);
  });
}

function markWhatsAppState(state, ready = state === 'CONNECTED') {
  whatsappState = state;
  whatsappReady = Boolean(ready);
  whatsappLastEventAt = new Date().toISOString();

  if (ready) {
    clearWhatsAppQr();
  }
}

function clearWhatsAppQr() {
  whatsappQr = null;
  whatsappQrText = null;
  whatsappQrSvg = null;
}

function scheduleWhatsAppReconnect(reason, delayMs = 5000) {
  if (whatsappReconnectTimer || whatsappRestarting) {
    return;
  }

  whatsappReconnectTimer = setTimeout(() => {
    whatsappReconnectTimer = null;
    restartWhatsAppClient(reason).catch(error => {
      console.warn('No se pudo reiniciar WhatsApp secundario automaticamente:', error.message);
    });
  }, delayMs);
}

function createQrText(input) {
  let output = '';
  qrcode.generate(input, { small: true }, value => {
    output = value;
  });
  return output;
}

function createQrSvgDataUrl(input) {
  const qr = new QRCode(-1, QRErrorCorrectLevel.L);
  qr.addData(input);
  qr.make();

  const margin = 4;
  const moduleCount = qr.getModuleCount();
  const viewBoxSize = moduleCount + margin * 2;
  const rects = [];

  for (let row = 0; row < moduleCount; row += 1) {
    for (let col = 0; col < moduleCount; col += 1) {
      if (qr.isDark(row, col)) {
        rects.push(`<rect x="${col + margin}" y="${row + margin}" width="1" height="1"/>`);
      }
    }
  }

  const svg = [
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${viewBoxSize} ${viewBoxSize}" shape-rendering="crispEdges">`,
    '<rect width="100%" height="100%" fill="#fff"/>',
    '<g fill="#000">',
    rects.join(''),
    '</g>',
    '</svg>'
  ].join('');

  return `data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`;
}

function sendHtmlFile(res, filename) {
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');
  res.setHeader('Surrogate-Control', 'no-store');
  res.sendFile(path.join(__dirname, filename));
}

function getWhatsAppTimestampMs(timestamp) {
  const value = Number(timestamp);

  if (!Number.isFinite(value) || value <= 0) {
    return Date.now();
  }

  return value < 1000000000000 ? value * 1000 : value;
}

function getStoredMessageId(message, chatId, direction) {
  if (message && message.id && message.id._serialized) {
    return message.id._serialized;
  }

  return `${direction}-${chatId}-${getWhatsAppTimestampMs(message && message.timestamp)}`;
}

function isDirectChatId(value) {
  return /@(c\.us|s\.whatsapp\.net|lid|g\.us)$/i.test(String(value || '').trim());
}

function getContactIdServer(contact) {
  return String(contact && contact.id && contact.id.server || '').toLowerCase();
}

function getContactPhone(contact, chatId) {
  if (!contact) {
    return '';
  }

  const contactNumber = normalizeChatPhone(contact.number || '');
  const contactIdUser = getContactIdServer(contact) === 'lid'
    ? ''
    : normalizeChatPhone(contact.id && contact.id.user || '');
  const phone = contactNumber || contactIdUser;
  const lidUser = /@lid$/i.test(chatId) ? normalizeChatPhone(chatId) : '';

  if (phone && lidUser && phone === lidUser) {
    return '';
  }

  return phone;
}

async function getMessageContactInfo(message, chatId) {
  let contact = null;

  if (message && message.getContact) {
    try {
      contact = await message.getContact();
    } catch (error) {
      contact = null;
    }
  }

  if (!contact && client && message && message.fromMe && chatId) {
    try {
      contact = await client.getContactById(chatId);
    } catch (error) {
      contact = null;
    }
  }

  const contactName = contact
    ? contact.pushname || contact.name || contact.shortName || ''
    : (message && message._data && message._data.notifyName ? message._data.notifyName : '');
  const contactPhone = getContactPhone(contact, chatId) || normalizeChatPhone(message && message.author || '');

  return {
    contactName,
    contactPhone
  };
}

function getMediaLabel(mimetype, fallbackType) {
  const cleanMime = String(mimetype || '').toLowerCase();

  if (cleanMime.startsWith('image/')) {
    return 'imagen';
  }

  if (cleanMime.startsWith('video/')) {
    return 'video';
  }

  if (cleanMime.startsWith('audio/')) {
    return 'audio';
  }

  if (String(fallbackType || '').toLowerCase() === 'ptt') {
    return 'audio';
  }

  return fallbackType || 'archivo';
}

async function getMessageMediaInfo(message) {
  if (!message || !message.hasMedia || !message.downloadMedia) {
    return {};
  }

  try {
    const media = await message.downloadMedia();

    if (!media || !media.mimetype) {
      return {};
    }

    const mediaInfo = {
      mediaMime: media.mimetype,
      mediaFilename: media.filename || (message._data && message._data.filename) || ''
    };

    if (media.data) {
      const mediaBytes = Buffer.byteLength(media.data, 'base64');

      if (mediaBytes <= maxStoredMediaBytes) {
        mediaInfo.mediaData = media.data;
      }
    }

    return mediaInfo;
  } catch (error) {
    console.warn('No se pudo descargar media de WhatsApp secundario:', error.message);
    return {};
  }
}

async function storeWhatsAppMessage(message, source = 'whatsapp-second') {
  if (!message) {
    return null;
  }

  const direction = message.fromMe ? 'outgoing' : 'incoming';
  const chatId = String(message.fromMe ? message.to : message.from || '').trim();

  if (!chatId || chatId === 'status@broadcast') {
    return null;
  }

  const contactInfo = await getMessageContactInfo(message, chatId);
  const mediaInfo = await getMessageMediaInfo(message);
  const phone = contactInfo.contactPhone || normalizeChatPhone(chatId);
  const ownerUsername = await getWhatsAppChatOwner(chatId, phone);
  const rawBody = String(message.body || message.caption || '').trim();
  const body = rawBody || (mediaInfo.mediaMime
    ? `[${getMediaLabel(mediaInfo.mediaMime, message.type)} sin texto]`
    : '');

  if (!body) {
    return null;
  }

  return saveWhatsAppMessage({
    id: getStoredMessageId(message, chatId, direction),
    chatId,
    phone,
    contactName: contactInfo.contactName,
    direction,
    body,
    mediaMime: mediaInfo.mediaMime,
    mediaData: mediaInfo.mediaData,
    mediaFilename: mediaInfo.mediaFilename,
    timestampTs: getWhatsAppTimestampMs(message.timestamp),
    fromMe: message.fromMe,
    ack: message.ack,
    source,
    ownerUsername
  });
}

function createWhatsAppClient() {
  return new Client({
    authStrategy: new LocalAuth({
      clientId: whatsappClientId,
      dataPath: whatsappAuthRoot
    }),
    puppeteer: {
      headless: true,
      ...(config.whatsappChromePath ? { executablePath: config.whatsappChromePath } : {}),
      protocolTimeout: config.whatsappProtocolTimeoutMs,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu'
      ]
    }
  });
}

function removeWhatsAppAuthSession() {
  const rootWithSeparator = whatsappAuthRoot.endsWith(path.sep)
    ? whatsappAuthRoot
    : `${whatsappAuthRoot}${path.sep}`;

  if (!whatsappAuthSessionDir.startsWith(rootWithSeparator)) {
    throw new Error('Ruta de sesion WhatsApp invalida');
  }

  fs.rmSync(whatsappAuthSessionDir, {
    force: true,
    recursive: true,
    maxRetries: 5,
    retryDelay: 500
  });
}

function attachWhatsAppEvents(instance) {
  instance.on('qr', qr => {
    markWhatsAppState('QR', false);
    whatsappLastError = null;
    whatsappQr = qr;
    whatsappQrText = createQrText(qr);
    whatsappQrSvg = createQrSvgDataUrl(qr);
    console.log('Escanea este QR para la segunda sesion de WhatsApp:');
    qrcode.generate(qr, { small: true });
  });

  instance.on('authenticated', () => {
    markWhatsAppState('AUTHENTICATED', false);
    clearWhatsAppQr();
    console.log('WhatsApp secundario autenticado');
  });

  instance.on('auth_failure', msg => {
    markWhatsAppState('AUTH_FAILURE', false);
    clearWhatsAppQr();
    whatsappLastError = String(msg || 'Fallo de autenticacion');
    console.error('Fallo de autenticacion en WhatsApp secundario:', msg);
  });

  instance.on('ready', () => {
    markWhatsAppState('CONNECTED', true);
    whatsappLastError = null;
    console.log('WhatsApp secundario conectado');
  });

  instance.on('change_state', state => {
    markWhatsAppState(state || 'UNKNOWN', state === 'CONNECTED');
    console.log('Estado de WhatsApp secundario:', state);
  });

  instance.on('disconnected', reason => {
    markWhatsAppState(`DISCONNECTED: ${reason}`, false);
    clearWhatsAppQr();
    console.log('WhatsApp secundario desconectado:', reason);
    scheduleWhatsAppReconnect(`disconnected: ${reason || 'unknown'}`);
  });

  instance.on('message', message => {
    storeWhatsAppMessage(message, 'whatsapp-second').catch(error => {
      console.warn('No se pudo guardar mensaje entrante secundario:', error.message);
    });
  });

  instance.on('message_create', message => {
    storeWhatsAppMessage(message, 'whatsapp-second').catch(error => {
      console.warn('No se pudo guardar mensaje creado secundario:', error.message);
    });
  });
}

async function initializeWhatsAppClient() {
  client = createWhatsAppClient();
  attachWhatsAppEvents(client);

  try {
    await client.initialize();
  } catch (error) {
    markWhatsAppState('INIT_ERROR', false);
    whatsappLastError = error.message;
    console.error('Error iniciando WhatsApp secundario:', error);
    throw error;
  }

  return client;
}

async function restartWhatsAppClient(reason = 'manual', options = {}) {
  if (whatsappRestarting) {
    return getWhatsAppStatus();
  }

  whatsappRestarting = true;
  if (whatsappReconnectTimer) {
    clearTimeout(whatsappReconnectTimer);
    whatsappReconnectTimer = null;
  }
  markWhatsAppState(options.resetAuth ? 'RESETTING_AUTH' : 'RESTARTING', false);
  whatsappLastError = null;
  clearWhatsAppQr();
  console.log(`Reiniciando WhatsApp secundario (${reason})`);

  const oldClient = client;
  client = null;

  if (oldClient) {
    try {
      await oldClient.destroy();
    } catch (error) {
      console.warn('No se pudo cerrar cliente WhatsApp secundario anterior:', error.message);
    }
  }

  try {
    if (options.resetAuth) {
      removeWhatsAppAuthSession();
      console.log('Sesion local secundaria de WhatsApp eliminada');
    }

    initializeWhatsAppClient().catch(() => { });
    return getWhatsAppStatus();
  } finally {
    whatsappRestarting = false;
  }
}

function isTransientWhatsAppError(error) {
  if (error && error.code === 'WHATSAPP_TRANSIENT') {
    return true;
  }

  const message = String(error && error.message || error || '').toLowerCase();

  return message.includes('attempted to use detached frame') ||
    message.includes('detached frame') ||
    message.includes('frame was detached') ||
    message.includes('execution context was destroyed') ||
    message.includes('target closed') ||
    message.includes('session closed') ||
    message.includes('page crashed') ||
    message.includes('browser has disconnected') ||
    message.includes('most likely the page has been closed') ||
    message.includes('protocol error') ||
    message.includes('todavia no esta conectado');
}

function createTransientWhatsAppError(error) {
  const detail = String(error && error.message || error || '').trim();
  const nextError = new Error(detail
    ? `WhatsApp secundario se recargo durante el envio. Reintentando cuando vuelva a conectar. Detalle: ${detail}`
    : 'WhatsApp secundario se recargo durante el envio. Reintentando cuando vuelva a conectar.');

  nextError.code = 'WHATSAPP_TRANSIENT';
  nextError.cause = error;
  return nextError;
}

function isUnconfirmedWhatsAppSendError(error) {
  return Boolean(error && error.code === 'WHATSAPP_SEND_UNCONFIRMED');
}

function createUnconfirmedWhatsAppSendError(error) {
  const detail = String(error && error.message || error || '').trim();
  const nextError = new Error(detail
    ? `Envio no confirmado por WhatsApp Web. Revisar el chat antes de reintentar. Detalle: ${detail}`
    : 'Envio no confirmado por WhatsApp Web. Revisar el chat antes de reintentar.');

  nextError.code = 'WHATSAPP_SEND_UNCONFIRMED';
  nextError.cause = error;
  return nextError;
}

function withTimeout(promise, timeoutMs, createError) {
  let timeoutId;
  const timeout = new Promise((resolve, reject) => {
    timeoutId = setTimeout(() => {
      reject(createError());
    }, timeoutMs);
  });

  return Promise.race([
    promise.finally(() => clearTimeout(timeoutId)),
    timeout
  ]);
}

async function getWhatsAppStatus() {
  if (client) {
    try {
      const state = await client.getState();

      if (state) {
        markWhatsAppState(state, state === 'CONNECTED');
      }
    } catch (error) {
      whatsappLastError = error.message;
    }
  }

  return {
    ready: whatsappReady,
    state: whatsappState,
    clientId: whatsappClientId,
    lastEventAt: whatsappLastEventAt,
    lastError: whatsappLastError,
    qr: whatsappReady ? null : whatsappQr,
    qrText: whatsappReady ? null : whatsappQrText,
    qrSvg: whatsappReady ? null : whatsappQrSvg
  };
}

function normalizeOutgoingMedia(input) {
  if (!input) {
    return null;
  }

  let mimetype = String(input.mimetype || input.mime || input.mediaMime || '').trim();
  let data = String(input.data || input.base64 || '').trim();
  const dataUrlMatch = data.match(/^data:([^;]+);base64,(.*)$/);

  if (dataUrlMatch) {
    mimetype = mimetype || dataUrlMatch[1];
    data = dataUrlMatch[2];
  }

  data = data.replace(/\s/g, '');

  if (!mimetype || !data) {
    throw new Error('Faltan datos del archivo');
  }

  if (!/^[A-Za-z0-9+/=]+$/.test(data)) {
    throw new Error('El archivo no esta en base64 valido');
  }

  const mediaBytes = Buffer.byteLength(data, 'base64');

  if (mediaBytes > maxStoredMediaBytes) {
    throw new Error(`El archivo supera el limite de ${Math.round(maxStoredMediaBytes / 1024 / 1024)} MB`);
  }

  return {
    mimetype,
    data,
    filename: path.basename(String(input.filename || input.name || 'archivo').trim()).slice(0, 180)
  };
}

async function resolveChatId(target) {
  const cleanTarget = String(target || '').trim();

  if (isDirectChatId(cleanTarget)) {
    return cleanTarget;
  }

  const cleanPhone = normalizeChatPhone(cleanTarget);

  if (!cleanPhone) {
    throw new Error('Falta telefono o chat');
  }

  const numberId = await client.getNumberId(cleanPhone);

  if (!numberId) {
    throw new Error('El numero no existe en WhatsApp o no se pudo resolver');
  }

  const serialized = String(numberId._serialized || '').trim();

  if (/@lid$/i.test(serialized)) {
    return `${cleanPhone}@c.us`;
  }

  return serialized || `${cleanPhone}@c.us`;
}

async function getWhatsAppContactInfoByChatId(chatId) {
  const cleanChatId = String(chatId || '').trim();

  if (!client || !cleanChatId) {
    return {};
  }

  try {
    const contact = await client.getContactById(cleanChatId);
    const contactName = contact
      ? contact.pushname || contact.name || contact.shortName || contact.verifiedName || ''
      : '';

    return {
      chatId: cleanChatId,
      phone: getContactPhone(contact, cleanChatId) || normalizeChatPhone(cleanChatId),
      contactName
    };
  } catch (error) {
    return {
      chatId: cleanChatId,
      phone: normalizeChatPhone(cleanChatId),
      contactName: ''
    };
  }
}

async function getOptionalWhatsAppContactInfoByChatId(chatId) {
  const timeoutMs = Math.min(10000, whatsappSendTimeoutMs);

  try {
    return await withTimeout(
      getWhatsAppContactInfoByChatId(chatId),
      timeoutMs,
      () => new Error(`No se pudo obtener el contacto en ${Math.round(timeoutMs / 1000)} segundos`)
    );
  } catch (error) {
    console.warn('No se pudo obtener info del contacto antes de enviar:', error.message);
    return {};
  }
}

async function resolveWhatsAppContact(target) {
  await getWhatsAppStatus();

  if (!client || !whatsappReady) {
    throw new Error(`WhatsApp secundario todavia no esta conectado (${whatsappState})`);
  }

  const chatId = await withTimeout(
    resolveChatId(target),
    whatsappSendTimeoutMs,
    () => createTransientWhatsAppError(new Error(`No se pudo resolver el contacto en ${Math.round(whatsappSendTimeoutMs / 1000)} segundos`))
  );
  const contact = await withTimeout(
    getWhatsAppContactInfoByChatId(chatId),
    whatsappSendTimeoutMs,
    () => createTransientWhatsAppError(new Error(`No se pudo obtener el contacto en ${Math.round(whatsappSendTimeoutMs / 1000)} segundos`))
  );

  return {
    chatId,
    phone: contact.phone || normalizeChatPhone(chatId),
    contactName: contact.contactName || ''
  };
}

async function sendWhatsApp(target, message, mediaInput, source = 'second-app', options = {}) {
  await getWhatsAppStatus();

  if (!client || !whatsappReady) {
    throw new Error(`WhatsApp secundario todavia no esta conectado (${whatsappState})`);
  }

  const cleanMessage = String(message || '').trim();
  const media = normalizeOutgoingMedia(mediaInput);

  if (!cleanMessage && !media) {
    throw new Error('Falta mensaje o archivo');
  }

  let chatId;
  let sentMessage;
  let contactInfo = {};

  try {
    chatId = await withTimeout(
      resolveChatId(target),
      whatsappSendTimeoutMs,
      () => createTransientWhatsAppError(new Error(`No se pudo resolver el chat en ${Math.round(whatsappSendTimeoutMs / 1000)} segundos`))
    );
    contactInfo = await getOptionalWhatsAppContactInfoByChatId(chatId);
  } catch (error) {
    if (isTransientWhatsAppError(error)) {
      whatsappLastError = String(error.message || error);
      markWhatsAppState('SESSION_REFRESHING', false);
      restartWhatsAppClient('transient-resolve-error').catch(restartError => {
        console.warn('No se pudo reiniciar WhatsApp secundario tras error resolviendo chat:', restartError.message);
      });
      throw error;
    }

    throw error;
  }

  try {
    if (media) {
      const messageMedia = new MessageMedia(media.mimetype, media.data, media.filename);
      sentMessage = await withTimeout(
        client.sendMessage(chatId, messageMedia, cleanMessage ? { caption: cleanMessage } : {}),
        whatsappSendTimeoutMs,
        () => createUnconfirmedWhatsAppSendError(new Error(`Timeout de confirmacion de envio (${Math.round(whatsappSendTimeoutMs / 1000)} segundos)`))
      );
    } else {
      sentMessage = await withTimeout(
        client.sendMessage(chatId, cleanMessage),
        whatsappSendTimeoutMs,
        () => createUnconfirmedWhatsAppSendError(new Error(`Timeout de confirmacion de envio (${Math.round(whatsappSendTimeoutMs / 1000)} segundos)`))
      );
    }
  } catch (error) {
    if (isTransientWhatsAppError(error) || isUnconfirmedWhatsAppSendError(error)) {
      whatsappLastError = String(error.message || error);
      markWhatsAppState('SESSION_REFRESHING', false);
      restartWhatsAppClient('unconfirmed-send-error').catch(restartError => {
        console.warn('No se pudo reiniciar WhatsApp secundario tras envio no confirmado:', restartError.message);
      });
      throw isUnconfirmedWhatsAppSendError(error)
        ? error
        : createUnconfirmedWhatsAppSendError(error);
    }

    throw error;
  }

  const cleanPhone = normalizeChatPhone(target || chatId);
  const body = cleanMessage || `[${getMediaLabel(media && media.mimetype, 'archivo')} sin texto]`;

  const savedMessage = await saveWhatsAppMessage({
    id: getStoredMessageId(sentMessage, chatId, 'outgoing'),
    chatId,
    phone: cleanPhone || normalizeChatPhone(chatId),
    contactName: String(options.contactName || contactInfo.contactName || '').trim(),
    direction: 'outgoing',
    body,
    mediaMime: media && media.mimetype,
    mediaData: media && media.data,
    mediaFilename: media && media.filename,
    timestampTs: getWhatsAppTimestampMs(sentMessage && sentMessage.timestamp),
    fromMe: true,
    ack: sentMessage && sentMessage.ack,
    source,
    ownerUsername: options.ownerUsername
  });

  return {
    chatId,
    message: savedMessage
  };
}

async function getDatabaseStatus() {
  const mysqlSettings = getMysqlSettings();

  try {
    await pingDatabase();

    return {
      ready: true,
      host: mysqlSettings.host,
      port: mysqlSettings.port,
      database: mysqlSettings.database,
      table: mysqlSettings.messagesTable,
      queueTable: mysqlSettings.queueTable,
      lastError: null
    };
  } catch (error) {
    return {
      ready: false,
      host: mysqlSettings.host,
      port: mysqlSettings.port,
      database: mysqlSettings.database,
      table: mysqlSettings.messagesTable,
      queueTable: mysqlSettings.queueTable,
      lastError: error.message
    };
  }
}

function getNextMessageQueueRunIso() {
  return new Date(Date.now() + messageQueueIntervalMinutes * 60 * 1000).toISOString();
}

async function processSecondMessageQueue() {
  if (messageQueueRunning) {
    return { skipped: true, reason: 'queue-running' };
  }

  messageQueueRunning = true;
  messageQueueState.runCount += 1;
  messageQueueState.lastRunStartedAt = nowIso();
  const unresolvedItemIds = new Set();
  let staleErrors = 0;

  try {
    staleErrors = await markStaleMessageQueueErrors();
    await getWhatsAppStatus();

    if (!client || !whatsappReady) {
      const result = {
        skipped: true,
        waiting: true,
        reason: `WhatsApp secundario no conectado (${whatsappState})`,
        staleErrors,
        stats: await getMessageQueueStats().catch(() => null)
      };
      messageQueueState.lastResult = result;
      messageQueueState.lastError = null;
      return result;
    }

    const items = await claimPendingMessageQueue(messageQueueBatchSize);
    let sent = 0;
    let errors = 0;
    items.forEach(item => unresolvedItemIds.add(Number(item.id)));

    for (let index = 0; index < items.length; index += 1) {
      const item = items[index];
      const template = getNextSecondMessageTemplate();
      const body = renderStringTemplate(template.template, item.variables || {}).trim();

      if (!body) {
        await markMessageQueueError(item.id, 'El template genero un mensaje vacio');
        unresolvedItemIds.delete(Number(item.id));
        errors += 1;
        continue;
      }

      try {
        const target = normalizeSecondQueuePhone(item.target) || item.target;
        await sendWhatsApp(target, body, null, item.source || 'second-queue', {
          contactName: item.variables && (
            item.variables.razon_social ||
            item.variables.razonSocial ||
            item.variables.cliente
          ),
          ownerUsername: item.owner_username
        });
        await markMessageQueueSent(item.id, body, template.index);
        unresolvedItemIds.delete(Number(item.id));
        sent += 1;
      } catch (error) {
        if (isTransientWhatsAppError(error)) {
          await releaseMessageQueueItem(item.id, error.message);
          unresolvedItemIds.delete(Number(item.id));

          for (const remaining of items.slice(index + 1)) {
            await releaseMessageQueueItem(remaining.id, error.message);
            unresolvedItemIds.delete(Number(remaining.id));
          }

          break;
        }

        await markMessageQueueError(item.id, error.message);
        unresolvedItemIds.delete(Number(item.id));
        errors += 1;
      }
    }

    const result = {
      skipped: false,
      staleErrors,
      claimed: items.length,
      sent,
      errors,
      stats: await getMessageQueueStats().catch(() => null)
    };
    messageQueueState.lastResult = result;
    messageQueueState.lastError = null;
    return result;
  } catch (error) {
    messageQueueState.lastError = {
      message: error.message,
      at: nowIso()
    };

    for (const id of unresolvedItemIds) {
      await markMessageQueueError(id, `Error inesperado en cola: ${error.message}`).catch(() => { });
    }

    throw error;
  } finally {
    messageQueueState.lastRunFinishedAt = nowIso();
    messageQueueState.nextRunAt = getNextMessageQueueRunIso();
    messageQueueRunning = false;
  }
}

function startSecondMessageQueueScheduler() {
  messageQueueState.active = true;
  messageQueueState.startedAt = nowIso();
  messageQueueState.nextRunAt = getNextMessageQueueRunIso();

  const timer = setInterval(() => {
    messageQueueState.nextRunAt = getNextMessageQueueRunIso();
    processSecondMessageQueue().catch(error => {
      console.error('Error en cola de mensajes secundaria:', error);
    });
  }, messageQueueIntervalMinutes * 60 * 1000);

  console.log(`Cola de mensajes secundaria activa cada ${messageQueueIntervalMinutes} minutos.`);
  return timer;
}

function buildPhantomUrl(baseUrl, params = {}) {
  const url = new URL(baseUrl);

  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null && value !== '') {
      url.searchParams.set(key, String(value));
    }
  }

  return url.toString();
}

function normalizePhantomQueryValue(value) {
  const text = String(value === undefined || value === null ? '' : value).trim();

  if (!/%[0-9a-f]{2}/i.test(text)) {
    return text;
  }

  try {
    return decodeURIComponent(text);
  } catch (error) {
    return text;
  }
}

function getPhantomHeaders(extraHeaders = {}) {
  let configuredHeaders = {};

  if (process.env.PHANTOM_API_HEADERS) {
    try {
      const parsed = JSON.parse(process.env.PHANTOM_API_HEADERS);
      configuredHeaders = parsed && typeof parsed === 'object' && !Array.isArray(parsed)
        ? parsed
        : {};
    } catch (error) {
      console.warn('PHANTOM_API_HEADERS no es JSON valido. Se ignora.');
    }
  }

  return {
    ...configuredHeaders,
    ...extraHeaders
  };
}

function stripPhantomBom(value) {
  return String(value === undefined || value === null ? '' : value)
    .replace(/^(?:\uFEFF|\u00EF\u00BB\u00BF|\u00C3\u00AF\u00C2\u00BB\u00C2\u00BF)/, '')
    .trim();
}

function parsePhantomPayload(text) {
  const cleanText = stripPhantomBom(text);

  if (!cleanText) {
    return null;
  }

  try {
    let parsed = JSON.parse(cleanText);

    for (let index = 0; index < 2 && typeof parsed === 'string'; index += 1) {
      const nested = stripPhantomBom(parsed);

      if (!nested || !/^[\[{]/.test(nested)) {
        break;
      }

      parsed = JSON.parse(nested);
    }

    return parsed;
  } catch (error) {
    return cleanText;
  }
}

function extractPhantomToken(text) {
  const cleanText = stripPhantomBom(text);

  if (!cleanText) {
    return '';
  }

  const parsed = parsePhantomPayload(cleanText);

  if (typeof parsed === 'string') {
    return stripPhantomBom(parsed.replace(/^"|"$/g, ''));
  }

  if (parsed && typeof parsed === 'object') {
    const candidates = [
      parsed.token,
      parsed.Token,
      parsed.access_token,
      parsed.accessToken,
      parsed.data && parsed.data.token,
      parsed.data && parsed.data.Token,
      parsed.result && parsed.result.token,
      parsed.resultado && parsed.resultado.token
    ];
    const token = candidates.find(value => value !== undefined && value !== null && String(value).trim() !== '');
    return token === undefined ? '' : stripPhantomBom(token);
  }

  return cleanText;
}

function extractPhantomTokenFromHeaders(headers) {
  if (!headers || typeof headers.get !== 'function') {
    return '';
  }

  const candidates = [
    headers.get('token'),
    headers.get('x-token'),
    headers.get('x-auth-token'),
    headers.get('authorization')
  ];

  for (const candidate of candidates) {
    const token = extractPhantomToken(String(candidate || '').replace(/^Bearer\s+/i, ''));

    if (token) {
      return token;
    }
  }

  const setCookie = headers.get('set-cookie') || '';
  const cookieMatch = setCookie.match(/(?:^|[;,\s])(?:token|phantom_token|auth_token)=([^;,\s]+)/i);
  return cookieMatch ? stripPhantomBom(cookieMatch[1]) : '';
}

function formatPhantomError(status, text) {
  const payload = parsePhantomPayload(text);
  const detail = payload && typeof payload === 'object'
    ? payload.error || payload.message || payload.msg || JSON.stringify(payload)
    : String(payload || '').trim();

  return detail ? `HTTP ${status}: ${detail}` : `HTTP ${status}`;
}

function extractPhantomRows(payload) {
  if (Array.isArray(payload)) {
    return payload;
  }

  if (!payload || typeof payload !== 'object') {
    return payload === undefined || payload === null ? [] : [{ value: payload }];
  }

  const candidates = [
    payload.abonados,
    payload.Abonados,
    payload.data,
    payload.datos,
    payload.Datos,
    payload.results,
    payload.resultados,
    payload.items,
    payload.records,
    payload.list,
    payload.lista,
    payload.result,
    payload.Result,
    payload.response,
    payload.respuesta
  ];

  return candidates.find(Array.isArray) || [payload];
}

function getFirstPhantomValue(row, keys, fallback = '') {
  if (!row || typeof row !== 'object' || Array.isArray(row)) {
    return fallback;
  }

  for (const key of keys) {
    if (row[key] !== undefined && row[key] !== null && row[key] !== '') {
      return row[key];
    }
  }

  return fallback;
}

function formatPhantomDateOnly(value) {
  const text = String(value === undefined || value === null ? '' : value).trim();

  if (!text) {
    return '';
  }

  const match = text.match(/^(\d{4})-(\d{2})-(\d{2})(?:[ T]\d{2}:\d{2}:\d{2})?/);

  if (match) {
    return `${match[3]}/${match[2]}/${match[1]}`;
  }

  return text;
}

function invertPhantomSign(value) {
  if (value === undefined || value === null || value === '') {
    return '';
  }

  if (typeof value === 'number') {
    return Number.isFinite(value) ? -value : value;
  }

  const text = String(value).trim();

  if (!text) {
    return '';
  }

  if (/^-?\s*0+(?:[,.]0+)?$/.test(text)) {
    return text.replace(/^-\s*/, '');
  }

  if (/^-\s*/.test(text)) {
    return text.replace(/^-\s*/, '');
  }

  if (/^\+\s*/.test(text)) {
    return '-' + text.replace(/^\+\s*/, '');
  }

  return '-' + text;
}

function parseDecimalValue(value) {
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : 0;
  }

  const text = String(value === undefined || value === null ? '' : value).trim();

  if (!text) {
    return 0;
  }

  const clean = text.replace(/\s/g, '').replace(/[$%]/g, '');

  if (/^-?\d{1,3}(\.\d{3})*(,\d+)?$/.test(clean)) {
    return Number(clean.replace(/\./g, '').replace(',', '.')) || 0;
  }

  if (/^-?\d+([.,]\d+)?$/.test(clean)) {
    return Number(clean.replace(',', '.')) || 0;
  }

  return Number(clean) || 0;
}

function hasDebtOrOverdueReceipts(row = {}) {
  return parseDecimalValue(row.deuda) !== 0 ||
    parseDecimalValue(row.comprobantesAdeudados) !== 0;
}

function getFirstPhoneCandidate(value) {
  return String(value || '')
    .split(';')
    .map(item => item.trim())
    .find(Boolean) || '';
}

function normalizeSecondQueuePhone(value) {
  if (isDirectChatId(value)) {
    return String(value || '').trim();
  }

  let phone = normalizeChatPhone(getFirstPhoneCandidate(value));

  if (!phone) {
    return '';
  }

  phone = phone.replace(/^00+/, '');

  if (phone.startsWith('549')) {
    return /^549\d{8,12}$/.test(phone) ? phone : '';
  }

  if (phone.startsWith('54')) {
    return '549' + phone.slice(2);
  }

  if (phone.startsWith('0')) {
    phone = phone.replace(/^0+/, '');
  }

  if (phone.startsWith('15') && phone.length >= 10) {
    phone = phone.slice(2);
  }

  const normalized = '549' + phone;

  return /^549\d{8,12}$/.test(normalized) ? normalized : '';
}

function isValidSecondQueueTarget(value) {
  const target = String(value || '').trim();
  return isDirectChatId(target) || /^549\d{8,12}$/.test(target);
}

function normalizePhantomEstado(value, fallback = 'Suspendido') {
  const estado = String(value || '').trim();
  return estado || fallback;
}

function formatPhantomClientRows(rows, options = {}) {
  const formattedRows = rows.map(row => {
    const razonFallback = [row && row.Apellido, row && row.Nombre].filter(Boolean).join(' ');
    const balance = getFirstPhantomValue(row, ['Balance_CC', 'BalanceCC', 'Balance', 'balance', 'Saldo', 'SaldoCC', 'SaldoCuentaCorriente']);
    const fechaUltimaFactura = formatPhantomDateOnly(getFirstPhantomValue(row, ['Fecha_Ultima_Factura']));
    const fechaUltimoCambio = formatPhantomDateOnly(getFirstPhantomValue(row, ['Fecha_Ultimo_Cambio', 'fechaUltimoCambio', 'fecha_ultimo_cambio']));
    const fechaInstalacion = formatPhantomDateOnly(getFirstPhantomValue(row, ['Fecha_Instalacion', 'fechaInstalacion', 'fecha_instalacion']));

    return {
      id: getFirstPhantomValue(row, ['ID', 'Id', 'id', 'IDA', 'ida', 'ClienteID', 'Cliente_Id', 'Codigo', 'CodigoCliente']),
      razonSocial: getFirstPhantomValue(row, ['RS', 'RazonSocial', 'Razon_Social', 'Razon Social', 'Razon', 'razon_social'], razonFallback),
      deuda: invertPhantomSign(balance),
      estado: getFirstPhantomValue(row, ['Estado', 'estado']),
      movil: getFirstPhantomValue(row, ['Movil', 'Móvil', 'movil', 'Celular', 'celular', 'Mobile', 'TelefonoMovil', 'TelMovil', 'Movi', 'movi']),
      telefono: getFirstPhantomValue(row, ['Telefono', 'Teléfono', 'telefono', 'Tel', 'tel', 'Telefono1', 'Telefono_1']),
      fechaUltimaFactura,
      fechaUltimoCambio,
      fechaInstalacion,
      comprobantesAdeudados: getFirstPhantomValue(row, ['C_Comprobantes_Adeudados', 'Fecha_Ultimo_Mov', 'CompAdeudados', 'ComprobantesAdeudados', 'Comprobantes_Adeudados', 'compAdeudados', 'comp_adeudados', 'Adeudados']),
      raw: row
    };
  });

  return options.filterDebt === false
    ? formattedRows
    : formattedRows.filter(hasDebtOrOverdueReceipts);
}

function createMessageVariablesFromRow(row = {}) {
  const id = getFirstPhantomValue(row, ['id', 'ID', 'Id', 'IDA', 'ida', 'ClienteID', 'Cliente_Id', 'Codigo', 'CodigoCliente']);
  const razonSocial = getFirstPhantomValue(row, ['razonSocial', 'razon_social', 'RS', 'RazonSocial', 'Razon_Social', 'Razon Social', 'Razon']);
  const deuda = getFirstPhantomValue(row, ['deuda', 'balance', 'Balance_CC', 'Balance', 'Saldo']);
  const estado = getFirstPhantomValue(row, ['estado', 'Estado']);
  const movil = getFirstPhantomValue(row, ['movil', 'Movil', 'Móvil', 'Celular', 'celular', 'Mobile', 'TelefonoMovil', 'TelMovil', 'Movi', 'movi']);
  const telefono = getFirstPhantomValue(row, ['telefono', 'Telefono', 'Teléfono', 'Tel', 'tel', 'Telefono1', 'Telefono_1']);
  const comprobantesAdeudados = getFirstPhantomValue(row, ['comprobantesAdeudados', 'C_Comprobantes_Adeudados', 'Fecha_Ultimo_Mov', 'ComprobantesAdeudados', 'Comprobantes_Adeudados']);
  const normalizedMovil = normalizeSecondQueuePhone(movil);
  const normalizedTelefono = normalizeSecondQueuePhone(telefono);
  const fechaUltimaFactura = formatPhantomDateOnly(getFirstPhantomValue(row, ['fechaUltimaFactura', 'fecha_ultima_factura', 'Fecha_Ultima_Factura']));
  const fechaUltimoCambio = formatPhantomDateOnly(getFirstPhantomValue(row, ['fechaUltimoCambio', 'fecha_ultimo_cambio', 'Fecha_Ultimo_Cambio']));
  const fechaInstalacion = formatPhantomDateOnly(getFirstPhantomValue(row, ['fechaInstalacion', 'fecha_instalacion', 'Fecha_Instalacion']));

  return {
    id,
    razon_social: razonSocial,
    razonSocial,
    cliente: razonSocial,
    deuda,
    estado,
    movil: normalizedMovil || movil,
    movil_raw: movil,
    telefono: normalizedTelefono || telefono,
    telefono_raw: telefono,
    fecha_ultima_factura: fechaUltimaFactura,
    fechaUltimaFactura,
    fecha_ultimo_cambio: fechaUltimoCambio,
    fechaUltimoCambio,
    fecha_instalacion: fechaInstalacion,
    fechaInstalacion,
    comprobantes_adeudados: comprobantesAdeudados,
    comprobantesAdeudados
  };
}

function getQueueTargetFromVariables(variables = {}) {
  return String(
    variables.movil ||
    variables.telefono ||
    variables.phone ||
    variables.target ||
    ''
  ).trim();
}

function createQueueItemFromRow(row = {}) {
  const variables = createMessageVariablesFromRow(row);
  const target = normalizeSecondQueuePhone(getQueueTargetFromVariables(variables));
  const id = String(variables.id || '').trim();
  const queueKey = id
    ? `phantom:${id}`
    : `phantom:${normalizeChatPhone(target) || target}`;

  return {
    queueKey,
    target,
    phone: normalizeChatPhone(target),
    source: 'second-phantom',
    variables
  };
}

function getPhantomCredentials() {
    const baseUrl = String(process.env.PHANTOM_API_URL || '').trim();
    const apiUser = normalizePhantomQueryValue(process.env.PHANTOM_API_USER);
    const apiPass = normalizePhantomQueryValue(process.env.PHANTOM_API_PASS);

    if (!baseUrl || !apiUser || !apiPass) {
      throw new Error('Faltan PHANTOM_API_URL, PHANTOM_API_USER o PHANTOM_API_PASS');
    }

  return { baseUrl, apiUser, apiPass };
}

async function createPhantomToken() {
  const { baseUrl, apiUser, apiPass } = getPhantomCredentials();

    const authUrl = buildPhantomUrl(baseUrl, {
      action: 'autentificar',
      api_user: apiUser,
      api_pass: apiPass
    });
    const authResponse = await fetch(authUrl, {
      method: 'POST',
      headers: getPhantomHeaders()
    });

    const authText = await authResponse.text();

    if (!authResponse.ok) {
      throw new Error(`Error autenticando Phantom: ${formatPhantomError(authResponse.status, authText)}`);
    }

    const token = extractPhantomToken(authText) || extractPhantomTokenFromHeaders(authResponse.headers);

    if (!token) {
      const authPreview = stripPhantomBom(authText).slice(0, 180);
      throw new Error(`Phantom no devolvio token. Auth HTTP ${authResponse.status}; body ${authPreview ? `"${authPreview}"` : 'vacio'}`);
    }

  return { baseUrl, token };
}

async function fetchPhantomConsultaMasivaRows(options = {}) {
    const { baseUrl, token } = await createPhantomToken();
    const idDesde = parsePositiveInteger(process.env.PHANTOM_CONSULTA_ID_DESDE, 1);
    const idHasta = parsePositiveInteger(process.env.PHANTOM_CONSULTA_ID_HASTA, 999999999);
    const desc = parsePositiveInteger(process.env.PHANTOM_CONSULTA_DESC, 1);
    const defaultLimit = parsePositiveInteger(process.env.PHANTOM_CONSULTA_LIMIT, 10);
  const requestedLimit = parsePositiveInteger(options.limit, defaultLimit);
    const limit = Math.min(requestedLimit, 500);
  const requestedOffset = options.offset;
  const requestedPage = parsePositiveInteger(options.page, 0);
    const offset = requestedOffset !== undefined
      ? parseNonNegativeInteger(requestedOffset, 0)
      : requestedPage
        ? (requestedPage - 1) * limit
        : parseNonNegativeInteger(process.env.PHANTOM_CONSULTA_OFFSET, 0);
    const balanceCC = parsePositiveInteger(process.env.PHANTOM_CONSULTA_BALANCE_CC, 1);
    const compAdeudados = parsePositiveInteger(process.env.PHANTOM_CONSULTA_COMP_ADEUDADOS, 1);
    const estado = normalizePhantomEstado(
    options.estado,
      process.env.PHANTOM_CONSULTA_ESTADO || 'Suspendido'
    );
    const consultaUrl = buildPhantomUrl(baseUrl, {
      action: 'Consulta_Masiva_Datos',
      JSON: 1,
      Desc: desc,
      Limit: limit,
      Offset: offset,
      BalanceCC: balanceCC,
      CompAdeudados: compAdeudados,
      Estado: estado
    });
    const consultaResponse = await fetch(consultaUrl, {
      method: 'POST',
      headers: getPhantomHeaders({
        Accept: 'application/json',
        'Content-Type': 'application/json'
      }),
      body: JSON.stringify({
        token,
        ID_Desde: idDesde,
        ID_Hasta: idHasta
      })
    });

    const consultaText = await consultaResponse.text();

    if (!consultaResponse.ok) {
      throw new Error(`Error consultando Phantom: ${formatPhantomError(consultaResponse.status, consultaText)}`);
    }

    const payload = parsePhantomPayload(consultaText);
    const phantomCode = payload && typeof payload === 'object' ? Number(payload.code) : NaN;

    if (Number.isFinite(phantomCode) && phantomCode >= 400) {
      throw new Error(`Error consultando Phantom: ${payload.message || payload.error || payload.msg || `code ${payload.code}`}`);
    }

    const rawRows = extractPhantomRows(payload);
    const shouldFilterDebt = estado.toLowerCase() !== 'baja';
    const rows = formatPhantomClientRows(rawRows, {
      filterDebt: shouldFilterDebt
    });

  return {
    rows,
    rawRows,
    estado,
    pagination: {
      limit,
      offset,
      page: Math.floor(offset / limit) + 1,
      returned: rows.length,
      rawReturned: rawRows.length,
      hasNextPage: rawRows.length === limit
    }
  };
}

async function handlePhantomConsultaMasiva(req, res) {
  try {
    const requestBody = req.body && typeof req.body === 'object' ? req.body : {};
    const estado = normalizePhantomEstado(
      req.query.estado ?? requestBody.estado,
      process.env.PHANTOM_CONSULTA_ESTADO || 'Suspendido'
    );
    const requestedLimit = req.query.limit ?? requestBody.limit;
    const requestedOffset = req.query.offset ?? requestBody.offset;
    const requestedPage = req.query.page ?? requestBody.page;
    const sortKey = req.query.sortKey ?? requestBody.sortKey;
    const sortDirection = req.query.sortDirection ?? requestBody.sortDirection;

    if (estado.toLowerCase() === 'baja') {
      const defaultLimit = parsePositiveInteger(process.env.PHANTOM_CONSULTA_LIMIT, 10);
      const limit = Math.min(parsePositiveInteger(requestedLimit, defaultLimit), 500);
      const page = parsePositiveInteger(requestedPage, 0);
      const offset = requestedOffset !== undefined
        ? parseNonNegativeInteger(requestedOffset, 0)
        : page
          ? (page - 1) * limit
          : 0;
      const result = await listPhantomBajaClients({
        limit,
        offset,
        sortKey,
        sortDirection
      });
      const syncStatus = await getPhantomBajaSyncStatus().catch(() => null);

      return res.json({
        success: true,
        rows: result.rows,
        pagination: {
          limit: result.limit,
          offset: result.offset,
          page: Math.floor(result.offset / result.limit) + 1,
          returned: result.rows.length,
          total: result.total,
          hasNextPage: result.hasNextPage
        },
        estado,
        source: 'db',
        sync: {
          ...phantomBajaSyncState,
          database: syncStatus
        },
        receivedAt: new Date().toISOString()
      });
    }

    const result = await fetchPhantomConsultaMasivaRows({
      estado,
      limit: requestedLimit,
      offset: requestedOffset,
      page: requestedPage
    });

    res.json({
      success: true,
      rows: result.rows,
      pagination: result.pagination,
      estado: result.estado,
      source: 'phantom',
      receivedAt: new Date().toISOString()
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
}

async function handleCheckWhatsAppNumber(req, res) {
  try {
    await getWhatsAppStatus();

    if (!client || !whatsappReady) {
      return res.status(503).json({
        success: false,
        error: `WhatsApp secundario todavia no esta conectado (${whatsappState})`
      });
    }

    const rawTarget = String(req.query.phone || req.query.target || '').trim();
    const target = normalizeSecondQueuePhone(rawTarget) || rawTarget;

    if (!target) {
      return res.status(400).json({
        success: false,
        error: 'Falta telefono'
      });
    }

    const chatId = isDirectChatId(target)
      ? target
      : await withTimeout(
        client.getNumberId(normalizeChatPhone(target)),
        Math.min(whatsappSendTimeoutMs, 20000),
        () => createTransientWhatsAppError(new Error('Timeout verificando numero en WhatsApp'))
      );
    const serialized = chatId && typeof chatId === 'object'
      ? String(chatId._serialized || '').trim()
      : String(chatId || '').trim();

    res.json({
      success: true,
      exists: Boolean(serialized),
      phone: normalizeChatPhone(target),
      chatId: serialized
    });
  } catch (error) {
    const status = isTransientWhatsAppError(error) ? 503 : 400;
    res.status(status).json({
      success: false,
      error: error.message
    });
  }
}

function getNextPhantomBajaSyncDate(fromDate = new Date()) {
  const next = new Date(fromDate);
  next.setHours(phantomBajaSyncHour, phantomBajaSyncMinute, 0, 0);

  if (next <= fromDate) {
    next.setDate(next.getDate() + 1);
  }

  return next;
}

async function syncPhantomBajaClients(reason = 'scheduled') {
  if (phantomBajaSyncRunning) {
    return {
      skipped: true,
      reason: 'sync-running'
    };
  }

  phantomBajaSyncRunning = true;
  phantomBajaSyncState.running = true;
  phantomBajaSyncState.lastRunStartedAt = nowIso();
  phantomBajaSyncState.lastError = null;
  console.log(`[PHANTOM BAJA] Sincronizando clientes baja (${reason})`);

  const startedAt = new Date();
  const allRows = [];
  let offset = 0;
  let page = 1;

  try {
    while (true) {
      const result = await fetchPhantomConsultaMasivaRows({
        estado: 'Baja',
        limit: phantomBajaSyncLimit,
        offset
      });
      allRows.push(...result.rows);

      if (!result.pagination.hasNextPage) {
        break;
      }

      offset += result.pagination.limit;
      page += 1;

      if (page > 10000) {
        throw new Error('Corte de seguridad: demasiadas paginas sincronizando Baja');
      }
    }

    const saved = await replacePhantomBajaClients(allRows, startedAt);
    const result = {
      skipped: false,
      reason,
      saved,
      pages: page,
      finishedAt: nowIso()
    };

    phantomBajaSyncState.lastResult = result;
    phantomBajaSyncState.lastError = null;
    console.log(`[PHANTOM BAJA] Sincronizacion completa: ${saved} registros en ${page} pagina(s)`);
    return result;
  } catch (error) {
    phantomBajaSyncState.lastError = {
      message: error.message,
      at: nowIso()
    };
    console.error('[PHANTOM BAJA] Error sincronizando:', error);
    throw error;
  } finally {
    phantomBajaSyncState.lastRunFinishedAt = nowIso();
    phantomBajaSyncState.running = false;
    phantomBajaSyncRunning = false;
  }
}

function scheduleNextPhantomBajaSync() {
  const nextRun = getNextPhantomBajaSyncDate();
  const delayMs = Math.max(nextRun.getTime() - Date.now(), 1000);
  phantomBajaSyncState.nextRunAt = nextRun.toISOString();

  if (phantomBajaSyncTimer) {
    clearTimeout(phantomBajaSyncTimer);
  }

  phantomBajaSyncTimer = setTimeout(() => {
    syncPhantomBajaClients('scheduled')
      .catch(() => { })
      .finally(scheduleNextPhantomBajaSync);
  }, delayMs);
}

function startPhantomBajaSyncScheduler() {
  phantomBajaSyncState.active = true;
  scheduleNextPhantomBajaSync();
  console.log(`Sync clientes Baja activo todos los dias a las ${String(phantomBajaSyncHour).padStart(2, '0')}:${String(phantomBajaSyncMinute).padStart(2, '0')}.`);
}

function listAvailableSecondUserGroups() {
  const seen = new Set();
  const groups = [];

  for (const group of listAssignedUserGroups()) {
    const cleanGroup = String(group || '').trim();
    const key = cleanGroup.toLowerCase();

    if (cleanGroup && !seen.has(key)) {
      seen.add(key);
      groups.push(cleanGroup);
    }
  }

  return groups.sort((left, right) => left.localeCompare(right));
}

function handleListUsers(req, res) {
  res.json({
    success: true,
    roles: allowedRoles,
    groups: listAvailableSecondUserGroups(),
    users: listAppUsers()
  });
}

function handleGetUser(req, res) {
  const user = listAppUsers().find(item => String(item.id) === String(req.params.id));

  if (!user) {
    return res.status(404).json({
      success: false,
      error: 'Usuario no encontrado'
    });
  }

  return res.json({
    success: true,
    user
  });
}

function handleCreateUser(req, res) {
  try {
    res.json({
      success: true,
      user: createUser(req.body || {})
    });
  } catch (error) {
    res.status(400).json({
      success: false,
      error: error.message
    });
  }
}

function handleUpdateUser(req, res) {
  try {
    res.json({
      success: true,
      user: updateUser(req.params.id, req.body || {})
    });
  } catch (error) {
    res.status(400).json({
      success: false,
      error: error.message
    });
  }
}

function handleDeleteUser(req, res) {
  try {
    res.json({
      success: true,
      user: deleteUser(req.params.id, req.user && req.user.username)
    });
  } catch (error) {
    res.status(400).json({
      success: false,
      error: error.message
    });
  }
}

function getMessageTemplatesPayload(selectedTemplate = null) {
  const messageTemplates = getSecondMessageTemplateRecords();

  return {
    success: true,
    template: messageTemplates.map(record => record.body).join('\n---\n'),
    templates: messageTemplates.map(record => record.body),
    messageTemplates,
    selectedTemplate,
    placeholders: secondMessageTemplatePlaceholders
  };
}

function handleListMessageTemplates(req, res) {
  res.json(getMessageTemplatesPayload());
}

function handleGetMessageTemplate(req, res) {
  const template = findSecondMessageTemplate(req.params.id);

  if (!template) {
    return res.status(404).json({
      success: false,
      error: 'Template no encontrado'
    });
  }

  return res.json({
    success: true,
    template,
    placeholders: secondMessageTemplatePlaceholders
  });
}

function handleCreateMessageTemplate(req, res) {
  try {
    const template = createSecondMessageTemplate(req.body || {});
    res.status(201).json(getMessageTemplatesPayload(template));
  } catch (error) {
    res.status(400).json({
      success: false,
      error: error.message
    });
  }
}

function handleReplaceMessageTemplates(req, res) {
  try {
    setSecondMessageTemplates(req.body && (req.body.template || req.body.templates));
    res.json(getMessageTemplatesPayload());
  } catch (error) {
    res.status(400).json({
      success: false,
      error: error.message
    });
  }
}

function handleUpdateMessageTemplate(req, res) {
  try {
    const template = updateSecondMessageTemplate(req.params.id, req.body || {});
    res.json(getMessageTemplatesPayload(template));
  } catch (error) {
    const status = error.message === 'Template no encontrado' ? 404 : 400;
    res.status(status).json({
      success: false,
      error: error.message
    });
  }
}

function handleDeleteMessageTemplate(req, res) {
  try {
    const template = deleteSecondMessageTemplate(req.params.id);
    res.json(getMessageTemplatesPayload(template));
  } catch (error) {
    const status = error.message === 'Template no encontrado' ? 404 : 400;
    res.status(status).json({
      success: false,
      error: error.message
    });
  }
}

app.get('/favicon.ico', (req, res) => {
  res.status(204).end();
});

app.get('/login', redirectIfAuthenticated, (req, res) => {
  sendHtmlFile(res, 'second-login.html');
});

app.post('/auth/login', handleLogin);
app.post('/auth/logout', handleLogout);
app.get('/auth/me', requireLoggedIn, handleMe);

app.get('/usuarios', requireAdmin, (req, res) => {
  sendHtmlFile(res, 'users.html');
});

app.get('/users', requireAdmin, handleListUsers);
app.get('/users/:id', requireAdmin, handleGetUser);
app.post('/users', requireAdmin, handleCreateUser);
app.put('/users/:id', requireAdmin, handleUpdateUser);
app.delete('/users/:id', requireAdmin, handleDeleteUser);

app.get('/api/users', requireAdmin, handleListUsers);
app.get('/api/users/:id', requireAdmin, handleGetUser);
app.post('/api/users', requireAdmin, handleCreateUser);
app.put('/api/users/:id', requireAdmin, handleUpdateUser);
app.delete('/api/users/:id', requireAdmin, handleDeleteUser);

app.get('/', requireLoggedIn, (req, res) => {
  sendHtmlFile(res, 'second-messages.html');
});

app.get('/dashboard', requireLoggedIn, (req, res) => {
  sendHtmlFile(res, 'second-messages.html');
});

app.get('/mensajes', requireLoggedIn, (req, res) => {
  sendHtmlFile(res, 'second-messages.html');
});

app.get('/cola', requireLoggedIn, (req, res) => {
  sendHtmlFile(res, 'queue.html');
});

app.get('/phantom', requireLoggedIn, (req, res) => {
  res.redirect('/phantom/suspendidos');
});

app.get('/phantom/suspendidos', requireLoggedIn, (req, res) => {
  sendHtmlFile(res, 'phantom.html');
});

app.get('/phantom/baja', requireLoggedIn, (req, res) => {
  sendHtmlFile(res, 'phantom.html');
});

app.get('/api/status', requireLoggedIn, async (req, res) => {
  const staleErrors = await markStaleMessageQueueErrors().catch(() => 0);
  const ownerUsername = getScopedOwnerUsername(req.user);
  const [whatsapp, mysqlStatus, queueStats] = await Promise.all([
    getWhatsAppStatus(),
    getDatabaseStatus(),
    getMessageQueueStats({ ownerUsername }).catch(() => null)
  ]);

  res.json({
    success: true,
    whatsapp,
    mysql: mysqlStatus,
    messageQueue: {
      ...messageQueueState,
      running: messageQueueRunning,
      staleErrors,
      stats: queueStats
    },
    mediaLimitBytes: maxStoredMediaBytes
  });
});

app.get('/api/message-templates', requireLoggedIn, handleListMessageTemplates);

app.get('/api/message-templates/:id', requireLoggedIn, handleGetMessageTemplate);

app.post('/api/message-templates', requireTemplateEditor, (req, res) => {
  const body = req.body || {};
  const isLegacyReplace = Object.prototype.hasOwnProperty.call(body, 'template') ||
    Object.prototype.hasOwnProperty.call(body, 'templates');
  const isCreate = Object.prototype.hasOwnProperty.call(body, 'body') ||
    Object.prototype.hasOwnProperty.call(body, 'text') ||
    Object.prototype.hasOwnProperty.call(body, 'name') ||
    Object.prototype.hasOwnProperty.call(body, 'title');

  if (isCreate && !isLegacyReplace) {
    return handleCreateMessageTemplate(req, res);
  }

  return handleReplaceMessageTemplates(req, res);
});

app.put('/api/message-templates/:id', requireTemplateEditor, handleUpdateMessageTemplate);
app.delete('/api/message-templates/:id', requireTemplateEditor, handleDeleteMessageTemplate);

app.get('/api/message-queue/status', requireLoggedIn, async (req, res) => {
  try {
    const staleErrors = await markStaleMessageQueueErrors();
    const ownerUsername = getScopedOwnerUsername(req.user);
    res.json({
      success: true,
      scheduler: {
        ...messageQueueState,
        running: messageQueueRunning,
        staleErrors
      },
      stats: await getMessageQueueStats({ ownerUsername })
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

app.get('/api/message-queue', requireLoggedIn, async (req, res) => {
  try {
    const staleErrors = await markStaleMessageQueueErrors();
    const ownerUsername = getScopedOwnerUsername(req.user);
    res.json({
      success: true,
      staleErrors,
      stats: await getMessageQueueStats({ ownerUsername }),
      items: await listMessageQueueItems({
        limit: req.query.limit,
        status: req.query.status,
        ownerUsername
      })
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

app.post('/api/message-queue/:id/cancel', requireLoggedIn, async (req, res) => {
  try {
    const ownerUsername = getScopedOwnerUsername(req.user);
    const item = await cancelMessageQueueItem(req.params.id, {
      ownerUsername
    });

    res.json({
      success: true,
      item,
      stats: await getMessageQueueStats({ ownerUsername })
    });
  } catch (error) {
    res.status(400).json({
      success: false,
      error: error.message
    });
  }
});

app.post('/api/message-queue/run', requirePrivileged, async (req, res) => {
  try {
    res.json({
      success: true,
      result: await processSecondMessageQueue()
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

app.post('/api/message-queue', requirePrivileged, async (req, res) => {
  try {
    const body = req.body || {};
    const rows = Array.isArray(body.rows) ? body.rows : [];
    const messages = Array.isArray(body.messages) ? body.messages : [];
    const ownerUsername = getUserOwnerUsername(req.user);
    const items = [];

    for (const row of rows) {
      items.push(createQueueItemFromRow(row));
    }

    for (const message of messages) {
      const variables = message.variables && typeof message.variables === 'object'
        ? message.variables
        : {};
      const rawTarget = String(message.target || message.chatId || message.phone || getQueueTargetFromVariables(variables)).trim();
      const target = normalizeSecondQueuePhone(rawTarget) || rawTarget;

      items.push({
        queueKey: String(message.queueKey || '').trim() || null,
        target,
        phone: normalizeChatPhone(message.phone || target),
        source: String(message.source || 'second-queue').trim() || 'second-queue',
        variables
      });
    }

    if (!items.length && (body.target || body.phone || body.chatId)) {
      const variables = body.variables && typeof body.variables === 'object'
        ? body.variables
        : {};
      const rawTarget = String(body.target || body.chatId || body.phone || getQueueTargetFromVariables(variables)).trim();
      const target = normalizeSecondQueuePhone(rawTarget) || rawTarget;

      items.push({
        queueKey: String(body.queueKey || '').trim() || null,
        target,
        phone: normalizeChatPhone(body.phone || target),
        source: String(body.source || 'second-queue').trim() || 'second-queue',
        variables
      });
    }

    const validItems = items
      .filter(item => item.target && isValidSecondQueueTarget(item.target))
      .map(item => ({
        ...item,
        ownerUsername
      }));

    if (!validItems.length) {
      throw new Error('No hay mensajes validos para encolar');
    }

    const queued = await enqueueMessageQueueItems(validItems);

    res.json({
      success: true,
      queued: queued.length,
      skipped: items.length - validItems.length,
      items: queued,
      stats: await getMessageQueueStats({ ownerUsername: getScopedOwnerUsername(req.user) })
    });
  } catch (error) {
    res.status(400).json({
      success: false,
      error: error.message
    });
  }
});

app.get('/api/chats', requireLoggedIn, async (req, res) => {
  try {
    res.json({
      success: true,
      conversations: await listWhatsAppConversations(req.query.limit, {
        ownerUsername: getScopedOwnerUsername(req.user)
      })
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

app.get('/api/contacts/resolve', requirePrivileged, async (req, res) => {
  try {
    const target = String(req.query.target || req.query.phone || req.query.chatId || '').trim();

    if (!target) {
      return res.status(400).json({
        success: false,
        error: 'Falta telefono o chat'
      });
    }

    res.json({
      success: true,
      contact: await resolveWhatsAppContact(target)
    });
  } catch (error) {
    const status = isTransientWhatsAppError(error) ? 503 : 400;
    res.status(status).json({
      success: false,
      error: error.message
    });
  }
});

app.get('/api/messages', requireLoggedIn, async (req, res) => {
  try {
    const chatId = String(req.query.chatId || '').trim();

    if (!chatId) {
      return res.status(400).json({
        success: false,
        error: 'Falta chatId'
      });
    }

    res.json({
      success: true,
      messages: await listWhatsAppMessages(chatId, req.query.limit, {
        ownerUsername: getScopedOwnerUsername(req.user)
      })
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

app.post('/api/messages/send', requirePrivileged, async (req, res) => {
  try {
    const body = req.body || {};
    const target = String(body.chatId || body.phone || '').trim();
    const result = await sendWhatsApp(target, body.message, body.media, 'second-inbox', {
      contactName: body.contactName,
      ownerUsername: getUserOwnerUsername(req.user)
    });

    res.json({
      success: true,
      chatId: result.chatId,
      message: result.message
    });
  } catch (error) {
    const status = isUnconfirmedWhatsAppSendError(error)
      ? 504
      : isTransientWhatsAppError(error)
        ? 503
        : 400;
    res.status(status).json({
      success: false,
      error: error.message
    });
  }
});

app.get('/api/phantom/consulta-masiva', requireLoggedIn, handlePhantomConsultaMasiva);
app.post('/api/phantom/consulta-masiva', requireLoggedIn, handlePhantomConsultaMasiva);
app.get('/api/phantom/baja/sync-status', requireLoggedIn, async (req, res) => {
  try {
    res.json({
      success: true,
      scheduler: phantomBajaSyncState,
      database: await getPhantomBajaSyncStatus()
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});
app.post('/api/phantom/baja/sync', requirePrivileged, async (req, res) => {
  try {
    res.json({
      success: true,
      result: await syncPhantomBajaClients('manual')
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});
app.get('/api/whatsapp/check-number', requireLoggedIn, handleCheckWhatsAppNumber);

app.post('/api/whatsapp/reconnect', requirePrivileged, async (req, res) => {
  try {
    res.json({
      success: true,
      whatsapp: await restartWhatsAppClient('manual')
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

app.post('/api/whatsapp/reset-auth', requirePrivileged, async (req, res) => {
  try {
    res.json({
      success: true,
      whatsapp: await restartWhatsAppClient('reset-auth', { resetAuth: true })
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

app.use((error, req, res, next) => {
  if (!error) {
    return next();
  }

  const status = error.type === 'entity.too.large' ? 413 : 500;
  res.status(status).json({
    success: false,
    error: status === 413 ? `El cuerpo de la solicitud supera ${maxRequestBodyMb} MB` : error.message
  });
});

setInterval(() => {
  getWhatsAppStatus().catch(() => { });
}, 15000);

pingDatabase().catch(error => {
  console.warn('MySQL de segunda app no esta listo:', error.message);
});

initializeWhatsAppClient().catch(() => { });
startSecondMessageQueueScheduler();
startPhantomBajaSyncScheduler();
syncPhantomBajaClients('startup')
  .then(result => console.log('[PHANTOM BAJA] Corrida inicial:', result))
  .catch(error => console.error('[PHANTOM BAJA] Error corrida inicial:', error));
processSecondMessageQueue()
  .then(result => console.log('[QUEUE] Corrida inicial:', result))
  .catch(error => console.error('[QUEUE] Error corrida inicial:', error));

app.listen(secondAppPort, () => {
  console.log(`Segunda app WhatsApp disponible en http://localhost:${secondAppPort}`);
});

module.exports = {
  app,
  getWhatsAppStatus,
  sendWhatsApp
};
