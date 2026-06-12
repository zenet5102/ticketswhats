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
  redirectIfAuthenticated,
  requireAuth
} = require('./auth');
const {
  createTicketResponseAction,
  listTickets,
  listWhatsAppConversations,
  listWhatsAppMessages,
  normalizeChatPhone,
  saveWhatsAppMessage
} = require('./db');
const {
  getMessageTemplate,
  getNotificationChannelReply,
  getTicketResponseQuestion,
  isAutomaticReminderEnabled,
  setAutomaticReminderEnabled,
  setMessageTemplate
} = require('./settings');
const {
  formatQuestionText,
  handleIncomingTextResponse
} = require('./ticketResponseFlow');
const {
  allowedRoles,
  createUser,
  deleteUser,
  listUsers: listAppUsers,
  updateUser
} = require('./users');
const {
  getTicketJobStatus,
  refreshTicketStatuses,
  refreshTicketPhones,
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
const requirePrivileged = requireAuth(['admin']);
const requireAdmin = requireAuth(['admin']);

app.get('/favicon.ico', (req, res) => {
  res.status(204).end();
});

app.get('/login', redirectIfAuthenticated, (req, res) => {
  res.sendFile(path.join(__dirname, 'login.html'));
});

app.post('/auth/login', handleLogin);
app.post('/auth/logout', handleLogout);
app.get('/auth/me', requireLoggedIn, handleMe);

app.get('/usuarios', requireAdmin, (req, res) => {
  res.sendFile(path.join(__dirname, 'users.html'));
});

app.get('/users', requireAdmin, (req, res) => {
  res.json({
    success: true,
    roles: allowedRoles,
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

app.get('/enviar', requirePrivileged, (req, res) => {
  res.sendFile(path.join(__dirname, 'enviar.html'));
});

app.get('/', requireLoggedIn, (req, res) => {
  res.sendFile(path.join(__dirname, 'dashboard.html'));
});

app.get('/dashboard', requireLoggedIn, (req, res) => {
  res.sendFile(path.join(__dirname, 'dashboard.html'));
});

app.get('/mensajes', requireLoggedIn, (req, res) => {
  res.sendFile(path.join(__dirname, 'messages.html'));
});

app.get('/test', requirePrivileged, (req, res) => {
  res.sendFile(path.join(__dirname, 'enviar.html'));
});

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
  } else if (!result) {
    await sendNotificationChannelReply(storedMessage);
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

  return {
    ticketExternalId,
    question,
    text: questionText,
    fullMessage: `${message}\n\n${questionText}`
  };
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

app.get('/messages/conversations', requireLoggedIn, (req, res) => {
  try {
    res.json({
      success: true,
      conversations: listWhatsAppConversations(req.query.limit)
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
      tickets: listTickets(req.query.date)
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
    const automaticReminderEnabled = req.body.automaticReminderEnabled === undefined
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

app.post('/settings/automatic-reminder', requirePrivileged, (req, res) => {
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

startTicketScheduler({
  isWhatsAppReady,
  sendWhatsApp
});

app.listen(config.port, () => {
  console.log(`API escuchando en puerto ${config.port}`);
});
