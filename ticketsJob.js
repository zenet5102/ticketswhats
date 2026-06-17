const { config } = require('./config');
const {
  closeDb,
  getNextTicket,
  listTickets,
  markMessageError,
  markMessageSent,
  pruneTicketsForDate,
  updateTicketClientInfo,
  updateTicketStatus,
  upsertTickets
} = require('./db');
const {
  fetchClientInfo,
  fetchTicketStatus,
  fetchTicketsFromApi,
  getLastTicketsFetchDiagnostics,
  getTodayDateString,
  isInProcessStatus,
  isResolvedStatus
} = require('./ticketApi');
const { getMessageTemplate, isAutomaticReminderEnabled } = require('./settings');

let cycleRunning = false;
const schedulerState = {
  active: false,
  intervalMinutes: config.syncIntervalMinutes,
  startedAt: null,
  lastRunStartedAt: null,
  lastRunFinishedAt: null,
  nextRunAt: null,
  lastResult: null,
  lastError: null,
  runCount: 0,
  notificationErrorLog: [],
  pendingNotificationTriggers: []
};

function nowIso() {
  return new Date().toISOString();
}

function getNextRunIso() {
  return new Date(Date.now() + config.syncIntervalMinutes * 60 * 1000).toISOString();
}

function renderMessage(template, nextTicket, currentTicket) {
  const values = {
    delegacion: nextTicket.delegacion,
    external_id: nextTicket.external_id,
    hora: nextTicket.start_time,
    razon_social: nextTicket.razon_social || '',
    cliente: nextTicket.razon_social || '',
    start: nextTicket.start,
    status: nextTicket.status || '',
    previous_external_id: currentTicket.external_id,
    previous_hora: currentTicket.start_time
  };

  return String(template).replace(/\{([a-zA-Z0-9_]+)\}/g, (match, key) => {
    return values[key] === undefined || values[key] === null ? match : String(values[key]);
  });
}

function isTicketSpecificSendError(error) {
  const message = String(error && error.message || error || '').toLowerCase();
  return message.includes('el numero no existe') || message.includes('faltan phone o message');
}

function getTicketLabel(ticket) {
  return String(ticket && (ticket.razon_social || ticket.external_id) || '').trim();
}

function getTicketStartTs(ticket) {
  const startTs = Number(ticket && ticket.start_ts || 0);
  return Number.isFinite(startTs) && startTs > 0 ? startTs : 0;
}

function recordNotificationError(entry = {}) {
  const nextTicket = entry.nextTicket || {};
  const currentTicket = entry.currentTicket || {};

  schedulerState.notificationErrorLog.unshift({
    at: nowIso(),
    stage: String(entry.stage || 'send').trim(),
    reason: String(entry.reason || 'Error enviando mensaje automatico').trim(),
    halted: Boolean(entry.halted),
    ticketExternalId: String(nextTicket.external_id || '').trim(),
    ticketLabel: getTicketLabel(nextTicket),
    ticketPhone: String(nextTicket.phone || '').trim(),
    ticketStartTime: String(nextTicket.start_time || '').trim(),
    currentTicketExternalId: String(currentTicket.external_id || '').trim(),
    currentTicketStartTime: String(currentTicket.start_time || '').trim()
  });

  schedulerState.notificationErrorLog = schedulerState.notificationErrorLog.slice(0, 50);
}

function queuePendingNotificationTrigger(ticket) {
  const externalId = String(ticket && ticket.external_id || '').trim();

  if (!externalId) {
    return;
  }

  if (schedulerState.pendingNotificationTriggers.some(item => item.external_id === externalId)) {
    return;
  }

  schedulerState.pendingNotificationTriggers.push({ ...ticket });
  schedulerState.pendingNotificationTriggers.sort((left, right) => {
    return getTicketStartTs(left) - getTicketStartTs(right) ||
      String(left.external_id || '').localeCompare(String(right.external_id || ''));
  });
  schedulerState.pendingNotificationTriggers = schedulerState.pendingNotificationTriggers.slice(0, 100);
}

