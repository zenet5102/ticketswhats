module.exports = {
  apps: [
    {
      name: 'wwebjs',
      script: './server.js',
      cwd: __dirname,
      watch: false,
      time: true
    },
    {
      name: 'whatsapp2',
      script: './secondServer.js',
      cwd: __dirname,
      watch: false,
      time: true
    },
    {
      name: 'wwebjs-third',
      script: './thirdServer.js',
      cwd: __dirname,
      watch: false,
      time: true
    }
  ]
};
