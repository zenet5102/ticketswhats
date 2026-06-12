const crypto = require('crypto');
const {
  authenticateUser: authenticateStoredUser,
  getPublicUserByUsername
} = require('./users');

const cookieName = process.env.AUTH_COOKIE_NAME || 'wwebjs_session';
const sessionHours = parsePositiveInteger(process.env.AUTH_SESSION_HOURS, 12);
const sessionSecret = process.env.AUTH_SESSION_SECRET || crypto.randomBytes(32).toString('hex');
const adminRoles = new Set(['admin']);
const privilegedRoles = new Set(['admin']);

function parsePositiveInteger(value, fallback) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

if (!process.env.AUTH_SESSION_SECRET) {
  console.warn('AUTH_SESSION_SECRET no esta definido. Las sesiones se invalidan al reiniciar.');
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
  res.json({
    success: true,
    user,
    redirect: sanitizeNext(req.body && req.body.next)
  });
}

function handleLogout(req, res) {
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
  redirectIfAuthenticated,
  requireAuth
};
