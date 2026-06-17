const {
  completeTicketResponseAction,
  getTicket,
  getPendingTicketResponseActionByChat
} = require('./db');
const { config } = require('./config');
const { postTicketNote } = require('./ticketApi');

function normalizeText(value) {
  return String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .trim()
    .toLowerCase();
}

function formatQuestionText(question) {
  if (!question || !question.enabled || !question.options.length) {
    return '';
  }

  return [
    question.prompt,
    ...question.options.map(option => `${option.key}. ${option.label}`)
  ].join('\n');
}

function findOptionByText(options, text) {
  const cleanText = normalizeText(text);

  if (!cleanText) {
    return null;
  }

  return options.find(option => {
    const cleanKey = normalizeText(option.key);
    const cleanLabel = normalizeText(option.label);
    return (
      cleanText === cleanKey ||
      cleanText.startsWith(`${cleanKey}.`) ||
      cleanText.startsWith(`${cleanKey} `) ||
      cleanText === cleanLabel ||
      cleanText.includes(cleanLabel)
    );
  }) || null;
}

function getByPath(source, path) {
  if (!source || !path) {
    return undefined;
  }

  return String(path)
    .split('.')
    .reduce((value, key) => (value && value[key] !== undefined ? value[key] : undefined), source);
}

function parseTicketPayload(ticket) {
  try {
    return JSON.parse(ticket && ticket.payload_json || '{}') || {};
  } catch (error) {
    return {};
  }
}

function getTicketIda(ticket) {
  const payload = parseTicketPayload(ticket);
  const candidates = [
    getByPath(payload, config.clientLookupTicketField),
    payload.IDA,
    payload.ida,
    payload.Ida,
    payload.IDAbonado,
    payload.idAbonado,
    payload.id_abonado,
    getByPath(payload, 'cliente.IDA'),
    getByPath(payload, 'cliente.ida')
  ];

  const value = candidates.find(candidate => (
    candidate !== undefined &&
    candidate !== null &&
    String(candidate).trim() !== ''
  ));

  return String(value || '').trim();
}

function buildVisitConfirmationDetail(ticket) {
  const hour = String(ticket && ticket.start_time || '').trim();
  const externalId = String(ticket && ticket.external_id || '').trim();
  const hourText = hour ? ` ${hour}` : '';
  const ticketText = externalId ? ` y numero de ticket ${externalId}` : '';

  return `Cliente confirma visita${hourText}${ticketText}`.trim();
}

async function postVisitConfirmationNote(ticket, result, context = {}) {
  const ida = getTicketIda(ticket);

  if (!ida) {
    result.notePosted = false;
    result.noteError = 'No se encontro IDA del ticket';
    return;
  }

  const note = {
    id: ida,
    asunto: 'Confirmacion de visita',
    detalle: buildVisitConfirmationDetail(ticket)
  };

  try {
    result.noteRequest = note;
    result.noteResponse = await postTicketNote(note);
    result.notePosted = true;

    if (context.logger) {
      context.logger('Nota de confirmacion enviada', {
        ticketExternalId: ticket.external_id,
        id: ida
      });
    }
  } catch (error) {
    result.notePosted = false;
    result.noteError = error.message;

    if (context.logger) {
      context.logger('No se pudo enviar nota de confirmacion', {
        ticketExternalId: ticket && ticket.external_id,
        error: error.message
      });
    }
  }
}

async function executeResponseAction(pendingAction, selectedOption, context = {}) {
  const result = {
    action: selectedOption.action,
    ticketExternalId: pendingAction.ticket_external_id,
    selectedLabel: selectedOption.label
  };

  if (selectedOption.action === 'confirm_visit') {
    result.message = 'Cliente confirmo la visita';
    await postVisitConfirmationNote(getTicket(pendingAction.ticket_external_id), result, context);
  } else if (selectedOption.action === 'request_reschedule') {
    result.message = 'Cliente solicito reprogramar';
  } else if (selectedOption.action === 'cancel_visit') {
    result.message = 'Cliente indico que no puede recibir al tecnico';
  } else {
    result.message = 'Accion personalizada registrada';
  }

  if (context.logger) {
    context.logger(result.message, result);
  }

  return result;
}

async function completeSelection(pendingAction, selectedOption, context = {}) {
  const actionResult = await executeResponseAction(pendingAction, selectedOption, context);

  return completeTicketResponseAction(pendingAction.id, {
    selectedKey: selectedOption.key,
    selectedLabel: selectedOption.label,
    selectedAction: selectedOption.action,
    responseMessageId: context.responseMessageId,
    responseBody: context.responseBody || selectedOption.label,
    actionResult: JSON.stringify(actionResult)
  });
}

async function handleIncomingTextResponse(input = {}) {
  const pendingAction = getPendingTicketResponseActionByChat(input.chatId, input.phone);

  if (!pendingAction) {
    return null;
  }

  const selectedOption = findOptionByText(pendingAction.options, input.body);

  if (!selectedOption) {
    return {
      matched: false,
      pendingAction
    };
  }

  const completedAction = await completeSelection(pendingAction, selectedOption, {
    responseMessageId: input.messageId,
    responseBody: input.body,
    logger: input.logger
  });

  return {
    matched: true,
    completedAction,
    selectedOption
  };
}

module.exports = {
  formatQuestionText,
  handleIncomingTextResponse
};
