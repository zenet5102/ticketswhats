const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');

const client = new Client({
    authStrategy: new LocalAuth()
});

client.on('qr', qr => {
    qrcode.generate(qr, { small: true });
});

client.on('ready', async () => {
    console.log('WhatsApp conectado');

    await client.sendMessage(
        '5491122871151@c.us',
        'Mensaje de prueba desde whatsapp-web.js'
    );

    console.log('Mensaje enviado');
});

client.initialize();