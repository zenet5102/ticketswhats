class ApiConnection {
  constructor(options = {}) {
    this.baseUrl = String(options.baseUrl || '').trim();
    this.defaultMethod = String(options.method || 'POST').toUpperCase();
    this.defaultBodyFormat = String(options.bodyFormat || 'json').toLowerCase();
    this.actionField = String(options.actionField || 'action').trim();
    this.timeoutMs = parsePositiveInteger(options.timeoutMs, 15000);
    this.headers = normalizeHeaders(options.headers);
    this.actions = new Map();

    for (const [name, action] of Object.entries(options.actions || {})) {
      this.addAction(name, action);
    }
  }

  addAction(name, options = {}) {
    const actionName = String(name || '').trim();

    if (!actionName) {
      throw new Error('Falta nombre de action');
    }

    this.actions.set(actionName, {
      action: options.action === undefined ? actionName : options.action,
      path: String(options.path || '').trim(),
      method: String(options.method || this.defaultMethod).toUpperCase(),
      bodyFormat: String(options.bodyFormat || this.defaultBodyFormat).toLowerCase(),
      query: normalizePlainObject(options.query),
      body: normalizePlainObject(options.body),
      headers: normalizeHeaders(options.headers),
      actionIn: options.actionIn || 'body'
    });

    return this;
  }

  async run(actionName, options = {}) {
    const response = await this.runDetailed(actionName, options);
    return response.payload;
  }

  async runDetailed(actionName, options = {}) {
    const action = this.getAction(actionName);
    const method = String(options.method || action.method || this.defaultMethod).toUpperCase();
    const bodyFormat = String(options.bodyFormat || action.bodyFormat || this.defaultBodyFormat).toLowerCase();
    const headers = {
      ...this.headers,
      ...action.headers,
      ...normalizeHeaders(options.headers)
    };
    const actionValue = options.action === undefined ? action.action : options.action;
    const query = {
      ...action.query,
      ...normalizePlainObject(options.query)
    };
    const body = {
      ...action.body,
      ...normalizePlainObject(options.body)
    };

    this.applyAction({
      actionIn: options.actionIn || action.actionIn,
      actionValue,
      query,
      body
    });

    const url = this.buildUrl(options.path || action.path, query);
    return this.requestDetailed(url, {
      method,
      bodyFormat,
      headers,
      body
    });
  }

  getAction(actionName) {
    const action = this.actions.get(String(actionName || '').trim());

    if (!action) {
      throw new Error(`Action no configurada: ${actionName}`);
    }

    return action;
  }

  applyAction({ actionIn, actionValue, query, body }) {
    if (!actionValue || !this.actionField) {
      return;
    }

    const target = String(actionIn || 'body').toLowerCase();

    if (target === 'query' || target === 'url') {
      query[this.actionField] = actionValue;
      return;
    }

    if (target === 'both') {
      query[this.actionField] = actionValue;
      body[this.actionField] = actionValue;
      return;
    }

    body[this.actionField] = actionValue;
  }

  buildUrl(pathValue, query = {}) {
    if (!this.baseUrl) {
      throw new Error('Falta baseUrl');
    }

    const url = new URL(joinUrl(this.baseUrl, pathValue));

    for (const [key, value] of Object.entries(query)) {
      if (value === undefined || value === null || value === '') {
        continue;
      }

      if (Array.isArray(value)) {
        for (const item of value) {
          if (item !== undefined && item !== null && item !== '') {
            url.searchParams.append(key, String(item));
          }
        }
        continue;
      }

      url.searchParams.set(key, String(value));
    }

    return url.toString();
  }

  async request(url, options = {}) {
    const response = await this.requestDetailed(url, options);
    return response.payload;
  }

  async requestDetailed(url, options = {}) {
    const method = String(options.method || this.defaultMethod).toUpperCase();
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    const requestOptions = {
      method,
      headers: {
        Accept: 'application/json',
        ...normalizeHeaders(options.headers)
      },
      signal: controller.signal
    };

    if (hasBody(method)) {
      const bodyFormat = String(options.bodyFormat || this.defaultBodyFormat).toLowerCase();

      if (bodyFormat === 'form' || bodyFormat === 'urlencoded') {
        requestOptions.headers['Content-Type'] = 'application/x-www-form-urlencoded';
        requestOptions.body = new URLSearchParams(normalizePlainObject(options.body)).toString();
      } else {
        requestOptions.headers['Content-Type'] = 'application/json';
        requestOptions.body = JSON.stringify(normalizePlainObject(options.body));
      }
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
}

function parsePositiveInteger(value, fallback) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function normalizeHeaders(headers) {
  if (!headers || typeof headers !== 'object' || Array.isArray(headers)) {
    return {};
  }

  return Object.entries(headers).reduce((normalized, [key, value]) => {
    if (key && value !== undefined && value !== null && value !== '') {
      normalized[key] = String(value);
    }

    return normalized;
  }, {});
}

function normalizePlainObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function hasBody(method) {
  return !['GET', 'HEAD'].includes(String(method || 'GET').toUpperCase());
}

function getSetCookies(headers) {
  if (!headers) {
    return [];
  }

  if (typeof headers.getSetCookie === 'function') {
    return headers.getSetCookie();
  }

  const cookieHeader = headers.get && headers.get('set-cookie');

  if (!cookieHeader) {
    return [];
  }

  return [cookieHeader];
}

function joinUrl(baseUrl, pathValue) {
  const path = String(pathValue || '').trim();

  if (!path) {
    return baseUrl;
  }

  if (/^https?:\/\//i.test(path)) {
    return path;
  }

  return `${String(baseUrl).replace(/\/+$/, '')}/${path.replace(/^\/+/, '')}`;
}

function stripJsonBom(value) {
  return String(value || '')
    .replace(/^\uFEFF/, '')
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

module.exports = {
  ApiConnection
};
