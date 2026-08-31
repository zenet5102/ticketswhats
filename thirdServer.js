require('./config');

const express = require('express');
const cors = require('cors');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const thirdDb = require('./thirdDb');

const app = express();
const port = Number.parseInt(process.env.THIRD_APP_PORT || '3002', 10);
const jsonLimitMb = Math.min(Math.max(Number.parseInt(process.env.THIRD_APP_JSON_LIMIT_MB || '25', 10), 1), 100);
const apiKeys = String(process.env.THIRD_APP_API_KEYS || process.env.THIRD_APP_API_KEY || '')
  .split(',')
  .map(key => key.trim())
  .filter(Boolean);
const cookieName = process.env.THIRD_APP_AUTH_COOKIE_NAME || 'wwebjs_third_session';
const sessionHours = Math.min(Math.max(Number.parseInt(process.env.THIRD_APP_AUTH_SESSION_HOURS || process.env.AUTH_SESSION_HOURS || '12', 10), 1), 720);
const sessionSecretPath = path.join(__dirname, 'data', 'third-auth-session-secret.key');
const sessionSecret = getSessionSecret();

app.use(cors());
app.use(express.json({ limit: `${jsonLimitMb}mb` }));

function readStoredSessionSecret() {
  try {
    if (!fs.existsSync(sessionSecretPath)) {
      return '';
    }

    return fs.readFileSync(sessionSecretPath, 'utf8').trim();
  } catch (error) {
    return '';
  }
}

function getSessionSecret() {
  const configuredSecret = String(process.env.THIRD_APP_AUTH_SESSION_SECRET || process.env.AUTH_SESSION_SECRET || '').trim();

  if (configuredSecret) {
    return configuredSecret;
  }

  const storedSecret = readStoredSessionSecret();

  if (storedSecret) {
    return storedSecret;
  }

  try {
    fs.mkdirSync(path.dirname(sessionSecretPath), { recursive: true });
    const generatedSecret = crypto.randomBytes(32).toString('hex');
    fs.writeFileSync(sessionSecretPath, `${generatedSecret}\n`, {
      encoding: 'utf8',
      flag: 'wx'
    });
    return generatedSecret;
  } catch (error) {
    return readStoredSessionSecret() || crypto.randomBytes(32).toString('hex');
  }
}

function getBearerToken(req) {
  const authorization = String(req.get('authorization') || '').trim();
  const match = authorization.match(/^Bearer\s+(.+)$/i);
  return match ? match[1].trim() : '';
}

function isValidApiKey(value) {
  const key = String(value || '').trim();

  if (!apiKeys.length) {
    return true;
  }

  if (!key) {
    return false;
  }

  return apiKeys.some(candidate => {
    const left = Buffer.from(candidate);
    const right = Buffer.from(key);
    return left.length === right.length && crypto.timingSafeEqual(left, right);
  });
}

function requireApiKey(req, res, next) {
  const apiKey = req.get('x-third-api-key') || getBearerToken(req);

  if (isValidApiKey(apiKey)) {
    req.authType = apiKeys.length ? 'api-key' : 'open-api';
    return next();
  }

  return res.status(401).json({
    success: false,
    error: 'API key del tercer server invalida o ausente'
  });
}

function signPayload(payload) {
  return crypto
    .createHmac('sha256', sessionSecret)
    .update(payload)
    .digest('base64url');
}

function createSessionValue(user) {
  const payload = Buffer.from(JSON.stringify({
    username: user.username,
    role: user.role,
    name: user.name,
    exp: Date.now() + sessionHours * 60 * 60 * 1000
  }), 'utf8').toString('base64url');

  return `${payload}.${signPayload(payload)}`;
}

function parseCookies(header) {
  const cookies = {};

  for (const part of String(header || '').split(';')) {
    const separatorIndex = part.indexOf('=');

    if (separatorIndex === -1) {
      continue;
    }

    const key = part.slice(0, separatorIndex).trim();
    const value = part.slice(separatorIndex + 1).trim();

    if (!key) {
      continue;
    }

    try {
      cookies[key] = decodeURIComponent(value);
    } catch (error) {
      cookies[key] = value;
    }
  }

  return cookies;
}

async function parseSessionValue(value) {
  const [payload, signature] = String(value || '').split('.');

  if (!payload || !signature || !isValidSignedValue(signature, signPayload(payload))) {
    return null;
  }

  try {
    const session = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));

    if (!session || Number(session.exp || 0) <= Date.now()) {
      return null;
    }

    const user = await thirdDb.getUserByUsername(session.username);
    return thirdDb.publicUser(user);
  } catch (error) {
    return null;
  }
}

