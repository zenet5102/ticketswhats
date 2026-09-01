const { Client, LocalAuth } = require('whatsapp-web.js');
const express = require('express');
const qrcode = require('qrcode-terminal');
const QRCode = require('qrcode-terminal/vendor/QRCode');
const QRErrorCorrectLevel = require('qrcode-terminal/vendor/QRCode/QRErrorCorrectLevel');
const path = require('path');
const { config } = require('./config');
const {
  normalizeChatPhone,
  saveWhatsAppMessage,
  updateWhatsAppMessageAck
} = require('./db');

const app = express();
const accountId = String(process.env.WHATSAPP_WORKER_ACCOUNT_ID || 'bot-2').trim();
const accountLabel = String(process.env.WHATSAPP_WORKER_LABEL || process.env.WHATSAPP_SECONDARY_LABEL || 'Coordinacion').trim();
const clientId = String(process.env.WHATSAPP_WORKER_CLIENT_ID || process.env.SECOND_WHATSAPP_CLIENT_ID || accountId).trim();
const port = parsePositiveInteger(process.env.WHATSAPP_WORKER_PORT, 3002);
const workerToken = String(process.env.WHATSAPP_WORKER_TOKEN || '').trim();
const whatsappAuthRoot = path.resolve(__dirname, '.wwebjs_auth');
const maxStoredMediaBytes = parsePositiveInteger(process.env.SECOND_APP_MAX_STORED_MEDIA_MB, 15) * 1024 * 1024;
const mediaDownloadRetryDelaysMs = [0, 750, 2000];
const recentMessagesSyncIntervalMs = parsePositiveInteger(process.env.WHATSAPP_RECENT_MESSAGES_SYNC_INTERVAL_MS, 120000);
const recentMessagesSyncChatCooldownMs = parsePositiveInteger(process.env.WHATSAPP_RECENT_MESSAGES_SYNC_CHAT_COOLDOWN_MS, 12000);
const recentMessagesSyncChatLimit = parsePositiveInteger(process.env.WHATSAPP_RECENT_MESSAGES_SYNC_CHAT_LIMIT, 35);
const recentMessagesSyncMessageLimit = parsePositiveInteger(process.env.WHATSAPP_RECENT_MESSAGES_SYNC_MESSAGE_LIMIT, 12);
const recentMessagesSyncBackoffBaseMs = parsePositiveInteger(process.env.WHATSAPP_RECENT_MESSAGES_SYNC_BACKOFF_BASE_MS, 300000);
const recentMessagesSyncBackoffMaxMs = parsePositiveInteger(process.env.WHATSAPP_RECENT_MESSAGES_SYNC_BACKOFF_MAX_MS, 900000);
const catchupOnReconnect = String(process.env.WHATSAPP_CATCHUP_ON_RECONNECT || 'true').toLowerCase() !== 'false';
const catchupDelayMs = parseNonNegativeInteger(process.env.WHATSAPP_CATCHUP_DELAY_MS, 60000);
const catchupChatLimit = parsePositiveInteger(process.env.WHATSAPP_CATCHUP_CHAT_LIMIT, 40);
const catchupMessageLimit = parsePositiveInteger(process.env.WHATSAPP_CATCHUP_MESSAGE_LIMIT, 15);

let client = null;
let syncRunning = false;
let lastRecentMessagesSyncAt = 0;
const lastRecentMessagesSyncByChat = new Map();
const state = {
  ready: false,
  state: 'starting',
  lastEventAt: null,
  lastError: null,
  qr: null,
  qrText: null,
  qrSvg: null,
  catchupScheduledAt: null,
  catchupLastStartedAt: null,
  catchupLastFinishedAt: null,
  catchupLastError: null,
  recentSyncFailureCount: 0,
  recentSyncBackoffUntil: 0,
  recentSyncLastError: null
};

app.use(express.json({ limit: '2mb' }));

function parsePositiveInteger(value, fallback) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function parseNonNegativeInteger(value, fallback) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