function getTicketGroup(ticket) {
  let payload = {};

  try {
    payload = JSON.parse(ticket.payload_json || '{}');
  } catch (error) {
    payload = {};
  }

  return String(
    payload.Grupo ||
    payload.grupo ||
    payload.Grupo_Tecnico ||
    payload.grupo_tecnico ||
    ticket.delegacion ||
    'Sin grupo'
  ).trim() || 'Sin grupo';
}

async function syncTickets(date = getTodayDateString()) {
  if (!config.ticketsApiUrl) {
    console.log('TICKETS_API_URL no configurado. No se sincronizan tickets.');
    return { skipped: true, saved: 0 };
  }

  const tickets = await fetchTicketsFromApi(date);
  const saved = upsertTickets(tickets);
  const diagnostics = getLastTicketsFetchDiagnostics();
  let deleted = 0;

  if (diagnostics && !diagnostics.apiMessage && diagnostics.rawCount > 0) {
    deleted = pruneTicketsForDate(
      diagnostics.selectedDate,
      tickets.map(ticket => ticket.externalId)
    );
  }

  console.log(`Tickets sincronizados para ${date}: ${saved}. Eliminados obsoletos: ${deleted}`);
  return { skipped: false, saved, deleted, date, diagnostics };
}

async function notifyNextTicket(currentTicket, options = {}) {
  if (!isAutomaticReminderEnabled()) {
    return { sent: false, reason: 'Envio automatico de recordatorios deshabilitado' };
  }

  const minimumStartTs = Number.isFinite(Number(options.minimumStartTs))
    ? Number(options.minimumStartTs)
    : getTicketStartTs(currentTicket);
  const nextTicket = getNextTicket(currentTicket, minimumStartTs);

  if (!nextTicket) {
    return { sent: false, reason: 'No hay ticket siguiente con horario futuro' };
  }

  if (options.notificationAttemptedIds && options.notificationAttemptedIds.has(nextTicket.external_id)) {
    return {
      sent: false,
      reason: 'El ticket siguiente ya fue evaluado en este ciclo',
      nextTicket
    };
  }

  if (options.notificationAttemptedIds) {
    options.notificationAttemptedIds.add(nextTicket.external_id);
  }

  if (nextTicket.message_sent_at) {
    return { sent: false, reason: 'El ticket siguiente ya fue notificado', nextTicket };
  }

  let latestNextStatus;

  try {
    latestNextStatus = await fetchTicketStatus(nextTicket.external_id);
  } catch (error) {
    recordNotificationError({
      stage: 'status-check',
      reason: `No se pudo verificar estado del ticket siguiente: ${error.message}`,
      currentTicket,
      nextTicket,
      halted: true
    });

    return {
      sent: false,
      error: true,
      haltNotifications: true,
      reason: `No se pudo verificar estado del ticket siguiente: ${error.message}`,
      nextTicket
    };
  }

  if (!latestNextStatus) {
    recordNotificationError({
      stage: 'status-check',
      reason: 'No se pudo verificar estado del ticket siguiente',
      currentTicket,
      nextTicket,
      halted: true
    });

    return {
      sent: false,
      error: true,
      haltNotifications: true,
      reason: 'No se pudo verificar estado del ticket siguiente',
      nextTicket
    };
  }

  updateTicketStatus(nextTicket.external_id, latestNextStatus);
  nextTicket.status = latestNextStatus;

  if (isInProcessStatus(latestNextStatus)) {
    return {
      sent: false,
      reason: 'El ticket siguiente ya esta en proceso',
      nextTicket
    };
  }

  if (isResolvedStatus(latestNextStatus)) {
    markMessageError(nextTicket.external_id, 'No se envia mensaje a tickets resueltos');
    recordNotificationError({
      stage: 'validation',
      reason: 'No se envia mensaje a tickets resueltos',
      currentTicket,
      nextTicket
    });

    return {
      sent: false,
      error: true,
      haltNotifications: false,
      reason: 'El ticket siguiente esta resuelto',
      nextTicket
    };
  }

  if (!nextTicket.phone) {
    markMessageError(nextTicket.external_id, 'El ticket no tiene telefono');
    recordNotificationError({
      stage: 'validation',
      reason: 'El ticket no tiene telefono',
      currentTicket,
      nextTicket
    });

    return {
      sent: false,
      error: true,
      haltNotifications: false,
      reason: 'El ticket siguiente no tiene telefono',
      nextTicket
    };
  }

  if (!options.sendWhatsApp) {
    recordNotificationError({
      stage: 'send',
      reason: 'No hay funcion de envio de WhatsApp',
      currentTicket,
      nextTicket,
      halted: true
    });

    return {
      sent: false,
      error: true,
      haltNotifications: true,
      reason: 'No hay funcion de envio de WhatsApp',
      nextTicket
    };
  }

  if (options.isWhatsAppReady && !options.isWhatsAppReady()) {
    return {
      sent: false,
      waiting: true,
      reason: 'WhatsApp no esta conectado',
      nextTicket
    };
  }

  const message = renderMessage(getMessageTemplate(), nextTicket, currentTicket);

  try {
    await options.sendWhatsApp(nextTicket.phone, message, 'ticket', {
      includeResponseQuestion: true,
      ticket: nextTicket,
      currentTicket
    });
    markMessageSent(nextTicket.external_id);
    console.log(`Aviso enviado al ticket ${nextTicket.external_id}`);
    return { sent: true, nextTicket };
  } catch (error) {
    const ticketSpecificError = isTicketSpecificSendError(error);

    if (ticketSpecificError) {
      markMessageError(nextTicket.external_id, error.message);
    }

    recordNotificationError({
      stage: 'send',
      reason: error.message,
      currentTicket,
      nextTicket,
      halted: !ticketSpecificError
    });

    console.warn(`No se pudo enviar aviso al ticket ${nextTicket.external_id}: ${error.message}`);
    return {
      sent: false,
      error: true,
      haltNotifications: !ticketSpecificError,
      reason: error.message,
      nextTicket
    };
  }
}

