module.exports = {
  apps: [
    {
      name: 'wwebjs',
      script: './server.js',
      cwd: __dirname,
      watch: false,
      time: true,
      env: {
        WHATSAPP_LOCAL_ACCOUNTS: process.env.WHATSAPP_LOCAL_ACCOUNTS || 'bot-1',
        WHATSAPP_BOT2_WORKER_URL: process.env.WHATSAPP_BOT2_WORKER_URL || 'http://127.0.0.1:3002'
      }
    },
    {
      name: 'wwebjs-bot2-worker',
      script: './whatsappWorker.js',
      cwd: __dirname,
      watch: false,
      time: true,
      env: {
        WHATSAPP_WORKER_ACCOUNT_ID: process.env.WHATSAPP_WORKER_ACCOUNT_ID || 'bot-2',
        WHATSAPP_WORKER_PORT: process.env.WHATSAPP_WORKER_PORT || '3002',
        WHATSAPP_WORKER_LABEL: process.env.WHATSAPP_WORKER_LABEL || process.env.WHATSAPP_SECONDARY_LABEL || 'Coordinacion',
        WHATSAPP_WORKER_CLIENT_ID: process.env.WHATSAPP_WORKER_CLIENT_ID || process.env.SECOND_WHATSAPP_CLIENT_ID || 'bot-2',
        WHATSAPP_WORKER_TOKEN: process.env.WHATSAPP_WORKER_TOKEN || ''
      }
    }
  ]
};