function wait(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function nowIso() {
  return new Date().toISOString();
}

function markState(nextState, ready = nextState === 'CONNECTED') {
  state.state = nextState || 'UNKNOWN';
  state.ready = Boolean(ready);
  state.lastEventAt = nowIso();

  if (ready) {
    clearQr();
  }
}

function createQrText(input) {
  const qr = QRCode.create(input, QRErrorCorrectLevel.L);
  return qr.modules.map(row => row.map(cell => (cell ? '1' : '0')).join('')).join('\n');
}

function createQrSvgDataUrl(input) {
  const qr = QRCode.create(input, QRErrorCorrectLevel.L);
  const moduleCount = qr.getModuleCount();
  const cells = [];

  for (let row = 0; row < moduleCount; row += 1) {
    for (let col = 0; col < moduleCount; col += 1) {
      if (qr.isDark(row, col)) {
        cells.push(`<rect x="${col}" y="${row}" width="1" height="1"/>`);
      }
    }
  }

  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${moduleCount} ${moduleCount}" shape-rendering="crispEdges"><rect width="100%" height="100%" fill="#fff"/><g fill="#000">${cells.join('')}</g></svg>`;
  return `data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`;
}

function clearQr() {
  state.qr = null;
  state.qrText = null;
  state.qrSvg = null;
}

function requireWorkerToken(req, res, next) {
  if (!workerToken || req.get('x-worker-token') === workerToken) {
    return next();
  }

  return res.status(401).json({
    success: false,
    error: 'Token interno invalido'
  });
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

function getMessageChatId(message, fallback = '') {
  const data = message && message._data || {};
  const id = message && message.id || {};
  const remote = id.remote || data.remote || data.id && data.id.remote || '';
  const preferred = message && message.fromMe
    ? message.to || data.to || data.toId && data.toId._serialized
    : message && (message.from || data.from || data.fromId && data.fromId._serialized);

  return String(preferred || remote || fallback || '').trim();
}

function isDirectChatId(value) {
  return /@(c\.us|s\.whatsapp\.net|lid)$/i.test(String(value || '').trim());
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

  return fallbackType || 'archivo';
}

async function ensureWhatsAppWebHelpers(helpers = []) {
  if (!client || !client.pupPage) {
    throw new Error(`${accountLabel} todavia no esta conectado`);
  }

  const requiredHelpers = helpers.length ? helpers : ['getChat'];
  const status = await client.pupPage.evaluate(names => {
    return {
      hasWWebJS: Boolean(window.WWebJS),
      missing: names.filter(name => !window.WWebJS || typeof window.WWebJS[name] !== 'function')
    };
  }, requiredHelpers);

  if (status.hasWWebJS && !status.missing.length) {
    return true;
  }

  const error = new Error(`WhatsApp Web todavia no cargo helpers internos (${status.missing.join(', ') || 'WWebJS'})`);
  error.code = 'WHATSAPP_TRANSIENT';
  throw error;
}

async function getMessageMediaInfo(message) {
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

      if (media.data && Buffer.byteLength(media.data, 'base64') <= maxStoredMediaBytes) {
        mediaInfo.mediaData = media.data;
      }

      return mediaInfo;
    } catch (error) {
      if (attempt === mediaDownloadRetryDelaysMs.length - 1) {
        console.warn(`No se pudo descargar media (${accountLabel}):`, error.message);
      }
    }
  }

  return {};
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

  return {
    contactName: contact ? contact.pushname || contact.name || contact.shortName || '' : message._data && message._data.notifyName || '',
    contactPhone: normalizeChatPhone(contact && (contact.number || contact.id && contact.id.user) || '')
  };
}

async function storeWhatsAppMessage(message, source = 'whatsapp', sender = {}) {
  const chatId = getMessageChatId(message);

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
    source,
    sentByUsername: sender.sentByUsername,
    sentByName: sender.sentByName,
    whatsappAccount: accountId
  });
}

function getChatSortTimestamp(chat) {
  const value = Number(chat && (chat.timestamp || chat.lastMessage && chat.lastMessage.timestamp));
  return Number.isFinite(value) && value > 0 ? (value < 1000000000000 ? value * 1000 : value) : 0;
}

function isSyncableWhatsAppChat(chat) {
  const chatId = String(chat && chat.id && chat.id._serialized || '').trim();
  return Boolean(chatId && chatId !== 'status@broadcast' && !chatId.endsWith('@g.us'));
}

