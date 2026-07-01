const fs = require('fs');
const path = require('path');
const { config } = require('./config');

const settingsPath = path.join(__dirname, 'data', 'settings.json');

function readSettings() {
  if (!fs.existsSync(settingsPath)) {
    return {};
  }

  try {
    return JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
  } catch (error) {
    console.warn('No se pudo leer data/settings.json. Se usan valores por defecto.');
    return {};
  }
}

function writeSettings(settings) {
  fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
  fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2), 'utf8');
}

function getMessageTemplate() {
  const settings = readSettings();
  return settings.messageTemplate || config.messageTemplate;
}

function isAutomaticReminderEnabled() {
  const settings = readSettings();
  return settings.automaticReminderEnabled !== false;
}

function setAutomaticReminderEnabled(enabled) {
  const settings = readSettings();
  settings.automaticReminderEnabled = Boolean(enabled);
  settings.updatedAt = new Date().toISOString();
  writeSettings(settings);

  return settings.automaticReminderEnabled;
}

function getTicketResponseQuestion() {
  const settings = readSettings();
  const configured = settings.ticketResponseQuestion || {};
  const options = Array.isArray(configured.options) && configured.options.length
    ? configured.options
    : [
        { key: '1', label: 'Si, confirmo', action: 'confirm_visit' },
        { key: '2', label: 'Necesito reprogramar', action: 'request_reschedule' }
      ];

  return {
    enabled: configured.enabled !== false,
    prompt: String(configured.prompt || 'Confirmas que podemos pasar por tu domicilio?').trim(),
    options: options
      .map((option, index) => ({
        key: String(option.key || index + 1).trim(),
        label: String(option.label || '').trim(),
        action: String(option.action || '').trim()
      }))
      .filter(option => option.key !== '3' && option.action !== 'cancel_visit')
      .filter(option => option.key && option.label && option.action)
      .slice(0, 10)
  };
}

function getTicketResponseReply(action) {
  const settings = readSettings();
  const configured = settings.ticketResponseReplies || {};
  const replies = {
    confirm_visit:
      'Gracias por confirmar. Este atento al telefono, pronto nos comunicaremos.',
    request_reschedule:
      'Perfecto, en breve uno de nuestros representantes se comunicara.',
    default:
      'No pudimos interpretar tu respuesta. Por favor responde 1 para confirmar o 2 para reprogramar.',
    ...configured
  };

  return String(replies[action] || replies.default || '').trim();
}

function getNotificationChannelReply() {
  const settings = readSettings();
  const supportPhone = String(
    settings.technicalVisitSupportPhone ||
    process.env.TECHNICAL_VISIT_SUPPORT_PHONE ||
    'xxxx'
  ).trim();
  const template = String(
    settings.notificationChannelReply ||
    process.env.NOTIFICATION_CHANNEL_REPLY ||
    'Este es un canal de notificaciones de visita tecnica. Para gestionar tu visita comunicate al numero {support_phone}.'
  ).trim();

  return template.replaceAll('{support_phone}', supportPhone || 'xxxx');
}

function setMessageTemplate(messageTemplate) {
  const template = String(messageTemplate || '').trim();

  if (!template) {
    throw new Error('El mensaje no puede estar vacio');
  }

  const settings = readSettings();
  settings.messageTemplate = template;
  settings.updatedAt = new Date().toISOString();
  writeSettings(settings);

  return settings.messageTemplate;
}

module.exports = {
  getNotificationChannelReply,
  getTicketResponseReply,
  getTicketResponseQuestion,
  isAutomaticReminderEnabled,
  getMessageTemplate,
  setAutomaticReminderEnabled,
  setMessageTemplate
};
