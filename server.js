'use strict';

const fs = require('node:fs/promises');
const { createHash, randomUUID } = require('node:crypto');
const path = require('node:path');
const dotenv = require('dotenv');
const envFilePath = process.env.MIKROTIK_ENV_FILE || path.join(__dirname, '.env');
dotenv.config({ path: envFilePath });

const bcrypt = require('bcryptjs');
const express = require('express');
const { getIronSession } = require('iron-session');
const { createActiveHotspotSampler, createHotspotTrafficSampler } = require('./hotspot-traffic');

function environmentValue(name) {
  const encoded = process.env[`${name}_BASE64`];
  if (encoded) {
    const decoded = Buffer.from(encoded, 'base64');
    if (decoded.toString('base64') !== encoded) {
      throw new Error(`${name}_BASE64 must be valid base64.`);
    }
    return decoded.toString('utf8');
  }
  return process.env[name];
}

function requiredEnv(name, trim = true) {
  const rawValue = environmentValue(name);
  const value = trim ? rawValue?.trim() : rawValue;
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

function positiveNumber(value, name) {
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`${name} must be an integer between 1 and 65535.`);
  }
  return port;
}

function positivePort(name, fallback) {
  return positiveNumber(process.env[name] || fallback, name);
}

function loadAppUsers(value) {
  let entries;
  try {
    entries = JSON.parse(value);
  } catch {
    throw new Error('APP_USERS_JSON harus berupa JSON array berisi username dan passwordHash bcrypt.');
  }

  if (!Array.isArray(entries) || entries.length < 1 || entries.length > 5) {
    throw new Error('APP_USERS_JSON harus berisi antara 1 dan 5 akun aplikasi.');
  }

  const users = new Map();
  for (const entry of entries) {
    if (
      !entry
      || typeof entry.username !== 'string'
      || !/^[A-Za-z0-9._-]{1,64}$/.test(entry.username)
      || typeof entry.passwordHash !== 'string'
      || !/^\$2[aby]\$(?:1[0-5])\$[./A-Za-z0-9]{53}$/.test(entry.passwordHash)
    ) {
      throw new Error('Setiap akun aplikasi harus memiliki username valid dan hash password bcrypt dengan cost 10–15.');
    }

    const username = entry.username.trim();
    const key = username.toLowerCase();
    if (users.has(key)) {
      throw new Error('Username akun aplikasi tidak boleh duplikat.');
    }
    users.set(key, {
      username,
      passwordHash: entry.passwordHash,
      passwordFingerprint: createHash('sha256').update(entry.passwordHash).digest('hex'),
    });
  }
  return users;
}