function clearRecentSyncBackoff() {
  state.recentSyncFailureCount = 0;
  state.recentSyncBackoffUntil = 0;
  state.recentSyncLastError = null;
}

function registerRecentSyncFailure(error) {
  state.recentSyncFailureCount = Number(state.recentSyncFailureCount || 0) + 1;
  state.recentSyncLastError = String(error && error.message || error || '').trim();

  if (state.recentSyncFailureCount < 2) {
    return 0;
  }

  const multiplier = Math.min(state.recentSyncFailureCount - 1, 3);
  const delay = Math.min(recentMessagesSyncBackoffBaseMs * multiplier, recentMessagesSyncBackoffMaxMs);
  state.recentSyncBackoffUntil = Date.now() + delay;
  return delay;
}

async function syncRecentWhatsAppMessages(options = {}) {
  const now = Date.now();
  const chatLimit = Math.min(Math.max(Number(options.chatLimit || recentMessagesSyncChatLimit) || recentMessagesSyncChatLimit, 1), 500);
  const messageLimit = Math.min(Math.max(Number(options.messageLimit || recentMessagesSyncMessageLimit) || recentMessagesSyncMessageLimit, 1), 200);
  const summary = {
    startedAt: new Date(now).toISOString(),
    finishedAt: null,
    reason: String(options.reason || 'scheduled'),
    accountId,
    ready: state.ready,
    state: state.state,
    skipped: false,
    backoffUntil: state.recentSyncBackoffUntil ? new Date(state.recentSyncBackoffUntil).toISOString() : null,
    chats: 0,
    messages: 0,
    stored: 0,
    error: ''
  };

  if (syncRunning) {
    return { ...summary, skipped: true, error: 'sync-running', finishedAt: nowIso() };
  }

  if (!options.force && now - lastRecentMessagesSyncAt < recentMessagesSyncIntervalMs) {
    return { ...summary, skipped: true, error: 'interval-cooldown', finishedAt: nowIso() };
  }

  if (!client || !state.ready) {
    return { ...summary, skipped: true, error: `${accountLabel} no conectado (${state.state})`, finishedAt: nowIso() };
  }

  if (!options.force && Number(state.recentSyncBackoffUntil || 0) > now) {
    return { ...summary, skipped: true, error: 'sync-backoff', finishedAt: nowIso() };
  }

  syncRunning = true;
  lastRecentMessagesSyncAt = now;

  try {
    await ensureWhatsAppWebHelpers(['getChats', 'getChat', 'getMessageModel']);
    const chats = await client.getChats();
    const recentChats = chats
      .filter(isSyncableWhatsAppChat)
      .sort((left, right) => {
        const unreadDelta = Number(right.unreadCount || 0) - Number(left.unreadCount || 0);
        return unreadDelta || getChatSortTimestamp(right) - getChatSortTimestamp(left);
      })
      .slice(0, chatLimit);
    summary.chats = recentChats.length;

    for (const chat of recentChats) {
      const chatId = String(chat && chat.id && chat.id._serialized || '').trim();
      const lastChatSync = lastRecentMessagesSyncByChat.get(chatId) || 0;

      if (!options.force && now - lastChatSync < recentMessagesSyncChatCooldownMs) {
        continue;
      }

      lastRecentMessagesSyncByChat.set(chatId, now);

      try {
        const messages = await chat.fetchMessages({ limit: messageLimit });
        summary.messages += messages.length;

        for (const message of messages) {
          const stored = await storeWhatsAppMessage(message, 'whatsapp');

          if (stored) {
            summary.stored += 1;
          }
        }
      } catch (error) {
        summary.error = error.message;
        const delay = registerRecentSyncFailure(error);
        if (delay) {
          console.warn(`Sync reciente pausado para ${accountLabel} por ${Math.round(delay / 60000)} minutos.`);
        }
        break;
      }
    }

    if (!summary.error) {
      clearRecentSyncBackoff();
    }
  } catch (error) {
    summary.error = error.message;
    const delay = registerRecentSyncFailure(error);
    if (delay) {
      console.warn(`Sync reciente pausado para ${accountLabel} por ${Math.round(delay / 60000)} minutos.`);
    }
    console.warn(`No se pudieron sincronizar chats recientes (${accountLabel}):`, error.message);
  } finally {
    summary.finishedAt = nowIso();
    syncRunning = false;
  }

  return summary;
}

