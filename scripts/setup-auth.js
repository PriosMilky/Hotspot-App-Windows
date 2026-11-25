'use strict';

const fs = require('node:fs/promises');
const { randomBytes, randomUUID } = require('node:crypto');
const path = require('node:path');
const bcrypt = require('bcryptjs');
const dotenv = require('dotenv');

const envFilePath = process.env.MIKROTIK_ENV_FILE || path.join(__dirname, '..', '.env');

async function readLine(prompt) {
  const readline = require('node:readline/promises');
  const terminal = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    return (await terminal.question(prompt)).trim();
  } finally {
    terminal.close();
  }
}

function readHidden(prompt) {
  const { stdin, stdout } = process;
  if (!stdin.isTTY || !stdout.isTTY || typeof stdin.setRawMode !== 'function') {
    return Promise.reject(new Error('Jalankan perintah ini langsung di terminal interaktif.'));
  }

  return new Promise((resolve, reject) => {
    let value = '';
    stdin.setRawMode(true);
    stdin.resume();
    stdout.write(prompt);

    function finish(error) {
      stdin.removeListener('data', onData);
      stdin.setRawMode(false);
      stdin.pause();
      stdout.write('\n');
      if (error) reject(error);
      else resolve(value);
    }

    function onData(chunk) {
      for (const key of chunk.toString('utf8')) {
        if (key === '\u0003') return finish(new Error('Dibatalkan.'));
        if (key === '\r' || key === '\n') return finish();
        if (key === '\u007f' || key === '\b') {
          value = [...value].slice(0, -1).join('');
          stdout.write('\b \b');
        } else if (!/[\u0000-\u001f\u007f]/.test(key)) {
          value += key;
          stdout.write('*');
        }
      }
    }

    stdin.on('data', onData);
  });
}

async function main() {
  const onlyIfNeeded = process.argv.includes('--if-needed');
  let contents = '';
  try {
    contents = await fs.readFile(envFilePath, 'utf8');
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }

  const environment = dotenv.parse(contents);
  let users = [];
  if (environment.APP_USERS_JSON) {
    try {
      users = JSON.parse(environment.APP_USERS_JSON);
    } catch {
      throw new Error('APP_USERS_JSON di .env bukan JSON yang valid.');
    }
    if (!Array.isArray(users) || users.length > 5) {
      throw new Error('APP_USERS_JSON harus berupa array dengan maksimal lima akun.');
    }
    if (users.some((user) => (
      !user
      || typeof user.username !== 'string'
      || !/^[A-Za-z0-9._-]{1,64}$/.test(user.username)
      || typeof user.passwordHash !== 'string'
      || !/^\$2[aby]\$(?:1[0-5])\$[./A-Za-z0-9]{53}$/.test(user.passwordHash)
    ))) {
      throw new Error('Ada akun yang tidak valid di APP_USERS_JSON.');
    }
    const usernames = users.map((user) => user.username.toLowerCase());
    if (new Set(usernames).size !== usernames.length) {
      throw new Error('Username akun aplikasi tidak boleh duplikat.');
    }
  }
  if (environment.APP_COOKIE_SECURE && !['true', 'false'].includes(environment.APP_COOKIE_SECURE)) {
    throw new Error('APP_COOKIE_SECURE harus bernilai true atau false.');
  }

  const hasSessionSecret = Buffer.byteLength(environment.APP_SESSION_SECRET || '', 'utf8') >= 32;
  const createAccount = !(onlyIfNeeded && users.length > 0);
  if (!createAccount && hasSessionSecret) {
    process.stdout.write('Akun aplikasi sudah dikonfigurasi.\n');
    return;
  }
  if (createAccount && users.length >= 5) throw new Error('Batas lima akun aplikasi sudah tercapai.');

  if (createAccount) {
    const username = await readLine('Username akun aplikasi: ');
    if (!/^[A-Za-z0-9._-]{1,64}$/.test(username)) {
      throw new Error('Username hanya boleh berisi huruf, angka, titik, garis bawah, dan tanda hubung.');
    }
    if (users.some((user) => user.username.toLowerCase() === username.toLowerCase())) {
      throw new Error('Username tersebut sudah terdaftar.');
    }

    const password = await readHidden('Password akun aplikasi (12-72 byte): ');
    const confirmation = await readHidden('Ulangi password: ');
    if (password !== confirmation) throw new Error('Password tidak sama.');
    if (Buffer.byteLength(password, 'utf8') < 12 || Buffer.byteLength(password, 'utf8') > 72) {
      throw new Error('Password harus memiliki panjang 12 sampai 72 byte.');
    }

    users.push({ username, passwordHash: await bcrypt.hash(password, 12) });
  }

  const values = {
    APP_USERS_JSON: `'${JSON.stringify(users)}'`,
    APP_SESSION_SECRET: environment.APP_SESSION_SECRET?.length >= 32
      ? environment.APP_SESSION_SECRET
      : randomBytes(32).toString('hex'),
  };
  if (!environment.APP_COOKIE_SECURE) values.APP_COOKIE_SECURE = 'false';

  const seen = new Set();
  const lines = contents.split(/\r?\n/).map((line) => {
    const match = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/);
    if (!match || !(match[1] in values)) return line;
    seen.add(match[1]);
    return `${match[1]}=${values[match[1]]}`;
  });
  for (const [name, value] of Object.entries(values)) {
    if (!seen.has(name)) lines.push(`${name}=${value}`);
  }

  const temporaryPath = `${envFilePath}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await fs.writeFile(temporaryPath, `${lines.join('\n').replace(/\n*$/, '')}\n`, {
      encoding: 'utf8',
      flag: 'wx',
      mode: 0o600,
    });
    await fs.chmod(temporaryPath, 0o600);
    await fs.rename(temporaryPath, envFilePath);
  } catch (error) {
    await fs.unlink(temporaryPath).catch(() => {});
    throw error;
  }

  const message = createAccount
    ? `Akun ditambahkan (${users.length}/5). Jalankan npm start untuk membuka aplikasi.\n`
    : 'Rahasia sesi aplikasi dibuat.\n';
  await new Promise((resolve) => process.stdout.write(message, resolve));
  process.exit(0);
}

main().catch((error) => {
  process.stderr.write(`${error.message}\n`, () => process.exit(1));
});