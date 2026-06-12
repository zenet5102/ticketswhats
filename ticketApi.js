const { config } = require('./config');

let lastTicketsFetchDiagnostics = null;

const ticketFieldCandidates = {
  id: [
    'id',
    'ID',
    'IDTT',
    'idtt',
    'ticketId',
    'TicketID',
    'ticket_id',
    'nroTicket',
    'nro_ticket',
    'numero',
    'number',
    'code'
  ],
  start: [
    'start',
    'START',
    'Start',
    'inicio',
    'fechaInicio',
    'FechaInicio',
    'fecha_inicio',
    'scheduledStart',
    'startDate',
    'Fecha',
    'fecha',
    'fechaHora'
  ],
  delegacion: [
    'delegacion',
    'Delegacion',
    'Delegación',
    'delegation',
    'sucursal',
    'Sucursal',
    'branch',
    'zona',
    'Zona'
  ],
  phone: [
    'phone',
    'telefono',
    'Telefono',
    'Teléfono',
    'celular',
    'Celular',
    'movil',
    'Movil',
    'whatsapp',
    'Whatsapp',
    'Contacto',
    'contacto',
    'cliente.telefono',
    'cliente.celular'
  ],
  clientId: [
    'IDA',
    'ida',
    'Ida',
    'idabonado',
    'IDAbonado',
    'idAbonado',
    'abonadoId',
    'AbonadoID',
    'cliente.IDA',
    'cliente.ida'
  ],
  clientName: [
    'Razon_Social',
    'RazonSocial',
    'razon_social',
    'razonSocial',
    'Nombre_Completo',
    'nombre_completo',
    'N_Abonado',
    'cliente.Razon_Social',
    'cliente.razon_social'
  ],
  status: [
    'estado',
    'Estado',
    'status',
    'Status',
    'state',
    'ticketStatus',
    'data.estado',
    'data.Estado',
    'data.status',
    'data.Status',
    'ticket.estado',
    'ticket.Estado',
    'ticket.status'
  ],
  category: [
    'Categoria',
    'categoria',
    'category',
    'Category',
    'tipo',
    'Tipo'
  ]
};

function getByPath(source, path) {
  if (!source || !path) {
    return undefined;
  }

  return String(path)
    .split('.')
    .reduce((value, key) => (value && value[key] !== undefined ? value[key] : undefined), source);
}

function firstValue(source, configuredPath, candidates) {
  const paths = configuredPath ? [configuredPath, ...candidates] : candidates;

  for (const path of paths) {
    const value = getByPath(source, path);

    if (value !== undefined && value !== null && String(value).trim() !== '') {
      return value;
    }
  }

  return undefined;
}

function extractArray(payload) {
  if (Array.isArray(payload)) {
    return payload;
  }

  if (!payload || typeof payload !== 'object') {
    return [];
  }

  const candidates = [
    payload.data,
    payload.tickets,
    payload.Tickets,
    payload.results,
    payload.Results,
    payload.items,
    payload.Items,
    payload.values,
    payload.Values,
    payload.data && payload.data.tickets,
    payload.data && payload.data.Tickets,
    payload.data && payload.data.results,
    payload.data && payload.data.Results,
    payload.data && payload.data.items
  ];

  return candidates.find(Array.isArray) || [];
}

function getPayloadMessage(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return null;
  }

  return payload.message || payload.error || payload.msg || null;
}

function extractFirstRecord(payload) {
  if (Array.isArray(payload)) {
    return payload[0] || {};
  }

  if (!payload || typeof payload !== 'object') {
    return payload;
  }

  const candidates = [
    payload.data,
    payload.ticket,
    payload.Ticket,
    payload.result,
    payload.Result,
    payload.item,
    payload.Item
  ];

  for (const candidate of candidates) {
    if (Array.isArray(candidate)) {
      return candidate[0] || {};
    }

    if (candidate && typeof candidate === 'object') {
      return candidate;
    }
  }

  return payload;
}

