require('./config');

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const {
  authenticateUser: authenticateStoredUser,
  getPublicUserByUsername
} = require('./users');

const cookieName = process.env.AUTH_COOKIE_NAME || 'wwebjs_session';
const sessionHours = parsePositiveInteger(process.env.AUTH_SESSION_HOURS, 12);
const activeUserMinutes = parsePositiveInteger(process.env.AUTH_ACTIVE_USER_MINUTES, 5);
const sessionSecretPath = path.join(__dirname, 'data', 'auth-session-secret.key');
const sessionSecret = getSessionSecret();
const adminRoles = new Set(['admin']);
const privilegedRoles = new Set(['admin', 'usuario']);
const activeUsers = new Map();

function parsePositiveInteger(value, fallback) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

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
  const configuredSecret = String(process.env.AUTH_SESSION_SECRET || '').trim();

  if (configuredSecret) {
    return configuredSecret;
  }

  const storedSecret = readStoredSessionSecret();

  if (storedSecret) {
    console.warn('AUTH_SESSION_SECRET no esta definido. Se usa un secreto local persistente.');
    return storedSecret;
  }

  try {
    fs.mkdirSync(path.dirname(sessionSecretPath), { recursive: true });

    const generatedSecret = crypto.randomBytes(32).toString('hex');
    fs.writeFileSync(sessionSecretPath, `${generatedSecret}\n`, {
      encoding: 'utf8',
      flag: 'wx'
    });

    console.warn('AUTH_SESSION_SECRET no esta definido. Se genero un secreto local persistente.');
    return generatedSecret;
  } catch (error) {
    const retrySecret = readStoredSessionSecret();

    if (retrySecret) {
      console.warn('AUTH_SESSION_SECRET no esta definido. Se usa un secreto local persistente.');
      return retrySecret;
    }

    console.warn(`AUTH_SESSION_SECRET no esta definido y no se pudo guardar uno local. Las sesiones se invalidan al reiniciar. ${error.message}`);
    return crypto.randomBytes(32).toString('hex');
  }
}

function safeCompare(leftValue, rightValue) {
  const left = Buffer.from(String(leftValue || ''), 'utf8');
  const right = Buffer.from(String(rightValue || ''), 'utf8');

  if (left.length !== right.length) {
    return false;
  }

  return crypto.timingSafeEqual(left, right);
}

function publicUser(user) {
  return {
    username: user.username,
    role: user.role,
    name: user.name,
    groups: Array.isArray(user.groups) ? user.groups : [],
    isAdmin: adminRoles.has(user.role),
    isPrivileged: privilegedRoles.has(user.role)
  };
}

function authenticateUser(username, password) {
  const user = authenticateStoredUser(username, password);
  return user ? publicUser(user) : null;
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

function parseSessionValue(value) {
  const [payload, signature] = String(value || '').split('.');

  if (!payload || !signature || !safeCompare(signature, signPayload(payload))) {
    return null;
  }

  try {
    const session = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));

    if (!session || Number(session.exp || 0) <= Date.now()) {
      return null;
    }

    const user = getPublicUserByUsername(session.username);
    return user ? publicUser(user) : null;
  } catch (error) {
    return null;
  }
}

function getSessionUser(req) {
  const cookies = parseCookies(req.headers.cookie);
  return parseSessionValue(cookies[cookieName]);
}

function recordUserActivity(user) {
  if (!user || !user.username) {
    return;
  }

  const now = Date.now();
  activeUsers.set(String(user.username).toLowerCase(), {
    username: user.username,
    role: user.role,
    name: user.name,
    groups: Array.isArray(user.groups) ? user.groups : [],
    isAdmin: Boolean(user.isAdmin),
    isPrivileged: Boolean(user.isPrivileged),
    lastSeenAt: new Date(now).toISOString(),
    lastSeenTs: now
  });
}

function removeUserActivity(username) {
  const cleanUsername = String(username || '').trim().toLowerCase();

  if (cleanUsername) {
    activeUsers.delete(cleanUsername);
  }
}

function pruneActiveUsers() {
  const now = Date.now();
  const ttlMs = activeUserMinutes * 60 * 1000;

  for (const [username, user] of activeUsers.entries()) {
    if (now - Number(user.lastSeenTs || 0) > ttlMs) {
      activeUsers.delete(username);
    }
  }
}

function listConnectedUsers() {
  pruneActiveUsers();
  return Array.from(activeUsers.values())
    .map(user => ({
      username: user.username,
      role: user.role,
      name: user.name,
      groups: user.groups,
      isAdmin: user.isAdmin,
      isPrivileged: user.isPrivileged,
      lastSeenAt: user.lastSeenAt
    }))
    .sort((left, right) => left.name.localeCompare(right.name) || left.username.localeCompare(right.username));
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
    return '/dashboard';
  }

  return next;
}

function isHtmlRequest(req) {
  return req.method === 'GET' && String(req.headers.accept || '').includes('text/html');
}

function requireAuth(allowedRoles) {
  return (req, res, next) => {
    const user = getSessionUser(req);

    if (!user) {
      if (isHtmlRequest(req)) {
        return res.redirect(`/login?next=${encodeURIComponent(req.originalUrl || '/dashboard')}`);
      }

      return res.status(401).json({
        success: false,
        error: 'Sesion requerida'
      });
    }

    const allowed = !allowedRoles || allowedRoles.includes(user.role);

    if (!allowed) {
      if (isHtmlRequest(req)) {
        return res.redirect('/dashboard');
      }

      return res.status(403).json({
        success: false,
        error: 'Permisos insuficientes'
      });
    }

    recordUserActivity(user);
    req.user = user;
    next();
  };
}

function redirectIfAuthenticated(req, res, next) {
  const user = getSessionUser(req);

  if (user) {
    return res.redirect(sanitizeNext(req.query.next));
  }

  next();
}

function handleLogin(req, res) {
  const user = authenticateUser(req.body && req.body.username, req.body && req.body.password);

  if (!user) {
    return res.status(401).json({
      success: false,
      error: 'Usuario o contrasena invalidos'
    });
  }

  res.setHeader('Set-Cookie', createSessionCookie(user, req));
  recordUserActivity(user);
  res.json({
    success: true,
    user,
    redirect: sanitizeNext(req.body && req.body.next)
  });
}

function handleLogout(req, res) {
  const user = getSessionUser(req);

  if (user) {
    removeUserActivity(user.username);
  }

  res.setHeader('Set-Cookie', clearSessionCookie());
  res.json({ success: true });
}

function handleMe(req, res) {
  res.json({
    success: true,
    user: req.user
  });
}

module.exports = {
  adminRoles,
  handleLogin,
  handleLogout,
  handleMe,
  listConnectedUsers,
  redirectIfAuthenticated,
  requireAuth
};
