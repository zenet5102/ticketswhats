require('./config');

const AUTH_ACTION = 'autentificar';
const CONSULTA_MASIVA_ACTION = 'Consulta_Masiva_Datos';
const CONSULTA_MASIVA_QUERY = {
  JSON: 1,
  Desc: 1,
  Limit: 10,
  Offset: 0,
  BalanceCC: 1,
  CompAdeudados: 1,
  Estado: 'Suspendido'
};
const DEFAULT_TOKEN_PATHS = [
  'token',
  'Token',
  'access_token',
  'accessToken',
  'data.token',
  'data.Token',
  'data.access_token',
  'resultado.token',
  'result.token'
];

function parsePositiveInteger(value, fallback) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function parseJsonObject(value, label) {
  if (!value) {
    return {};
  }

  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch (error) {
    console.warn(`${label} no es JSON valido. Se ignora.`);
    return {};
  }
}

function parseCsvList(value, fallback = []) {
  const items = String(value || '')
    .split(',')
    .map(item => item.trim())
    .filter(Boolean);

  return items.length ? items : fallback;
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

function getByPath(source, path) {
  if (!source || !path) {
    return undefined;
  }

  return String(path)
    .split('.')
    .reduce((value, key) => (value && value[key] !== undefined ? value[key] : undefined), source);
}

function getFirstByPaths(source, paths) {
  for (const path of paths) {
    const value = getByPath(source, path);

    if (value !== undefined && value !== null && String(value).trim() !== '') {
      return value;
    }
  }

  return undefined;
}

function getAuthToken(payload, paths) {
  if (typeof payload === 'string') {
    const cleanPayload = stripJsonBom(payload);
    return /^(ok|true|success|exito|autenticado)$/i.test(cleanPayload) ? '' : cleanPayload;
  }

  const token = getFirstByPaths(payload, paths);
  return token === undefined || token === null ? '' : stripJsonBom(token);
}

function buildCookieHeader(cookies = []) {
  return cookies
    .map(cookie => String(cookie || '').split(';')[0].trim())
    .filter(Boolean)
    .join('; ');
}

function getSetCookies(headers) {
  if (!headers) {
    return [];
  }

  if (typeof headers.getSetCookie === 'function') {
    return headers.getSetCookie();
  }

  const cookieHeader = headers.get && headers.get('set-cookie');
  return cookieHeader ? [cookieHeader] : [];
}

function stripJsonBom(value) {
  return String(value === undefined || value === null ? '' : value)
    .replace(/^(?:\uFEFF|\u00EF\u00BB\u00BF|\u00C3\u00AF\u00C2\u00BB\u00C2\u00BF)/, '')
    .trim();
}

function parseResponsePayload(text) {
  const cleanText = stripJsonBom(text);

  if (!cleanText) {
    return null;
  }

  try {
    let parsed = JSON.parse(cleanText);

    for (let index = 0; index < 2 && typeof parsed === 'string'; index += 1) {
      const nested = stripJsonBom(parsed);

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

class PhantomApi {
  constructor(options = {}) {
    this.baseUrl = String(options.baseUrl || process.env.PHANTOM_API_URL || '').trim();
    this.apiUser = String(options.apiUser || process.env.PHANTOM_API_USER || '').trim();
    this.apiPass = String(options.apiPass || process.env.PHANTOM_API_PASS || '').trim();
    this.timeoutMs = parsePositiveInteger(options.timeoutMs || process.env.PHANTOM_API_TIMEOUT_MS, 15000);
    this.headers = {
      ...parseJsonObject(process.env.PHANTOM_API_HEADERS, 'PHANTOM_API_HEADERS'),
      ...(options.headers || {})
    };
    this.tokenPaths = parseCsvList(process.env.PHANTOM_API_TOKEN_PATHS, DEFAULT_TOKEN_PATHS);
  }

  buildActionUrl(action, query = {}) {
    if (!this.baseUrl) {
      throw new Error('Falta PHANTOM_API_URL');
    }

    const url = new URL(this.baseUrl);
    url.searchParams.set('action', action);

    for (const [key, value] of Object.entries(query || {})) {
      if (value !== undefined && value !== null && value !== '') {
        url.searchParams.set(key, String(value));
      }
    }

    return url.toString();
  }

  async postAction(action, body, options = {}) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    const url = this.buildActionUrl(action, options.query);
    const headers = {
      Accept: 'application/json',
      ...this.headers,
      ...(options.headers || {})
    };
    const requestOptions = {
      method: 'POST',
      headers,
      signal: controller.signal
    };

    if (body !== undefined) {
      requestOptions.headers = {
        ...requestOptions.headers,
        'Content-Type': 'application/json'
      };
      requestOptions.body = JSON.stringify(body || {});
    }

    try {
      const response = await fetch(url, requestOptions);
      const text = await response.text();
      const payload = parseResponsePayload(text);

      if (!response.ok) {
        const message = payload && typeof payload === 'object'
          ? payload.error || payload.message || payload.msg
          : '';
        throw new Error(message || `HTTP ${response.status} ${response.statusText}`);
      }

      return {
        payload,
        status: response.status,
        statusText: response.statusText,
        headers: Object.fromEntries(response.headers.entries()),
        cookies: getSetCookies(response.headers)
      };
    } finally {
      clearTimeout(timeout);
    }
  }

  async autentificar(options = {}) {
    const apiUser = normalizePhantomQueryValue(options.apiUser || this.apiUser);
    const apiPass = normalizePhantomQueryValue(options.apiPass || this.apiPass);

    if (!apiUser || !apiPass) {
      throw new Error('Faltan PHANTOM_API_USER o PHANTOM_API_PASS');
    }

    const response = await this.postAction(
      AUTH_ACTION,
      undefined,
      {
        query: {
          api_user: apiUser,
          api_pass: apiPass
        },
        headers: options.headers
      }
    );
    const token = getAuthToken(response.payload, this.tokenPaths);

    return {
      token,
      payload: response.payload,
      cookies: response.cookies || [],
      cookieHeader: buildCookieHeader(response.cookies || [])
    };
  }

  async consultaMasivaDatos(options = {}) {
    const auth = await this.autentificar({
      apiUser: options.apiUser,
      apiPass: options.apiPass,
      headers: options.authHeaders
    });
    const headers = { ...(options.headers || {}) };

    if (auth.cookieHeader && !headers.Cookie) {
      headers.Cookie = auth.cookieHeader;
    }

    const idDesde = parsePositiveInteger(options.idDesde || process.env.PHANTOM_CONSULTA_ID_DESDE, 1);
    const idHasta = parsePositiveInteger(options.idHasta || process.env.PHANTOM_CONSULTA_ID_HASTA, 999999999);
    const response = await this.postAction(
      CONSULTA_MASIVA_ACTION,
      {
        token: auth.token || '',
        ID_Desde: idDesde,
        ID_Hasta: idHasta
      },
      {
        headers,
        query: {
          ...CONSULTA_MASIVA_QUERY,
          ...(options.query || {})
        }
      }
    );
    const phantomCode = response.payload && typeof response.payload === 'object'
      ? Number(response.payload.code)
      : NaN;

    if (Number.isFinite(phantomCode) && phantomCode >= 400) {
      throw new Error(response.payload.message || response.payload.error || response.payload.msg || `Phantom code ${response.payload.code}`);
    }

    return {
      rows: extractRows(response.payload),
      payload: response.payload,
      auth: {
        tokenReceived: Boolean(auth.token),
        cookieReceived: Boolean(auth.cookieHeader)
      }
    };
  }
}

function extractRows(payload) {
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
    payload.respuesta,
    payload.data && payload.data.items,
    payload.data && payload.data.records,
    payload.data && payload.data.datos,
    payload.result && payload.result.items,
    payload.result && payload.result.datos
  ];

  for (const candidate of candidates) {
    if (Array.isArray(candidate)) {
      return candidate;
    }
  }

  return [payload];
}

module.exports = {
  PhantomApi,
  extractRows
};
