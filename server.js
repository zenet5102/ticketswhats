const { Client, LocalAuth } = require('whatsapp-web.js');
const express = require('express');
const qrcode = require('qrcode-terminal');
const QRCode = require('qrcode-terminal/vendor/QRCode');
const QRErrorCorrectLevel = require('qrcode-terminal/vendor/QRCode/QRErrorCorrectLevel');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const { config } = require('./config');
const {
  handleLogin,
  handleLogout,
  handleMe,
  listConnectedUsers,
  redirectIfAuthenticated,
  requireAuth
} = require('./auth');
const {
  createTicketResponseAction,
  createAutomaticMessageTemplate,
  deleteAutomaticMessageTemplate,
  ensureAutomaticMessageTemplate,
  filterTicketsByGroups,
  listAutomaticMessageTemplates,
  listTickets,
  listTicketGroups,
  listWhatsAppChatPhones,
  listWhatsAppConversations,
  listWhatsAppMessages,
  normalizeChatPhone,
  saveWhatsAppMessage,
  updateAutomaticMessageTemplate
} = require('./db');
const {
  getMessageTemplate,
  getNotificationChannelReply,
  getTicketResponseReply,
  getTicketResponseQuestion,
  isAutomaticReminderEnabled,
  setAutomaticReminderEnabled,
  setMessageTemplate
} = require('./settings');
const {
  formatQuestionText,
  handleIncomingTextResponse
} = require('./ticketResponseFlow');
const { runResponseNotificationTest } = require('./notificationTest');
const {
  allowedRoles,
  createUser,
  deleteUser,
  getPublicUserByUsername,
  listAssignedUserGroups,
  listUsers: listAppUsers,
  updateUser
} = require('./users');
const {
  getTicketJobStatus,
  refreshTicketStatuses,
  refreshTicketPhones,
  retryPendingNotifications,
  runTicketCycle,
  startTicketScheduler,
  syncTickets
} = require('./ticketsJob');

let whatsappReady = false;
let whatsappState = 'starting';
let whatsappLastEventAt = null;
let whatsappLastError = null;
let whatsappQr = null;
let whatsappQrText = null;
let whatsappQrSvg = null;
let whatsappRestarting = false;
let client = null;
const maxStoredMediaBytes = 8 * 1024 * 1024;
const lastMediaBackfillByChat = new Map();
const notificationChannelReplyByChat = new Map();
const notificationChannelReplyCooldownMs = 6 * 60 * 60 * 1000;
const whatsappAuthRoot = path.resolve(__dirname, '.wwebjs_auth');
const whatsappAuthSessionDir = path.resolve(whatsappAuthRoot, 'session-bot-1');
const temporaryTransferHours = parsePositiveInteger(
  process.env.GROUP_TRANSFER_HOURS,
  parsePositiveInteger(process.env.AUTH_SESSION_HOURS, 12)
);
const temporaryGroupTransfers = new Map();

function parsePositiveInteger(value, fallback) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
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

const app = express();
app.use(cors());
app.use(express.json());

const requireLoggedIn = requireAuth();
const requirePrivileged = requireLoggedIn;
const requireAdmin = requireAuth(['admin']);

app.get('/favicon.ico', (req, res) => {
  res.status(204).end();
});

function sendHtmlFile(res, filename) {
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');
  res.setHeader('Surrogate-Control', 'no-store');
  res.sendFile(path.join(__dirname, filename));
}

app.get('/login', redirectIfAuthenticated, (req, res) => {
  sendHtmlFile(res, 'login.html');
});

app.post('/auth/login', handleLogin);
app.post('/auth/logout', handleLogout);
app.get('/auth/me', requireLoggedIn, handleMe);

app.get('/usuarios', requireAdmin, (req, res) => {
  sendHtmlFile(res, 'users.html');
});

app.get('/users', requireAdmin, (req, res) => {
  res.json({
    success: true,
    roles: allowedRoles,
    groups: listAvailableUserGroups(),
    users: listAppUsers()
  });
});

app.post('/users', requireAdmin, (req, res) => {
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
});

app.put('/users/:id', requireAdmin, (req, res) => {
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
});

app.delete('/users/:id', requireAdmin, (req, res) => {
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
});

