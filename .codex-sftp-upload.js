const fs = require('fs');
const path = require('path');
const posix = require('path').posix;
const { Client } = require('ssh2');

const host = process.env.SFTP_HOST;
const username = process.env.SFTP_USER;
const password = process.env.SFTP_PASS;
const localRoot = process.env.SFTP_LOCAL;
const remoteName = process.env.SFTP_REMOTE_NAME || path.basename(localRoot);

if (!host || !username || !password || !localRoot) {
  console.error('Missing SFTP_HOST, SFTP_USER, SFTP_PASS, or SFTP_LOCAL.');
  process.exit(2);
}

function sftpCall(sftp, method, ...args) {
  return new Promise((resolve, reject) => {
    sftp[method](...args, (err, result) => (err ? reject(err) : resolve(result)));
  });
}

async function ensureRemoteDir(sftp, dir) {
  const absolute = dir.startsWith('/');
  const parts = dir.split('/').filter(Boolean);
  let current = absolute ? '/' : '';

  for (const part of parts) {
    current = current === '/' ? `/${part}` : (current ? `${current}/${part}` : part);
    try {
      await sftpCall(sftp, 'stat', current);
    } catch (err) {
      if (err && err.code === 2) {
        await sftpCall(sftp, 'mkdir', current);
      } else {
        throw err;
      }
    }
  }
}

async function remoteFileHasSameSize(sftp, remotePath, size) {
  try {
    const stat = await sftpCall(sftp, 'stat', remotePath);
    return stat && stat.isFile() && stat.size === size;
  } catch (err) {
    if (err && err.code === 2) {
      return false;
    }

    throw err;
  }
}

async function walk(root) {
  const entries = await fs.promises.readdir(root, { withFileTypes: true });
  const files = [];

  for (const entry of entries) {
    const fullPath = path.join(root, entry.name);
    if (entry.isDirectory()) {
      files.push(...await walk(fullPath));
    } else if (entry.isFile()) {
      const stat = await fs.promises.stat(fullPath);
      files.push({ fullPath, size: stat.size });
    }
  }

  return files;
}

function uploadFile(sftp, localPath, remotePath) {
  return new Promise((resolve, reject) => {
    sftp.fastPut(localPath, remotePath, err => (err ? reject(err) : resolve()));
  });
}

async function main() {
  const conn = new Client();
  await new Promise((resolve, reject) => {
    conn
      .on('ready', resolve)
      .on('error', reject)
      .connect({
        host,
        username,
        password,
        readyTimeout: 20000,
      });
  });

  const sftp = await new Promise((resolve, reject) => {
    conn.sftp((err, session) => (err ? reject(err) : resolve(session)));
  });

  try {
    const remoteHome = await sftpCall(sftp, 'realpath', '.');
    const remoteRoot = posix.join(remoteHome, remoteName);
    const files = await walk(localRoot);
    const totalBytes = files.reduce((sum, file) => sum + file.size, 0);
    let uploadedFiles = 0;
    let uploadedBytes = 0;
    let alreadyCurrentFiles = 0;
    let skippedFiles = 0;
    const startedAt = Date.now();

    console.log(`remoteRoot=${remoteRoot}`);
    console.log(`files=${files.length}`);
    console.log(`bytes=${totalBytes}`);

    await ensureRemoteDir(sftp, remoteRoot);

    for (const file of files) {
      const relative = path.relative(localRoot, file.fullPath).split(path.sep).join('/');
      const remotePath = posix.join(remoteRoot, relative);
      if (await remoteFileHasSameSize(sftp, remotePath, file.size)) {
        alreadyCurrentFiles += 1;
        if ((uploadedFiles + skippedFiles + alreadyCurrentFiles) % 250 === 0 || uploadedFiles + skippedFiles + alreadyCurrentFiles === files.length) {
          const mb = (uploadedBytes / 1024 / 1024).toFixed(1);
          const totalMb = (totalBytes / 1024 / 1024).toFixed(1);
          const seconds = ((Date.now() - startedAt) / 1000).toFixed(0);
          console.log(`progress=${uploadedFiles + skippedFiles + alreadyCurrentFiles}/${files.length} uploaded=${uploadedFiles} current=${alreadyCurrentFiles} skipped=${skippedFiles} ${mb}/${totalMb}MB elapsed=${seconds}s`);
        }
        continue;
      }

      await ensureRemoteDir(sftp, posix.dirname(remotePath));
      try {
        await uploadFile(sftp, file.fullPath, remotePath);
      } catch (err) {
        if (err && (err.code === 'EBUSY' || err.code === 'EPERM' || err.code === 'EACCES')) {
          skippedFiles += 1;
          console.log(`skipped=${relative} reason=${err.code}`);
          continue;
        }

        throw err;
      }
      uploadedFiles += 1;
      uploadedBytes += file.size;

      if ((uploadedFiles + skippedFiles + alreadyCurrentFiles) % 250 === 0 || uploadedFiles + skippedFiles + alreadyCurrentFiles === files.length) {
        const mb = (uploadedBytes / 1024 / 1024).toFixed(1);
        const totalMb = (totalBytes / 1024 / 1024).toFixed(1);
        const seconds = ((Date.now() - startedAt) / 1000).toFixed(0);
        console.log(`progress=${uploadedFiles + skippedFiles + alreadyCurrentFiles}/${files.length} uploaded=${uploadedFiles} current=${alreadyCurrentFiles} skipped=${skippedFiles} ${mb}/${totalMb}MB elapsed=${seconds}s`);
      }
    }

    console.log('upload=complete');
    console.log(`uploaded=${uploadedFiles}`);
    console.log(`current=${alreadyCurrentFiles}`);
    console.log(`skipped=${skippedFiles}`);
    console.log(`remoteRoot=${remoteRoot}`);
  } finally {
    sftp.end();
    conn.end();
  }
}

main().catch(err => {
  console.error(err && err.stack ? err.stack : String(err));
  process.exit(1);
});