async function refreshTicketStatuses(options = {}) {
  if (!config.ticketStatusApiUrl) {
    console.log('TICKET_STATUS_API_URL no configurado. No se actualizan estados.');
    return { skipped: true, checked: 0, notifications: 0 };
  }

  const date = options.date || getTodayDateString();
  const tickets = listTickets(date);
  const notificationsEnabled = isAutomaticReminderEnabled();
  const whatsappReadyForNotifications = !notificationsEnabled ||
    !options.isWhatsAppReady ||
    options.isWhatsAppReady();
  let checked = 0;
  let notifications = 0;
  let notificationErrors = 0;
  const notificationAttemptedIds = new Set();
  const notificationAttemptedGroups = new Set();
  let skippedGroupNotifications = 0;
  let skippedAfterHalt = 0;
  let skippedWithoutWhatsApp = 0;
  let notificationHalted = false;
  let notificationHaltReason = '';

  for (const ticket of tickets) {
    const status = await fetchTicketStatus(ticket.external_id);

    if (!status) {
      continue;
    }

    checked += 1;
    updateTicketStatus(ticket.external_id, status);

    if (isInProcessStatus(status)) {
      if (!whatsappReadyForNotifications) {
        queuePendingNotificationTrigger({
          ...ticket,
          status
        });
        skippedWithoutWhatsApp += 1;
        continue;
      }

      if (notificationHalted) {
        skippedAfterHalt += 1;
        continue;
      }

      const groupName = getTicketGroup(ticket);

      if (notificationAttemptedGroups.has(groupName)) {
        skippedGroupNotifications += 1;
        continue;
      }

      notificationAttemptedGroups.add(groupName);

      const updatedTicket = {
        ...ticket,
        status
      };
      const result = await notifyNextTicket(updatedTicket, {
        ...options,
        notificationAttemptedIds
      });

      if (result.sent) {
        notifications += 1;
      } else if (result.error) {
        notificationErrors += 1;

        if (result.haltNotifications) {
          notificationHalted = true;
          notificationHaltReason = result.reason || 'Avisos detenidos por error de envio';
        }
      }
    }
  }

  if (!whatsappReadyForNotifications && skippedWithoutWhatsApp) {
    console.log(`Estados actualizados: ${checked}. Avisos pendientes: ${skippedWithoutWhatsApp}. WhatsApp no esta conectado.`);
  }

  console.log(`Estados actualizados: ${checked}. Avisos enviados: ${notifications}. Fallos de envio: ${notificationErrors}. Avisos omitidos por grupo: ${skippedGroupNotifications}. Avisos omitidos por corte: ${skippedAfterHalt}`);
  return {
    skipped: false,
    checked,
    notifications,
    notificationErrors,
    notificationHalted,
    notificationHaltReason,
    notificationWaiting: !whatsappReadyForNotifications,
    notificationWaitReason: !whatsappReadyForNotifications ? 'WhatsApp no esta conectado' : '',
    skippedAfterHalt,
    skippedWithoutWhatsApp,
    skippedGroupNotifications
  };
}