app.get('/transfers', requireLoggedIn, (req, res) => {
  try {
    res.json({
      success: true,
      users: listTransferUsers(req.user && req.user.username),
      groups: listTransferableGroupsForUser(req.user),
      transfers: listTemporaryGroupTransfers(),
      expiresAfterHours: temporaryTransferHours
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

app.post('/transfers', requireLoggedIn, (req, res) => {
  try {
    res.json({
      success: true,
      transfer: setTemporaryGroupTransfer(
        req.body && req.body.username,
        req.body && req.body.groups,
        req.user
      )
    });
  } catch (error) {
    res.status(400).json({
      success: false,
      error: error.message
    });
  }
});

app.delete('/transfers/:username', requireLoggedIn, (req, res) => {
  try {
    res.json({
      success: true,
      transfer: clearTemporaryGroupTransfer(req.params.username)
    });
  } catch (error) {
    res.status(400).json({
      success: false,
      error: error.message
    });
  }
});

app.get('/enviar', requirePrivileged, (req, res) => {
  sendHtmlFile(res, 'enviar.html');
});

app.get('/', requireLoggedIn, (req, res) => {
  sendHtmlFile(res, 'dashboard.html');
});

app.get('/dashboard', requireLoggedIn, (req, res) => {
  sendHtmlFile(res, 'dashboard.html');
});

app.get('/mensajes', requireLoggedIn, (req, res) => {
  sendHtmlFile(res, 'messages.html');
});

app.get('/errores', requireLoggedIn, (req, res) => {
  sendHtmlFile(res, 'errores.html');
});

app.get('/test', requirePrivileged, (req, res) => {
  sendHtmlFile(res, 'enviar.html');
});

function getUserAllowedGroups(user) {
  if (user && user.isAdmin) {
    return null;
  }

  return listEffectiveUserGroups(user);
}

function listVisibleTicketsForUser(user, date) {
  return filterTicketsByGroups(listTickets(date), getUserAllowedGroups(user));
}

function listAvailableUserGroups() {
  const seen = new Set();
  const groups = [];

  for (const group of [...listTicketGroups(), ...listAssignedUserGroups()]) {
    const cleanGroup = String(group || '').trim();
    const key = cleanGroup.toLowerCase();

    if (cleanGroup && !seen.has(key)) {
      seen.add(key);
      groups.push(cleanGroup);
    }
  }

  return groups.sort((left, right) => left.localeCompare(right));
}

function normalizeGroupListForTransfer(groups, allowedGroups) {
  const availableGroups = new Map(
    (Array.isArray(allowedGroups) ? allowedGroups : listAvailableUserGroups())
      .map(group => [group.toLowerCase(), group])
  );
  const source = Array.isArray(groups)
    ? groups
    : String(groups || '').split(',');
  const seen = new Set();
  const cleanGroups = [];

  for (const group of source) {
    const key = String(group || '').trim().toLowerCase();

    if (key && availableGroups.has(key) && !seen.has(key)) {
      seen.add(key);
      cleanGroups.push(availableGroups.get(key));
    }
  }

  return cleanGroups;
}

function mergeGroupLists(...groupLists) {
  const seen = new Set();
  const merged = [];

  for (const groups of groupLists) {
    for (const group of Array.isArray(groups) ? groups : []) {
      const cleanGroup = String(group || '').trim();
      const key = cleanGroup.toLowerCase();

      if (cleanGroup && !seen.has(key)) {
        seen.add(key);
        merged.push(cleanGroup);
      }
    }
  }

  return merged;
}

function transferKey(username) {
  return String(username || '').trim().toLowerCase();
}

function pruneTemporaryGroupTransfers() {
  const now = Date.now();

  for (const [username, transfer] of temporaryGroupTransfers.entries()) {
    if (Number(transfer.expiresAtTs || 0) <= now) {
      temporaryGroupTransfers.delete(username);
    }
  }
}

function publicTransfer(transfer) {
  if (!transfer) {
    return null;
  }

  return {
    username: transfer.username,
    name: transfer.name,
    role: transfer.role,
    groups: transfer.groups,
    grantedBy: transfer.grantedBy,
    grantedByName: transfer.grantedByName,
    grantedAt: transfer.grantedAt,
    expiresAt: transfer.expiresAt
  };
}

function getTemporaryGroupTransfer(username) {
  pruneTemporaryGroupTransfers();
  return publicTransfer(temporaryGroupTransfers.get(transferKey(username)));
}

function listTemporaryGroupTransfers() {
  pruneTemporaryGroupTransfers();
  return Array.from(temporaryGroupTransfers.values())
    .map(publicTransfer)
    .sort((left, right) => left.name.localeCompare(right.name) || left.username.localeCompare(right.username));
}

function listEffectiveUserGroups(user) {
  if (!user) {
    return [];
  }

  const transfer = getTemporaryGroupTransfer(user.username);
  return mergeGroupLists(user.groups, transfer && transfer.groups);
}

function listTransferableGroupsForUser(user) {
  if (user && user.isAdmin) {
    return listAvailableUserGroups();
  }

  return listEffectiveUserGroups(user).sort((left, right) => left.localeCompare(right));
}

function listTransferUsers(currentUsername) {
  const currentKey = transferKey(currentUsername);

  return listConnectedUsers()
    .filter(user => transferKey(user.username) !== currentKey)
    .filter(user => !user.isAdmin)
    .map(user => ({
      username: user.username,
      name: user.name,
      role: user.role,
      isAdmin: Boolean(user.isAdmin),
      lastSeenAt: user.lastSeenAt,
      transfer: getTemporaryGroupTransfer(user.username)
    }));
}

function isConnectedUsername(username) {
  const key = transferKey(username);
  return listConnectedUsers().some(user => transferKey(user.username) === key);
}

function setTemporaryGroupTransfer(username, groups, actor) {
  const target = getPublicUserByUsername(username);

  if (!target) {
    throw new Error('Usuario no encontrado');
  }

  if (!isConnectedUsername(target.username)) {
    throw new Error('El usuario no esta conectado');
  }

  if (target.isAdmin) {
    throw new Error('El usuario admin ya ve todos los grupos');
  }

  const cleanGroups = normalizeGroupListForTransfer(groups, listTransferableGroupsForUser(actor));

  if (!cleanGroups.length) {
    throw new Error('Selecciona al menos un grupo');
  }

  const now = Date.now();
  const expiresAtTs = now + temporaryTransferHours * 60 * 60 * 1000;
  const transfer = {
    username: target.username,
    name: target.name,
    role: target.role,
    groups: cleanGroups,
    grantedBy: actor && actor.username || '',
    grantedByName: actor && actor.name || '',
    grantedAt: new Date(now).toISOString(),
    expiresAt: new Date(expiresAtTs).toISOString(),
    expiresAtTs
  };

  temporaryGroupTransfers.set(transferKey(target.username), transfer);
  return publicTransfer(transfer);
}

function clearTemporaryGroupTransfer(username) {
  const target = getPublicUserByUsername(username);
  const key = transferKey(target ? target.username : username);
  const existingTransfer = temporaryGroupTransfers.get(key);

  temporaryGroupTransfers.delete(key);
  return publicTransfer(existingTransfer);
}

function getVisibleTicketPhones(user) {
  const phones = new Set();

  for (const ticket of listVisibleTicketsForUser(user)) {
    const phone = normalizeChatPhone(ticket.phone || '');

    if (phone) {
      phones.add(phone);
    }
  }

  return phones;
}

function parseTicketPayload(ticket) {
  try {
    return JSON.parse(ticket && ticket.payload_json || '{}') || {};
  } catch (error) {
    return {};
  }
}

function getTicketIda(ticket) {
  const payload = parseTicketPayload(ticket);

  return String(
    payload.IDA ||
    payload.ida ||
    payload.IDAbonado ||
    payload.id_abonado ||
    ''
  ).trim();
}

function getTicketInfo(ticket) {
  if (!ticket) {
    return {};
  }

  return {
    ticket_external_id: ticket.external_id,
    ticket_ida: getTicketIda(ticket),
    ticket_razon_social: ticket.razon_social || '',
    ticket_delegacion: ticket.delegacion || '',
    ticket_start: ticket.start || '',
    ticket_start_time: ticket.start_time || '',
    ticket_response_action: ticket.response_action || '',
    ticket_response_label: ticket.response_label || '',
    ticket_response_body: ticket.response_body || '',
    ticket_response_received_at: ticket.response_received_at || ''
  };
}

function buildTicketInfoByPhone(user) {
  const byPhone = new Map();
  const tickets = listVisibleTicketsForUser(user)
    .slice()
    .sort((left, right) => Number(right.start_ts || 0) - Number(left.start_ts || 0));

  for (const ticket of tickets) {
    const phone = normalizeChatPhone(ticket.phone || '');

    if (phone && !byPhone.has(phone)) {
      byPhone.set(phone, getTicketInfo(ticket));
    }
  }

  return byPhone;
}

function attachTicketInfoToConversations(user, conversations) {
  const ticketsByPhone = buildTicketInfoByPhone(user);

  return conversations.map(conversation => {
    const phone = normalizeChatPhone(conversation && conversation.phone || '');
    const chatPhone = normalizeChatPhone(conversation && conversation.chat_id || '');
    const ticketInfo = ticketsByPhone.get(phone) || ticketsByPhone.get(chatPhone) || {};

    return {
      ...conversation,
      ...ticketInfo
    };
  });
}

function conversationMatchesPhones(conversation, phones) {
  const directPhone = normalizeChatPhone(conversation && conversation.phone || '');
  const chatPhone = normalizeChatPhone(conversation && conversation.chat_id || '');

  return Boolean((directPhone && phones.has(directPhone)) || (chatPhone && phones.has(chatPhone)));
}

function listVisibleConversationsForUser(user, limit) {
  if (user && user.isAdmin) {
    return attachTicketInfoToConversations(user, listWhatsAppConversations(limit));
  }

  const requestedLimit = Math.min(Math.max(Number(limit) || 100, 1), 300);
  const phones = getVisibleTicketPhones(user);

  if (!phones.size) {
    return [];
  }

  const conversations = listWhatsAppConversations(1000)
    .filter(conversation => conversationMatchesPhones(conversation, phones))
    .slice(0, requestedLimit);

  return attachTicketInfoToConversations(user, conversations);
}

function canReadChat(user, chatId) {
  if (user && user.isAdmin) {
    return true;
  }

  const phones = getVisibleTicketPhones(user);
  const candidatePhones = [
    chatId,
    ...listWhatsAppChatPhones(chatId)
  ].map(value => normalizeChatPhone(value));

  return candidatePhones.some(candidatePhone => candidatePhone && phones.has(candidatePhone));
}

function canSendToTarget(user, chatId, phone) {
  if (user && user.isAdmin) {
    return true;
  }

  const cleanChatId = String(chatId || '').trim();
  const cleanPhone = normalizeChatPhone(phone || cleanChatId);

  if (!cleanPhone) {
    return false;
  }

  if (cleanChatId) {
    if (canReadChat(user, cleanChatId)) {
      return true;
    }

    return normalizeChatPhone(cleanChatId) === cleanPhone && getVisibleTicketPhones(user).has(cleanPhone);
  }

  return getVisibleTicketPhones(user).has(cleanPhone);
}

function getIncomingMessagePhones(storedMessage) {
  const phones = new Set();
  const candidates = [
    storedMessage && storedMessage.phone,
    storedMessage && storedMessage.chat_id,
    ...listWhatsAppChatPhones(storedMessage && storedMessage.chat_id)
  ];

  for (const candidate of candidates) {
    const phone = normalizeChatPhone(candidate);

    if (phone) {
      phones.add(phone);
    }
  }

  return phones;
}

function incomingMessageMatchesAnyTicket(storedMessage) {
  const phones = getIncomingMessagePhones(storedMessage);

  if (!phones.size) {
    return false;
  }

  return listTickets().some(ticket => {
    const phone = normalizeChatPhone(ticket && ticket.phone || '');

    return phone && phones.has(phone);
  });
}

function createWhatsAppClient() {
  return new Client({
    authStrategy: new LocalAuth({
      clientId: 'bot-1'
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
    console.log('Escanea este QR con WhatsApp:');
    qrcode.generate(qr, { small: true });
  });

  instance.on('authenticated', () => {
    markWhatsAppState('AUTHENTICATED', false);
    clearWhatsAppQr();
    console.log('WhatsApp autenticado');
  });

  instance.on('auth_failure', msg => {
    markWhatsAppState('AUTH_FAILURE', false);
    clearWhatsAppQr();
    whatsappLastError = String(msg || 'Fallo de autenticacion');
    console.error('Fallo de autenticacion:', msg);
  });

  instance.on('ready', () => {
    markWhatsAppState('CONNECTED', true);
    whatsappLastError = null;
    console.log('WhatsApp conectado');
  });

  instance.on('change_state', state => {
    markWhatsAppState(state || 'UNKNOWN', state === 'CONNECTED');
    console.log('Estado de WhatsApp:', state);
  });

  instance.on('disconnected', reason => {
    markWhatsAppState(`DISCONNECTED: ${reason}`, false);
    clearWhatsAppQr();
    console.log('WhatsApp desconectado:', reason);
  });

  instance.on('message', message => {
    storeWhatsAppMessage(message, 'whatsapp')
      .then(storedMessage => processIncomingTicketResponse(storedMessage))
      .catch(error => {
        console.warn('No se pudo guardar mensaje entrante:', error.message);
      });
  });

  instance.on('message_create', message => {
    storeWhatsAppMessage(message, 'whatsapp').catch(error => {
      console.warn('No se pudo guardar mensaje creado:', error.message);
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
    console.error('Error iniciando WhatsApp:', error);
    throw error;
  }

  return client;
}

async function restartWhatsAppClient(reason = 'manual', options = {}) {
  if (whatsappRestarting) {
    return getWhatsAppStatus();
  }

  whatsappRestarting = true;
  markWhatsAppState(options.resetAuth ? 'RESETTING_AUTH' : 'RESTARTING', false);
  whatsappLastError = null;
  clearWhatsAppQr();
  console.log(`Reiniciando WhatsApp (${reason})`);

  const oldClient = client;
  client = null;

  if (oldClient) {
    try {
      await oldClient.destroy();
    } catch (error) {
      console.warn('No se pudo cerrar cliente WhatsApp anterior:', error.message);
    }
  }

  try {
    if (options.resetAuth) {
      removeWhatsAppAuthSession();
      console.log('Sesion local de WhatsApp eliminada');
    }

    initializeWhatsAppClient().catch(() => {});
    return getWhatsAppStatus();
  } finally {
    whatsappRestarting = false;
  }
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
  return /@(c\.us|s\.whatsapp\.net|lid)$/i.test(String(value || '').trim());
}

function isLidChatId(value) {
  return /@lid$/i.test(String(value || '').trim());
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
  const lidUser = isLidChatId(chatId) ? normalizeChatPhone(chatId) : '';

  if (phone && lidUser && phone === lidUser) {
    return '';
  }

  return phone;
}

async function getMessageContactInfo(message, chatId) {
  let contact = null;

  if (client && message.fromMe && chatId) {
    try {
      contact = await client.getContactById(chatId);
    } catch (error) {
      contact = null;
    }
  }

  if (!contact && message.getContact) {
    try {
      contact = await message.getContact();
    } catch (error) {
      contact = null;
    }
  }

  const contactName = contact
    ? contact.pushname || contact.name || contact.shortName || ''
    : (message._data && message._data.notifyName ? message._data.notifyName : '');
  const contactPhone = getContactPhone(contact, chatId);

  return {
    contactName,
    contactPhone
  };
}

function getMediaLabel(mimetype, fallbackType) {
  if (String(mimetype || '').startsWith('image/')) {
    return 'imagen';
  }

  if (String(mimetype || '').startsWith('video/')) {
    return 'video';
  }

  if (String(mimetype || '').startsWith('audio/')) {
    return 'audio';
  }

  if (String(fallbackType || '').toLowerCase() === 'ptt') {
    return 'audio';
  }

  return fallbackType || 'archivo';
}

function shouldStoreInlineMedia(mimetype) {
  const cleanMime = String(mimetype || '').toLowerCase();
  return cleanMime.startsWith('image/') || cleanMime.startsWith('audio/');
}

async function getMessageMediaInfo(message) {
  if (!message.hasMedia || !message.downloadMedia) {
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

    if (shouldStoreInlineMedia(media.mimetype) && media.data) {
      const mediaBytes = Buffer.byteLength(media.data, 'base64');

      if (mediaBytes <= maxStoredMediaBytes) {
        mediaInfo.mediaData = media.data;
      }
    }

    return mediaInfo;
  } catch (error) {
    console.warn('No se pudo descargar media de WhatsApp:', error.message);
    return {};
  }
}

async function storeWhatsAppMessage(message, source = 'whatsapp') {
  try {
    const chatId = String(message.fromMe ? message.to || message.from : message.from || '').trim();

    if (!chatId || chatId === 'status@broadcast' || chatId.endsWith('@g.us')) {
      return null;
    }

    const direction = message.fromMe ? 'outgoing' : 'incoming';
    const rawBody = String(message.body || message.caption || '').trim();
    const systemTypes = new Set(['e2e_notification', 'notification_template', 'ciphertext']);
    const mediaInfo = await getMessageMediaInfo(message);

    if (!rawBody && systemTypes.has(String(message.type || '').toLowerCase())) {
      return null;
    }

    const body = rawBody || `[${getMediaLabel(mediaInfo.mediaMime, message.type)} sin texto]`;
    const contactInfo = await getMessageContactInfo(message, chatId);

    return saveWhatsAppMessage({
      id: getStoredMessageId(message, chatId, direction),
      chatId,
      phone: contactInfo.contactPhone || normalizeChatPhone(chatId),
      contactName: contactInfo.contactName,
      direction,
      body,
      mediaMime: mediaInfo.mediaMime,
      mediaData: mediaInfo.mediaData,
      mediaFilename: mediaInfo.mediaFilename,
      timestampTs: getWhatsAppTimestampMs(message.timestamp),
      fromMe: Boolean(message.fromMe),
      ack: message.ack,
      source
    });
  } catch (error) {
    console.warn('No se pudo guardar mensaje de WhatsApp:', error.message);
    return null;
  }
}

async function processIncomingTicketResponse(storedMessage) {
  if (!storedMessage || storedMessage.direction !== 'incoming') {
    return null;
  }

  const result = await handleIncomingTextResponse({
    chatId: storedMessage.chat_id,
    phone: storedMessage.phone,
    body: storedMessage.body,
    messageId: storedMessage.id,
    logger: (message, detail) => console.log(message, detail)
  });

  if (result && result.matched) {
    console.log(
      `Respuesta de ticket ${result.completedAction.ticket_external_id}: ${result.selectedOption.label}`
    );
    const reply = getTicketResponseReply(result.selectedOption.action);

    if (reply) {
      await sendWhatsApp(storedMessage.chat_id, reply, 'ticket-response');
    }
  } else if (result && result.matched === false) {
    const reply = getTicketResponseReply('default');

    if (reply) {
      await sendWhatsApp(storedMessage.chat_id, reply, 'ticket-response');
    }
  } else if (!result && !incomingMessageMatchesAnyTicket(storedMessage)) {
    const sent = await sendNotificationChannelReply(storedMessage);

    if (sent) {
      console.log(`Aviso de canal enviado a chat sin ticket: ${storedMessage.chat_id}`);
    }
  }

  return result;
}

async function sendNotificationChannelReply(storedMessage) {
  const chatId = String(storedMessage && storedMessage.chat_id || '').trim();

  if (!chatId) {
    return false;
  }

  const now = Date.now();
  const lastReplyAt = notificationChannelReplyByChat.get(chatId) || 0;

  if (now - lastReplyAt < notificationChannelReplyCooldownMs) {
    return false;
  }

  notificationChannelReplyByChat.set(chatId, now);

  try {
    await sendWhatsApp(chatId, getNotificationChannelReply(), 'notification-channel');
    return true;
  } catch (error) {
    notificationChannelReplyByChat.delete(chatId);
    console.warn(`No se pudo enviar aviso de canal al chat ${chatId}:`, error.message);
    return false;
  }
}

function isMissingStoredMedia(message) {
  const body = String(message.body || '').toLowerCase();
  const mime = String(message.media_mime || '').toLowerCase();
  const canRenderInline = mime.startsWith('image/') || mime.startsWith('audio/');
  const mediaPlaceholder = /^\[(image|imagen|audio|ptt) sin texto\]$/.test(body);

  return !message.media_data && (canRenderInline || mediaPlaceholder);
}

async function backfillChatMedia(chatId) {
  const now = Date.now();
  const lastBackfill = lastMediaBackfillByChat.get(chatId) || 0;

  if (!client || !whatsappReady || now - lastBackfill < 30000) {
    return;
  }

  const storedMessages = listWhatsAppMessages(chatId, 80);
  const missingIds = new Set(
    storedMessages
      .filter(isMissingStoredMedia)
      .map(message => message.id)
  );

  if (!missingIds.size) {
    return;
  }

  lastMediaBackfillByChat.set(chatId, now);

  try {
    const chat = await client.getChatById(chatId);
    const recentMessages = await chat.fetchMessages({ limit: 80 });

    for (const message of recentMessages) {
      if (message.id && missingIds.has(message.id._serialized)) {
        await storeWhatsAppMessage(message, 'whatsapp');
      }
    }
  } catch (error) {
    console.warn(`No se pudo recuperar media del chat ${chatId}:`, error.message);
  }
}

initializeWhatsAppClient().catch(() => {});

async function getWhatsAppStatus() {
  try {
    if (client && client.pupPage) {
      const state = await client.getState();

      if (state) {
        markWhatsAppState(state, state === 'CONNECTED');
      }
    }
  } catch (error) {
    whatsappLastError = error.message;
  }

  return {
    ready: whatsappReady,
    state: whatsappState,
    lastEventAt: whatsappLastEventAt,
    lastError: whatsappLastError,
    qr: whatsappReady ? null : whatsappQr,
    qrText: whatsappReady ? null : whatsappQrText,
    qrSvg: whatsappReady ? null : whatsappQrSvg
  };
}

setInterval(() => {
  getWhatsAppStatus().catch(() => {});
}, 15000);

function isWhatsAppReady() {
  return whatsappReady;
}

function getTicketExternalId(ticket) {
  return String(ticket && (ticket.external_id || ticket.externalId) || '').trim();
}

function buildTicketQuestionContext(message, options = {}) {
  if (!options.includeResponseQuestion) {
    return null;
  }

  const ticketExternalId = getTicketExternalId(options.ticket);
  const question = getTicketResponseQuestion();
  const questionText = formatQuestionText(question);

  if (!ticketExternalId || !questionText) {
    return null;
  }

  const cleanMessage = String(message || '').trim();
  const fullMessage = cleanMessage.includes(questionText)
    ? cleanMessage
    : `${cleanMessage}\n\n${questionText}`;

  return {
    ticketExternalId,
    question,
    text: questionText,
    fullMessage
  };
}

function getAutomaticMessageDefaultBody() {
  const questionText = formatQuestionText(getTicketResponseQuestion());
  const baseMessage = getMessageTemplate();

  return questionText && !baseMessage.includes(questionText)
    ? `${baseMessage}\n\n${questionText}`
    : baseMessage;
}

async function sendWhatsApp(phone, message, source = 'bot', options = {}) {
  await getWhatsAppStatus();

  if (!client || !whatsappReady) {
    throw new Error(`WhatsApp todavia no esta conectado (${whatsappState})`);
  }

  const target = String(phone || '').trim();
  const targetChatId = isDirectChatId(target) ? target : '';
  const cleanPhone = normalizeChatPhone(target);
  const cleanMessage = String(message || '').trim();
  const questionContext = buildTicketQuestionContext(cleanMessage, options);
  const fullMessage = questionContext ? questionContext.fullMessage : cleanMessage;

  if ((!targetChatId && !cleanPhone) || !cleanMessage) {
    throw new Error('Faltan phone o message');
  }

  console.log('Enviando a:', targetChatId || cleanPhone);

  let chatId = targetChatId;

  if (!chatId) {
    const numberId = await client.getNumberId(cleanPhone);

    if (!numberId) {
      throw new Error('El numero no existe en WhatsApp o no se pudo resolver');
    }

    chatId = numberId._serialized;
  }

  console.log('Chat ID resuelto:', chatId);
  const sentMessage = await client.sendMessage(chatId, fullMessage);
  const sentMessageId = getStoredMessageId(sentMessage, chatId, 'outgoing');

  try {
    saveWhatsAppMessage({
      id: sentMessageId,
      chatId,
      phone: cleanPhone,
      direction: 'outgoing',
      body: fullMessage,
      timestampTs: getWhatsAppTimestampMs(sentMessage && sentMessage.timestamp),
      fromMe: true,
      ack: sentMessage && sentMessage.ack,
      source
    });
  } catch (error) {
    console.warn('Mensaje enviado, pero no se pudo guardar el historial:', error.message);
  }

  if (questionContext) {
    try {
      createTicketResponseAction({
        ticketExternalId: questionContext.ticketExternalId,
        chatId,
        phone: cleanPhone || normalizeChatPhone(chatId),
        question: questionContext.question.prompt,
        options: questionContext.question.options,
        deliveryMode: 'text',
        sentMessageId
      });
    } catch (error) {
      console.warn('Mensaje enviado, pero no se pudo registrar la pregunta pendiente:', error.message);
    }
  }

  return sentMessage;
}

app.post('/send', requirePrivileged, async (req, res) => {
  try {
    const { phone, message } = req.body;
    await sendWhatsApp(phone, message, 'manual');
    res.json({ success: true });
  } catch (error) {
    const status = error.message.includes('todavia no esta conectado') ? 503 : 500;

    if (error.message === 'Faltan phone o message') {
      return res.status(400).json({
        success: false,
        error: error.message
      });
    }

    console.error('Error enviando mensaje:', error);
    res.status(status).json({
      success: false,
      error: error.message
    });
  }
});

async function handleResponseNotificationTest(req, res) {
  try {
    const body = req.body || {};
    const result = await runResponseNotificationTest(body, {
      visibleTickets: listVisibleTicketsForUser(req.user, body.date),
      processIncomingTicketResponse
    });

    res.json({ success: true, result });
  } catch (error) {
    const status = error.statusCode || 500;

    if (status >= 500) {
      console.error('Error ejecutando prueba de notificacion:', error);
    }

    res.status(status).json({
      success: false,
      error: error.message
    });
  }
}

app.post('/notifications/test', requirePrivileged, handleResponseNotificationTest);
app.post('/notifications/test-response', requirePrivileged, handleResponseNotificationTest);

app.get('/messages/conversations', requireLoggedIn, (req, res) => {
  try {
    res.json({
      success: true,
      conversations: listVisibleConversationsForUser(req.user, req.query.limit)
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

app.get('/messages', requireLoggedIn, async (req, res) => {
  try {
    const chatId = String(req.query.chatId || '').trim();

    if (!chatId) {
      return res.status(400).json({
        success: false,
        error: 'Falta chatId'
      });
    }

    if (!canReadChat(req.user, chatId)) {
      return res.status(403).json({
        success: false,
        error: 'Chat fuera de los grupos asignados'
      });
    }

    await backfillChatMedia(chatId);

    res.json({
      success: true,
      messages: listWhatsAppMessages(chatId, req.query.limit)
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

app.post('/messages/send', requirePrivileged, async (req, res) => {
  try {
    const targetChatId = String(req.body && req.body.chatId || '').trim();
    const targetPhone = String(req.body && req.body.phone || '').trim();
    const target = targetChatId || targetPhone;
    const cleanPhone = normalizeChatPhone(targetPhone || target);
    const cleanMessage = String(req.body && req.body.message || '').trim();

    if (!target || !cleanMessage) {
      return res.status(400).json({
        success: false,
        error: 'Faltan telefono o mensaje'
      });
    }

    if (!canSendToTarget(req.user, targetChatId, targetPhone || target)) {
      return res.status(403).json({
        success: false,
        error: 'Chat fuera de los grupos asignados'
      });
    }

    const sentMessage = await sendWhatsApp(target, cleanMessage, 'inbox');
    const chatId = sentMessage.to || (isDirectChatId(target) ? target : `${cleanPhone}@c.us`);

    res.json({
      success: true,
      message: saveWhatsAppMessage({
        id: getStoredMessageId(sentMessage, chatId, 'outgoing'),
        chatId,
        phone: cleanPhone,
        direction: 'outgoing',
        body: cleanMessage,
        timestampTs: getWhatsAppTimestampMs(sentMessage && sentMessage.timestamp),
        fromMe: true,
        ack: sentMessage && sentMessage.ack,
        source: 'inbox'
      })
    });
  } catch (error) {
    const status = error.message.includes('todavia no esta conectado') ? 503 : 500;
    res.status(status).json({
      success: false,
      error: error.message
    });
  }
});

app.get('/tickets', requireLoggedIn, (req, res) => {
  try {
    res.json({
      success: true,
      tickets: listVisibleTicketsForUser(req.user, req.query.date)
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

app.get('/tickets/job-status', requireLoggedIn, async (req, res) => {
  const whatsapp = await getWhatsAppStatus();

  res.json({
    success: true,
    whatsappReady: whatsapp.ready,
    whatsapp,
    job: getTicketJobStatus()
  });
});

app.post('/whatsapp/reconnect', requirePrivileged, async (req, res) => {
  try {
    const whatsapp = await restartWhatsAppClient('manual');
    res.json({
      success: true,
      whatsapp
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

app.post('/whatsapp/reset-auth', requirePrivileged, async (req, res) => {
  try {
    const whatsapp = await restartWhatsAppClient('reset-auth', {
      resetAuth: true
    });
    res.json({
      success: true,
      whatsapp
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

app.get('/settings/message-template', requireLoggedIn, (req, res) => {
  res.json({
    success: true,
    template: getMessageTemplate(),
    automaticReminderEnabled: isAutomaticReminderEnabled(),
    placeholders: [
      'external_id',
      'razon_social',
      'cliente',
      'delegacion',
      'hora',
      'start',
      'status',
      'previous_external_id',
      'previous_hora'
    ]
  });
});

app.post('/settings/message-template', requirePrivileged, (req, res) => {
  try {
    const template = setMessageTemplate(req.body.template);
    const automaticReminderEnabled = req.body.automaticReminderEnabled === undefined || !(req.user && req.user.isAdmin)
      ? isAutomaticReminderEnabled()
      : setAutomaticReminderEnabled(req.body.automaticReminderEnabled);

    res.json({ success: true, template, automaticReminderEnabled });
  } catch (error) {
    res.status(400).json({
      success: false,
      error: error.message
    });
  }
});

app.get('/settings/automatic-message-templates', requireLoggedIn, (req, res) => {
  const defaultBody = getAutomaticMessageDefaultBody();
  ensureAutomaticMessageTemplate(defaultBody);
  res.json({
    success: true,
    templates: listAutomaticMessageTemplates(),
    defaultTemplate: defaultBody,
    placeholders: [
      'external_id',
      'razon_social',
      'cliente',
      'delegacion',
      'hora',
      'start',
      'status',
      'previous_external_id',
      'previous_hora'
    ]
  });
});

app.post('/settings/automatic-message-templates', requirePrivileged, (req, res) => {
  try {
    const template = createAutomaticMessageTemplate(req.body || {});
    res.status(201).json({ success: true, template, templates: listAutomaticMessageTemplates() });
  } catch (error) {
    res.status(400).json({
      success: false,
      error: error.message
    });
  }
});

app.put('/settings/automatic-message-templates/:id', requirePrivileged, (req, res) => {
  try {
    const template = updateAutomaticMessageTemplate(req.params.id, req.body || {});
    res.json({ success: true, template, templates: listAutomaticMessageTemplates() });
  } catch (error) {
    const status = error.message === 'Template no encontrado' ? 404 : 400;
    res.status(status).json({
      success: false,
      error: error.message
    });
  }
});

app.delete('/settings/automatic-message-templates/:id', requirePrivileged, (req, res) => {
  try {
    const template = deleteAutomaticMessageTemplate(req.params.id);
    res.json({ success: true, template, templates: listAutomaticMessageTemplates() });
  } catch (error) {
    const status = error.message === 'Template no encontrado' ? 404 : 400;
    res.status(status).json({
      success: false,
      error: error.message
    });
  }
});

app.post('/settings/automatic-reminder', requireAdmin, (req, res) => {
  try {
    const automaticReminderEnabled = setAutomaticReminderEnabled(req.body && req.body.enabled);
    res.json({ success: true, automaticReminderEnabled });
  } catch (error) {
    res.status(400).json({
      success: false,
      error: error.message
    });
  }
});

app.post('/tickets/sync', requirePrivileged, async (req, res) => {
  try {
    const result = await syncTickets(req.body && req.body.date);
    result.phones = await refreshTicketPhones(result.date);
    res.json({ success: true, result });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

app.post('/tickets/status', requirePrivileged, async (req, res) => {
  try {
    const result = await refreshTicketStatuses({
      date: req.body && req.body.date,
      isWhatsAppReady,
      sendWhatsApp
    });
    res.json({ success: true, result });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

app.post('/tickets/phones', requirePrivileged, async (req, res) => {
  try {
    const result = await refreshTicketPhones(req.body && req.body.date);
    res.json({ success: true, result });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

app.post('/tickets/run', requirePrivileged, async (req, res) => {
  try {
    const result = await runTicketCycle({
      date: req.body && req.body.date,
      isWhatsAppReady,
      sendWhatsApp
    });
    res.json({ success: true, result });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

app.post('/tickets/retry-notifications', requirePrivileged, async (req, res) => {
  try {
    const result = await retryPendingNotifications({
      date: req.body && req.body.date,
      isWhatsAppReady,
      sendWhatsApp
    });
    res.json({ success: true, result });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

startTicketScheduler({
  isWhatsAppReady,
  sendWhatsApp
});

app.listen(config.port, () => {
  console.log(`API escuchando en puerto ${config.port}`);
});