function isValidSignedValue(leftValue, rightValue) {
  const left = Buffer.from(String(leftValue || ''), 'utf8');
  const right = Buffer.from(String(rightValue || ''), 'utf8');

  if (left.length !== right.length) {
    return false;
  }

  return crypto.timingSafeEqual(left, right);
}

async function getSessionUser(req) {
  const cookies = parseCookies(req.headers.cookie);
  return parseSessionValue(cookies[cookieName]);
}

function serializeCookie(name, value, options = {}) {
  const parts = [
    `${name}=${encodeURIComponent(value)}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax'
  ];

  if (options.maxAge !== undefined) {
    parts.push(`Max-Age=${options.maxAge}`);
  }

  if (options.secure) {
    parts.push('Secure');
  }

  return parts.join('; ');
}

function createSessionCookie(user, req) {
  return serializeCookie(cookieName, createSessionValue(user), {
    maxAge: sessionHours * 60 * 60,
    secure: Boolean(req.secure)
  });
}

function clearSessionCookie() {
  return serializeCookie(cookieName, '', { maxAge: 0 });
}

function sanitizeNext(value) {
  const next = String(value || '').trim();

  if (!next || !next.startsWith('/') || next.startsWith('//') || next.startsWith('/auth/')) {
    return '/api/third/status';
  }

  return next;
}

function isHtmlRequest(req) {
  return req.method === 'GET' && String(req.headers.accept || '').includes('text/html');
}

function requireSession(allowedRoles) {
  return asyncHandler(async (req, res, next) => {
    const user = await getSessionUser(req);

    if (!user) {
      if (isHtmlRequest(req)) {
        return res.redirect(`/login?next=${encodeURIComponent(req.originalUrl || '/api/third/status')}`);
      }

      return res.status(401).json({
        success: false,
        error: 'Sesion requerida'
      });
    }

    const allowed = !allowedRoles || allowedRoles.includes(user.role);

    if (!allowed) {
      return res.status(403).json({
        success: false,
        error: 'Permisos insuficientes'
      });
    }

    res.setHeader('Set-Cookie', createSessionCookie(user, req));
    req.user = user;
    req.authType = 'session';
    next();
  });
}

function requireSessionOrApiKey(req, res, next) {
  const apiKey = req.get('x-third-api-key') || getBearerToken(req);

  if (isValidApiKey(apiKey)) {
    req.authType = apiKeys.length ? 'api-key' : 'open-api';
    return next();
  }

  return requireSession()(req, res, next);
}

function asyncHandler(handler) {
  return async (req, res, next) => {
    try {
      await handler(req, res, next);
    } catch (error) {
      res.status(error.statusCode || 500).json({
        success: false,
        error: error.message
      });
    }
  };
}

function sendHtmlFile(res, filename) {
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');
  res.sendFile(path.join(__dirname, filename));
}

function unavailableInThirdServer(feature) {
  const error = new Error(`${feature} no esta disponible en el tercer server de migracion`);
  error.statusCode = 503;
  throw error;
}

function getQueueSnapshot() {
  return {
    success: true,
    thirdServer: true,
    scheduler: {
      enabled: false,
      running: false,
      lastRunAt: null,
      lastError: null
    },
    stats: {
      pending: 0,
      processing: 0,
      sent: 0,
      error: 0,
      canceled: 0
    },
    items: []
  };
}

app.get('/login', asyncHandler(async (req, res, next) => {
  const user = await getSessionUser(req);

  if (user) {
    return res.redirect(sanitizeNext(req.query.next));
  }

  next();
}), (req, res) => {
  sendHtmlFile(res, 'login.html');
});

app.post('/auth/login', asyncHandler(async (req, res) => {
  const user = await thirdDb.authenticateUser(req.body && req.body.username, req.body && req.body.password);

  if (!user) {
    return res.status(401).json({
      success: false,
      error: 'Usuario o contrasena invalidos'
    });
  }

  res.setHeader('Set-Cookie', createSessionCookie(user, req));
  res.json({
    success: true,
    user,
    redirect: sanitizeNext(req.body && req.body.next)
  });
}));

app.post('/auth/logout', asyncHandler(async (req, res) => {
  res.setHeader('Set-Cookie', clearSessionCookie());
  res.json({ success: true });
}));

app.get('/auth/me', requireSession(), (req, res) => {
  res.json({
    success: true,
    user: req.user
  });
});

app.get('/', requireSession(), (req, res) => {
  res.redirect('/dashboard');
});

app.get('/dashboard', requireSession(), (req, res) => {
  sendHtmlFile(res, 'dashboard.html');
});

app.get('/mensajes', requireSession(), (req, res) => {
  sendHtmlFile(res, 'messages.html');
});

app.get('/cola', requireSession(), (req, res) => {
  sendHtmlFile(res, 'queue.html');
});

app.get('/usuarios', requireSession(['admin']), (req, res) => {
  sendHtmlFile(res, 'users.html');
});

app.get('/phantom', requireSession(), (req, res) => {
  res.redirect('/phantom/suspendidos');
});

app.get('/clientes', requireSession(), (req, res) => {
  res.redirect('/phantom/suspendidos');
});

app.get('/clientes/suspendidos', requireSession(), (req, res) => {
  res.redirect('/phantom/suspendidos');
});

app.get('/clientes/activos', requireSession(), (req, res) => {
  res.redirect('/phantom/activos');
});

app.get('/clientes/bajas', requireSession(), (req, res) => {
  res.redirect('/phantom/baja');
});

app.get('/phantom/suspendidos', requireSession(), (req, res) => {
  sendHtmlFile(res, 'phantom.html');
});

app.get('/phantom/activos', requireSession(), (req, res) => {
  sendHtmlFile(res, 'phantom.html');
});

app.get('/phantom/clientes', requireSession(), (req, res) => {
  sendHtmlFile(res, 'phantom.html');
});

app.get('/phantom/baja', requireSession(), (req, res) => {
  sendHtmlFile(res, 'phantom.html');
});

app.get('/api/third/status', asyncHandler(async (req, res) => {
  const mysql = thirdDb.getMysqlSettings();
  const ready = await thirdDb.pingDatabase()
    .then(() => true)
    .catch(() => false);

  res.json({
    success: true,
    server: 'third',
    port,
    mysql: {
      ready,
      host: mysql.host,
      port: mysql.port,
      database: mysql.database,
      user: mysql.user
    },
    auth: {
      apiKeyRequired: apiKeys.length > 0,
      loginEnabled: true
    }
  });
}));

app.get('/api/third/counts', requireSessionOrApiKey, asyncHandler(async (req, res) => {
  res.json({
    success: true,
    counts: await thirdDb.getCounts()
  });
}));

app.get('/api/third/users', requireSessionOrApiKey, asyncHandler(async (req, res) => {
  res.json({
    success: true,
    users: await thirdDb.listUsers(req.query || {})
  });
}));

app.get('/api/third/tickets', requireSessionOrApiKey, asyncHandler(async (req, res) => {
  res.json({
    success: true,
    tickets: await thirdDb.listTickets(req.query || {})
  });
}));

app.get('/api/third/messages', requireSessionOrApiKey, asyncHandler(async (req, res) => {
  res.json({
    success: true,
    messages: await thirdDb.listMessages(req.query || {})
  });
}));

app.get('/api/third/audit/messages', requireSessionOrApiKey, asyncHandler(async (req, res) => {
  const messages = await thirdDb.listMessages(req.query || {});

  res.json({
    success: true,
    query: req.query || {},
    count: messages.length,
    messages
  });
}));

app.post('/api/third/audit/messages', requireSessionOrApiKey, asyncHandler(async (req, res) => {
  const messages = await thirdDb.listMessages(req.body || {});

  res.json({
    success: true,
    query: req.body || {},
    count: messages.length,
    messages
  });
}));

app.get('/api/status', requireSession(), asyncHandler(async (req, res) => {
  const mysql = thirdDb.getMysqlSettings();
  const ready = await thirdDb.pingDatabase()
    .then(() => true)
    .catch(() => false);
  const queue = getQueueSnapshot();

  res.json({
    success: true,
    thirdServer: true,
    whatsapp: {
      ready: false,
      state: 'migration-only'
    },
    mysql: {
      ready,
      host: mysql.host,
      port: mysql.port,
      database: mysql.database,
      user: mysql.user
    },
    queue: queue.stats,
    scheduler: queue.scheduler
  });
}));

app.get('/tickets/job-status', requireSession(), asyncHandler(async (req, res) => {
  res.json(await thirdDb.getTicketJobStatus());
}));

app.get('/tickets', requireSession(), asyncHandler(async (req, res) => {
  res.json({
    success: true,
    tickets: await thirdDb.listTickets(req.query || {})
  });
}));

app.get('/tickets/:externalId', requireSession(), asyncHandler(async (req, res) => {
  const ticket = await thirdDb.getTicketByExternalId(req.params.externalId);

  if (!ticket) {
    return res.status(404).json({
      success: false,
      error: 'Ticket no encontrado'
    });
  }

  res.json({ success: true, ticket });
}));

app.post('/tickets/:externalId/validate-phone', requireSession(), asyncHandler(async () => {
  unavailableInThirdServer('Validacion de telefono por WhatsApp');
}));

app.post('/tickets/:externalId/phone', requireSession(), asyncHandler(async () => {
  unavailableInThirdServer('Actualizacion de telefono de ticket');
}));

app.get('/messages/conversations', requireSession(), asyncHandler(async (req, res) => {
  res.json({
    success: true,
    conversations: await thirdDb.listConversations(req.query || {})
  });
}));

app.post('/messages/conversations/bucket', requireSession(), asyncHandler(async () => {
  unavailableInThirdServer('Cambio de bandeja de conversacion');
}));

app.get('/messages', requireSession(), asyncHandler(async (req, res) => {
  res.json({
    success: true,
    messages: await thirdDb.listMessages(req.query || {})
  });
}));

app.post('/messages/send', requireSession(['admin', 'usuario']), asyncHandler(async () => {
  unavailableInThirdServer('Envio de WhatsApp');
}));

app.post('/messages/validate-phone', requireSession(['admin', 'usuario']), asyncHandler(async () => {
  unavailableInThirdServer('Validacion de telefono por WhatsApp');
}));

app.post('/whatsapp/reconnect', requireSession(['admin', 'usuario']), asyncHandler(async () => {
  unavailableInThirdServer('Reconectar WhatsApp');
}));

app.post('/whatsapp/reset-auth', requireSession(['admin']), asyncHandler(async () => {
  unavailableInThirdServer('Reset de autenticacion WhatsApp');
}));

app.get('/users', requireSession(['admin']), asyncHandler(async (req, res) => {
  res.json({
    success: true,
    users: await thirdDb.listUsers(req.query || {})
  });
}));

app.post('/users', requireSession(['admin']), asyncHandler(async () => {
  unavailableInThirdServer('Alta de usuarios');
}));

app.put('/users/:id', requireSession(['admin']), asyncHandler(async () => {
  unavailableInThirdServer('Edicion de usuarios');
}));

app.delete('/users/:id', requireSession(['admin']), asyncHandler(async () => {
  unavailableInThirdServer('Baja de usuarios');
}));

app.get('/transfers', requireSession(), asyncHandler(async (req, res) => {
  res.json({
    success: true,
    transfers: [],
    users: await thirdDb.listUsers({ limit: 500 })
  });
}));

app.post('/transfers', requireSession(['admin']), asyncHandler(async () => {
  unavailableInThirdServer('Transferencias');
}));

app.delete('/transfers/:username', requireSession(['admin']), asyncHandler(async () => {
  unavailableInThirdServer('Transferencias');
}));

app.get('/settings/message-template', requireSession(), asyncHandler(async (req, res) => {
  res.json({
    success: true,
    template: await thirdDb.getAppStateValue('message_template', ''),
    automaticReminderEnabled: false
  });
}));

app.post('/settings/message-template', requireSession(['admin', 'usuario']), asyncHandler(async () => {
  unavailableInThirdServer('Edicion de configuracion');
}));

app.get('/settings/notification-channel-reply', requireSession(), asyncHandler(async (req, res) => {
  res.json({
    success: true,
    enabled: false,
    template: ''
  });
}));

app.post('/settings/notification-channel-reply', requireSession(['admin', 'usuario']), asyncHandler(async () => {
  unavailableInThirdServer('Edicion de canal de respuesta');
}));

app.get('/settings/automatic-message-templates', requireSession(), asyncHandler(async (req, res) => {
  const templates = await thirdDb.listAutomaticMessageTemplates();

  res.json({
    success: true,
    templates,
    defaultTemplate: templates[0] && templates[0].body || ''
  });
}));

app.post('/settings/automatic-message-templates', requireSession(['admin', 'usuario']), asyncHandler(async () => {
  unavailableInThirdServer('Edicion de templates');
}));

app.put('/settings/automatic-message-templates/:id', requireSession(['admin', 'usuario']), asyncHandler(async () => {
  unavailableInThirdServer('Edicion de templates');
}));

app.delete('/settings/automatic-message-templates/:id', requireSession(['admin', 'usuario']), asyncHandler(async () => {
  unavailableInThirdServer('Edicion de templates');
}));

app.post('/settings/automatic-reminder', requireSession(['admin']), asyncHandler(async () => {
  unavailableInThirdServer('Recordatorios automaticos');
}));

app.get('/api/message-queue/status', requireSession(), (req, res) => {
  res.json(getQueueSnapshot());
});

app.get('/api/message-queue', requireSession(), (req, res) => {
  res.json(getQueueSnapshot());
});

app.post('/api/message-queue', requireSession(['admin', 'usuario']), asyncHandler(async () => {
  unavailableInThirdServer('Cola de mensajes');
}));

app.post('/api/message-queue/:id/cancel', requireSession(['admin', 'usuario']), asyncHandler(async () => {
  unavailableInThirdServer('Cola de mensajes');
}));

app.get('/api/message-templates', requireSession(), asyncHandler(async (req, res) => {
  const templates = await thirdDb.listAutomaticMessageTemplates();

  res.json({
    success: true,
    templates,
    defaultTemplate: templates[0] && templates[0].body || ''
  });
}));

app.get('/api/message-templates/:id', requireSession(), asyncHandler(async (req, res) => {
  const templates = await thirdDb.listAutomaticMessageTemplates();
  const template = templates.find(item => String(item.id) === String(req.params.id));

  if (!template) {
    return res.status(404).json({
      success: false,
      error: 'Template no encontrado'
    });
  }

  res.json({ success: true, template });
}));

app.post('/api/message-templates', requireSession(['admin', 'usuario']), asyncHandler(async () => {
  unavailableInThirdServer('Edicion de templates');
}));

app.put('/api/message-templates/:id', requireSession(['admin', 'usuario']), asyncHandler(async () => {
  unavailableInThirdServer('Edicion de templates');
}));

app.delete('/api/message-templates/:id', requireSession(['admin', 'usuario']), asyncHandler(async () => {
  unavailableInThirdServer('Edicion de templates');
}));

app.get('/api/phantom/consulta-masiva', requireSession(), asyncHandler(async (req, res) => {
  const estado = String(req.query.estado || '').trim();
  const search = String(req.query.search || '').trim();
  const tickets = await thirdDb.listTickets({
    client: search,
    limit: req.query.limit || 100,
    offset: req.query.offset || 0
  });
  const rows = tickets.map(ticket => ({
    IDA: ticket.external_id,
    CLIENTE: ticket.razon_social || ticket.delegacion || ticket.external_id,
    ESTADO: estado || ticket.status || 'Migrado',
    MOVIL: ticket.phone || '',
    TELEFONO: ticket.phone || '',
    DELEGACION: ticket.delegacion || '',
    FECHA: ticket.start_date || '',
    HORA: ticket.start_time || '',
    ticket_external_id: ticket.external_id,
    payload: ticket.payload_json
  }));

  res.json({
    success: true,
    thirdServer: true,
    estado,
    rows,
    pagination: {
      limit: Number(req.query.limit || 100),
      offset: Number(req.query.offset || 0),
      total: rows.length,
      hasNextPage: rows.length >= Number(req.query.limit || 100)
    },
    receivedAt: new Date().toISOString()
  });
}));

app.post('/api/phantom/consulta-masiva', requireSession(), asyncHandler(async () => {
  unavailableInThirdServer('Consulta Phantom en vivo');
}));

app.get('/api/phantom/cliente-avanzada', requireSession(), asyncHandler(async (req, res) => {
  const ticket = await thirdDb.getTicketByExternalId(req.query.IDA || req.query.id || req.query.ticket);

  res.json({
    success: true,
    thirdServer: true,
    data: ticket || null
  });
}));

app.post('/api/phantom/cliente-avanzada', requireSession(), asyncHandler(async () => {
  unavailableInThirdServer('Consulta Phantom en vivo');
}));

app.get('/api/phantom/baja/sync-status', requireSession(), (req, res) => {
  res.json({
    success: true,
    thirdServer: true,
    running: false,
    lastRunAt: null,
    lastError: null
  });
});

app.post('/api/phantom/baja/sync', requireSession(['admin', 'usuario']), asyncHandler(async () => {
  unavailableInThirdServer('Sincronizacion Phantom');
}));

app.get('/api/whatsapp/check-number', requireSession(), asyncHandler(async () => {
  unavailableInThirdServer('Validacion de WhatsApp');
}));

app.use((req, res) => {
  res.status(404).json({
    success: false,
    error: 'Ruta no encontrada'
  });
});

const server = app.listen(port, () => {
  console.log(`Tercer server de migracion escuchando en puerto ${port}`);
});

function shutdown() {
  server.close(async () => {
    await thirdDb.closePool().catch(error => {
      console.error('Error cerrando MySQL del tercer server:', error.message);
    });
    process.exit(0);
  });
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