function makeRouterConfig(values) {
  const host = typeof values.host === 'string' ? values.host.trim() : '';
  const protocol = values.protocol;
  const port = positiveNumber(values.port, 'MikroTik port');
  const username = typeof values.username === 'string' ? values.username.trim() : '';
  const password = typeof values.password === 'string' ? values.password : '';

  if (
    !host
    || host.length > 253
    || /[/\\?#@\s\u0000-\u001f\u007f]/.test(host)
    || host.includes('://')
  ) {
    throw new Error('Alamat MikroTik harus berupa IP atau hostname tanpa scheme atau path.');
  }
  if (!['http', 'https'].includes(protocol)) {
    throw new Error('Protocol harus berupa HTTP atau HTTPS.');
  }
  if (!username || username.length > 128 || username.includes(':') || /[\u0000-\u001f\u007f]/.test(username)) {
    throw new Error('Username API MikroTik tidak valid.');
  }
  if (!password || password.length > 256 || /[\u0000-\u001f\u007f]/.test(password)) {
    throw new Error('Password API MikroTik tidak valid.');
  }

  const urlHost = host.includes(':') && !host.startsWith('[') ? `[${host}]` : host;
  let restUrl;
  try {
    restUrl = new URL(`${protocol}://${urlHost}:${port}/rest/`);
  } catch {
    throw new Error('Alamat MikroTik tidak valid. Masukkan IP atau hostname yang benar.');
  }
  return { host, protocol, port, username, password, restUrl };
}

let routerConfig = makeRouterConfig({
  host: requiredEnv('MIKROTIK_HOST'),
  protocol: environmentValue('MIKROTIK_PROTOCOL') || 'https',
  port: environmentValue('MIKROTIK_PORT') || (environmentValue('MIKROTIK_PROTOCOL') === 'http' ? 80 : 443),
  username: requiredEnv('MIKROTIK_USERNAME'),
  password: requiredEnv('MIKROTIK_PASSWORD', false),
});
let routerConnectionEnabled = true;
const activeHotspotSampler = createActiveHotspotSampler();
const hotspotTrafficSampler = createHotspotTrafficSampler();
const app = express();
const appHost = process.env.HOST || '127.0.0.1';
const appPort = positivePort('PORT', 3000);
const appUsers = loadAppUsers(requiredEnv('APP_USERS_JSON', false));
const appSessionSecret = requiredEnv('APP_SESSION_SECRET', false);
if (Buffer.byteLength(appSessionSecret, 'utf8') < 32) {
  throw new Error('APP_SESSION_SECRET harus memiliki panjang minimal 32 byte.');
}

const secureCookieValue = environmentValue('APP_COOKIE_SECURE') || 'false';
if (!['true', 'false'].includes(secureCookieValue)) {
  throw new Error('APP_COOKIE_SECURE harus bernilai true atau false.');
}
const sessionOptions = {
  cookieName: 'coco-hotspot-session',
  password: appSessionSecret,
  ttl: 8 * 60 * 60,
  cookieOptions: {
    httpOnly: true,
    secure: secureCookieValue === 'true',
    sameSite: 'strict',
    path: '/',
  },
};
const failedLoginAttempts = new Map();
const loginWindowMs = 15 * 60 * 1000;
const maxFailedLoginAttempts = 5;
const dummyPasswordHash = bcrypt.hashSync('invalid-login-placeholder', 12);

class RouterApiError extends Error {
  constructor(statusCode, message) {
    super(message);
    this.statusCode = statusCode;
  }
}

async function routerRequest(resource, options = {}, config = routerConfig) {
  let response;
  try {
    const authorization = `Basic ${Buffer.from(`${config.username}:${config.password}`).toString('base64')}`;
    response = await fetch(new URL(resource, config.restUrl), {
      method: options.method || 'GET',
      headers: {
        authorization,
        ...(options.body ? { 'content-type': 'application/json' } : {}),
      },
      body: options.body ? JSON.stringify(options.body) : undefined,
      signal: AbortSignal.timeout(8000),
    });
  } catch (error) {
    const timedOut = error.name === 'TimeoutError' || error.name === 'AbortError';
    console.error(`RouterOS REST request failed: ${error.message}`);
    throw new RouterApiError(
      timedOut ? 504 : 502,
      timedOut
        ? 'Koneksi ke MikroTik timeout.'
        : 'Tidak dapat terhubung ke MikroTik. Periksa alamat, port, dan sertifikat HTTPS.',
    );
  }

  if (!response.ok) {
    const text = await response.text();
    let payload;
    try {
      payload = JSON.parse(text);
    } catch {
      payload = null;
    }

    const rawDetail = payload && typeof payload.detail === 'string'
      ? payload.detail
      : payload && typeof payload.message === 'string'
        ? payload.message
        : '';
    const detail = rawDetail
      .replaceAll(config.password, '[redacted]')
      .replaceAll(config.username, '[redacted]')
      .replace(/[\u0000-\u001f\u007f]+/g, ' ')
      .trim()
      .slice(0, 300);
    console.error(`RouterOS REST returned HTTP ${response.status}${detail ? `: ${detail}` : '.'}`);
    throw new RouterApiError(
      502,
      detail
        ? `MikroTik menolak permintaan: ${detail}`
        : 'MikroTik menolak permintaan. Periksa credential, profile, dan izin akun API.',
    );
  }

  return response;
}

async function readHotspotProfiles(config = routerConfig) {
  const response = await routerRequest('ip/hotspot/user/profile', {}, config);
  let rows;
  try {
    rows = await response.json();
  } catch {
    throw new RouterApiError(502, 'MikroTik mengirim daftar profile dengan format tidak valid.');
  }

  if (!Array.isArray(rows)) {
    throw new RouterApiError(502, 'MikroTik mengirim daftar profile dengan format tidak valid.');
  }

  return [...new Set(rows
    .map((row) => row && typeof row.name === 'string' ? row.name : '')
    .filter((name) => name.trim() !== ''))];
}

async function readActiveHotspotSessions(config = routerConfig) {
  const response = await routerRequest('ip/hotspot/active', {}, config);
  let rows;
  try {
    rows = await response.json();
  } catch {
    throw new RouterApiError(502, 'MikroTik mengirim data user aktif dengan format tidak valid.');
  }

  if (!Array.isArray(rows)) {
    throw new RouterApiError(502, 'MikroTik mengirim data user aktif dengan format tidak valid.');
  }
  return rows;
}

async function readDhcpLeases(config = routerConfig) {
  const response = await routerRequest('ip/dhcp-server/lease', {}, config);
  let rows;
  try {
    rows = await response.json();
  } catch {
    throw new RouterApiError(502, 'MikroTik mengirim daftar DHCP lease dengan format tidak valid.');
  }

  if (!Array.isArray(rows)) {
    throw new RouterApiError(502, 'MikroTik mengirim daftar DHCP lease dengan format tidak valid.');
  }
  return rows;
}

function parseTrafficCounter(value) {
  const text = typeof value === 'number' && Number.isSafeInteger(value)
    ? String(value)
    : value;
  if (typeof text !== 'string' || !/^\d+$/.test(text)) {
    throw new RouterApiError(502, 'MikroTik mengirim nilai traffic dengan format tidak valid.');
  }
  return BigInt(text);
}

function createHotspotTrafficCounterSnapshot(sessions) {
  const counters = new Map();
  for (const session of sessions) {
    const macAddress = typeof session['mac-address'] === 'string'
      ? session['mac-address'].toLowerCase()
      : '';
    const sessionId = typeof session['.id'] === 'string' && session['.id'].trim()
      ? `id:${session['.id']}`
      : `identity:${session.user}\u0000${session.address}\u0000${macAddress}`;
    counters.set(sessionId, {
      uploadBytes: parseTrafficCounter(session['bytes-in']),
      downloadBytes: parseTrafficCounter(session['bytes-out']),
    });
  }
  return counters;
}

function findMostActiveHotspotUsers(sessions, leases, limit = 3) {
  const leasesByMac = new Map();
  const leasesByAddress = new Map();
  for (const lease of leases) {
    if (!lease || typeof lease !== 'object') continue;
    if (typeof lease['mac-address'] === 'string') {
      leasesByMac.set(lease['mac-address'].toLowerCase(), lease);
    }
    if (typeof lease.address === 'string') {
      leasesByAddress.set(lease.address, lease);
    }
  }

  const rankedSessions = [];
  for (const session of sessions) {
    if (
      !session
      || typeof session !== 'object'
      || typeof session.user !== 'string'
      || !session.user.trim()
      || typeof session.address !== 'string'
      || !session.address.trim()
    ) {
      throw new RouterApiError(502, 'MikroTik mengirim identitas sesi aktif dengan format tidak valid.');
    }

    const uploadBytes = parseTrafficCounter(session['bytes-in']);
    const downloadBytes = parseTrafficCounter(session['bytes-out']);
    const macAddress = typeof session['mac-address'] === 'string' ? session['mac-address'] : '';
    const lease = (macAddress && leasesByMac.get(macAddress.toLowerCase()))
      || leasesByAddress.get(session.address);
    const deviceName = [
      session['host-name'],
      lease?.['host-name'],
      lease?.comment,
      macAddress,
    ].find((value) => typeof value === 'string' && value.trim()) || 'Unknown device';

    rankedSessions.push({
      username: session.user,
      deviceName,
      ip: session.address,
      uploadBytes,
      downloadBytes,
      trafficBytes: uploadBytes + downloadBytes,
    });
  }

  return rankedSessions
    .sort((left, right) => {
      if (left.trafficBytes === right.trafficBytes) return 0;
      return left.trafficBytes > right.trafficBytes ? -1 : 1;
    })
    .slice(0, limit)
    .map((session) => ({
      username: session.username,
      deviceName: session.deviceName,
      ip: session.ip,
      uploadBytes: session.uploadBytes.toString(),
      downloadBytes: session.downloadBytes.toString(),
      totalTrafficBytes: session.trafficBytes.toString(),
    }));
}

function toLegacyMostActiveUser(user) {
  if (!user) return null;
  return {
    ...user,
    trafficBytes: user.totalTrafficBytes,
  };
}

async function readActiveHotspotCount(config = routerConfig) {
  const sessions = await readActiveHotspotSessions(config);
  return activeHotspotSampler.sample(createHotspotTrafficCounterSnapshot(sessions));
}

function sampleActiveHotspotUsage(sessions) {
  const trafficCounters = createHotspotTrafficCounterSnapshot(sessions);
  return {
    ...activeHotspotSampler.sample(trafficCounters),
    trafficSpeed: hotspotTrafficSampler.sample(trafficCounters),
  };
}

async function readActiveHotspotUsage(config = routerConfig) {
  const sessions = await readActiveHotspotSessions(config);
  return sampleActiveHotspotUsage(sessions);
}

async function readActiveHotspotSummary(config = routerConfig) {
  const sessions = await readActiveHotspotSessions(config);
  const mostActiveUsers = sessions.length > 0
    ? findMostActiveHotspotUsers(sessions, await readDhcpLeases(config))
    : [];
  return {
    ...sampleActiveHotspotUsage(sessions),
    mostActiveUser: toLegacyMostActiveUser(mostActiveUsers[0] || null),
    mostActiveUsers,
  };
}

function getPublicRouterSettings(config = routerConfig) {
  return {
    host: config.host,
    protocol: config.protocol,
    port: config.port,
    username: config.username,
  };
}

function isLocalAdminRequest(req, res, next) {
  const address = req.socket.remoteAddress || '';
  const normalizedAddress = address.startsWith('::ffff:') ? address.slice(7) : address;
  if (normalizedAddress !== '::1' && !normalizedAddress.startsWith('127.')) {
    return res.status(403).json({ error: 'Pengaturan koneksi hanya dapat diubah dari komputer server.' });
  }

  const origin = req.get('origin');
  if (origin) {
    try {
      if (new URL(origin).host !== req.get('host')) {
        return res.status(403).json({ error: 'Permintaan pengaturan koneksi harus berasal dari aplikasi ini.' });
      }
    } catch {
      return res.status(403).json({ error: 'Origin permintaan tidak valid.' });
    }
  }

  return next();
}

function isSameOriginRequest(req) {
  const origin = req.get('origin');
  if (!origin) return true;

  try {
    return new URL(origin).host === req.get('host');
  } catch {
    return false;
  }
}

function getSessionUser(session) {
  if (typeof session.username !== 'string' || typeof session.passwordFingerprint !== 'string') {
    return null;
  }
  const user = appUsers.get(session.username.toLowerCase());
  return user && user.passwordFingerprint === session.passwordFingerprint ? user : null;
}

async function requireAuthentication(req, res, next) {
  try {
    const session = await getIronSession(req, res, sessionOptions);
    const user = getSessionUser(session);
    if (!user) {
      if (session.username) session.destroy();
      if (req.originalUrl.startsWith('/api/')) {
        return res.status(401).json({ error: 'Silakan masuk untuk melanjutkan.', loginRequired: true });
      }
      return res.redirect(303, '/login');
    }

    req.authSession = session;
    req.authUser = user.username;
    res.setHeader('Cache-Control', 'no-store');
    return next();
  } catch (error) {
    return next(error);
  }
}

function getLoginAttemptState(key, now = Date.now()) {
  let state = failedLoginAttempts.get(key);
  if (state?.blockedUntil > now) return state;
  if (!state || now - state.startedAt >= loginWindowMs) {
    state = { startedAt: now, count: 0, blockedUntil: 0 };
    failedLoginAttempts.set(key, state);
  }
  return state;
}

function registerFailedLogin(key) {
  const state = getLoginAttemptState(key);
  state.count += 1;
  if (state.count >= maxFailedLoginAttempts) {
    state.blockedUntil = Date.now() + loginWindowMs;
  }
  return state;
}

function requireRouterConnection(req, res, next) {
  if (!routerConnectionEnabled) {
    return res.status(409).json({
      error: 'MikroTik sedang diputuskan dari aplikasi. Tekan Connect untuk mengaktifkan kembali.',
    });
  }
  return next();
}

function serializeEnvValue(value) {
  if (value.includes('"') || value.includes('\\')) {
    return {
      value: '""',
      base64: JSON.stringify(Buffer.from(value, 'utf8').toString('base64')),
    };
  }

  return { value: JSON.stringify(value), base64: '""' };
}

function updateEnvContent(contents, config) {
  const values = new Map();
  for (const [name, value] of Object.entries({
    MIKROTIK_HOST: config.host,
    MIKROTIK_PROTOCOL: config.protocol,
    MIKROTIK_PORT: String(config.port),
    MIKROTIK_USERNAME: config.username,
    MIKROTIK_PASSWORD: config.password,
  })) {
    const serialized = serializeEnvValue(value);
    values.set(name, serialized.value);
    values.set(`${name}_BASE64`, serialized.base64);
  }

  const seen = new Set();
  const lines = (contents ? contents.split(/\r?\n/) : []).map((line) => {
    const match = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/);
    if (!match || !values.has(match[1])) return line;
    seen.add(match[1]);
    return `${match[1]}=${values.get(match[1])}`;
  });

  for (const [name, value] of values) {
    if (!seen.has(name)) lines.push(`${name}=${value}`);
  }

  return `${lines.join('\n').replace(/\n*$/, '')}\n`;
}