function buildActionBody(action, extraBody = {}, externalId) {
  const body = { ...extraBody };

  if (action) {
    body[config.apiActionField] = action;
  }

  if (externalId !== undefined && externalId !== null) {
    body[config.ticketIdBodyField] = externalId;
  }

  return body;
}

function setByPath(target, path, value) {
  const keys = String(path || '').split('.').filter(Boolean);

  if (!keys.length) {
    return;
  }

  let current = target;

  for (let index = 0; index < keys.length - 1; index += 1) {
    const key = keys[index];

    if (!current[key] || typeof current[key] !== 'object' || Array.isArray(current[key])) {
      current[key] = {};
    }

    current = current[key];
  }

  current[keys[keys.length - 1]] = value;
}

function addDays(date, days) {
  const next = new Date(date);
  next.setDate(next.getDate() + days);
  return next;
}

function formatPeriodDate(date) {
  return `${pad(date.getDate())}/${pad(date.getMonth() + 1)}/${date.getFullYear()}`;
}

function getTargetDate(value) {
  return parseStartDate(value) || new Date();
}

function getPeriodStartDate(baseDate = new Date()) {
  return new Date(
    baseDate.getFullYear(),
    baseDate.getMonth() - config.ticketsApiPeriodMonthsBack,
    1
  );
}

function buildTicketsBody() {
  const body = buildActionBody(config.ticketsApiAction, config.ticketsApiBody);

  if (config.ticketsApiPeriodField) {
    const now = new Date();
    const from = config.ticketsApiPeriodStartDate || formatPeriodDate(getPeriodStartDate(now));
    const to = addDays(now, config.ticketsApiPeriodDaysForward);
    setByPath(body, config.ticketsApiPeriodField, `${from}-${formatPeriodDate(to)}`);
  }

  return body;
}

function buildClientBody(clientId) {
  const body = buildActionBody(config.clientApiAction, config.clientApiBody);
  setByPath(body, config.clientLookupMethodField, config.clientLookupMethod);
  setByPath(body, config.clientLookupValueField, clientId);
  return body;
}

function hasBody(method) {
  return !['GET', 'HEAD'].includes(String(method || 'GET').toUpperCase());
}

async function fetchJson(url, options = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), config.requestTimeoutMs);
  const method = String(options.method || 'GET').toUpperCase();
  const bodyFormat = String(options.bodyFormat || 'json').toLowerCase();
  const requestHasBody = hasBody(method);
  const requestOptions = {
    method,
    headers: {
      Accept: 'application/json',
      ...config.apiHeaders
    },
    signal: controller.signal
  };

  if (requestHasBody) {
    if (bodyFormat === 'form' || bodyFormat === 'urlencoded') {
      requestOptions.headers = {
        'Content-Type': 'application/x-www-form-urlencoded',
        ...requestOptions.headers
      };
      requestOptions.body = new URLSearchParams(options.body || {}).toString();
    } else {
      requestOptions.headers = {
        'Content-Type': 'application/json',
        ...requestOptions.headers
      };
      requestOptions.body = JSON.stringify(options.body || {});
    }
  }

  try {
    const response = await fetch(url, requestOptions);
    const text = await response.text();

    if (!response.ok) {
      throw new Error(`HTTP ${response.status} ${response.statusText}`);
    }

    return parseJsonPayload(text);
  } finally {
    clearTimeout(timeout);
  }
}

function stripJsonBom(value) {
  return String(value || '')
    .replace(/^\uFEFF/, '')
    .trim();
}