function scheduleReconnectCatchup(reason = 'reconnect') {
  if (!catchupOnReconnect || !state.ready) {
    return;
  }

  state.catchupScheduledAt = nowIso();
  setTimeout(() => {
    state.catchupLastStartedAt = nowIso();
    state.catchupLastError = null;
    syncRecentWhatsAppMessages({
      force: true,
      reason: `catchup:${reason}`,
      chatLimit: catchupChatLimit,
      messageLimit: catchupMessageLimit
    })
      .then(() => {
        state.catchupLastFinishedAt = nowIso();
      })
      .catch(error => {
        state.catchupLastError = error.message;
      });
  }, catchupDelayMs);
}

function publicStatus() {
  const info = client && client.info || {};
  const wid = info.wid && (info.wid._serialized || info.wid.user) || '';

  return {
    id: accountId,
    label: accountLabel,
    clientId,
    ready: state.ready,
    state: state.state,
    phone: normalizeChatPhone(info.wid && info.wid.user || wid),
    displayName: String(info.pushname || info.name || '').trim(),
    wid: String(wid || '').trim(),
    lastEventAt: state.lastEventAt,
    lastError: state.lastError,
    catchupScheduledAt: state.catchupScheduledAt,
    catchupLastStartedAt: state.catchupLastStartedAt,
    catchupLastFinishedAt: state.catchupLastFinishedAt,
    catchupLastError: state.catchupLastError,
    recentSyncFailureCount: state.recentSyncFailureCount,
    recentSyncBackoffUntil: state.recentSyncBackoffUntil ? new Date(state.recentSyncBackoffUntil).toISOString() : null,
    recentSyncLastError: state.recentSyncLastError,
    qr: state.ready ? null : state.qr,
    qrText: state.ready ? null : state.qrText,
    qrSvg: state.ready ? null : state.qrSvg
  };
}

async function sendWhatsApp(target, message, source = 'inbox', sender = {}) {
  if (!client || !state.ready) {
    throw new Error(`${accountLabel} todavia no esta conectado (${state.state})`);
  }

  const cleanTarget = String(target || '').trim();
  const cleanPhone = normalizeChatPhone(cleanTarget);
  const cleanMessage = String(message || '').trim();

  if ((!cleanTarget && !cleanPhone) || !cleanMessage) {
    throw new Error('Faltan telefono o mensaje');
  }

  await ensureWhatsAppWebHelpers(['getChat', 'sendMessage']);

  let chatId = isDirectChatId(cleanTarget) ? cleanTarget : '';

  if (!chatId) {
    await ensureWhatsAppWebHelpers(['getContact']);
    const numberId = await client.getNumberId(cleanPhone);

    if (!numberId) {
      throw new Error('El numero no existe en WhatsApp o no se pudo resolver');
    }

    chatId = numberId._serialized;
  }

  const sentMessage = await client.sendMessage(chatId, cleanMessage);
  return storeWhatsAppMessage(sentMessage, source, sender);
}

async function validateWhatsAppTarget(phone) {
  if (!client || !state.ready) {
    throw new Error(`${accountLabel} todavia no esta conectado (${state.state})`);
  }

  const cleanPhone = normalizeChatPhone(phone);

  if (!cleanPhone) {
    throw new Error('Falta telefono');
  }

  await ensureWhatsAppWebHelpers(['getChat']);
  const numberId = await client.getNumberId(cleanPhone);

  return {
    exists: Boolean(numberId),
    phone: cleanPhone,
    chatId: numberId && numberId._serialized || '',
    accountId
  };
}

