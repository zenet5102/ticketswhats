const primary = require('./primaryMessageDb');

(async () => {
  for (const [name, run] of [
    ['conversations', () => primary.listWhatsAppConversations(5, { accountId: 'bot-1' })],
    ['messages', () => primary.listWhatsAppMessages(process.argv[2] || '161095717236925@lid', 5, { accountId: 'bot-1' })],
  ]) {
    try {
      const rows = await run();
      console.log(`${name}=ok count=${rows.length}`);
      console.log(JSON.stringify(rows.slice(0, 2), null, 2));
    } catch (error) {
      console.log(`${name}=error`);
      console.log(error && error.stack ? error.stack : String(error));
    }
  }
  process.exit(0);
})().catch(error => {
  console.error(error && error.stack ? error.stack : String(error));
  process.exit(1);
});