function parseJsonPayload(text) {
  let parsed = JSON.parse(stripJsonBom(text));

  for (let index = 0; index < 2 && typeof parsed === 'string'; index += 1) {
    const nested = stripJsonBom(parsed);

    if (!nested || !/^[\[{]/.test(nested)) {
      break;
    }

    parsed = JSON.parse(nested);
  }

  return parsed;
}

function pad(value) {
  return String(value).padStart(2, '0');
}

function formatDate(date) {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function formatTime(date) {
  return `${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function normalizeWhitespace(value) {
  return String(value || '')
    .replace(/\s+/g, ' ')
    .trim();
}

function getDateOnlyString(value) {
  const raw = normalizeWhitespace(value);

  if (!raw || /^0{4}-0{2}-0{2}/.test(raw)) {
    return null;
  }

  let match = raw.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);

  if (match) {
    const [, year, month, day] = match;
    return `${year}-${pad(month)}-${pad(day)}`;
  }

  match = raw.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/);

  if (match) {
    const [, day, month, year] = match;
    return `${year}-${pad(month)}-${pad(day)}`;
  }

  const parsed = parseStartDate(raw);
  return parsed ? formatDate(parsed) : null;
}

function parseStartDate(value) {
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : value;
  }

  const raw = normalizeWhitespace(value);

  if (!raw) {
    return null;
  }

  if (/^0{4}-0{2}-0{2}/.test(raw)) {
    return null;
  }

  const slashMatch = raw.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2}))?)?/);

  if (slashMatch) {
    const [, day, month, year, hour = '0', minute = '0', second = '0'] = slashMatch;
    return new Date(
      Number(year),
      Number(month) - 1,
      Number(day),
      Number(hour),
      Number(minute),
      Number(second)
    );
  }

  const localIsoMatch = raw.match(
    /^(\d{4})-(\d{1,2})-(\d{1,2})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2}))?)?$/
  );

  if (localIsoMatch) {
    const [, year, month, day, hour = '0', minute = '0', second = '0'] = localIsoMatch;
    return new Date(
      Number(year),
      Number(month) - 1,
      Number(day),
      Number(hour),
      Number(minute),
      Number(second)
    );
  }

  const parsed = new Date(raw);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function normalizeTicket(raw) {
  const externalId = firstValue(raw, config.fieldMap.id, ticketFieldCandidates.id);
  const delegacion = normalizeClientName(firstValue(raw, config.fieldMap.delegacion, ticketFieldCandidates.delegacion));
  const category = normalizeClientName(firstValue(raw, config.fieldMap.category, ticketFieldCandidates.category));
  const dateRaw = firstValue(raw, config.fieldMap.date, ticketFieldCandidates.start);
  const dateValue = parseStartDate(dateRaw);
  const dateOnly = getDateOnlyString(dateRaw);

  if (isExcludedCategory(category)) {
    return null;
  }

  if (!hasAllowedDelegacionPrefix(delegacion)) {
    return null;
  }

  if (!externalId || !delegacion || !dateValue || !dateOnly) {
    return null;
  }

  return {
    externalId: String(externalId).trim(),
    clientId: String(firstValue(raw, config.clientLookupTicketField, ticketFieldCandidates.clientId) || '').trim(),
    delegacion,
    startRaw: normalizeWhitespace(dateRaw),
    startTs: dateValue.getTime(),
    startDate: dateOnly,
    startTime: formatTime(dateValue),
    phone: normalizePhone(firstValue(raw, config.fieldMap.phone, ticketFieldCandidates.phone)),
    razonSocial: normalizeClientName(firstValue(raw, '', ticketFieldCandidates.clientName)),
    status: normalizeStatus(firstValue(raw, config.fieldMap.status, ticketFieldCandidates.status)),
    raw
  };
}

function normalizePhone(value) {
  if (value === undefined || value === null) {
    return null;
  }

  const candidates = String(value)
    .split(';')
    .map(part => part.replace(/\D/g, ''))
    .filter(phone => phone.length >= 8);

  return candidates[0] || null;
}

function findPhoneInRecord(record) {
  const directPhone = normalizePhone(firstValue(record, config.fieldMap.phone, ticketFieldCandidates.phone));

  if (directPhone) {
    return directPhone;
  }

  if (!record || typeof record !== 'object') {
    return null;
  }

  const phoneKeyPattern = /(tel|telefono|cel|celular|movil|whatsapp|contacto)/i;
  const stack = [record];
  const visited = new Set();

  while (stack.length) {
    const current = stack.pop();

    if (!current || typeof current !== 'object' || visited.has(current)) {
      continue;
    }

    visited.add(current);

    for (const [key, value] of Object.entries(current)) {
      if (value && typeof value === 'object') {
        stack.push(value);
        continue;
      }

      if (phoneKeyPattern.test(key)) {
        const phone = normalizePhone(value);

        if (phone) {
          return phone;
        }
      }
    }
  }

  return null;
}

function normalizeClientName(value) {
  if (value === undefined || value === null) {
    return null;
  }

  const name = String(value)
    .replace(/\s+/g, ' ')
    .trim();

  return name || null;
}

function findClientNameInRecord(record) {
  const directName = normalizeClientName(firstValue(record, '', ticketFieldCandidates.clientName));

  if (directName) {
    return directName;
  }

  if (!record || typeof record !== 'object') {
    return null;
  }

  const apellido = normalizeClientName(record.Apellido || record.apellido);
  const nombre = normalizeClientName(record.Nombre || record.nombre);

  if (apellido && nombre) {
    return `${apellido} ${nombre}`;
  }

  return apellido || nombre || null;
}

function normalizeStatus(value) {
  if (value === undefined || value === null) {
    return null;
  }

  if (typeof value === 'object') {
    return normalizeStatus(
      value.name ||
      value.nombre ||
      value.label ||
      value.Estado ||
      value.estado ||
      value.Status ||
      value.status ||
      value.value
    );
  }

  const status = String(value).trim();
  return status || null;
}

function normalizeStatusForCompare(value) {
  return String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .trim()
    .toLowerCase()
    .replace(/[_-]+/g, ' ');
}

function isInProcessStatus(value) {
  const status = normalizeStatusForCompare(value);
  return status === 'en proceso' || status === 'proceso' || status === 'in progress' || status === 'in process';
}

function isResolvedStatus(value) {
  const status = normalizeStatusForCompare(value);
  return status === 'resuelto' || status === 'resolved' || status === 'cerrado' || status === 'closed';
}

function isExcludedCategory(value) {
  if (!config.excludedCategories.length) {
    return false;
  }

  const category = normalizeStatusForCompare(value);
  return config.excludedCategories.some(excluded => normalizeStatusForCompare(excluded) === category);
}

function hasAllowedDelegacionPrefix(value) {
  if (!config.allowedDelegacionPrefixes.length) {
    return true;
  }

  const delegacion = normalizeStatusForCompare(value);
  return config.allowedDelegacionPrefixes.some(prefix => delegacion.startsWith(normalizeStatusForCompare(prefix)));
}

function getTodayDateString() {
  return formatDate(new Date());
}

function summarizeTicketsByDate(tickets) {
  const counts = tickets.reduce((summary, ticket) => {
    summary[ticket.startDate] = (summary[ticket.startDate] || 0) + 1;
    return summary;
  }, {});

  return Object.entries(counts)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([date, count]) => `${date}: ${count}`)
    .join(', ');
}

async function fetchTicketsFromApi(targetDate = getTodayDateString()) {
  if (!config.ticketsApiUrl) {
    return [];
  }

  const selectedDate = formatDate(getTargetDate(targetDate));
  const requestBody = buildTicketsBody();
  const payload = await fetchJson(config.ticketsApiUrl, {
    method: config.ticketsApiMethod,
    bodyFormat: config.ticketsApiBodyFormat,
    body: requestBody
  });
  const rawTickets = extractArray(payload);

  const normalizedTickets = rawTickets
    .map(normalizeTicket)
    .filter(ticket => ticket && ticket.delegacion);

  const dateSummary = summarizeTicketsByDate(normalizedTickets);
  const dates = normalizedTickets.reduce((summary, ticket) => {
    summary[ticket.startDate] = (summary[ticket.startDate] || 0) + 1;
    return summary;
  }, {});

  if (dateSummary) {
    console.log(`Tickets recibidos por fecha: ${dateSummary}`);
  }

  const tickets = normalizedTickets
    .filter(ticket => ticket.startDate === selectedDate)
    .sort((left, right) => {
      if (left.startTs !== right.startTs) {
        return left.startTs - right.startTs;
      }

      return left.externalId.localeCompare(right.externalId);
    });

  lastTicketsFetchDiagnostics = {
    selectedDate,
    requestBody,
    rawCount: rawTickets.length,
    normalizedCount: normalizedTickets.length,
    returnedCount: tickets.length,
    dates,
    apiMessage: getPayloadMessage(payload)
  };

  return tickets;
}

function getLastTicketsFetchDiagnostics() {
  return lastTicketsFetchDiagnostics;
}

async function fetchClientInfo(clientId) {
  if (!config.clientApiUrl || !clientId) {
    return {
      phone: null,
      razonSocial: null
    };
  }

  const payload = await fetchJson(config.clientApiUrl, {
    method: config.clientApiMethod,
    bodyFormat: config.clientApiBodyFormat,
    body: buildClientBody(clientId)
  });
  const record = extractFirstRecord(payload);

  return {
    phone: findPhoneInRecord(record),
    razonSocial: findClientNameInRecord(record)
  };
}

async function fetchClientPhone(clientId) {
  const info = await fetchClientInfo(clientId);
  return info.phone;
}

async function enrichTicketsWithClientPhones(tickets) {
  const enriched = [];

  for (const ticket of tickets) {
    if ((!ticket.phone || !ticket.razonSocial) && ticket.clientId) {
      try {
        const clientInfo = await fetchClientInfo(ticket.clientId);
        ticket.phone = clientInfo.phone || ticket.phone;
        ticket.razonSocial = clientInfo.razonSocial || ticket.razonSocial;
      } catch (error) {
        console.warn(`No se pudo obtener telefono del cliente ${ticket.clientId}: ${error.message}`);
      }
    }

    enriched.push(ticket);
  }

  return enriched;
}

function buildStatusUrl(externalId, method) {
  const encodedId = encodeURIComponent(externalId);
  const baseUrl = config.ticketStatusApiUrl;

  if (baseUrl.includes('{id}')) {
    return baseUrl.replaceAll('{id}', encodedId);
  }

  if (baseUrl.includes(':id')) {
    return baseUrl.replaceAll(':id', encodedId);
  }

  if (!hasBody(method)) {
    return `${baseUrl.replace(/\/$/, '')}/${encodedId}`;
  }

  return baseUrl;
}

async function fetchTicketStatus(externalId) {
  if (!config.ticketStatusApiUrl) {
    return null;
  }

  const payload = await fetchJson(buildStatusUrl(externalId, config.ticketStatusApiMethod), {
    method: config.ticketStatusApiMethod,
    bodyFormat: config.ticketStatusApiBodyFormat,
    body: buildActionBody(
      config.ticketStatusApiAction,
      config.ticketStatusApiBody,
      externalId
    )
  });

  if (typeof payload === 'string') {
    return normalizeStatus(payload);
  }

  const record = extractFirstRecord(payload);
  return normalizeStatus(firstValue(record, config.fieldMap.status, ticketFieldCandidates.status));
}

module.exports = {
  fetchClientInfo,
  fetchClientPhone,
  fetchTicketStatus,
  fetchTicketsFromApi,
  getLastTicketsFetchDiagnostics,
  getTodayDateString,
  isInProcessStatus,
  isResolvedStatus,
  normalizeStatusForCompare
};
