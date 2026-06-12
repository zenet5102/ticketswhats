const { Client } = require('ssh2');

const host = process.env.SFTP_HOST;
const username = process.env.SFTP_USER;
const password = process.env.SFTP_PASS;
const remoteDir = process.env.SFTP_REMOTE_DIR || '/home/Jony/wwebjs';

if (!host || !username || !password) {
  console.error('Missing SFTP_HOST, SFTP_USER, or SFTP_PASS.');
  process.exit(2);
}

const command = [
  `if [ -d ${JSON.stringify(remoteDir)} ]; then`,
  `printf 'files='; find ${JSON.stringify(remoteDir)} -type f 2>/dev/null | wc -l;`,
  `printf 'bytes='; du -sb ${JSON.stringify(remoteDir)} 2>/dev/null | awk '{print $1}';`,
  'else',
  "echo 'files=0'; echo 'bytes=0';",
  'fi',
].join(' ');

const conn = new Client();
let stdout = '';
let stderr = '';

conn
  .on('ready', () => {
    conn.exec(command, (err, stream) => {
      if (err) throw err;
      stream
        .on('close', code => {
          conn.end();
          if (code !== 0) {
            console.error(stderr || `Remote command failed with code ${code}`);
            process.exit(code || 1);
          }
          process.stdout.write(stdout);
        })
        .on('data', chunk => {
          stdout += chunk.toString();
        })
        .stderr.on('data', chunk => {
          stderr += chunk.toString();
        });
    });
  })
  .on('error', err => {
    console.error(err && err.stack ? err.stack : String(err));
    process.exit(1);
  })
  .connect({
    host,
    username,
    password,
    readyTimeout: 20000,
  });