async function retryPendingNotifications(options = {}) {
  if (!isAutomaticReminderEnabled()) {
    return {
      skipped: true,
      reason: 'Envio automatico de recordatorios deshabilitado',
      pending: schedulerState.pendingNotificationTriggers.length
    };
  }

  if (options.isWhatsAppReady && !options.isWhatsAppReady()) {
    return {
      skipped: true,
      waiting: true,
      reason: 'WhatsApp no esta conectado',
      pending: schedulerState.pendingNotificationTriggers.length
    };
  }

  if (!schedulerState.pendingNotificationTriggers.length) {
    const cycleResult = await runTicketCycle(options);

    return {
      skipped: false,
      fallbackCycle: true,
      pending: 0,
      cycle: cycleResult
    };
  }

  const pending = schedulerState.pendingNotificationTriggers.slice();
  schedulerState.pendingNotificationTriggers = [];
  const notificationAttemptedIds = new Set();
  let notifications = 0;
  let notificationErrors = 0;
  let retried = 0;
  let requeued = 0;
  let halted = false;
  let stoppedOnError = false;
  let haltReason = '';

  for (const trigger of pending) {
    retried += 1;

    const result = await notifyNextTicket(trigger, {
      ...options,
      minimumStartTs: getTicketStartTs(trigger),
      notificationAttemptedIds
    });

    if (result.sent) {
      notifications += 1;
      continue;
    }

    if (result.waiting) {
      queuePendingNotificationTrigger(trigger);
      requeued += 1;
      continue;
    }

    if (result.error) {
      notificationErrors += 1;
      halted = Boolean(result.haltNotifications);
      stoppedOnError = true;
      haltReason = result.reason || 'Avisos detenidos por error de envio';

      for (const remaining of pending.slice(retried)) {
        queuePendingNotificationTrigger(remaining);
        requeued += 1;
      }

      break;
    }
  }

  const result = {
    skipped: false,
    retried,
    notifications,
    notificationErrors,
    requeued,
    pending: schedulerState.pendingNotificationTriggers.length,
    notificationHalted: halted,
    stoppedOnError,
    notificationHaltReason: haltReason
  };

  schedulerState.lastResult = {
    ...(schedulerState.lastResult || {}),
    retry: result
  };
  schedulerState.lastError = null;

  return result;
}

function getClientIdFromStoredTicket(ticket) {
  try {
    const payload = JSON.parse(ticket.payload_json || '{}');
    return (
      payload[config.clientLookupTicketField] ||
      payload.IDA ||
      payload.ida ||
      payload.Ida ||
      null
    );
  } catch (error) {
    return null;
  }
}

async function refreshTicketPhones(date = getTodayDateString()) {
  const tickets = listTickets(date);
  let checked = 0;
  let updated = 0;
  let namesUpdated = 0;
  let missingClientId = 0;
  let missingPhone = 0;

  for (const ticket of tickets) {
    if (ticket.phone && ticket.razon_social) {
      continue;
    }

    const clientId = getClientIdFromStoredTicket(ticket);

    if (!clientId) {
      missingClientId += 1;
      continue;
    }

    checked += 1;

    try {
      const clientInfo = await fetchClientInfo(clientId);

      if (!clientInfo.phone && !clientInfo.razonSocial) {
        missingPhone += 1;
        continue;
      }

      updateTicketClientInfo(ticket.external_id, clientInfo);

      if (clientInfo.phone && !ticket.phone) {
        updated += 1;
      }

      if (clientInfo.razonSocial && !ticket.razon_social) {
        namesUpdated += 1;
      }
    } catch (error) {
      missingPhone += 1;
      console.warn(`No se pudo actualizar movil del ticket ${ticket.external_id}: ${error.message}`);
    }
  }

  console.log(`Moviles actualizados: ${updated}. Razones sociales actualizadas: ${namesUpdated}. Clientes consultados: ${checked}.`);

  return {
    checked,
    updated,
    namesUpdated,
    missingClientId,
    missingPhone
  };
}