async function persistRouterConfig(config) {
  let contents = '';
  try {
    contents = await fs.readFile(envFilePath, 'utf8');
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }

  const temporaryPath = `${envFilePath}.${process.pid}.${randomUUID()}.tmp`;
  let temporaryFileCreated = false;
  try {
    await fs.writeFile(temporaryPath, updateEnvContent(contents, config), {
      encoding: 'utf8',
      flag: 'wx',
      mode: 0o600,
    });
    temporaryFileCreated = true;
    await fs.chmod(temporaryPath, 0o600);
    await fs.rename(temporaryPath, envFilePath);
    temporaryFileCreated = false;
  } catch (error) {
    if (temporaryFileCreated) await fs.unlink(temporaryPath).catch(() => {});
    throw error;
  }
}

function updateProcessEnvironment(config) {
  for (const [name, value] of Object.entries({
    MIKROTIK_HOST: config.host,
    MIKROTIK_PROTOCOL: config.protocol,
    MIKROTIK_PORT: String(config.port),
    MIKROTIK_USERNAME: config.username,
    MIKROTIK_PASSWORD: config.password,
  })) {
    process.env[name] = value;
    delete process.env[`${name}_BASE64`];
  }
}

function sendRouterError(res, error) {
  if (error instanceof RouterApiError) {
    return res.status(error.statusCode).json({ error: error.message });
  }

  console.error(`RouterOS response processing failed: ${error.message}`);
  return res.status(502).json({ error: 'Respons MikroTik tidak dapat diproses.' });
}

