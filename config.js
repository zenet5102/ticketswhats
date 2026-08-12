const fs = require('fs');
const path = require('path');

function loadEnvFile(filePath = path.join(__dirname, '.env')) {
  if (!fs.existsSync(filePath)) {
    return;
  }

  const lines = fs.readFileSync(filePath, 'utf8').split(/\r?\n/);

  for (const line of lines) {
    const trimmed = line.trim();

    if (!trimmed || trimmed.startsWith('#')) {
      continue;
    }

    const separatorIndex = trimmed.indexOf('=');

    if (separatorIndex === -1) {
      continue;
    }

    const key = trimmed.slice(0, separatorIndex).trim();
    let value = trimmed.slice(separatorIndex + 1).trim();

    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }

    if (key && process.env[key] === undefined) {
      process.env[key] = value;
    }
  }
}

function parsePositiveInteger(value, fallback) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function parseNonNegativeInteger(value, fallback) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

function parseBoolean(value, fallback) {
  if (value === undefined || value === null || value === '') {
    return fallback;
  }

  return !['0', 'false', 'no', 'off'].includes(String(value).trim().toLowerCase());
}

function parseHeaders(value) {
  if (!value) {
    return {};
  }

  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch (error) {
    console.warn('TICKETS_API_HEADERS no es JSON valido. Se ignora.');
    return {};
  }
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

function parseCsvList(value) {
  if (!value) {
    return [];
  }

  return String(value)
    .split(',')
    .map(item => item.trim())
    .filter(Boolean);
}

loadEnvFile();

const apiHeaders = parseHeaders(process.env.TICKETS_API_HEADERS);

if (process.env.TICKETS_API_TOKEN && !apiHeaders.Authorization) {
  apiHeaders.Authorization = `Bearer ${process.env.TICKETS_API_TOKEN}`;
}

function resolveDbPath(value) {
  if (!value) {
    return path.join(__dirname, 'data', 'tickets.sqlite');
  }

  if (value === ':memory:' || path.isAbsolute(value)) {
    return value;
  }

  return path.join(__dirname, value);
}

function resolveWhatsAppChromePath() {
  if (process.env.WHATSAPP_CHROME_PATH) {
    return process.env.WHATSAPP_CHROME_PATH;
  }

  const candidates = [
    path.join(process.env.ProgramFiles || '', 'Google', 'Chrome', 'Application', 'chrome.exe'),
    path.join(process.env['ProgramFiles(x86)'] || '', 'Google', 'Chrome', 'Application', 'chrome.exe'),
    path.join(process.env.LOCALAPPDATA || '', 'Google', 'Chrome', 'Application', 'chrome.exe'),
    path.join(process.env.ProgramFiles || '', 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
    path.join(process.env['ProgramFiles(x86)'] || '', 'Microsoft', 'Edge', 'Application', 'msedge.exe')
  ];

  return candidates.find(candidate => candidate && fs.existsSync(candidate)) || '';
}

const config = {
  port: parsePositiveInteger(process.env.PORT, 3000),
  dbPath: resolveDbPath(process.env.TICKETS_DB_PATH),
  whatsappProtocolTimeoutMs: parsePositiveInteger(process.env.WHATSAPP_PROTOCOL_TIMEOUT_MS, 180000),
  whatsappChromePath: resolveWhatsAppChromePath(),
  syncIntervalMinutes: parsePositiveInteger(process.env.TICKET_SYNC_INTERVAL_MINUTES, 30),
  ticketNotificationMaxPerCycle: parsePositiveInteger(process.env.TICKET_NOTIFICATION_MAX_PER_CYCLE, 1),
  ticketNotificationMinDelayMs: parseNonNegativeInteger(process.env.TICKET_NOTIFICATION_MIN_DELAY_MS, 120000),
  ticketNotificationPhoneCooldownHours: parseNonNegativeInteger(process.env.TICKET_NOTIFICATION_PHONE_COOLDOWN_HOURS, 24),
  notificationChannelReplyCooldownHours: parseNonNegativeInteger(process.env.NOTIFICATION_CHANNEL_REPLY_COOLDOWN_HOURS, 24),
  notificationChannelSuppressAfterManualHours: parseNonNegativeInteger(process.env.NOTIFICATION_CHANNEL_SUPPRESS_AFTER_MANUAL_HOURS, 24),
  requestTimeoutMs: parsePositiveInteger(process.env.TICKETS_API_TIMEOUT_MS, 15000),
  clientRequestTimeoutMs: parsePositiveInteger(process.env.CLIENT_API_TIMEOUT_MS, 30000),
  autoStartTicketJobs: parseBoolean(process.env.AUTO_START_TICKET_JOBS, true),
  ticketsApiUrl: process.env.TICKETS_API_URL || '',
  ticketStatusApiUrl: process.env.TICKET_STATUS_API_URL || process.env.TICKETS_API_URL || '',
  ticketsApiMethod: (process.env.TICKETS_API_METHOD || 'POST').toUpperCase(),
  ticketStatusApiMethod: (
    process.env.TICKET_STATUS_API_METHOD ||
    process.env.TICKETS_API_METHOD ||
    'POST'
  ).toUpperCase(),
  ticketsApiBodyFormat: (process.env.TICKETS_API_BODY_FORMAT || 'json').toLowerCase(),
  ticketStatusApiBodyFormat: (
    process.env.TICKET_STATUS_API_BODY_FORMAT ||
    process.env.TICKETS_API_BODY_FORMAT ||
    'json'
  ).toLowerCase(),
  clientApiUrl: process.env.CLIENT_API_URL || process.env.TICKETS_API_URL || '',
  clientApiMethod: (
    process.env.CLIENT_API_METHOD ||
    process.env.TICKETS_API_METHOD ||
    'POST'
  ).toUpperCase(),
  clientApiBodyFormat: (
    process.env.CLIENT_API_BODY_FORMAT ||
    process.env.TICKETS_API_BODY_FORMAT ||
    'json'
  ).toLowerCase(),
  apiActionField: process.env.TICKETS_API_ACTION_FIELD || 'action',
  ticketIdBodyField: process.env.TICKET_ID_BODY_FIELD || 'id',
  ticketsApiAction: process.env.TICKETS_API_ACTION || 'gettickets',
  ticketStatusApiAction:
    process.env.TICKET_STATUS_API_ACTION ||
    process.env.TICKET_DETAIL_API_ACTION ||
    'getticket',
  ticketsApiPeriodField: process.env.TICKETS_API_PERIOD_FIELD || '',
  ticketsApiPeriodStartDate: process.env.TICKETS_API_PERIOD_START_DATE || '',
  ticketsApiPeriodMonthsBack: parsePositiveInteger(process.env.TICKETS_API_PERIOD_MONTHS_BACK, 2),
  ticketsApiPeriodDaysForward: parsePositiveInteger(process.env.TICKETS_API_PERIOD_DAYS_FORWARD, 1),
  clientApiAction: process.env.CLIENT_API_ACTION || 'getCliente',
  clientLookupTicketField: process.env.CLIENT_LOOKUP_TICKET_FIELD || 'IDA',
  clientLookupMethod: process.env.CLIENT_LOOKUP_METHOD || 'IDA',
  clientLookupMethodField: process.env.CLIENT_LOOKUP_METHOD_FIELD || 'data.metodo',
  clientLookupValueField: process.env.CLIENT_LOOKUP_VALUE_FIELD || 'data.valor',
  ticketsApiBody: parseJsonObject(process.env.TICKETS_API_BODY, 'TICKETS_API_BODY'),
  ticketStatusApiBody: parseJsonObject(process.env.TICKET_STATUS_API_BODY, 'TICKET_STATUS_API_BODY'),
  clientApiBody: parseJsonObject(process.env.CLIENT_API_BODY, 'CLIENT_API_BODY'),
  apiHeaders,
  allowedDelegacionPrefixes: parseCsvList(process.env.TICKET_DELEGACION_PREFIXES),
  excludedCategories: parseCsvList(process.env.TICKET_EXCLUDED_CATEGORIES),
  messageTemplate:
    process.env.TICKET_MESSAGE_TEMPLATE ||
    'Hola, le informamos que nuestro tecnico esta proximo a llegar a su domicilio.',
  fieldMap: {
    id: process.env.TICKET_ID_FIELD || '',
    date: process.env.TICKET_DATE_FIELD || process.env.TICKET_START_FIELD || '',
    start: process.env.TICKET_START_FIELD || '',
    category: process.env.TICKET_CATEGORY_FIELD || '',
    delegacion: process.env.TICKET_DELEGACION_FIELD || '',
    phone: process.env.TICKET_PHONE_FIELD || '',
    status: process.env.TICKET_STATUS_FIELD || ''
  }
};

module.exports = {
  config,
  loadEnvFile
};