function createWhatsAppClient() {
  return new Client({
    authStrategy: new LocalAuth({
      clientId,
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

function initializeWhatsAppClient() {
  client = createWhatsAppClient();

  client.on('qr', qr => {
    markState('QR', false);
    state.lastError = null;
    state.qr = qr;
    state.qrText = createQrText(qr);
    state.qrSvg = createQrSvgDataUrl(qr);
    console.log(`Escanea este QR con WhatsApp (${accountLabel}):`);
    qrcode.generate(qr, { small: true });
  });

  client.on('authenticated', () => {
    markState('AUTHENTICATED', false);
    clearQr();
    console.log(`WhatsApp autenticado (${accountLabel})`);
  });

  client.on('auth_failure', msg => {
    markState('AUTH_FAILURE', false);
    clearQr();
    state.lastError = String(msg || 'Fallo de autenticacion');
    console.error(`Fallo de autenticacion (${accountLabel}):`, msg);
  });

  client.on('ready', () => {
    markState('CONNECTED', true);
    state.lastError = null;
    console.log(`WhatsApp conectado (${accountLabel})`);
    scheduleReconnectCatchup('ready');
  });

  client.on('change_state', nextState => {
    const connected = nextState === 'CONNECTED';
    markState(nextState || 'UNKNOWN', connected);
    if (connected) {
      scheduleReconnectCatchup('change_state');
    }
    console.log(`Estado de WhatsApp (${accountLabel}):`, nextState);
  });

  client.on('disconnected', reason => {
    markState(`DISCONNECTED: ${reason}`, false);
    clearQr();
    console.log(`WhatsApp desconectado (${accountLabel}):`, reason);
  });

  client.on('message', message => {
    storeWhatsAppMessage(message, 'whatsapp').catch(error => {
      console.warn(`No se pudo guardar mensaje entrante (${accountLabel}):`, error.message);
    });
  });

  client.on('message_create', message => {
    storeWhatsAppMessage(message, 'whatsapp').catch(error => {
      console.warn(`No se pudo guardar mensaje creado (${accountLabel}):`, error.message);
    });
  });

  client.on('message_ack', (message, ack) => {
    try {
      const messageId = message && message.id && message.id._serialized;
      updateWhatsAppMessageAck(messageId, ack);
    } catch (error) {
      console.warn(`No se pudo actualizar estado del mensaje (${accountLabel}):`, error.message);
    }
  });

  client.initialize().catch(error => {
    markState('INIT_ERROR', false);
    state.lastError = error.message;
    console.error(`Error iniciando WhatsApp (${accountLabel}):`, error);
  });
}

app.get('/status', requireWorkerToken, (req, res) => {
  res.json({
    success: true,
    whatsapp: publicStatus()
  });
});

app.post('/send', requireWorkerToken, async (req, res) => {
  try {
    const savedMessage = await sendWhatsApp(
      req.body && (req.body.target || req.body.phone || req.body.chatId),
      req.body && req.body.message,
      req.body && req.body.source || 'inbox',
      {
        sentByUsername: req.body && req.body.sentByUsername,
        sentByName: req.body && req.body.sentByName
      }
    );

    res.json({
      success: true,
      message: savedMessage
    });
  } catch (error) {
    res.status(error.message.includes('todavia no esta conectado') ? 503 : 500).json({
      success: false,
      error: error.message
    });
  }
});

app.post('/validate-phone', requireWorkerToken, async (req, res) => {
  try {
    res.json({
      success: true,
      ...(await validateWhatsAppTarget(req.body && req.body.phone))
    });
  } catch (error) {
    res.status(error.message.includes('todavia no esta conectado') ? 503 : 400).json({
      success: false,
      error: error.message
    });
  }
});

app.post('/recover', requireWorkerToken, async (req, res) => {
  try {
    res.json({
      success: true,
      result: await syncRecentWhatsAppMessages({
        force: true,
        reason: 'manual-recovery',
        chatLimit: req.body && req.body.chatLimit,
        messageLimit: req.body && req.body.messageLimit
      })
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

setInterval(() => {
  syncRecentWhatsAppMessages({ reason: 'interval' }).catch(() => {});
}, recentMessagesSyncIntervalMs);

initializeWhatsAppClient();

app.listen(port, '127.0.0.1', () => {
  console.log(`Worker WhatsApp ${accountLabel} escuchando en 127.0.0.1:${port}`);
});
