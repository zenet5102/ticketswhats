const {
  completeTicketResponseAction,
  getPendingTicketResponseActionByChat
} = require('./db');

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

async function executeResponseAction(pendingAction, selectedOption, context = {}) {
  const result = {
    action: selectedOption.action,
    ticketExternalId: pendingAction.ticket_external_id,
    selectedLabel: selectedOption.label
  };

  if (selectedOption.action === 'confirm_visit') {
    result.message = 'Cliente confirmo la visita';
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