app.disable('x-powered-by');
app.use(express.json({ limit: '4kb' }));
const publicDirectory = path.join(__dirname, 'public');

app.get('/login', async (req, res, next) => {
  try {
    const session = await getIronSession(req, res, sessionOptions);
    if (getSessionUser(session)) return res.redirect('/');
    res.setHeader('Cache-Control', 'no-store');
    return res.sendFile(path.join(publicDirectory, 'login.html'));
  } catch (error) {
    return next(error);
  }
});

app.get('/api/auth/session', async (req, res, next) => {
  try {
    const session = await getIronSession(req, res, sessionOptions);
    res.setHeader('Cache-Control', 'no-store');
    return res.json({ authenticated: Boolean(getSessionUser(session)) });
  } catch (error) {
    return next(error);
  }
});

app.post('/api/auth/login', async (req, res, next) => {
  if (!isSameOriginRequest(req)) {
    return res.status(403).json({ error: 'Permintaan masuk harus berasal dari aplikasi ini.' });
  }

  const { username, password } = req.body ?? {};
  if (
    typeof username !== 'string'
    || typeof password !== 'string'
    || username.trim().length < 1
    || username.trim().length > 64
    || password.length < 1
    || password.length > 128
  ) {
    return res.status(400).json({ error: 'Masukkan username dan password.' });
  }

  const attemptKey = req.socket.remoteAddress || 'unknown';
  const attemptState = getLoginAttemptState(attemptKey);
  if (attemptState.blockedUntil > Date.now()) {
    const retryAfter = Math.ceil((attemptState.blockedUntil - Date.now()) / 1000);
    res.setHeader('Retry-After', String(retryAfter));
    return res.status(429).json({ error: 'Terlalu banyak percobaan masuk. Coba lagi beberapa menit.' });
  }

  try {
    const user = appUsers.get(username.trim().toLowerCase());
    const passwordMatches = await bcrypt.compare(password, user?.passwordHash || dummyPasswordHash);
    if (!user || !passwordMatches) {
      const state = registerFailedLogin(attemptKey);
      if (state.blockedUntil > Date.now()) {
        res.setHeader('Retry-After', String(Math.ceil((state.blockedUntil - Date.now()) / 1000)));
        return res.status(429).json({ error: 'Terlalu banyak percobaan masuk. Coba lagi beberapa menit.' });
      }
      return res.status(401).json({ error: 'Username atau password salah.' });
    }

    failedLoginAttempts.delete(attemptKey);
    const session = await getIronSession(req, res, sessionOptions);
    session.username = user.username;
    session.passwordFingerprint = user.passwordFingerprint;
    await session.save();
    res.setHeader('Cache-Control', 'no-store');
    return res.json({ authenticated: true });
  } catch (error) {
    return next(error);
  }
});

