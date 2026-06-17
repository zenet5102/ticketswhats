const {
  normalizeChatPhone,
  saveWhatsAppMessage
} = require('./db');

function normalizeTargetPhone(value) {
  return normalizeChatPhone(String(value || '').trim());
}

function getTicketPhone(ticket) {
  return normalizeTargetPhone(ticket && ticket.phone);
}

function getTicketByExternalId(externalId, visibleTickets) {
  const cleanExternalId = String(externalId || '').trim();

  if (!cleanExternalId) {
    return null;
  }

  return visibleTickets.find(ticket => String(ticket.external_id || '') === cleanExternalId) || null;
}

function getTicketByPhone(phone, visibleTickets) {
  const cleanPhone = normalizeTargetPhone(phone);

  if (!cleanPhone) {
    return null;
  }

  return visibleTickets.find(ticket => getTicketPhone(ticket) === cleanPhone) || null;
}

function getFallbackTicket(visibleTickets) {
  return visibleTickets.find(ticket => getTicketPhone(ticket)) || null;
}

function resolveTicket(input = {}, visibleTickets = []) {
  const externalId = input.ticketExternalId || input.externalId || input.ticketId;
  const requestedPhone = input.phone || input.to || input.target || input.chatId;
  const ticketFromRequest = getTicketByExternalId(externalId, visibleTickets);

  if (externalId) {
    return ticketFromRequest;
  }

  if (requestedPhone) {
    return getTicketByPhone(requestedPhone, visibleTickets);
  }

  return getFallbackTicket(visibleTickets);
}

function buildChatId(input = {}, ticket) {
  const explicitChatId = String(input.chatId || '').trim();

  if (explicitChatId.includes('@')) {
    return explicitChatId;
  }

  const phone = normalizeTargetPhone(
    input.phone ||
    input.to ||
    input.target ||
    explicitChatId ||
    getTicketPhone(ticket)
  );

  return phone ? `${phone}@c.us` : '';
}

function buildMessageId(chatId, timestamp) {
  const suffix = Math.random().toString(36).slice(2, 8);

  return `notification-test-response-${timestamp}-${normalizeTargetPhone(chatId) || 'chat'}-${suffix}`;
}

function createHttpError(message, statusCode) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}

async function runResponseNotificationTest(input = {}, dependencies = {}) {
  const visibleTickets = Array.isArray(dependencies.visibleTickets)
    ? dependencies.visibleTickets
    : [];
  const ticket = resolveTicket(input, visibleTickets);
  const chatId = buildChatId(input, ticket);
  const phone = normalizeTargetPhone(input.phone || input.to || input.target || chatId || getTicketPhone(ticket));
  const body = String(input.message || input.response || '1').trim();
  const timestamp = Date.now();

  if (!ticket) {
    throw createHttpError('No hay tickets visibles con movil para probar la notificacion', 400);
  }

  if (!chatId || !phone) {
    throw createHttpError('Falta phone o chatId para probar la notificacion', 400);
  }

  if (!body) {
    throw createHttpError('Falta message o response para probar la notificacion', 400);
  }

  const storedMessage = saveWhatsAppMessage({
    id: buildMessageId(chatId, timestamp),
    chatId,
    phone,
    contactName: String(input.contactName || 'Prueba respuesta').trim(),
    direction: 'incoming',
    body,
    timestampTs: timestamp,
    fromMe: false,
    source: 'notification-test'
  });

  const responseResult = dependencies.processIncomingTicketResponse
    ? await dependencies.processIncomingTicketResponse(storedMessage)
    : null;

  return {
    message: storedMessage,
    ticket: {
      externalId: ticket.external_id,
      phone: ticket.phone,
      razonSocial: ticket.razon_social || '',
      delegacion: ticket.delegacion || ''
    },
    response: responseResult
      ? {
          matched: Boolean(responseResult.matched),
          selectedLabel: responseResult.selectedOption && responseResult.selectedOption.label || null,
          ticketExternalId: responseResult.completedAction && responseResult.completedAction.ticket_external_id || null
        }
      : null
  };
}

module.exports = {
  runResponseNotificationTest
};
