const { Client, LocalAuth, MessageMedia } = require('whatsapp-web.js');
const express = require('express');
const qrcode = require('qrcode-terminal');
const QRCode = require('qrcode-terminal/vendor/QRCode');
const QRErrorCorrectLevel = require('qrcode-terminal/vendor/QRCode/QRErrorCorrectLevel');
const cors = require('cors');
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
  getMysqlSettings,
  listWhatsAppConversations,
  listWhatsAppMessages,
  normalizeChatPhone,
  pingDatabase,
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

let whatsappReady = false;
let whatsappState = 'starting';
let whatsappLastEventAt = null;
let whatsappLastError = null;
let whatsappQr = null;
let whatsappQrText = null;
let whatsappQrSvg = null;
let whatsappRestarting = false;
let client = null;

app.use(cors());
app.use(express.json({ limit: `${maxRequestBodyMb}mb` }));

const requireLoggedIn = requireAuth();
const requirePrivileged = requireLoggedIn;

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

  if (!chatId) {
    return null;
  }

  const contactInfo = await getMessageContactInfo(message, chatId);
  const mediaInfo = await getMessageMediaInfo(message);
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
    phone: contactInfo.contactPhone || normalizeChatPhone(chatId),
    contactName: contactInfo.contactName,
    direction,
    body,
    mediaMime: mediaInfo.mediaMime,
    mediaData: mediaInfo.mediaData,
    mediaFilename: mediaInfo.mediaFilename,
    timestampTs: getWhatsAppTimestampMs(message.timestamp),
    fromMe: message.fromMe,
    ack: message.ack,
    source
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

    initializeWhatsAppClient().catch(() => {});
    return getWhatsAppStatus();
  } finally {
    whatsappRestarting = false;
  }
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

  return numberId._serialized;
}

async function sendWhatsApp(target, message, mediaInput, source = 'second-app') {
  await getWhatsAppStatus();

  if (!client || !whatsappReady) {
    throw new Error(`WhatsApp secundario todavia no esta conectado (${whatsappState})`);
  }

  const cleanMessage = String(message || '').trim();
  const media = normalizeOutgoingMedia(mediaInput);

  if (!cleanMessage && !media) {
    throw new Error('Falta mensaje o archivo');
  }

  const chatId = await resolveChatId(target);
  let sentMessage;

  if (media) {
    const messageMedia = new MessageMedia(media.mimetype, media.data, media.filename);
    sentMessage = await client.sendMessage(chatId, messageMedia, cleanMessage ? { caption: cleanMessage } : {});
  } else {
    sentMessage = await client.sendMessage(chatId, cleanMessage);
  }

  const cleanPhone = normalizeChatPhone(target || chatId);
  const body = cleanMessage || `[${getMediaLabel(media && media.mimetype, 'archivo')} sin texto]`;

  const savedMessage = await saveWhatsAppMessage({
    id: getStoredMessageId(sentMessage, chatId, 'outgoing'),
    chatId,
    phone: cleanPhone || normalizeChatPhone(chatId),
    direction: 'outgoing',
    body,
    mediaMime: media && media.mimetype,
    mediaData: media && media.data,
    mediaFilename: media && media.filename,
    timestampTs: getWhatsAppTimestampMs(sentMessage && sentMessage.timestamp),
    fromMe: true,
    ack: sentMessage && sentMessage.ack,
    source
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
      lastError: null
    };
  } catch (error) {
    return {
      ready: false,
      host: mysqlSettings.host,
      port: mysqlSettings.port,
      database: mysqlSettings.database,
      table: mysqlSettings.messagesTable,
      lastError: error.message
    };
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

app.get('/', requireLoggedIn, (req, res) => {
  sendHtmlFile(res, 'second-messages.html');
});

app.get('/dashboard', requireLoggedIn, (req, res) => {
  sendHtmlFile(res, 'second-messages.html');
});

app.get('/mensajes', requireLoggedIn, (req, res) => {
  sendHtmlFile(res, 'second-messages.html');
});

app.get('/api/status', requireLoggedIn, async (req, res) => {
  const [whatsapp, mysqlStatus] = await Promise.all([
    getWhatsAppStatus(),
    getDatabaseStatus()
  ]);

  res.json({
    success: true,
    whatsapp,
    mysql: mysqlStatus,
    mediaLimitBytes: maxStoredMediaBytes
  });
});

app.get('/api/chats', requireLoggedIn, async (req, res) => {
  try {
    res.json({
      success: true,
      conversations: await listWhatsAppConversations(req.query.limit)
    });
  } catch (error) {
    res.status(500).json({
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
      messages: await listWhatsAppMessages(chatId, req.query.limit)
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
    const result = await sendWhatsApp(target, body.message, body.media, 'second-inbox');

    res.json({
      success: true,
      chatId: result.chatId,
      message: result.message
    });
  } catch (error) {
    const status = error.message.includes('todavia no esta conectado') ? 503 : 400;
    res.status(status).json({
      success: false,
      error: error.message
    });
  }
});

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
  getWhatsAppStatus().catch(() => {});
}, 15000);

pingDatabase().catch(error => {
  console.warn('MySQL de segunda app no esta listo:', error.message);
});

initializeWhatsAppClient().catch(() => {});

app.listen(secondAppPort, () => {
  console.log(`Segunda app WhatsApp disponible en http://localhost:${secondAppPort}`);
});

module.exports = {
  app,
  getWhatsAppStatus,
  sendWhatsApp
};