app.post('/api/auth/logout', requireAuthentication, (req, res) => {
  req.authSession.destroy();
  return res.status(204).end();
});

app.use('/api', requireAuthentication);
app.use(requireAuthentication);
app.use(express.static(publicDirectory, {
  setHeaders(res) {
    res.setHeader('Cache-Control', 'no-store');
  },
}));

app.get('/api/router-settings', isLocalAdminRequest, (req, res) => {
  return res.json({ settings: getPublicRouterSettings() });
});

app.get('/api/mikrotik-connection', isLocalAdminRequest, (req, res) => {
  return res.json({ connected: routerConnectionEnabled });
});

app.post('/api/mikrotik-connection/disconnect', isLocalAdminRequest, (req, res) => {
  routerConnectionEnabled = false;
  activeHotspotSampler.reset();
  hotspotTrafficSampler.reset();
  return res.json({
    connected: false,
    message: 'Koneksi MikroTik diputuskan oleh aplikasi.',
  });
});

app.post('/api/mikrotik-connection/connect', isLocalAdminRequest, async (req, res) => {
  try {
    await readHotspotProfiles();
  } catch (error) {
    return sendRouterError(res, error);
  }

  routerConnectionEnabled = true;
  activeHotspotSampler.reset();
  hotspotTrafficSampler.reset();
  return res.json({
    connected: true,
    message: 'Koneksi MikroTik berhasil aktif kembali.',
  });
});