async function runTicketCycle(options = {}) {
  if (cycleRunning) {
    console.log('El ciclo de tickets ya esta en ejecucion.');
    return { skipped: true, reason: 'cycle-running' };
  }

  cycleRunning = true;
  schedulerState.runCount += 1;
  schedulerState.lastRunStartedAt = nowIso();

  try {
    const date = options.date || getTodayDateString();
    const sync = await syncTickets(date);
    const phones = await refreshTicketPhones(date);
    const statuses = await refreshTicketStatuses({
      ...options,
      date
    });
    const result = { sync, phones, statuses };
    schedulerState.lastResult = result;
    schedulerState.lastError = null;
    return result;
  } catch (error) {
    schedulerState.lastError = {
      message: error.message,
      at: nowIso()
    };
    throw error;
  } finally {
    schedulerState.lastRunFinishedAt = nowIso();
    cycleRunning = false;
  }
}

function startTicketScheduler(options = {}) {
  if (!config.autoStartTicketJobs) {
    console.log('Jobs de tickets desactivados por AUTO_START_TICKET_JOBS.');
    schedulerState.active = false;
    return null;
  }

  const intervalMs = config.syncIntervalMinutes * 60 * 1000;
  const run = () => {
    schedulerState.nextRunAt = getNextRunIso();
    runTicketCycle(options).catch(error => {
      console.error('Error en ciclo de tickets:', error);
    });
  };

  schedulerState.active = true;
  schedulerState.startedAt = nowIso();
  schedulerState.nextRunAt = getNextRunIso();
  run();

  const timer = setInterval(run, intervalMs);
  console.log(`Jobs de tickets activos cada ${config.syncIntervalMinutes} minutos.`);

  return {
    stop() {
      clearInterval(timer);
      schedulerState.active = false;
      schedulerState.nextRunAt = null;
    },
    runNow: run
  };
}

function getTicketJobStatus() {
  return {
    ...schedulerState,
    cycleRunning,
    config: {
      ticketsApiConfigured: Boolean(config.ticketsApiUrl),
      ticketStatusApiConfigured: Boolean(config.ticketStatusApiUrl),
      clientApiConfigured: Boolean(config.clientApiUrl),
      ticketsApiMethod: config.ticketsApiMethod,
      ticketStatusApiMethod: config.ticketStatusApiMethod,
      clientApiMethod: config.clientApiMethod,
      ticketsApiBodyFormat: config.ticketsApiBodyFormat,
      ticketStatusApiBodyFormat: config.ticketStatusApiBodyFormat,
      clientApiBodyFormat: config.clientApiBodyFormat,
      ticketsApiAction: config.ticketsApiAction,
      ticketsApiPeriodField: config.ticketsApiPeriodField,
      ticketsApiPeriodStartDate: config.ticketsApiPeriodStartDate,
      ticketsApiPeriodMonthsBack: config.ticketsApiPeriodMonthsBack,
      ticketsApiPeriodDaysForward: config.ticketsApiPeriodDaysForward,
      ticketDateField: config.fieldMap.date,
      ticketDelegacionPrefixes: config.allowedDelegacionPrefixes,
      ticketExcludedCategories: config.excludedCategories,
      ticketStatusApiAction: config.ticketStatusApiAction,
      clientApiAction: config.clientApiAction,
      syncIntervalMinutes: config.syncIntervalMinutes,
      autoStartTicketJobs: config.autoStartTicketJobs,
      automaticReminderEnabled: isAutomaticReminderEnabled()
    }
  };
}

if (require.main === module) {
  runTicketCycle()
    .then(result => {
      console.log(JSON.stringify(result, null, 2));
    })
    .catch(error => {
      console.error(error);
      process.exitCode = 1;
    })
    .finally(closeDb);
}

module.exports = {
  getTicketJobStatus,
  retryPendingNotifications,
  refreshTicketStatuses,
  refreshTicketPhones,
  runTicketCycle,
  startTicketScheduler,
  syncTickets
};
