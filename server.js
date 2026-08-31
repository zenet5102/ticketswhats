const { Client, LocalAuth } = require('whatsapp-web.js');
const express = require('express');
const qrcode = require('qrcode-terminal');
const QRCode = require('qrcode-terminal/vendor/QRCode');
const QRErrorCorrectLevel = require('qrcode-terminal/vendor/QRCode/QRErrorCorrectLevel');
const cors = require('cors');
const crypto = require('crypto');
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
  disableTicketAutomaticMessage,
  ensureAutomaticMessageTemplate,
  filterTicketsByGroups,
  getAuditPhoneCandidates,
  getTicket,
  getLatestTicketResponseActionByChat,
  getWhatsAppConversationBucketOverride,
  listAutomaticMessageTemplates,
  listTickets,
  listTicketsForAudit,
  listTicketGroups,
  listWhatsAppConversationBucketOverrides,
  listWhatsAppChatPhones,
  listWhatsAppConversations,
  listWhatsAppMessagesByPhone,
  listWhatsAppMessages,
  getAppState,
  getRecentOutgoingMessage,
  getRecentOutgoingMessageBySource,
  normalizeChatPhone,
  saveWhatsAppMessage,
  setAppState,
  setWhatsAppConversationBucketOverride,
  updateAutomaticMessageTemplate,
  updateTicketPhone,
  updateWhatsAppMessageAck
} = require('./db');
const {
  getMessageTemplate,
  getNotificationChannelReply,
  getNotificationChannelReplySettings,
  getTicketResponseReply,
  getTicketResponseQuestion,
  isAutomaticReminderEnabled,
  isNotificationChannelReplyEnabled,
  setAutomaticReminderEnabled,
  setNotificationChannelReplySettings,
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
const { getTodayDateString } = require('./ticketApi');
const secondDb = require('./secondMessageDb');
const { PhantomApi } = require('./phantomApi');

let whatsappReady = false;
let whatsappState = 'starting';
let whatsappLastEventAt = null;
let whatsappLastError = null;
let whatsappQr = null;
let whatsappQrText = null;
let whatsappQrSvg = null;
let whatsappRestarting = false;
let client = null;
const whatsappAccounts = [
  {
    id: 'bot-1',
    label: process.env.WHATSAPP_PRIMARY_LABEL || 'Numero 1',
    clientId: process.env.WHATSAPP_PRIMARY_CLIENT_ID || 'bot-1'
  },
  {
    id: 'bot-2',
    label: process.env.WHATSAPP_SECONDARY_LABEL || 'Numero 2',
    clientId: process.env.SECOND_WHATSAPP_CLIENT_ID || 'bot-2'
  }
];
const whatsappAccountStates = new Map(whatsappAccounts.map(account => [account.id, {
  ...account,
  ready: false,
  state: 'starting',
  lastEventAt: null,
  lastError: null,
  qr: null,
  qrText: null,
  qrSvg: null,
  restarting: false,
  initializing: false,
  client: null
}]));
const maxStoredMediaBytes = 8 * 1024 * 1024;
const lastMediaBackfillByChat = new Map();
const lastRecentMessagesSyncByChat = new Map();
const mediaDownloadRetryDelaysMs = [0, 750, 2000];
const notificationChannelReplyByChat = new Map();
const notificationChannelReplyCooldownMs = config.notificationChannelReplyCooldownHours * 60 * 60 * 1000;
const notificationChannelSuppressAfterManualMs = config.notificationChannelSuppressAfterManualHours * 60 * 60 * 1000;
const recentMessagesSyncIntervalMs = parsePositiveInteger(process.env.WHATSAPP_RECENT_MESSAGES_SYNC_INTERVAL_MS, 5000);
const recentMessagesSyncChatCooldownMs = parsePositiveInteger(process.env.WHATSAPP_RECENT_MESSAGES_SYNC_CHAT_COOLDOWN_MS, 12000);
const recentMessagesSyncChatLimit = parsePositiveInteger(process.env.WHATSAPP_RECENT_MESSAGES_SYNC_CHAT_LIMIT, 35);
const recentMessagesSyncMessageLimit = parsePositiveInteger(process.env.WHATSAPP_RECENT_MESSAGES_SYNC_MESSAGE_LIMIT, 12);
const whatsappAuthRoot = path.resolve(__dirname, '.wwebjs_auth');
const whatsappAuthSessionDir = path.resolve(whatsappAuthRoot, 'session-bot-1');
const secondMaxStoredMediaBytes = parsePositiveInteger(process.env.SECOND_APP_MAX_STORED_MEDIA_MB, 15) * 1024 * 1024;
const secondMessageQueueIntervalMinutes = parsePositiveInteger(process.env.SECOND_MESSAGE_QUEUE_INTERVAL_MINUTES, 10);
const secondMessageQueueBatchSize = parsePositiveInteger(process.env.SECOND_MESSAGE_QUEUE_BATCH_SIZE, 20);
const secondMessageSettingsPath = path.join(__dirname, 'data', 'second-message-settings.json');
const phantomBajaSyncHour = Math.min(parseNonNegativeInteger(process.env.PHANTOM_BAJA_SYNC_HOUR, 3), 23);
const phantomBajaSyncMinute = Math.min(parseNonNegativeInteger(process.env.PHANTOM_BAJA_SYNC_MINUTE, 0), 59);
const phantomBajaSyncLimit = Math.min(parsePositiveInteger(process.env.PHANTOM_BAJA_SYNC_LIMIT, 500), 500);
const temporaryTransferHours = parsePositiveInteger(
  process.env.GROUP_TRANSFER_HOURS,
  parsePositiveInteger(process.env.AUTH_SESSION_HOURS, 12)
);
const temporaryGroupTransfers = new Map();
let secondMessageQueueRunning = false;
let phantomBajaSyncRunning = false;
let phantomBajaSyncTimer = null;
const secondMessageQueueState = {
  active: false,
  intervalMinutes: secondMessageQueueIntervalMinutes,
  batchSize: secondMessageQueueBatchSize,
  startedAt: null,
  lastRunStartedAt: null,
  lastRunFinishedAt: null,
  nextRunAt: null,
  lastResult: null,
  lastError: null,
  runCount: 0
};
const phantomBajaSyncState = {
  active: false,
  running: false,
  lastRunStartedAt: null,
  lastRunFinishedAt: null,
  nextRunAt: null,
  lastResult: null,
  lastError: null
};
let recentMessagesSyncRunning = false;
let lastRecentMessagesSyncAt = 0;

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

function getPhantomPlatformUserName(user) {
  const username = String(user && user.username || '').trim();
  const fallback = String(user && user.name || 'usuario').trim() || 'usuario';
  const cleanName = username || fallback;
  return cleanName.startsWith('_') ? cleanName : `_${cleanName}`;
}

function getWhatsAppAccountState(accountId = 'bot-1') {
  refreshWhatsAppAccountLabels();
  return whatsappAccountStates.get(accountId) || whatsappAccountStates.get('bot-1');
}

function getWhatsAppAccountConfig(accountId = 'bot-1') {
  return getWhatsAppAccountState(accountId);
}

function isValidWhatsAppAccount(accountId) {
  return whatsappAccountStates.has(String(accountId || '').trim());
}

function getDefaultWhatsAppAccountId(user) {
  const accounts = Array.isArray(user && user.whatsappAccounts) ? user.whatsappAccounts : [];
  const accountId = String(accounts[0] || user && user.whatsappAccount || '').trim();
  return isValidWhatsAppAccount(accountId) ? accountId : 'bot-1';
}

function canAccessWhatsAppAccount(user, accountId) {
  if (!isValidWhatsAppAccount(accountId)) {
    return false;
  }

  if (user && user.isAdmin) {
    return true;
  }

  return getAllowedWhatsAppAccountIds(user).includes(accountId);
}

function getAllowedWhatsAppAccountIds(user) {
  if (user && user.isAdmin) {
    return whatsappAccounts.map(account => account.id);
  }

  const accounts = Array.isArray(user && user.whatsappAccounts)
    ? user.whatsappAccounts.filter(isValidWhatsAppAccount)
    : [];

  return accounts.length ? accounts : [getDefaultWhatsAppAccountId(user)];
}

function getPublicWhatsAppAccounts(user) {
  refreshWhatsAppAccountLabels();
  const allowed = new Set(getAllowedWhatsAppAccountIds(user));
  return whatsappAccounts
    .filter(account => allowed.has(account.id))
    .map(account => ({
      id: account.id,
      label: account.label,
      clientId: account.clientId
    }));
}

function getWhatsAppAccountLabelState() {
  try {
    return JSON.parse(getAppState('whatsapp_account_labels', '{}') || '{}') || {};
  } catch (error) {
    return {};
  }
}

function refreshWhatsAppAccountLabels() {
  const labels = getWhatsAppAccountLabelState();

  for (const account of whatsappAccounts) {
    const state = whatsappAccountStates.get(account.id);
    const label = String(labels[account.id] || account.label || account.id).trim() || account.id;

    account.label = label;

    if (state) {
      state.label = label;
    }
  }
}

function updateWhatsAppAccountLabel(accountId, label) {
  const cleanAccountId = String(accountId || '').trim();

  if (!isValidWhatsAppAccount(cleanAccountId)) {
    throw new Error('Sesion WhatsApp invalida');
  }

  const cleanLabel = String(label || '').trim().slice(0, 80);

  if (!cleanLabel) {
    throw new Error('Falta nombre de sesion');
  }

  const labels = getWhatsAppAccountLabelState();
  labels[cleanAccountId] = cleanLabel;
  setAppState('whatsapp_account_labels', JSON.stringify(labels));
  refreshWhatsAppAccountLabels();

  return getWhatsAppAccountState(cleanAccountId);
}

function markWhatsAppState(state, ready = state === 'CONNECTED', accountId = 'bot-1') {
  const account = getWhatsAppAccountState(accountId);
  account.state = state;
  account.ready = Boolean(ready);
  account.lastEventAt = new Date().toISOString();

  if (account.id === 'bot-1') {
    whatsappState = account.state;
    whatsappReady = account.ready;
    whatsappLastEventAt = account.lastEventAt;
  }

  if (ready) {
    clearWhatsAppQr(account.id);
  }
}

function clearWhatsAppQr(accountId = 'bot-1') {
  const account = getWhatsAppAccountState(accountId);
  account.qr = null;
  account.qrText = null;
  account.qrSvg = null;

  if (account.id === 'bot-1') {
    whatsappQr = null;
    whatsappQrText = null;
    whatsappQrSvg = null;
  }
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
app.use(express.json({
  limit: `${parsePositiveInteger(process.env.SECOND_APP_JSON_LIMIT_MB, 25)}mb`
}));

const requireLoggedIn = requireAuth();
const requirePrivileged = requireLoggedIn;
const requireAdmin = requireAuth(['admin']);
const auditApiKeys = String(process.env.AUDIT_API_KEYS || process.env.AUDIT_API_KEY || '')
  .split(',')
  .map(key => key.trim())
  .filter(Boolean);

function getRequestBearerToken(req) {
  const authorization = String(req.get('authorization') || '').trim();
  const match = authorization.match(/^Bearer\s+(.+)$/i);
  return match ? match[1].trim() : '';
}

function isValidAuditApiKey(value) {
  const key = String(value || '').trim();

  if (!key || !auditApiKeys.length) {
    return false;
  }

  return auditApiKeys.some(candidate => {
    const left = Buffer.from(candidate);
    const right = Buffer.from(key);
    return left.length === right.length && crypto.timingSafeEqual(left, right);
  });
}

function requireAuditAccess(req, res, next) {
  const apiKey = req.get('x-audit-api-key') || getRequestBearerToken(req);

  if (isValidAuditApiKey(apiKey)) {
    req.auditAuth = { type: 'api-key' };
    return next();
  }

  if (!auditApiKeys.length) {
    return requireAdmin(req, res, next);
  }

  return res.status(401).json({
    success: false,
    error: 'API key de auditoria invalida o ausente'
  });
}

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
    whatsappAccounts: getPublicWhatsAppAccounts(req.user),
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

app.get('/cola', requireLoggedIn, (req, res) => {
  sendHtmlFile(res, 'queue.html');
});

app.get('/phantom', requireLoggedIn, (req, res) => {
  res.redirect('/phantom/suspendidos');
});

app.get('/phantom/suspendidos', requireLoggedIn, (req, res) => {
  sendHtmlFile(res, 'phantom.html');
});

app.get('/phantom/activos', requireLoggedIn, (req, res) => {
  sendHtmlFile(res, 'phantom.html');
});

app.get('/phantom/clientes', requireLoggedIn, (req, res) => {
  sendHtmlFile(res, 'phantom.html');
});

app.get('/phantom/baja', requireLoggedIn, (req, res) => {
  sendHtmlFile(res, 'phantom.html');
});

app.get('/whatsapp', requireAdmin, (req, res) => {
  sendHtmlFile(res, 'whatsapp.html');
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

function getVisibleTicketPhones(user, date) {
  const phones = new Set();

  for (const ticket of listVisibleTicketsForUser(user, date)) {
    for (const value of [ticket.phone, ...getTicketPhones(ticket)]) {
      const phone = normalizeChatPhone(value || '');

      if (phone) {
        phones.add(phone);
      }
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

function getTicketCategory(ticket) {
  const payload = parseTicketPayload(ticket);

  return String(
    payload.Categoria ||
    payload.categoria ||
    payload.Category ||
    payload.category ||
    payload.Tipo ||
    payload.tipo ||
    ''
  ).trim();
}

function getTicketPhones(ticket) {
  try {
    const phones = JSON.parse(ticket && ticket.phones_json || '[]');
    return Array.isArray(phones)
      ? phones.map(phone => normalizeChatPhone(phone)).filter(Boolean)
      : [];
  } catch (error) {
    return [];
  }
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
    ticket_category: getTicketCategory(ticket),
    ticket_phone: ticket.phone || '',
    ticket_phones: getTicketPhones(ticket),
    ticket_start: ticket.start || '',
    ticket_start_time: ticket.start_time || '',
    ticket_automatic_disabled_at: ticket.automatic_message_disabled_at || '',
    ticket_automatic_disabled_reason: ticket.automatic_message_disabled_reason || '',
    ticket_response_action: ticket.response_action || '',
    ticket_response_label: ticket.response_label || '',
    ticket_response_body: ticket.response_body || '',
    ticket_response_received_at: ticket.response_received_at || ''
  };
}

function parseAuditTimestamp(value, endOfDay = false) {
  const raw = String(value || '').trim();

  if (!raw) {
    return 0;
  }

  const normalized = /^\d{4}-\d{2}-\d{2}$/.test(raw)
    ? `${raw}T${endOfDay ? '23:59:59.999' : '00:00:00.000'}`
    : raw;
  const parsed = Date.parse(normalized);

  return Number.isFinite(parsed) ? parsed : 0;
}

function normalizeAuditLimit(value) {
  return Math.min(Math.max(Number(value) || 200, 1), 1000);
}

function addAuditPhones(target, values) {
  for (const value of values) {
    for (const candidate of getAuditPhoneCandidates(value)) {
      target.add(candidate);
    }
  }
}

function compactAuditTicket(ticket) {
  if (!ticket) {
    return null;
  }

  return {
    id: ticket.external_id,
    externalId: ticket.external_id,
    razonSocial: ticket.razon_social || '',
    delegacion: ticket.delegacion || '',
    status: ticket.status || '',
    start: ticket.start || '',
    startDate: ticket.start_date || '',
    startTime: ticket.start_time || '',
    phones: Array.from(new Set([ticket.phone, ...getTicketPhones(ticket)]
      .map(phone => normalizeChatPhone(phone))
      .filter(Boolean))),
    ida: getTicketIda(ticket),
    category: getTicketCategory(ticket)
  };
}

function compactAuditClient(client) {
  if (!client) {
    return null;
  }

  return {
    id: String(client.id || ''),
    razonSocial: client.razonSocial || client.razon_social || '',
    estado: client.estado || '',
    movil: client.movil || '',
    telefono: client.telefono || '',
    email: client.email || '',
    direccion: client.direccion || '',
    ciudad: client.ciudad || ''
  };
}

function compactMessageClient(client) {
  if (!client) {
    return null;
  }

  return {
    id: String(client.id || ''),
    razonSocial: client.razonSocial || client.razon_social || '',
    apellido: client.apellido || '',
    nombre: client.nombre || '',
    documento: client.documento || '',
    cuit: client.cuit || '',
    categoria: client.categoria || '',
    condicion: client.condicion || '',
    estado: client.estado || '',
    deuda: client.deuda || '',
    movil: client.movil || '',
    telefono: client.telefono || '',
    email: client.email || '',
    direccion: client.direccion || '',
    dirNumero: client.dirNumero || client.dir_numero || '',
    barrio: client.barrio || '',
    ciudad: client.ciudad || '',
    perfil: client.perfil || '',
    television: client.television || '',
    telefonia: client.telefonia || '',
    otros: client.otros || '',
    mac: client.mac || '',
    usuario: client.usuario || '',
    router: client.router || '',
    olt: client.olt || '',
    fechaAlta: client.fechaAlta || client.fecha_alta || '',
    fechaInstalacion: client.fechaInstalacion || client.fecha_instalacion || '',
    fechaUltimoCambio: client.fechaUltimoCambio || client.fecha_ultimo_cambio || '',
    fechaUltimaFactura: client.fechaUltimaFactura || client.fecha_ultima_factura || '',
    syncedAt: client.syncedAt || client.synced_at || ''
  };
}

function normalizeAuditMessage(row, store, context = {}) {
  const phone = normalizeChatPhone(row.phone || row.chat_id || '');
  const timestampTs = Number(row.timestamp_ts || 0);

  return {
    store,
    id: String(row.id || ''),
    accountId: row.whatsapp_account || context.accountId || (store === 'primary-sqlite' ? 'bot-1' : 'bot-2'),
    chatId: row.chat_id || '',
    phone,
    contactName: row.contact_name || '',
    direction: row.direction || '',
    body: row.body || '',
    timestampTs,
    timestampIso: row.timestamp_iso || (timestampTs ? new Date(timestampTs).toISOString() : ''),
    fromMe: Boolean(row.from_me),
    ack: row.ack === null || row.ack === undefined ? null : Number(row.ack),
    source: row.source || '',
    ownerUsername: row.owner_username || row.sent_by_username || '',
    sentByName: row.sent_by_name || '',
    createdAt: row.created_at || '',
    media: {
      hasMedia: Boolean(row.media_mime || row.media_filename || row.media_data),
      mime: row.media_mime || '',
      filename: row.media_filename || '',
      data: row.media_data || undefined
    }
  };
}

function dedupeAuditMessages(messages) {
  const seen = new Set();
  const output = [];

  for (const message of messages) {
    const key = `${message.store}:${message.id || message.chatId + ':' + message.timestampTs + ':' + message.body}`;

    if (!seen.has(key)) {
      seen.add(key);
      output.push(message);
    }
  }

  return output.sort((left, right) =>
    (left.timestampTs || 0) - (right.timestampTs || 0) ||
    String(left.id).localeCompare(String(right.id))
  );
}

async function buildAuditMessagesResponse(query = {}) {
  const limit = normalizeAuditLimit(query.limit);
  const fromTs = parseAuditTimestamp(query.from || query.fromDate || query.since);
  const toTs = parseAuditTimestamp(query.to || query.toDate || query.until, true);
  const includeMedia = ['1', 'true', 'yes', 'si'].includes(String(query.includeMedia || '').toLowerCase());
  const source = String(query.source || 'primary').trim().toLowerCase();
  const accountId = String(query.accountId || query.whatsappAccount || '').trim();
  const phoneInput = String(query.phone || query.telefono || '').trim();
  const ticketInput = String(query.ticket || query.ticketId || query.externalId || '').trim();
  const clientIdInput = String(query.clientId || query.ida || query.IDA || '').trim();
  const clientInput = String(query.client || query.cliente || query.razonSocial || '').trim();
  const phones = new Set();
  const ticketMap = new Map();
  const clientMap = new Map();
  const warnings = [];

  if (phoneInput) {
    addAuditPhones(phones, [phoneInput]);
  }

  if (ticketInput) {
    const ticket = getTicket(ticketInput);

    if (ticket) {
      ticketMap.set(ticket.external_id, ticket);
      addAuditPhones(phones, [ticket.phone, ...getTicketPhones(ticket)]);
    }
  }

  for (const ticket of listTicketsForAudit({
    phone: phoneInput,
    client: clientInput,
    limit: 50
  })) {
    ticketMap.set(ticket.external_id, ticket);
    addAuditPhones(phones, [ticket.phone, ...getTicketPhones(ticket)]);
  }

  if (clientIdInput || clientInput || phoneInput) {
    try {
      const clientMatches = [];

      if (clientIdInput) {
        const client = await secondDb.findPhantomClientById(clientIdInput);
        if (client) {
          clientMatches.push(client);
        }

        for (const link of await secondDb.listClientChatLinks(clientIdInput, 100)) {
          addAuditPhones(phones, [link.phone, link.chat_id]);
        }
      }

      if (phoneInput) {
        clientMatches.push(...await secondDb.findPhantomClientsByPhone(phoneInput, 10));
      }

      if (clientInput) {
        const searchResult = await secondDb.listPhantomBajaClients({
          search: clientInput,
          limit: 10,
          offset: 0
        });
        clientMatches.push(...searchResult.rows);
      }

      for (const client of clientMatches) {
        const id = String(client.id || '');
        if (id && !clientMap.has(id)) {
          clientMap.set(id, client);
          addAuditPhones(phones, [client.movil, client.telefono]);
        }
      }
    } catch (error) {
      warnings.push(`No se pudo consultar clientes MySQL: ${error.message}`);
    }
  }

  if (!phones.size && !ticketInput && !clientIdInput && !clientInput) {
    const error = new Error('Indica phone, ticket, clientId o client');
    error.statusCode = 400;
    throw error;
  }

  const messages = [];
  const queryOptions = { accountId, fromTs, toTs, includeMedia };

  if (source === 'all' || source === 'primary' || source === 'sqlite') {
    for (const phone of phones) {
      for (const row of listWhatsAppMessagesByPhone(phone, limit, queryOptions)) {
        messages.push(normalizeAuditMessage(row, 'primary-sqlite'));
      }
    }
  }

  if (source === 'all' || source === 'second' || source === 'mysql') {
    try {
      for (const phone of phones) {
        for (const row of await secondDb.listWhatsAppMessagesByPhone(phone, limit, queryOptions)) {
          messages.push(normalizeAuditMessage(row, 'second-mysql', { accountId: 'bot-2' }));
        }
      }
    } catch (error) {
      warnings.push(`No se pudo consultar mensajes MySQL: ${error.message}`);
    }
  }

  const normalizedMessages = dedupeAuditMessages(messages).slice(-limit);

  return {
    success: true,
    query: {
      phone: phoneInput,
      ticket: ticketInput,
      clientId: clientIdInput,
      client: clientInput,
      source,
      accountId,
      fromTs: fromTs || null,
      toTs: toTs || null,
      limit,
      includeMedia
    },
    resolved: {
      phones: Array.from(phones),
      tickets: Array.from(ticketMap.values()).map(compactAuditTicket),
      clients: Array.from(clientMap.values()).map(compactAuditClient)
    },
    count: normalizedMessages.length,
    warnings,
    messages: normalizedMessages
  };
}

function buildTicketInfoByPhone(user) {
  const byPhone = new Map();
  const tickets = listVisibleTicketsForUser(user, getTodayDateString())
    .slice()
    .sort((left, right) => Number(right.start_ts || 0) - Number(left.start_ts || 0));

  for (const ticket of tickets) {
    const phones = [ticket.phone, ...getTicketPhones(ticket)]
      .map(value => normalizeChatPhone(value || ''))
      .filter(Boolean);

    for (const phone of phones) {
      if (!byPhone.has(phone)) {
        byPhone.set(phone, getTicketInfo(ticket));
      }
    }
  }

  return byPhone;
}

function attachTicketInfoToConversations(user, conversations) {
  const ticketsByPhone = buildTicketInfoByPhone(user);

  return conversations.map(conversation => {
    const phone = normalizeChatPhone(conversation && conversation.phone || '');
    const chatPhone = normalizeChatPhone(conversation && conversation.chat_id || '');
    let ticketInfo = ticketsByPhone.get(phone) || ticketsByPhone.get(chatPhone) || {};

    if (!ticketInfo.ticket_external_id) {
      const responseAction = getLatestTicketResponseActionByChat(
        conversation && conversation.chat_id,
        conversation && conversation.phone
      );
      const responseTicket = responseAction && getTicket(responseAction.ticket_external_id);

      if (responseTicket && canAccessTicket(user, responseTicket.external_id)) {
        ticketInfo = getTicketInfo(responseTicket);
      }
    }

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

function normalizeConversationOwner(value) {
  return String(value || '').trim().toLowerCase();
}

function conversationWasStartedByUser(conversation, user) {
  const username = normalizeConversationOwner(user && user.username);
  const sender = normalizeConversationOwner(
    conversation && (
      conversation.last_sent_by_username ||
      conversation.sent_by_username ||
      conversation.owner_username
    )
  );

  if (!username) {
    return false;
  }

  if (sender && username === sender) {
    return true;
  }

  return listWhatsAppMessages(
    conversation && conversation.chat_id,
    80,
    { accountId: conversation && conversation.whatsapp_account }
  ).some(message => normalizeConversationOwner(message && message.sent_by_username) === username);
}

function userHasTicketGroupRestrictions(user) {
  return Array.isArray(user && user.groups) && user.groups.length > 0;
}

function canReadAllConversationsForAccount(user, accountId) {
  if (!canAccessWhatsAppAccount(user, accountId)) {
    return false;
  }

  return Boolean(user && user.isAdmin) || !userHasTicketGroupRestrictions(user);
}

function listVisibleConversationsForUser(user, limit) {
  return listConversationBucketsForUser(user, limit).conversations;
}

function isAppStartedConversation(conversation) {
  return Number(conversation && conversation.app_started_messages || 0) > 0 ||
    Number(conversation && conversation.outgoing_messages || 0) > 0;
}

function isTicketLinkedConversation(conversation) {
  return Boolean(
    conversation &&
    (
      conversation.ticket_external_id ||
      conversation.ticket_ida ||
      conversation.ticket_razon_social ||
      conversation.ticket_delegacion ||
      conversation.ticket_start
    )
  );
}

function isTrackedConversation(conversation) {
  return isAppStartedConversation(conversation) || isTicketLinkedConversation(conversation);
}

function isOtherConversation(conversation) {
  return !isTrackedConversation(conversation) && String(conversation && conversation.direction || '') === 'incoming';
}

function getConversationChatId(conversation) {
  return String(conversation && conversation.chat_id || '').trim();
}

function getConversationAccountId(conversation) {
  return String(conversation && conversation.whatsapp_account || conversation && conversation.accountId || 'bot-1').trim() || 'bot-1';
}

function getConversationIdentity(conversation) {
  return `${getConversationAccountId(conversation)}:${getConversationChatId(conversation)}`;
}

function getRepresentedChatIds(conversations) {
  const represented = new Set();

  for (const conversation of conversations) {
    const chatId = getConversationChatId(conversation);
    const accountId = getConversationAccountId(conversation);

    if (!chatId) {
      continue;
    }

    represented.add(`${accountId}:${chatId}`);

    for (const message of listWhatsAppMessages(chatId, 80, { accountId })) {
      const messageChatId = String(message && message.chat_id || '').trim();

      if (messageChatId) {
        represented.add(`${accountId}:${messageChatId}`);
      }
    }
  }

  return represented;
}

function attachBucketOverride(conversation, overridesByChatId) {
  const chatId = getConversationChatId(conversation);
  const accountId = getConversationAccountId(conversation);
  const override = overridesByChatId.get(`${accountId}:${chatId}`);

  if (!override) {
    return conversation;
  }

  return {
    ...conversation,
    conversation_bucket_override: override.bucket,
    conversation_bucket_updated_by: override.updated_by || '',
    conversation_bucket_updated_at: override.updated_at || ''
  };
}

function sortConversationsByLatest(conversations) {
  return [...conversations].sort((left, right) => {
    const rightTime = Number(right && right.timestamp_ts || 0);
    const leftTime = Number(left && left.timestamp_ts || 0);
    const timeDelta = rightTime - leftTime;

    if (timeDelta) {
      return timeDelta;
    }

    return getConversationChatId(left).localeCompare(getConversationChatId(right));
  });
}

function splitConversationBuckets(conversations, requestedLimit) {
  const overridesByChatId = new Map(
    listWhatsAppConversationBucketOverrides()
      .map(override => [
        `${String(override.whatsapp_account || 'bot-1').trim() || 'bot-1'}:${String(override.chat_id || '').trim()}`,
        override
      ])
  );
  const withOverrides = conversations.map(conversation => attachBucketOverride(conversation, overridesByChatId));
  const forcedMain = withOverrides.filter(conversation => conversation.conversation_bucket_override === 'main');
  const forcedOther = withOverrides.filter(conversation => conversation.conversation_bucket_override === 'other');
  const autoConversations = withOverrides.filter(conversation => !conversation.conversation_bucket_override);
  const trackedConversations = [
    ...sortConversationsByLatest(forcedMain),
    ...sortConversationsByLatest(autoConversations.filter(isTrackedConversation))
  ]
    .slice(0, requestedLimit);
  const representedChatIds = getRepresentedChatIds(trackedConversations);

  return {
    conversations: trackedConversations,
    otherConversations: [
      ...sortConversationsByLatest(forcedOther),
      ...sortConversationsByLatest(
        autoConversations.filter(conversation => isOtherConversation(conversation) && !representedChatIds.has(getConversationIdentity(conversation)))
      )
    ]
      .slice(0, requestedLimit)
  };
}

function listConversationBucketsForUser(user, limit) {
  const requestedLimit = Math.min(Math.max(Number(limit) || 100, 1), 300);
  const accountIds = getAllowedWhatsAppAccountIds(user);
  const allConversations = accountIds.flatMap(accountId => listWhatsAppConversations(1000, { accountId }));

  if (user && user.isAdmin) {
    return splitConversationBuckets(
      attachTicketInfoToConversations(user, allConversations),
      requestedLimit
    );
  }

  const phones = getVisibleTicketPhones(user, getTodayDateString());

  return splitConversationBuckets(
    attachTicketInfoToConversations(
      user,
      allConversations
        .filter(conversation => (
          canReadAllConversationsForAccount(user, getConversationAccountId(conversation)) ||
          conversationMatchesPhones(conversation, phones) ||
          conversationWasStartedByUser(conversation, user)
        ))
    ),
    requestedLimit
  );
}

function canReadChat(user, chatId, accountId = 'bot-1') {
  if (!canAccessWhatsAppAccount(user, accountId)) {
    return false;
  }

  if (user && user.isAdmin) {
    return true;
  }

  if (canReadAllConversationsForAccount(user, accountId)) {
    return true;
  }

  const phones = getVisibleTicketPhones(user);
  const candidatePhones = [
    chatId,
    ...listWhatsAppChatPhones(chatId)
  ].map(value => normalizeChatPhone(value));

  if (candidatePhones.some(candidatePhone => candidatePhone && phones.has(candidatePhone))) {
    return true;
  }

  return listWhatsAppMessages(chatId, 80, { accountId })
    .some(message => normalizeConversationOwner(message && message.sent_by_username) === normalizeConversationOwner(user && user.username));
}

function canSendToAnyTarget(user) {
  return Boolean(user && (user.isAdmin || user.role === 'usuario'));
}

function canSendToTarget(user, chatId, phone, accountId = 'bot-1') {
  if (!canAccessWhatsAppAccount(user, accountId)) {
    return false;
  }

  if (canSendToAnyTarget(user)) {
    return true;
  }

  const cleanChatId = String(chatId || '').trim();
  const cleanPhone = normalizeChatPhone(phone || cleanChatId);

  if (!cleanPhone) {
    return false;
  }

  if (!cleanChatId) {
    return true;
  }

  if (cleanChatId) {
    if (canReadChat(user, cleanChatId, accountId)) {
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
    return [ticket && ticket.phone, ...getTicketPhones(ticket)].some(value => {
      const phone = normalizeChatPhone(value || '');

      return phone && phones.has(phone);
    });
  });
}

function createWhatsAppClient(accountId = 'bot-1') {
  const account = getWhatsAppAccountConfig(accountId);

  return new Client({
    authStrategy: new LocalAuth({
      clientId: account.clientId,
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

function removeWhatsAppAuthSession(accountId = 'bot-1') {
  const account = getWhatsAppAccountConfig(accountId);
  const authSessionDir = path.resolve(whatsappAuthRoot, `session-${account.clientId}`);
  const rootWithSeparator = whatsappAuthRoot.endsWith(path.sep)
    ? whatsappAuthRoot
    : `${whatsappAuthRoot}${path.sep}`;

  if (!authSessionDir.startsWith(rootWithSeparator)) {
    throw new Error('Ruta de sesion WhatsApp invalida');
  }

  fs.rmSync(authSessionDir, {
    force: true,
    recursive: true,
    maxRetries: 5,
    retryDelay: 500
  });
}

function attachWhatsAppEvents(instance, accountId = 'bot-1') {
  const account = getWhatsAppAccountConfig(accountId);

  instance.on('qr', qr => {
    markWhatsAppState('QR', false, account.id);
    account.lastError = null;
    account.qr = qr;
    account.qrText = createQrText(qr);
    account.qrSvg = createQrSvgDataUrl(qr);

    if (account.id === 'bot-1') {
      whatsappLastError = null;
      whatsappQr = account.qr;
      whatsappQrText = account.qrText;
      whatsappQrSvg = account.qrSvg;
    }

    console.log(`Escanea este QR con WhatsApp (${account.label}):`);
    qrcode.generate(qr, { small: true });
  });

  instance.on('authenticated', () => {
    markWhatsAppState('AUTHENTICATED', false, account.id);
    clearWhatsAppQr(account.id);
    console.log(`WhatsApp autenticado (${account.label})`);
  });

  instance.on('auth_failure', msg => {
    markWhatsAppState('AUTH_FAILURE', false, account.id);
    clearWhatsAppQr(account.id);
    account.lastError = String(msg || 'Fallo de autenticacion');

    if (account.id === 'bot-1') {
      whatsappLastError = account.lastError;
    }

    console.error(`Fallo de autenticacion (${account.label}):`, msg);
  });

  instance.on('ready', () => {
    markWhatsAppState('CONNECTED', true, account.id);
    account.lastError = null;

    if (account.id === 'bot-1') {
      whatsappLastError = null;
    }

    console.log(`WhatsApp conectado (${account.label})`);
  });

  instance.on('change_state', state => {
    markWhatsAppState(state || 'UNKNOWN', state === 'CONNECTED', account.id);
    console.log(`Estado de WhatsApp (${account.label}):`, state);
  });

  instance.on('disconnected', reason => {
    markWhatsAppState(`DISCONNECTED: ${reason}`, false, account.id);
    clearWhatsAppQr(account.id);
    console.log(`WhatsApp desconectado (${account.label}):`, reason);
  });

  instance.on('message', message => {
    storeWhatsAppMessage(message, 'whatsapp', account.id)
      .then(storedMessage => {
        if (account.id === 'bot-1') {
          return processIncomingTicketResponse(storedMessage);
        }
        return null;
      })
      .catch(error => {
        console.warn('No se pudo guardar mensaje entrante:', error.message);
      });
  });

  instance.on('message_create', message => {
    storeWhatsAppMessage(message, 'whatsapp', account.id).catch(error => {
      console.warn('No se pudo guardar mensaje creado:', error.message);
    });
  });

  instance.on('message_ack', (message, ack) => {
    try {
      const messageId = message && message.id && message.id._serialized;
      updateWhatsAppMessageAck(messageId, ack);
    } catch (error) {
      console.warn('No se pudo actualizar estado del mensaje:', error.message);
    }
  });
}

function canAccessTicket(user, ticketExternalId) {
  const cleanExternalId = String(ticketExternalId || '').trim();

  if (!cleanExternalId) {
    return false;
  }

  if (user && user.isAdmin) {
    return Boolean(getTicket(cleanExternalId));
  }

  return listVisibleTicketsForUser(user).some(ticket => String(ticket.external_id || '') === cleanExternalId);
}

async function initializeWhatsAppClient(accountId = 'bot-1') {
  const account = getWhatsAppAccountState(accountId);

  if (account.initializing) {
    return account.client;
  }

  if (account.client && !account.restarting) {
    return account.client;
  }

  account.initializing = true;
  account.client = createWhatsAppClient(account.id);
  if (account.id === 'bot-1') {
    client = account.client;
  }
  attachWhatsAppEvents(account.client, account.id);

  try {
    await account.client.initialize();
  } catch (error) {
    markWhatsAppState('INIT_ERROR', false, account.id);
    account.lastError = error.message;
    if (account.id === 'bot-1') {
      whatsappLastError = error.message;
    }
    console.error(`Error iniciando WhatsApp (${account.label}):`, error);
    throw error;
  } finally {
    account.initializing = false;
  }

  return account.client;
}

async function initializeWhatsAppClients() {
  for (const account of whatsappAccounts) {
    initializeWhatsAppClient(account.id).catch(() => {});
  }
}

async function restartWhatsAppClient(reason = 'manual', options = {}) {
  const accountId = isValidWhatsAppAccount(options.accountId) ? options.accountId : 'bot-1';
  const account = getWhatsAppAccountState(accountId);

  if (account.restarting) {
    return getWhatsAppStatus(account.id);
  }

  account.restarting = true;

  if (account.id === 'bot-1') {
    whatsappRestarting = true;
  }

  markWhatsAppState(options.resetAuth ? 'RESETTING_AUTH' : 'RESTARTING', false, account.id);
  account.lastError = null;
  clearWhatsAppQr(account.id);
  console.log(`Reiniciando WhatsApp ${account.label} (${reason})`);

  const oldClient = account.client;
  account.client = null;

  if (account.id === 'bot-1') {
    client = null;
    whatsappLastError = null;
  }

  if (oldClient) {
    try {
      await oldClient.destroy();
    } catch (error) {
      console.warn(`No se pudo cerrar cliente WhatsApp anterior (${account.label}):`, error.message);
    }
  }

  try {
    if (options.resetAuth) {
      removeWhatsAppAuthSession(account.id);
      console.log(`Sesion local de WhatsApp eliminada (${account.label})`);
    }

    initializeWhatsAppClient(account.id).catch(() => {});
    return getWhatsAppStatus(account.id);
  } finally {
    account.restarting = false;
    if (account.id === 'bot-1') {
      whatsappRestarting = false;
    }
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
    message.includes('protocol error');
}

function createTransientWhatsAppError(error) {
  const detail = String(error && error.message || error || '').trim();
  const nextError = new Error(detail
    ? `WhatsApp se recargo durante la operacion. Reintentando cuando vuelva a conectar. Detalle: ${detail}`
    : 'WhatsApp se recargo durante la operacion. Reintentando cuando vuelva a conectar.');

  nextError.code = 'WHATSAPP_TRANSIENT';
  nextError.cause = error;
  return nextError;
}

function handleTransientWhatsAppError(error, reason, accountId = 'bot-1') {
  if (!isTransientWhatsAppError(error)) {
    return false;
  }

  const account = getWhatsAppAccountState(accountId);
  const transientError = createTransientWhatsAppError(error);
  account.lastError = transientError.message;

  if (account.id === 'bot-1') {
    whatsappLastError = transientError.message;
  }

  markWhatsAppState('SESSION_REFRESHING', false, account.id);
  restartWhatsAppClient(reason, { accountId: account.id }).catch(restartError => {
    console.warn(`No se pudo reiniciar WhatsApp tras error transitorio (${account.label}):`, restartError.message);
  });
  return true;
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

function hasSerializedMessageId(message) {
  return Boolean(message && message.id && message.id._serialized);
}

function getMessageChatId(message, fallback = '') {
  const data = message && message._data || {};
  const id = message && message.id || {};
  const remote = id.remote || data.remote || data.id && data.id.remote || '';
  const preferred = message && message.fromMe
    ? message.to || data.to || data.toId && data.toId._serialized
    : message && (message.from || data.from || data.fromId && data.fromId._serialized);
  const chatId = String(preferred || remote || fallback || '').trim();

  return chatId;
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

async function getMessageContactInfo(message, chatId, accountId = 'bot-1') {
  const account = getWhatsAppAccountState(accountId);
  const accountClient = account.client || client;
  let contact = null;

  if (accountClient && message.fromMe && chatId) {
    try {
      contact = await accountClient.getContactById(chatId);
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
  return Boolean(String(mimetype || '').trim());
}

function wait(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function getMessageMediaInfo(message, accountId = 'bot-1') {
  if (!message.hasMedia || !message.downloadMedia) {
    return {};
  }

  for (let attempt = 0; attempt < mediaDownloadRetryDelaysMs.length; attempt += 1) {
    const delay = mediaDownloadRetryDelaysMs[attempt];

    if (delay) {
      await wait(delay);
    }

    try {
      const media = await message.downloadMedia();

      if (!media || !media.mimetype) {
        continue;
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
      if (attempt === mediaDownloadRetryDelaysMs.length - 1) {
        if (handleTransientWhatsAppError(error, 'media-download-error', accountId)) {
          return {};
        }

        console.warn('No se pudo descargar media de WhatsApp:', error.message);
      }
    }
  }

  return {};
}

async function storeWhatsAppMessage(message, source = 'whatsapp', accountId = 'bot-1') {
  try {
    const chatId = getMessageChatId(message);

    if (!chatId || chatId === 'status@broadcast' || chatId.endsWith('@g.us')) {
      return null;
    }

    const direction = message.fromMe ? 'outgoing' : 'incoming';
    const rawBody = String(message.body || message.caption || '').trim();
    const systemTypes = new Set(['e2e_notification', 'notification_template', 'ciphertext']);
    const mediaInfo = await getMessageMediaInfo(message, accountId);

    if (!rawBody && systemTypes.has(String(message.type || '').toLowerCase())) {
      return null;
    }

    const body = rawBody || `[${getMediaLabel(mediaInfo.mediaMime, message.type)} sin texto]`;
    const contactInfo = await getMessageContactInfo(message, chatId, accountId);

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
      source,
      whatsappAccount: accountId
    });
  } catch (error) {
    handleTransientWhatsAppError(error, 'media-download-error', accountId);
    console.warn('No se pudo guardar mensaje de WhatsApp:', error.message);
    return null;
  }
}

function getChatSortTimestamp(chat) {
  const value = Number(chat && (chat.timestamp || chat.lastMessage && chat.lastMessage.timestamp));

  if (!Number.isFinite(value) || value <= 0) {
    return 0;
  }

  return value < 1000000000000 ? value * 1000 : value;
}

function isSyncableWhatsAppChat(chat) {
  const chatId = String(chat && chat.id && chat.id._serialized || '').trim();

  return Boolean(chatId && chatId !== 'status@broadcast' && !chatId.endsWith('@g.us'));
}

async function syncRecentWhatsAppMessages(options = {}) {
  const now = Date.now();

  if (!client || !whatsappReady || recentMessagesSyncRunning) {
    return;
  }

  if (!options.force && now - lastRecentMessagesSyncAt < recentMessagesSyncIntervalMs) {
    return;
  }

  recentMessagesSyncRunning = true;
  lastRecentMessagesSyncAt = now;

  try {
    const chats = await client.getChats();
    const recentChats = chats
      .filter(isSyncableWhatsAppChat)
      .sort((left, right) => {
        const unreadDelta = Number(right.unreadCount || 0) - Number(left.unreadCount || 0);

        if (unreadDelta) {
          return unreadDelta;
        }

        return getChatSortTimestamp(right) - getChatSortTimestamp(left);
      })
      .slice(0, recentMessagesSyncChatLimit);

    for (const chat of recentChats) {
      const chatId = String(chat && chat.id && chat.id._serialized || '').trim();
      const lastChatSync = lastRecentMessagesSyncByChat.get(chatId) || 0;

      if (!options.force && now - lastChatSync < recentMessagesSyncChatCooldownMs) {
        continue;
      }

      lastRecentMessagesSyncByChat.set(chatId, now);

      try {
        const messages = await chat.fetchMessages({ limit: recentMessagesSyncMessageLimit });

        for (const message of messages) {
          await storeWhatsAppMessage(message, 'whatsapp');
        }
      } catch (error) {
        if (handleTransientWhatsAppError(error, 'recent-messages-sync-error')) {
          console.warn(`WhatsApp se recargo mientras se sincronizaban mensajes recientes de ${chatId}.`);
          return;
        }

        console.warn(`No se pudieron sincronizar mensajes recientes de ${chatId}:`, error.message);
      }
    }
  } catch (error) {
    if (handleTransientWhatsAppError(error, 'recent-chats-sync-error')) {
      console.warn('WhatsApp se recargo mientras se listaban chats recientes.');
      return;
    }

    console.warn('No se pudieron sincronizar chats recientes de WhatsApp:', error.message);
  } finally {
    recentMessagesSyncRunning = false;
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

  if (!isNotificationChannelReplyEnabled()) {
    return false;
  }

  const now = Date.now();
  const lastReplyAt = notificationChannelReplyByChat.get(chatId) || 0;

  if (now - lastReplyAt < notificationChannelReplyCooldownMs) {
    return false;
  }

  const recentReply = getRecentOutgoingMessageBySource(
    chatId,
    'notification-channel',
    now - notificationChannelReplyCooldownMs
  );

  if (recentReply) {
    notificationChannelReplyByChat.set(chatId, Number(recentReply.timestamp_ts || now));
    return false;
  }

  const recentOutgoing = getRecentOutgoingMessage(
    chatId,
    now - notificationChannelSuppressAfterManualMs
  );
  const recentOutgoingSource = String(recentOutgoing && recentOutgoing.source || '').trim();

  if (recentOutgoingSource === 'manual' || recentOutgoingSource === 'inbox') {
    console.log(`No se envia aviso de canal a ${chatId}: conversacion iniciada manualmente.`);
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
  const canStoreInline = Boolean(mime);
  const mediaPlaceholder = /^\[(image|imagen|audio|ptt|video|archivo|document) sin texto\]$/.test(body);

  return !message.media_data && (canStoreInline || mediaPlaceholder);
}

async function backfillChatMedia(chatId, accountId = 'bot-1') {
  const now = Date.now();
  const account = getWhatsAppAccountState(accountId);
  const backfillKey = `${account.id}:${chatId}`;
  const lastBackfill = lastMediaBackfillByChat.get(backfillKey) || 0;

  if (!account.client || !account.ready || now - lastBackfill < 30000) {
    return;
  }

  const storedMessages = listWhatsAppMessages(chatId, 80, {
    accountId: account.id
  });
  const missingIds = new Set(
    storedMessages
      .filter(isMissingStoredMedia)
      .map(message => message.id)
  );

  if (!missingIds.size) {
    return;
  }

  lastMediaBackfillByChat.set(backfillKey, now);

  try {
    const chat = await account.client.getChatById(chatId);
    const recentMessages = await chat.fetchMessages({ limit: 80 });

    for (const message of recentMessages) {
      if (message.id && missingIds.has(message.id._serialized)) {
        await storeWhatsAppMessage(message, 'whatsapp', account.id);
      }
    }
  } catch (error) {
    if (handleTransientWhatsAppError(error, 'media-backfill-error', account.id)) {
      console.warn(`WhatsApp se recargo mientras se recuperaba media del chat ${chatId}. Se reintentara luego.`);
      return;
    }

    console.warn(`No se pudo recuperar media del chat ${chatId}:`, error.message);
  }
}

initializeWhatsAppClients();

async function getWhatsAppStatus(accountId = 'bot-1') {
  const account = getWhatsAppAccountState(accountId);
  const accountClient = account.client;

  try {
    if (accountClient && accountClient.pupPage) {
      const state = await accountClient.getState();

      if (state) {
        markWhatsAppState(state, state === 'CONNECTED', account.id);
      }
    }
  } catch (error) {
    if (handleTransientWhatsAppError(error, 'status-check-error', account.id)) {
      // Keep returning the current status object below.
    } else {
      account.lastError = error.message;

      if (account.id === 'bot-1') {
        whatsappLastError = error.message;
      }
    }
  }

  const connectedInfo = getConnectedWhatsAppInfo(account.id);

  return {
    id: account.id,
    label: account.label,
    clientId: account.clientId,
    ready: account.ready,
    state: account.state,
    phone: connectedInfo.phone,
    displayName: connectedInfo.displayName,
    wid: connectedInfo.wid,
    lastEventAt: account.lastEventAt,
    lastError: account.lastError,
    qr: account.ready ? null : account.qr,
    qrText: account.ready ? null : account.qrText,
    qrSvg: account.ready ? null : account.qrSvg
  };
}

async function getWhatsAppAccountsStatus() {
  const accounts = [];

  for (const account of whatsappAccounts) {
    accounts.push(await getWhatsAppStatus(account.id));
  }

  return accounts;
}

function getConnectedWhatsAppInfo(accountId = 'bot-1') {
  const account = getWhatsAppAccountState(accountId);
  const info = account.client && account.client.info || {};
  const wid = info.wid && (info.wid._serialized || info.wid.user) || '';
  const phone = normalizeChatPhone(info.wid && info.wid.user || wid);

  return {
    phone,
    displayName: String(info.pushname || info.name || '').trim(),
    wid: String(wid || '').trim()
  };
}

setInterval(() => {
  getWhatsAppAccountsStatus().catch(() => {});
  syncRecentWhatsAppMessages().catch(() => {});
}, 15000);

function isWhatsAppReady() {
  return getWhatsAppAccountState('bot-1').ready;
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
  const accountId = isValidWhatsAppAccount(options.accountId || options.whatsappAccount)
    ? String(options.accountId || options.whatsappAccount).trim()
    : 'bot-1';
  const account = getWhatsAppAccountState(accountId);

  await getWhatsAppStatus(account.id);

  if (!account.client || !account.ready) {
    throw new Error(`${account.label} todavia no esta conectado (${account.state})`);
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

  console.log(`Enviando desde ${account.label} a:`, targetChatId || cleanPhone);

  let chatId = targetChatId;
  let sentMessage = null;

  try {
    if (!chatId) {
      const numberId = await account.client.getNumberId(cleanPhone);

      if (!numberId) {
        throw new Error('El numero no existe en WhatsApp o no se pudo resolver');
      }

      chatId = numberId._serialized;
    }

    console.log('Chat ID resuelto:', chatId);
    sentMessage = await account.client.sendMessage(chatId, fullMessage);
  } catch (error) {
    if (handleTransientWhatsAppError(error, 'send-error', account.id)) {
      throw createTransientWhatsAppError(error);
    }

    throw error;
  }
  const sentMessageId = getStoredMessageId(sentMessage, chatId, 'outgoing');
  let savedMessage = null;

  try {
    savedMessage = saveWhatsAppMessage({
      id: sentMessageId,
      chatId,
      phone: cleanPhone,
      direction: 'outgoing',
      body: fullMessage,
      timestampTs: getWhatsAppTimestampMs(sentMessage && sentMessage.timestamp),
      fromMe: true,
      ack: sentMessage && sentMessage.ack,
      source,
      sentByUsername: options.sentByUsername,
      sentByName: options.sentByName,
      whatsappAccount: account.id
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
        sentMessageId: sentMessageId || undefined
      });
    } catch (error) {
      console.warn('Mensaje enviado, pero no se pudo registrar la pregunta pendiente:', error.message);
    }
  }

  if (sentMessage && typeof sentMessage === 'object') {
    sentMessage._savedMessage = savedMessage;
    sentMessage._resolvedChatId = chatId;
  }

  return sentMessage;
}

async function validateWhatsAppTarget(phone, accountId = 'bot-1') {
  const account = getWhatsAppAccountState(accountId);

  await getWhatsAppStatus(account.id);

  if (!account.client || !account.ready) {
    throw new Error(`${account.label} todavia no esta conectado (${account.state})`);
  }

  const cleanPhone = normalizeChatPhone(phone);

  if (!cleanPhone) {
    throw new Error('Falta telefono');
  }

  const numberId = await account.client.getNumberId(cleanPhone);

  return {
    exists: Boolean(numberId),
    phone: cleanPhone,
    chatId: numberId && numberId._serialized || '',
    accountId: account.id
  };
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

function createSecondMessageTemplateId() {
  return `tpl_${Date.now().toString(36)}_${crypto.randomBytes(3).toString('hex')}`;
}

function normalizeSecondMessageTemplateRecords(value) {
  const source = Array.isArray(value)
    ? value
    : parseSecondMessageTemplates(value).map(body => ({ body }));
  const usedIds = new Set();
  const records = [];
  const now = nowIso();

  source.forEach((item, index) => {
    const record = item && typeof item === 'object' && !Array.isArray(item) ? item : { body: item };
    const body = String(record.body ?? record.template ?? record.text ?? '').trim();

    if (!body) {
      return;
    }

    let id = String(record.id || '').trim();
    if (!/^[a-zA-Z0-9_-]{1,80}$/.test(id) || usedIds.has(id)) {
      id = `tpl_${index + 1}`;
      let suffix = 2;
      while (usedIds.has(id)) {
        id = `tpl_${index + 1}_${suffix}`;
        suffix += 1;
      }
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

function getSecondMessageTemplateRecords(settings = readSecondMessageSettings()) {
  const source = Array.isArray(settings.messageTemplates)
    ? settings.messageTemplates
    : Array.isArray(settings.templates)
      ? settings.templates
      : settings.template || getDefaultSecondMessageTemplate();
  const configured = normalizeSecondMessageTemplateRecords(source);

  return configured.length ? configured : normalizeSecondMessageTemplateRecords([{
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

  settings.template = cleanRecords[0].body;
  settings.templates = cleanRecords.map(record => record.body);
  settings.messageTemplates = cleanRecords;
  settings.cursor = Number.isFinite(Number(settings.cursor)) ? Number(settings.cursor) % cleanRecords.length : 0;
  settings.updatedAt = nowIso();
  writeSecondMessageSettings(settings);
  return cleanRecords;
}

function getNextSecondMessageTemplate() {
  const settings = readSecondMessageSettings();
  const records = getSecondMessageTemplateRecords(settings);
  const index = Number.isFinite(Number(settings.cursor)) ? Number(settings.cursor) % records.length : 0;
  const template = records[index];
  settings.cursor = (index + 1) % records.length;
  persistSecondMessageTemplateRecords(records, settings);

  return {
    id: template.id,
    name: template.name,
    template: template.body,
    index,
    total: records.length
  };
}

function createSecondMessageTemplate(input = {}) {
  const settings = readSecondMessageSettings();
  const records = getSecondMessageTemplateRecords(settings);
  const now = nowIso();
  const body = String(input.body ?? input.template ?? input.text ?? '').trim();

  if (!body) {
    throw new Error('El mensaje no puede estar vacio');
  }

  const template = {
    id: createSecondMessageTemplateId(),
    name: normalizeSecondMessageTemplateName(input.name ?? input.title, `Template ${records.length + 1}`),
    body,
    createdAt: now,
    updatedAt: now
  };
  persistSecondMessageTemplateRecords([...records, template], settings);
  return template;
}

function updateSecondMessageTemplate(id, input = {}) {
  const settings = readSecondMessageSettings();
  const records = getSecondMessageTemplateRecords(settings);
  const index = records.findIndex(record => record.id === String(id || '').trim());

  if (index === -1) {
    throw new Error('Template no encontrado');
  }

  const body = Object.prototype.hasOwnProperty.call(input, 'body') ||
    Object.prototype.hasOwnProperty.call(input, 'template') ||
    Object.prototype.hasOwnProperty.call(input, 'text')
    ? String(input.body ?? input.template ?? input.text ?? '').trim()
    : records[index].body;

  if (!body) {
    throw new Error('El mensaje no puede estar vacio');
  }

  const template = {
    ...records[index],
    name: normalizeSecondMessageTemplateName(input.name ?? input.title, records[index].name),
    body,
    updatedAt: nowIso()
  };
  const nextRecords = records.slice();
  nextRecords[index] = template;
  persistSecondMessageTemplateRecords(nextRecords, settings);
  return template;
}

function deleteSecondMessageTemplate(id) {
  const settings = readSecondMessageSettings();
  const records = getSecondMessageTemplateRecords(settings);
  const template = records.find(record => record.id === String(id || '').trim());

  if (!template) {
    throw new Error('Template no encontrado');
  }

  if (records.length === 1) {
    throw new Error('Debe quedar al menos un template');
  }

  persistSecondMessageTemplateRecords(records.filter(record => record.id !== template.id), settings);
  return template;
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

function renderStringTemplate(template, variables = {}) {
  return String(template || '').replace(/\{([a-zA-Z0-9_]+)\}/g, (match, key) => {
    const value = variables[key];
    return value === undefined || value === null ? match : String(value);
  });
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
  const match = text.match(/^(\d{4})-(\d{2})-(\d{2})(?:[ T]\d{2}:\d{2}:\d{2})?/);
  return match ? `${match[3]}/${match[2]}/${match[1]}` : text;
}

function invertPhantomSign(value) {
  if (value === undefined || value === null || value === '') {
    return '';
  }

  if (typeof value === 'number') {
    return Number.isFinite(value) ? -value : value;
  }

  const text = String(value).trim();
  if (!text || /^-?\s*0+(?:[,.]0+)?$/.test(text)) {
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

  const clean = String(value === undefined || value === null ? '' : value).trim().replace(/\s/g, '').replace(/[$%]/g, '');
  if (/^-?\d{1,3}(\.\d{3})*(,\d+)?$/.test(clean)) {
    return Number(clean.replace(/\./g, '').replace(',', '.')) || 0;
  }
  if (/^-?\d+([.,]\d+)?$/.test(clean)) {
    return Number(clean.replace(',', '.')) || 0;
  }
  return Number(clean) || 0;
}

function hasDebtOrOverdueReceipts(row = {}) {
  return parseDecimalValue(row.deuda) !== 0 || parseDecimalValue(row.comprobantesAdeudados) !== 0;
}

function formatPhantomClientRows(rows, options = {}) {
  const formattedRows = rows.map(row => {
    const razonFallback = [row && row.Apellido, row && row.Nombre].filter(Boolean).join(' ');
    const balance = getFirstPhantomValue(row, ['Balance_CC', 'BalanceCC', 'Balance', 'balance', 'Saldo', 'SaldoCC', 'SaldoCuentaCorriente']);
    return {
      id: getFirstPhantomValue(row, ['ID', 'Id', 'id', 'IDA', 'ida', 'ClienteID', 'Cliente_Id', 'Codigo', 'CodigoCliente']),
      razonSocial: getFirstPhantomValue(row, ['RS', 'RazonSocial', 'Razon_Social', 'Razon Social', 'Razon', 'razon_social'], razonFallback),
      deuda: invertPhantomSign(balance),
      estado: getFirstPhantomValue(row, ['Estado', 'estado']),
      movil: getFirstPhantomValue(row, ['Movil', 'Movil', 'movil', 'Celular', 'celular', 'Mobile', 'TelefonoMovil', 'TelMovil', 'Movi', 'movi']),
      telefono: getFirstPhantomValue(row, ['Telefono', 'Telefono', 'telefono', 'Tel', 'tel', 'Telefono1', 'Telefono_1']),
      fechaUltimaFactura: formatPhantomDateOnly(getFirstPhantomValue(row, ['Fecha_Ultima_Factura'])),
      fechaUltimoCambio: formatPhantomDateOnly(getFirstPhantomValue(row, ['Fecha_Ultimo_Cambio', 'fechaUltimoCambio', 'fecha_ultimo_cambio'])),
      fechaInstalacion: formatPhantomDateOnly(getFirstPhantomValue(row, ['Fecha_Instalacion', 'fechaInstalacion', 'fecha_instalacion'])),
      comprobantesAdeudados: getFirstPhantomValue(row, ['C_Comprobantes_Adeudados', 'Fecha_Ultimo_Mov', 'CompAdeudados', 'ComprobantesAdeudados', 'Comprobantes_Adeudados', 'compAdeudados', 'comp_adeudados', 'Adeudados']),
      raw: row
    };
  });

  return options.filterDebt === false ? formattedRows : formattedRows.filter(hasDebtOrOverdueReceipts);
}

function getFirstPhoneCandidate(value) {
  return String(value || '').split(/[;,|/\n\r\t]+/).map(item => item.trim()).find(Boolean) || '';
}

function normalizeArgentineMobilePhone(value, options = {}) {
  let phone = normalizeChatPhone(value).replace(/^00+/, '');
  const defaultAreaCode = String(options.defaultAreaCode || '11').replace(/\D/g, '') || '11';

  if (!phone) {
    return '';
  }
  if (phone.startsWith('549')) {
    phone = phone.slice(3);
  } else if (phone.startsWith('54')) {
    phone = phone.slice(2);
    if (phone.startsWith('9')) {
      phone = phone.slice(1);
    }
  }
  phone = phone.replace(/^0+/, '');
  if (phone.startsWith('15') && phone.length < 11) {
    phone = defaultAreaCode + phone.slice(2);
  }
  if (phone.length > 10) {
    for (let areaLength = 2; areaLength <= 4; areaLength += 1) {
      const prefix = phone.slice(0, areaLength);
      const rest = phone.slice(areaLength);
      if (rest.startsWith('15') && (prefix + rest.slice(2)).length === 10) {
        phone = prefix + rest.slice(2);
        break;
      }
    }
  }
  return phone.length === 10 ? `549${phone}` : '';
}

function normalizeSecondQueuePhone(value) {
  if (isDirectChatId(value)) {
    return String(value || '').trim();
  }
  return normalizeArgentineMobilePhone(getFirstPhoneCandidate(value));
}

function isValidSecondQueueTarget(value) {
  const target = String(value || '').trim();
  return isDirectChatId(target) || /^549\d{8,12}$/.test(target);
}

function normalizePhantomEstado(value, fallback = 'Suspendido') {
  return String(value || '').trim() || fallback;
}

function createMessageVariablesFromRow(row = {}) {
  const id = getFirstPhantomValue(row, ['id', 'ID', 'Id', 'IDA', 'ida', 'ClienteID', 'Cliente_Id', 'Codigo', 'CodigoCliente']);
  const razonSocial = getFirstPhantomValue(row, ['razonSocial', 'razon_social', 'RS', 'RazonSocial', 'Razon_Social', 'Razon Social', 'Razon']);
  const movil = getFirstPhantomValue(row, ['movil', 'Movil', 'Celular', 'celular', 'Mobile', 'TelefonoMovil', 'TelMovil']);
  const telefono = getFirstPhantomValue(row, ['telefono', 'Telefono', 'Tel', 'tel', 'Telefono1', 'Telefono_1']);

  return {
    id,
    razon_social: razonSocial,
    razonSocial,
    cliente: razonSocial,
    deuda: getFirstPhantomValue(row, ['deuda', 'balance', 'Balance_CC', 'Balance', 'Saldo']),
    estado: getFirstPhantomValue(row, ['estado', 'Estado']),
    movil: normalizeSecondQueuePhone(movil) || movil,
    movil_raw: movil,
    telefono: normalizeSecondQueuePhone(telefono) || telefono,
    telefono_raw: telefono,
    fecha_ultima_factura: formatPhantomDateOnly(getFirstPhantomValue(row, ['fechaUltimaFactura', 'fecha_ultima_factura', 'Fecha_Ultima_Factura'])),
    comprobantes_adeudados: getFirstPhantomValue(row, ['comprobantesAdeudados', 'C_Comprobantes_Adeudados', 'Fecha_Ultimo_Mov', 'ComprobantesAdeudados', 'Comprobantes_Adeudados'])
  };
}

function getQueueTargetFromVariables(variables = {}) {
  return String(variables.movil || variables.telefono || variables.phone || variables.target || '').trim();
}

function createQueueItemFromRow(row = {}) {
  const variables = createMessageVariablesFromRow(row);
  const target = normalizeSecondQueuePhone(getQueueTargetFromVariables(variables));
  const id = String(variables.id || '').trim();
  return {
    queueKey: id ? `phantom:${id}` : `phantom:${normalizeChatPhone(target) || target}`,
    target,
    phone: normalizeChatPhone(target),
    source: 'second-phantom',
    variables
  };
}

async function fetchPhantomConsultaMasivaRows(options = {}) {
  const api = new PhantomApi();
  const defaultLimit = parsePositiveInteger(process.env.PHANTOM_CONSULTA_LIMIT, 10);
  const limit = Math.min(parsePositiveInteger(options.limit, defaultLimit), 500);
  const page = parsePositiveInteger(options.page, 0);
  const offset = options.offset !== undefined
    ? parseNonNegativeInteger(options.offset, 0)
    : page ? (page - 1) * limit : parseNonNegativeInteger(process.env.PHANTOM_CONSULTA_OFFSET, 0);
  const allEstados = options.allEstados === true || options.allStates === true;
  const estado = allEstados ? '' : normalizePhantomEstado(options.estado, process.env.PHANTOM_CONSULTA_ESTADO || 'Suspendido');
  const consultaParams = {
    JSON: 1,
    Desc: parsePositiveInteger(process.env.PHANTOM_CONSULTA_DESC, 1),
    Limit: limit,
    Offset: offset,
    BalanceCC: parsePositiveInteger(process.env.PHANTOM_CONSULTA_BALANCE_CC, 1),
    CompAdeudados: parsePositiveInteger(process.env.PHANTOM_CONSULTA_COMP_ADEUDADOS, 1)
  };

  if (!allEstados) {
    consultaParams.Estado = estado;
  }

  const result = await api.consultaMasivaDatos({
    idDesde: parsePositiveInteger(process.env.PHANTOM_CONSULTA_ID_DESDE, 1),
    idHasta: parsePositiveInteger(process.env.PHANTOM_CONSULTA_ID_HASTA, 999999999),
    query: consultaParams
  });
  const rawRows = result.rows;
  const rows = formatPhantomClientRows(rawRows, {
    filterDebt: !allEstados && estado.toLowerCase() !== 'baja'
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

function assertRequiredPhantomValue(value, label) {
  const text = String(value === undefined || value === null ? '' : value).trim();
  if (!text) {
    throw new Error(`Falta ${label}`);
  }
  return text;
}

function assertPhantomNumberValue(value, label) {
  const text = assertRequiredPhantomValue(value, label);
  if (!Number.isFinite(Number(String(text).replace(',', '.')))) {
    throw new Error(`${label} invalido`);
  }
  return text;
}

async function fetchPhantomAction(action, options = {}) {
  const api = new PhantomApi();
  const auth = await api.autentificar();
  const headers = { ...(options.headers || {}) };

  if (auth.cookieHeader && !headers.Cookie) {
    headers.Cookie = auth.cookieHeader;
  }

  const response = await api.postAction(action, options.method === 'GET' ? undefined : (options.body || {}), {
    headers,
    query: {
      token: auth.token || '',
      ...(options.query || {})
    }
  });
  const payload = response.payload;
  const phantomCode = payload && typeof payload === 'object' ? Number(payload.code) : NaN;

  if (Number.isFinite(phantomCode) && phantomCode >= 400) {
    throw new Error(`Error consultando Phantom: ${payload.message || payload.error || payload.msg || `code ${payload.code}`}`);
  }

  return payload;
}

function extractPhantomTicketNumber(payload) {
  const stack = [payload];
  while (stack.length) {
    const current = stack.shift();
    if (current === undefined || current === null || current === '') {
      continue;
    }
    if (typeof current === 'number' && Number.isFinite(current)) {
      return String(Math.trunc(current));
    }
    if (typeof current === 'string') {
      const clean = stripPhantomBom(current).replace(/^"|"$/g, '').trim();
      const exact = clean.match(/^\d+$/);
      const labeled = clean.match(/(?:tt|ticket|id|numero|nro|#)\D{0,12}(\d{1,20})/i);
      if (exact || labeled) {
        return exact ? exact[0] : labeled[1];
      }
      const parsed = parsePhantomPayload(clean);
      if (parsed !== clean) {
        stack.push(parsed);
      }
      continue;
    }
    if (Array.isArray(current)) {
      stack.push(...current);
      continue;
    }
    if (typeof current === 'object') {
      for (const key of ['ticket', 'Ticket', 'id', 'ID', 'IDTT', 'idtt', 'numero', 'Numero', 'nro', 'Nro', 'data', 'result', 'resultado']) {
        if (current[key] !== undefined && current[key] !== null && current[key] !== '') {
          stack.push(current[key]);
        }
      }
    }
  }
  return '';
}

async function fetchPhantomNapAvailability(options = {}) {
  return fetchPhantomAction('Consultar_Disponibilidad_NAP', {
    method: 'POST',
    body: {
      Latitud: assertPhantomNumberValue(options.latitud ?? options.Latitud, 'Latitud'),
      Longitud: assertPhantomNumberValue(options.longitud ?? options.Longitud, 'Longitud'),
      DistanciaDrop: assertPhantomNumberValue(options.distanciaDrop ?? options.DistanciaDrop, 'DistanciaDrop')
    }
  });
}

async function fetchPhantomAdvancedClient(options = {}) {
  return fetchPhantomAction('Consulta_Cliente_Avanzada', {
    method: 'POST',
    query: {
      JSON: 1,
      IDA: assertRequiredPhantomValue(options.ida ?? options.IDA ?? options.id ?? options.cliente, 'IDA'),
      InfoFTTH: 1,
      ImporteProductos: 1
    }
  });
}

async function createPhantomSupportTicket(options = {}) {
  const payload = await fetchPhantomAction('Phantom_Generar_TT', {
    method: 'POST',
    query: {
      IDA: assertRequiredPhantomValue(options.ida ?? options.IDA ?? options.id ?? options.cliente, 'IDA'),
      Plataforma: String(options.plataforma ?? options.Plataforma ?? 'Bot Automatic').trim() || 'Bot Automatic',
      Soporte: options.Soporte ?? options.soporte ?? ''
    },
    body: {
      Categoria: 'Comunicacion',
      Prioridad: '3',
      Asunto: String(options.asunto ?? options.Asunto ?? 'Comunicacion por WhatsApp').trim() || 'Comunicacion por WhatsApp',
      Detalle: String(options.note ?? options.detalle ?? options.Detalle ?? 'Comunicacion registrada desde WhatsApp').trim() || 'Comunicacion registrada desde WhatsApp',
      Delegacion: 'Creado como Resuelto',
      Estado: 'Resuelto'
    }
  });
  const ticketNumber = extractPhantomTicketNumber(payload);
  if (!ticketNumber) {
    throw new Error('Phantom no devolvio numero de ticket valido');
  }
  return { ticketNumber, raw: payload };
}

async function getSecondDatabaseStatus() {
  const mysqlSettings = secondDb.getMysqlSettings();

  try {
    await secondDb.pingDatabase();
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

function getNextSecondMessageQueueRunIso() {
  return new Date(Date.now() + secondMessageQueueIntervalMinutes * 60 * 1000).toISOString();
}

async function processSecondMessageQueue() {
  if (secondMessageQueueRunning) {
    return { skipped: true, reason: 'queue-running' };
  }

  secondMessageQueueRunning = true;
  secondMessageQueueState.runCount += 1;
  secondMessageQueueState.lastRunStartedAt = nowIso();
  const unresolvedItemIds = new Set();

  try {
    const staleErrors = await secondDb.markStaleMessageQueueErrors();
    const whatsapp = await getWhatsAppStatus('bot-2');

    if (!whatsapp.ready) {
      const result = {
        skipped: true,
        waiting: true,
        reason: `${whatsapp.label || 'Numero 2'} no conectado (${whatsapp.state})`,
        staleErrors,
        stats: await secondDb.getMessageQueueStats().catch(() => null)
      };
      secondMessageQueueState.lastResult = result;
      secondMessageQueueState.lastError = null;
      return result;
    }

    const items = await secondDb.claimPendingMessageQueue(secondMessageQueueBatchSize);
    let sent = 0;
    let errors = 0;
    items.forEach(item => unresolvedItemIds.add(Number(item.id)));

    for (let index = 0; index < items.length; index += 1) {
      const item = items[index];
      const template = getNextSecondMessageTemplate();
      const body = renderStringTemplate(template.template, item.variables || {}).trim();

      if (!body) {
        await secondDb.markMessageQueueError(item.id, 'El template genero un mensaje vacio');
        unresolvedItemIds.delete(Number(item.id));
        errors += 1;
        continue;
      }

      try {
        const target = normalizeSecondQueuePhone(item.target) || item.target;
        await sendWhatsApp(target, body, item.source || 'second-queue', {
          accountId: 'bot-2',
          sentByUsername: item.owner_username || 'queue',
          sentByName: item.owner_username || 'Cola'
        });
        await secondDb.markMessageQueueSent(item.id, body, template.index);
        unresolvedItemIds.delete(Number(item.id));
        sent += 1;
      } catch (error) {
        if (isTransientWhatsAppError(error)) {
          await secondDb.releaseMessageQueueItem(item.id, error.message);
          unresolvedItemIds.delete(Number(item.id));
          for (const remaining of items.slice(index + 1)) {
            await secondDb.releaseMessageQueueItem(remaining.id, error.message);
            unresolvedItemIds.delete(Number(remaining.id));
          }
          break;
        }

        await secondDb.markMessageQueueError(item.id, error.message);
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
      stats: await secondDb.getMessageQueueStats().catch(() => null)
    };
    secondMessageQueueState.lastResult = result;
    secondMessageQueueState.lastError = null;
    return result;
  } catch (error) {
    secondMessageQueueState.lastError = {
      message: error.message,
      at: nowIso()
    };

    for (const id of unresolvedItemIds) {
      await secondDb.markMessageQueueError(id, `Error inesperado en cola: ${error.message}`).catch(() => {});
    }

    throw error;
  } finally {
    secondMessageQueueState.lastRunFinishedAt = nowIso();
    secondMessageQueueState.nextRunAt = getNextSecondMessageQueueRunIso();
    secondMessageQueueRunning = false;
  }
}

function startSecondMessageQueueScheduler() {
  secondMessageQueueState.active = true;
  secondMessageQueueState.startedAt = nowIso();
  secondMessageQueueState.nextRunAt = getNextSecondMessageQueueRunIso();
  setInterval(() => {
    secondMessageQueueState.nextRunAt = getNextSecondMessageQueueRunIso();
    processSecondMessageQueue().catch(error => {
      console.error('Error en cola de mensajes secundaria:', error);
    });
  }, secondMessageQueueIntervalMinutes * 60 * 1000);
  console.log(`Cola de mensajes secundaria activa cada ${secondMessageQueueIntervalMinutes} minutos.`);
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
    return { skipped: true, reason: 'sync-running' };
  }

  phantomBajaSyncRunning = true;
  phantomBajaSyncState.running = true;
  phantomBajaSyncState.lastRunStartedAt = nowIso();
  phantomBajaSyncState.lastError = null;
  const startedAt = new Date();
  const allRows = [];
  let offset = 0;
  let page = 1;

  try {
    while (true) {
      const result = await fetchPhantomConsultaMasivaRows({
        allEstados: true,
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
        throw new Error('Corte de seguridad: demasiadas paginas sincronizando clientes Phantom');
      }
    }

    const saved = await secondDb.replacePhantomBajaClients(allRows, startedAt);
    const result = {
      skipped: false,
      reason,
      saved,
      pages: page,
      finishedAt: nowIso()
    };
    phantomBajaSyncState.lastResult = result;
    phantomBajaSyncState.lastError = null;
    return result;
  } catch (error) {
    phantomBajaSyncState.lastError = {
      message: error.message,
      at: nowIso()
    };
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
      .catch(error => console.error('[PHANTOM] Error sincronizando:', error))
      .finally(scheduleNextPhantomBajaSync);
  }, delayMs);
}

function startPhantomBajaSyncScheduler() {
  phantomBajaSyncState.active = true;
  scheduleNextPhantomBajaSync();
  console.log(`Sync clientes Phantom activo todos los dias a las ${String(phantomBajaSyncHour).padStart(2, '0')}:${String(phantomBajaSyncMinute).padStart(2, '0')}.`);
}

app.post('/send', requirePrivileged, async (req, res) => {
  try {
    const { phone, message } = req.body;
    const accountId = isValidWhatsAppAccount(req.body && req.body.accountId) ? req.body.accountId : 'bot-1';
    await sendWhatsApp(phone, message, 'manual', {
      sentByUsername: req.user && req.user.username,
      sentByName: req.user && req.user.name,
      accountId
    });
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

app.get('/messages/conversations', requireLoggedIn, async (req, res) => {
  try {
    await syncRecentWhatsAppMessages();
    const buckets = listConversationBucketsForUser(req.user, req.query.limit);

    res.json({
      success: true,
      conversations: buckets.conversations,
      otherConversations: buckets.otherConversations
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

app.post('/messages/conversations/bucket', requirePrivileged, (req, res) => {
  try {
    const chatId = String(req.body && req.body.chatId || '').trim();
    const accountId = isValidWhatsAppAccount(req.body && req.body.accountId)
      ? String(req.body.accountId).trim()
      : getDefaultWhatsAppAccountId(req.user);
    const bucket = String(req.body && req.body.bucket || '').trim().toLowerCase();

    if (!chatId || !['main', 'other'].includes(bucket)) {
      return res.status(400).json({
        success: false,
        error: 'Faltan chatId o bandeja'
      });
    }

    if (!canReadChat(req.user, chatId, accountId)) {
      return res.status(403).json({
        success: false,
        error: canAccessWhatsAppAccount(req.user, accountId)
          ? 'Chat fuera de los grupos asignados'
          : 'Sesion WhatsApp no asignada al usuario'
      });
    }

    const override = setWhatsAppConversationBucketOverride(
      chatId,
      bucket,
      req.user && req.user.username || '',
      accountId
    );
    const buckets = listConversationBucketsForUser(req.user, req.query.limit);

    res.json({
      success: true,
      override,
      conversations: buckets.conversations,
      otherConversations: buckets.otherConversations
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

app.get('/messages/client-details', requireLoggedIn, async (req, res) => {
  try {
    const chatId = String(req.query.chatId || '').trim();
    const accountId = isValidWhatsAppAccount(req.query.accountId)
      ? String(req.query.accountId).trim()
      : getDefaultWhatsAppAccountId(req.user);
    const ticketExternalId = String(req.query.ticketExternalId || req.query.ticket || '').trim();
    const requestedClientId = String(req.query.clientId || req.query.ida || req.query.IDA || '').trim();
    const requestedPhone = normalizeChatPhone(req.query.phone || '');
    const phones = new Set();
    let ticket = null;
    let clientId = requestedClientId;

    if (chatId && !canReadChat(req.user, chatId, accountId)) {
      return res.status(403).json({
        success: false,
        error: canAccessWhatsAppAccount(req.user, accountId)
          ? 'Chat fuera de los grupos asignados'
          : 'Sesion WhatsApp no asignada al usuario'
      });
    }

    if (ticketExternalId) {
      if (!canAccessTicket(req.user, ticketExternalId)) {
        return res.status(403).json({
          success: false,
          error: 'Ticket fuera de los grupos asignados'
        });
      }

      ticket = getTicket(ticketExternalId);
      clientId = clientId || getTicketIda(ticket);
      for (const phone of [ticket && ticket.phone, ...getTicketPhones(ticket)]) {
        const cleanPhone = normalizeChatPhone(phone);
        if (cleanPhone) {
          phones.add(cleanPhone);
        }
      }
    }

    if (requestedPhone) {
      phones.add(requestedPhone);
    }

    if (chatId) {
      const chatPhone = normalizeChatPhone(chatId);
      if (chatPhone) {
        phones.add(chatPhone);
      }

      for (const phone of listWhatsAppChatPhones(chatId)) {
        const cleanPhone = normalizeChatPhone(phone);
        if (cleanPhone) {
          phones.add(cleanPhone);
        }
      }
    }

    if (!clientId && chatId) {
      clientId = await secondDb.getIdentifiedClientId(chatId, requestedPhone || chatId);
    }

    let client = clientId ? await secondDb.findPhantomClientById(clientId) : null;

    if (!client) {
      for (const phone of phones) {
        client = await secondDb.findPhantomClientByPhone(phone);
        if (client) {
          clientId = String(client.id || '');
          break;
        }
      }
    }

    const links = clientId ? await secondDb.listClientChatLinks(clientId, 20) : [];

    res.json({
      success: true,
      client: compactMessageClient(client),
      ticket: ticket ? compactAuditTicket(ticket) : null,
      phones: Array.from(phones),
      links,
      source: client ? 'mysql' : 'none'
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
    const accountId = isValidWhatsAppAccount(req.query.accountId)
      ? String(req.query.accountId).trim()
      : getDefaultWhatsAppAccountId(req.user);

    if (!chatId) {
      return res.status(400).json({
        success: false,
        error: 'Falta chatId'
      });
    }

    if (!canReadChat(req.user, chatId, accountId)) {
      return res.status(403).json({
        success: false,
        error: 'Chat fuera de los grupos asignados'
      });
    }

    await backfillChatMedia(chatId, accountId);

    res.json({
      success: true,
      messages: listWhatsAppMessages(chatId, req.query.limit, {
        accountId
      })
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

app.post('/messages/validate-phone', requirePrivileged, async (req, res) => {
  try {
    const accountId = isValidWhatsAppAccount(req.body && req.body.accountId) ? req.body.accountId : getDefaultWhatsAppAccountId(req.user);
    if (!canAccessWhatsAppAccount(req.user, accountId)) {
      return res.status(403).json({
        success: false,
        error: 'Sesion WhatsApp no asignada al usuario'
      });
    }
    const result = await validateWhatsAppTarget(req.body && req.body.phone, accountId);

    res.json({
      success: true,
      ...result
    });
  } catch (error) {
    const status = error.message.includes('todavia no esta conectado') ? 503 : 400;

    res.status(status).json({
      success: false,
      error: error.message
    });
  }
});

app.post('/messages/send', requirePrivileged, async (req, res) => {
  try {
    const targetChatId = String(req.body && req.body.chatId || '').trim();
    const targetPhone = String(req.body && req.body.phone || '').trim();
    const ticketExternalId = String(req.body && req.body.ticketExternalId || '').trim();
    const accountId = isValidWhatsAppAccount(req.body && req.body.accountId)
      ? String(req.body.accountId).trim()
      : getDefaultWhatsAppAccountId(req.user);
    const target = targetChatId || targetPhone;
    const cleanPhone = normalizeChatPhone(targetPhone || target);
    const cleanMessage = String(req.body && req.body.message || '').trim();

    if (!target || !cleanMessage) {
      return res.status(400).json({
        success: false,
        error: 'Faltan telefono o mensaje'
      });
    }

    if (ticketExternalId && !canSendToAnyTarget(req.user) && !canAccessTicket(req.user, ticketExternalId)) {
      return res.status(403).json({
        success: false,
        error: 'Ticket fuera de los grupos asignados'
      });
    }

    if (!canSendToTarget(req.user, targetChatId, targetPhone || target, accountId)) {
      return res.status(403).json({
        success: false,
        error: canAccessWhatsAppAccount(req.user, accountId)
          ? 'Chat fuera de los grupos asignados'
          : 'Sesion WhatsApp no asignada al usuario'
      });
    }

    const sentMessage = await sendWhatsApp(target, cleanMessage, 'inbox', {
      sentByUsername: req.user && req.user.username,
      sentByName: req.user && req.user.name,
      accountId
    });
    const fallbackChatId = isDirectChatId(target) ? target : `${cleanPhone}@c.us`;
    const chatId = getMessageChatId(sentMessage, fallbackChatId);
    const responseMessage = sentMessage && sentMessage._savedMessage || {
      id: hasSerializedMessageId(sentMessage)
        ? getStoredMessageId(sentMessage, chatId, 'outgoing')
        : '',
      chat_id: chatId,
      phone: cleanPhone,
      direction: 'outgoing',
      body: cleanMessage,
      timestamp_ts: getWhatsAppTimestampMs(sentMessage && sentMessage.timestamp),
      from_me: 1,
      ack: Number.isFinite(Number(sentMessage && sentMessage.ack)) ? Number(sentMessage.ack) : null,
      source: 'inbox',
      sent_by_username: req.user && req.user.username || null,
      sent_by_name: req.user && req.user.name || null,
      whatsapp_account: accountId
    };

    let ticket = null;

    if (ticketExternalId) {
      ticket = disableTicketAutomaticMessage(ticketExternalId, 'Mensaje manual enviado desde conversaciones');
    }

    res.json({
      success: true,
      message: responseMessage,
      ticket
    });
  } catch (error) {
    const status = error.message.includes('todavia no esta conectado') ? 503 : 500;
    res.status(status).json({
      success: false,
      error: error.message
    });
  }
});

app.get('/api/audit/messages', requireAuditAccess, async (req, res) => {
  try {
    res.json(await buildAuditMessagesResponse(req.query || {}));
  } catch (error) {
    res.status(error.statusCode || 500).json({
      success: false,
      error: error.message
    });
  }
});

app.post('/api/audit/messages', requireAuditAccess, async (req, res) => {
  try {
    res.json(await buildAuditMessagesResponse(req.body || {}));
  } catch (error) {
    res.status(error.statusCode || 500).json({
      success: false,
      error: error.message
    });
  }
});

app.get('/api/status', requireLoggedIn, async (req, res) => {
  const staleErrors = await secondDb.markStaleMessageQueueErrors().catch(() => 0);
  const ownerUsername = getScopedOwnerUsername(req.user);
  const [whatsapp, mysqlStatus, queueStats] = await Promise.all([
    getWhatsAppStatus('bot-2'),
    getSecondDatabaseStatus(),
    secondDb.getMessageQueueStats({ ownerUsername }).catch(() => null)
  ]);

  res.json({
    success: true,
    whatsapp,
    mysql: mysqlStatus,
    messageQueue: {
      ...secondMessageQueueState,
      running: secondMessageQueueRunning,
      staleErrors,
      stats: queueStats
    },
    mediaLimitBytes: secondMaxStoredMediaBytes
  });
});

app.get('/api/message-templates', requireLoggedIn, (req, res) => {
  res.json(getMessageTemplatesPayload());
});

app.get('/api/message-templates/:id', requireLoggedIn, (req, res) => {
  const template = getSecondMessageTemplateRecords().find(record => record.id === String(req.params.id || '').trim());

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
});

app.post('/api/message-templates', requirePrivileged, (req, res) => {
  try {
    const body = req.body || {};
    const isLegacyReplace = Object.prototype.hasOwnProperty.call(body, 'template') ||
      Object.prototype.hasOwnProperty.call(body, 'templates');
    const isCreate = Object.prototype.hasOwnProperty.call(body, 'body') ||
      Object.prototype.hasOwnProperty.call(body, 'text') ||
      Object.prototype.hasOwnProperty.call(body, 'name') ||
      Object.prototype.hasOwnProperty.call(body, 'title');

    if (isCreate && !isLegacyReplace) {
      return res.status(201).json(getMessageTemplatesPayload(createSecondMessageTemplate(body)));
    }

    persistSecondMessageTemplateRecords(body.template || body.templates);
    return res.json(getMessageTemplatesPayload());
  } catch (error) {
    return res.status(400).json({
      success: false,
      error: error.message
    });
  }
});

app.put('/api/message-templates/:id', requirePrivileged, (req, res) => {
  try {
    res.json(getMessageTemplatesPayload(updateSecondMessageTemplate(req.params.id, req.body || {})));
  } catch (error) {
    res.status(error.message === 'Template no encontrado' ? 404 : 400).json({
      success: false,
      error: error.message
    });
  }
});

app.delete('/api/message-templates/:id', requirePrivileged, (req, res) => {
  try {
    res.json(getMessageTemplatesPayload(deleteSecondMessageTemplate(req.params.id)));
  } catch (error) {
    res.status(error.message === 'Template no encontrado' ? 404 : 400).json({
      success: false,
      error: error.message
    });
  }
});

app.get('/api/message-queue/status', requireLoggedIn, async (req, res) => {
  try {
    const staleErrors = await secondDb.markStaleMessageQueueErrors();
    const ownerUsername = getScopedOwnerUsername(req.user);
    res.json({
      success: true,
      scheduler: {
        ...secondMessageQueueState,
        running: secondMessageQueueRunning,
        staleErrors
      },
      stats: await secondDb.getMessageQueueStats({ ownerUsername })
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
    const staleErrors = await secondDb.markStaleMessageQueueErrors();
    const ownerUsername = getScopedOwnerUsername(req.user);
    res.json({
      success: true,
      staleErrors,
      stats: await secondDb.getMessageQueueStats({ ownerUsername }),
      items: await secondDb.listMessageQueueItems({
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
    const item = await secondDb.cancelMessageQueueItem(req.params.id, { ownerUsername });
    res.json({
      success: true,
      item,
      stats: await secondDb.getMessageQueueStats({ ownerUsername })
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

    rows.forEach(row => items.push(createQueueItemFromRow(row)));

    for (const message of messages) {
      const variables = message.variables && typeof message.variables === 'object' ? message.variables : {};
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
      const variables = body.variables && typeof body.variables === 'object' ? body.variables : {};
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
      .map(item => ({ ...item, ownerUsername }));

    if (!validItems.length) {
      throw new Error('No hay mensajes validos para encolar');
    }

    const queued = await secondDb.enqueueMessageQueueItems(validItems);
    res.json({
      success: true,
      queued: queued.length,
      skipped: items.length - validItems.length,
      items: queued,
      stats: await secondDb.getMessageQueueStats({ ownerUsername: getScopedOwnerUsername(req.user) })
    });
  } catch (error) {
    res.status(400).json({
      success: false,
      error: error.message
    });
  }
});

async function handlePhantomConsultaMasiva(req, res) {
  try {
    const requestBody = req.body && typeof req.body === 'object' ? req.body : {};
    const rawEstado = req.query.estado ?? requestBody.estado;
    const estado = rawEstado === undefined || rawEstado === null ? '' : normalizePhantomEstado(rawEstado, '');
    const excludeEstados = String(req.query.excludeEstados ?? requestBody.excludeEstados ?? '')
      .split(',')
      .map(item => item.trim())
      .filter(Boolean);

    if (estado || excludeEstados.length) {
      const defaultLimit = parsePositiveInteger(process.env.PHANTOM_CONSULTA_LIMIT, 10);
      const limit = Math.min(parsePositiveInteger(req.query.limit ?? requestBody.limit, defaultLimit), 500);
      const page = parsePositiveInteger(req.query.page ?? requestBody.page, 0);
      const offset = req.query.offset !== undefined || requestBody.offset !== undefined
        ? parseNonNegativeInteger(req.query.offset ?? requestBody.offset, 0)
        : page ? (page - 1) * limit : 0;
      const result = await secondDb.listPhantomBajaClients({
        estado,
        excludeEstados,
        search: req.query.search ?? requestBody.search,
        limit,
        offset,
        sortKey: req.query.sortKey ?? requestBody.sortKey,
        sortDirection: req.query.sortDirection ?? requestBody.sortDirection
      });
      const syncStatus = await secondDb.getPhantomBajaSyncStatus().catch(() => null);

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
        excludeEstados,
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
      limit: req.query.limit ?? requestBody.limit,
      offset: req.query.offset ?? requestBody.offset,
      page: req.query.page ?? requestBody.page
    });

    return res.json({
      success: true,
      rows: result.rows,
      pagination: result.pagination,
      estado: result.estado,
      source: 'phantom',
      receivedAt: new Date().toISOString()
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      error: error.message
    });
  }
}

app.get('/api/phantom/consulta-masiva', requireLoggedIn, handlePhantomConsultaMasiva);
app.post('/api/phantom/consulta-masiva', requireLoggedIn, handlePhantomConsultaMasiva);

app.post('/api/phantom/disponibilidad-nap', requireLoggedIn, async (req, res) => {
  try {
    res.json({
      success: true,
      data: await fetchPhantomNapAvailability(req.body || {}),
      receivedAt: new Date().toISOString()
    });
  } catch (error) {
    res.status(400).json({
      success: false,
      error: error.message
    });
  }
});

app.get('/api/phantom/cliente-avanzada', requireLoggedIn, async (req, res) => {
  try {
    res.json({
      success: true,
      data: await fetchPhantomAdvancedClient(req.query || {}),
      receivedAt: new Date().toISOString()
    });
  } catch (error) {
    res.status(400).json({
      success: false,
      error: error.message
    });
  }
});

app.post('/api/phantom/cliente-avanzada', requireLoggedIn, async (req, res) => {
  try {
    res.json({
      success: true,
      data: await fetchPhantomAdvancedClient(req.body || {}),
      receivedAt: new Date().toISOString()
    });
  } catch (error) {
    res.status(400).json({
      success: false,
      error: error.message
    });
  }
});

app.post('/api/phantom/tickets/comunicacion', requireLoggedIn, async (req, res) => {
  try {
    const ticket = await createPhantomSupportTicket({
      ...(req.body || {}),
      plataforma: getPhantomPlatformUserName(req.user)
    });
    res.json({
      success: true,
      ticket,
      message: null,
      receivedAt: new Date().toISOString()
    });
  } catch (error) {
    res.status(400).json({
      success: false,
      error: error.message
    });
  }
});

app.get('/api/phantom/baja/sync-status', requireLoggedIn, async (req, res) => {
  try {
    res.json({
      success: true,
      scheduler: phantomBajaSyncState,
      database: await secondDb.getPhantomBajaSyncStatus()
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

app.post('/tickets/:externalId/phone', requirePrivileged, (req, res) => {
  try {
    const externalId = String(req.params.externalId || '').trim();
    const phone = String(req.body && req.body.phone || '').trim();

    if (!canAccessTicket(req.user, externalId)) {
      return res.status(403).json({
        success: false,
        error: 'Ticket fuera de los grupos asignados'
      });
    }

    const cleanPhone = normalizeChatPhone(phone);

    if (!cleanPhone) {
      return res.status(400).json({
        success: false,
        error: 'Telefono invalido'
      });
    }

    res.json({
      success: true,
      ticket: updateTicketPhone(externalId, cleanPhone)
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

app.post('/tickets/:externalId/validate-phone', requirePrivileged, async (req, res) => {
  try {
    const externalId = String(req.params.externalId || '').trim();

    if (!canAccessTicket(req.user, externalId)) {
      return res.status(403).json({
        success: false,
        error: 'Ticket fuera de los grupos asignados'
      });
    }

    const ticket = getTicket(externalId);
    const result = await validateWhatsAppTarget(ticket && ticket.phone);

    res.json({
      success: true,
      ticket,
      ...result
    });
  } catch (error) {
    const status = error.message.includes('todavia no esta conectado') ? 503 : 500;

    if (error.message === 'Falta telefono') {
      return res.status(400).json({
        success: false,
        error: 'El ticket no tiene telefono'
      });
    }

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
  const defaultAccountId = getDefaultWhatsAppAccountId(req.user);
  const whatsapp = await getWhatsAppStatus(defaultAccountId);
  const allowedAccountIds = new Set(getAllowedWhatsAppAccountIds(req.user));
  const whatsappAccountsStatus = (await getWhatsAppAccountsStatus())
    .filter(account => allowedAccountIds.has(account.id));

  res.json({
    success: true,
    whatsappReady: whatsapp.ready,
    whatsapp,
    whatsappAccounts: whatsappAccountsStatus,
    job: getTicketJobStatus()
  });
});

app.get('/tickets/:externalId', requireLoggedIn, (req, res) => {
  try {
    const externalId = String(req.params.externalId || '').trim();

    if (!canAccessTicket(req.user, externalId)) {
      return res.status(403).json({
        success: false,
        error: 'Ticket fuera de los grupos asignados'
      });
    }

    res.json({
      success: true,
      ticket: getTicket(externalId)
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

app.post('/whatsapp/reconnect', requireAdmin, async (req, res) => {
  try {
    const accountId = isValidWhatsAppAccount(req.body && req.body.accountId) ? req.body.accountId : 'bot-1';
    const whatsapp = await restartWhatsAppClient('manual', { accountId });
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

app.put('/whatsapp/accounts/:id', requireAdmin, async (req, res) => {
  try {
    const account = updateWhatsAppAccountLabel(req.params.id, req.body && req.body.label);
    res.json({
      success: true,
      account: await getWhatsAppStatus(account.id)
    });
  } catch (error) {
    res.status(400).json({
      success: false,
      error: error.message
    });
  }
});

app.post('/whatsapp/reset-auth', requireAdmin, async (req, res) => {
  try {
    const accountId = isValidWhatsAppAccount(req.body && req.body.accountId) ? req.body.accountId : 'bot-1';
    const whatsapp = await restartWhatsAppClient('reset-auth', {
      accountId,
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

app.get('/settings/notification-channel-reply', requireLoggedIn, (req, res) => {
  res.json({
    success: true,
    ...getNotificationChannelReplySettings(),
    placeholders: ['support_phone']
  });
});

app.post('/settings/notification-channel-reply', requirePrivileged, (req, res) => {
  try {
    const settings = setNotificationChannelReplySettings({
      template: req.body && req.body.template,
      enabled: !(req.body && req.body.enabled === false)
    });

    res.json({
      success: true,
      ...settings,
      placeholders: ['support_phone']
    });
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

secondDb.pingDatabase().catch(error => {
  console.warn('MySQL de clientes no esta listo:', error.message);
});

startSecondMessageQueueScheduler();
startPhantomBajaSyncScheduler();
syncPhantomBajaClients('startup')
  .then(result => console.log('[PHANTOM] Corrida inicial:', result))
  .catch(error => console.error('[PHANTOM] Error corrida inicial:', error));
processSecondMessageQueue()
  .then(result => console.log('[QUEUE] Corrida inicial:', result))
  .catch(error => console.error('[QUEUE] Error corrida inicial:', error));

startTicketScheduler({
  isWhatsAppReady,
  sendWhatsApp
});

app.listen(config.port, () => {
  console.log(`API escuchando en puerto ${config.port}`);
});
