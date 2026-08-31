require('./config');

const express = require('express');
const cors = require('cors');
const crypto = require('crypto');
const thirdDb = require('./thirdDb');

const app = express();
const port = Number.parseInt(process.env.THIRD_APP_PORT || '3002', 10);
const jsonLimitMb = Math.min(Math.max(Number.parseInt(process.env.THIRD_APP_JSON_LIMIT_MB || '25', 10), 1), 100);
const apiKeys = String(process.env.THIRD_APP_API_KEYS || process.env.THIRD_APP_API_KEY || '')
  .split(',')
  .map(key => key.trim())
  .filter(Boolean);

app.use(cors());
app.use(express.json({ limit: `${jsonLimitMb}mb` }));

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
    return next();
  }

  return res.status(401).json({
    success: false,
    error: 'API key del tercer server invalida o ausente'
  });
}

function asyncHandler(handler) {
  return async (req, res) => {
    try {
      await handler(req, res);
    } catch (error) {
      res.status(error.statusCode || 500).json({
        success: false,
        error: error.message
      });
    }
  };
}

app.get('/', (req, res) => {
  res.json({
    success: true,
    app: 'wwebjs-third-server',
    statusUrl: '/api/third/status'
  });
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
      apiKeyRequired: apiKeys.length > 0
    }
  });
}));

app.get('/api/third/counts', requireApiKey, asyncHandler(async (req, res) => {
  res.json({
    success: true,
    counts: await thirdDb.getCounts()
  });
}));

app.get('/api/third/users', requireApiKey, asyncHandler(async (req, res) => {
  res.json({
    success: true,
    users: await thirdDb.listUsers(req.query || {})
  });
}));

app.get('/api/third/tickets', requireApiKey, asyncHandler(async (req, res) => {
  res.json({
    success: true,
    tickets: await thirdDb.listTickets(req.query || {})
  });
}));

app.get('/api/third/messages', requireApiKey, asyncHandler(async (req, res) => {
  res.json({
    success: true,
    messages: await thirdDb.listMessages(req.query || {})
  });
}));

app.get('/api/third/audit/messages', requireApiKey, asyncHandler(async (req, res) => {
  const messages = await thirdDb.listMessages(req.query || {});

  res.json({
    success: true,
    query: req.query || {},
    count: messages.length,
    messages
  });
}));

app.post('/api/third/audit/messages', requireApiKey, asyncHandler(async (req, res) => {
  const messages = await thirdDb.listMessages(req.body || {});

  res.json({
    success: true,
    query: req.body || {},
    count: messages.length,
    messages
  });
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