app.post('/api/router-settings', isLocalAdminRequest, async (req, res) => {
  const { host, protocol, port, username, password } = req.body ?? {};
  if (
    typeof host !== 'string'
    || typeof protocol !== 'string'
    || (typeof port !== 'string' && typeof port !== 'number')
    || typeof username !== 'string'
    || (password !== undefined && typeof password !== 'string')
  ) {
    return res.status(400).json({ error: 'Lengkapi alamat, protocol, port, dan username API MikroTik.' });
  }

  let candidateConfig;
  try {
    candidateConfig = makeRouterConfig({
      host,
      protocol,
      port,
      username,
      password: password ? password : routerConfig.password,
    });
  } catch (error) {
    return res.status(400).json({ error: error.message });
  }

  let profiles;
  try {
    profiles = await readHotspotProfiles(candidateConfig);
  } catch (error) {
    return sendRouterError(res, error);
  }

  try {
    await persistRouterConfig(candidateConfig);
  } catch (error) {
    console.error(`Unable to save MikroTik settings: ${error.message}`);
    return res.status(500).json({ error: 'Koneksi berhasil, tetapi pengaturan tidak dapat disimpan ke .env.' });
  }

  routerConfig = candidateConfig;
  routerConnectionEnabled = true;
  activeHotspotSampler.reset();
  hotspotTrafficSampler.reset();
  updateProcessEnvironment(candidateConfig);
  return res.json({
    message: 'Koneksi MikroTik berhasil diuji dan pengaturan telah disimpan.',
    profiles,
    settings: getPublicRouterSettings(candidateConfig),
  });
});

app.get('/api/hotspot-profiles', requireRouterConnection, async (req, res) => {
  try {
    return res.json({ profiles: await readHotspotProfiles() });
  } catch (error) {
    return sendRouterError(res, error);
  }
});

app.get('/api/hotspot-active-count', requireRouterConnection, async (req, res) => {
  try {
    return res.json(await readActiveHotspotCount());
  } catch (error) {
    return sendRouterError(res, error);
  }
});

app.get('/api/hotspot-active-usage', isLocalAdminRequest, requireRouterConnection, async (req, res) => {
  try {
    return res.json(await readActiveHotspotUsage());
  } catch (error) {
    return sendRouterError(res, error);
  }
});

app.get('/api/hotspot-active-summary', isLocalAdminRequest, requireRouterConnection, async (req, res) => {
  try {
    return res.json(await readActiveHotspotSummary());
  } catch (error) {
    return sendRouterError(res, error);
  }
});

app.post('/api/hotspot-users', requireRouterConnection, async (req, res) => {
  const { username, password, profile } = req.body ?? {};
  if (
    typeof username !== 'string'
    || typeof password !== 'string'
    || typeof profile !== 'string'
    || username.trim().length < 1
    || username.trim().length > 64
    || password.length < 1
    || password.length > 128
    || /[\u0000-\u001f\u007f]/.test(username)
    || /[\u0000-\u001f\u007f]/.test(password)
    || profile.trim().length < 1
    || profile.length > 255
    || /[\u0000-\u001f\u007f]/.test(profile)
  ) {
    return res.status(400).json({ error: 'Username, password, atau profile tidak valid.' });
  }

  try {
    const profiles = await readHotspotProfiles();
    if (!profiles.includes(profile)) {
      return res.status(400).json({ error: 'Profile tidak tersedia di MikroTik. Muat ulang pilihan profile.' });
    }

    await routerRequest('ip/hotspot/user', {
      method: 'PUT',
      body: {
        name: username.trim(),
        password,
        profile,
      },
    });
    return res.status(201).json({ message: 'User Hotspot berhasil dibuat.' });
  } catch (error) {
    return sendRouterError(res, error);
  }
});

app.use((error, req, res, next) => {
  if (error.type === 'entity.parse.failed') {
    return res.status(400).json({ error: 'Format JSON tidak valid.' });
  }
  if (error.type === 'entity.too.large') {
    return res.status(413).json({ error: 'Permintaan terlalu besar.' });
  }
  console.error(`Request failed: ${error.message}`);
  return res.status(500).json({ error: 'Terjadi kesalahan pada server.' });
});

app.listen(appPort, appHost, () => {
  console.log(`Web app running at http://${appHost}:${appPort}`);
});
