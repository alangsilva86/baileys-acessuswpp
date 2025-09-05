/**
 * Baileys HTTP Service — robust, extensible, production‑ready.
 * - CommonJS (Node 18+)
 * - Structured logging (pino)
 * - Auth via x-api-key (constant-time compare)
 * - Graceful reconnect with backoff
 * - Webhook relay (optional) with HMAC signature
 * - Input validation + JID resolution via onWhatsApp
 * - Message delivery status tracking
 * - Group utilities and basic image send
 *
 * Endpoints (all JSON):
 *  GET  /health
 *  GET  /qr
 *  GET  /whoami
 *  GET  /status?id=MSG_ID
 *  GET  /groups        (auth)
 *  POST /pair          (auth) { phoneNumber }
 *  POST /exists        (auth) { to }
 *  POST /send-text     (auth) { to, message }
 *  POST /send-image    (auth) { to, url, caption? }
 *  POST /send-group    (auth) { groupId, message }
 *  POST /send-me       (auth) { message }
 */

require('dotenv').config();

const express = require('express');
const crypto = require('crypto');
const pino = require('pino');
const QRCode = require('qrcode');

const {
  default: makeWASocket,
  useMultiFileAuthState,
  fetchLatestBaileysVersion,
  DisconnectReason
} = require('@whiskeysockets/baileys');

// Aguardadores de ACK por messageId
const ackWaiters = new Map(); // mid -> {resolve, timer}

function waitForAck(messageId, timeoutMs = 10000) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      ackWaiters.delete(messageId);
      resolve(null); // timeout, sem ACK
    }, timeoutMs);
    ackWaiters.set(messageId, { resolve, timer });
  });
}

// --------------------------- Configuration ---------------------------

const PORT = Number(process.env.PORT || 3000);
const API_KEYS = String(process.env.API_KEY || 'change-me')
  .split(',')
  .map(s => s.trim())
  .filter(Boolean);
const SESSION_DIR = process.env.SESSION_DIR || './sessions';
const LOG_LEVEL = process.env.LOG_LEVEL || 'info';
const WEBHOOK_URL = process.env.WEBHOOK_URL || ''; // optional
const SERVICE_NAME = process.env.SERVICE_NAME || 'baileys-api';

// Hard caps / defaults
const SEND_TIMEOUT_MS = 25_000; // network send timeout safeguard
const RECONNECT_MIN_DELAY_MS = 1_000;
const RECONNECT_MAX_DELAY_MS = 30_000;

// Very lightweight burst control (global): up to N sends per WINDOW_MS
const RATE_MAX_SENDS = Number(process.env.RATE_MAX_SENDS || 20);
const RATE_WINDOW_MS = Number(process.env.RATE_WINDOW_MS || 15_000);

// Basic input sanity
const E164_BRAZIL = /^55\d{10,11}$/; // 55 + DDD + 8..9 digits (landline/cell)

// ----------------------------- Logger --------------------------------

const logger = pino({
  level: LOG_LEVEL,
  base: { service: SERVICE_NAME }
});

// ---------------------------- App setup ------------------------------

const app = express();
app.use(express.json({ limit: '1mb' }));

// Simple request logging with request id
app.use((req, res, next) => {
  req.id = crypto.randomUUID();
  const start = Date.now();
  logger.info({ reqId: req.id, method: req.method, url: req.url }, 'request.start');
  res.on('finish', () => {
    logger.info({
      reqId: req.id,
      method: req.method,
      url: req.url,
      statusCode: res.statusCode,
      ms: Date.now() - start
    }, 'request.end');
  });
  next();
});

// --------------------------- Auth & Utils ----------------------------

/** constant-time comparison to mitigate timing attacks */
function safeEquals(a, b) {
  const bufA = Buffer.from(String(a));
  const bufB = Buffer.from(String(b));
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

function isAuthorized(req) {
  const key = req.header('x-api-key') || '';
  return API_KEYS.some(k => safeEquals(k, key));
}

function auth(req, res, next) {
  if (!isAuthorized(req)) {
    return res.status(401).json({ error: 'unauthorized' });
  }
  next();
}

/** Wrap async handlers to bubble errors to Express */
function asyncHandler(fn) {
  return (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
}

/** Minimal phone sanitizer for BR E.164 (digits only) */
function normalizeToE164BR(val) {
  const digits = String(val || '').replace(/\D+/g, '');
  if (digits.startsWith('55') && E164_BRAZIL.test(digits)) return digits;
  // Heuristics: if user passed DDD+NUM (11/10 digits), prefix 55
  if (/^\d{10,11}$/.test(digits)) return `55${digits}`;
  return null;
}

/** Build HMAC-SHA256 signature for webhook payload */
function buildSignature(payload, secret) {
  const h = crypto.createHmac('sha256', String(secret));
  h.update(payload);
  return `sha256=${h.digest('hex')}`;
}

// --------------------------- WhatsApp Socket -------------------------

let sock = null;
let lastQR = null;
let reconnectDelay = RECONNECT_MIN_DELAY_MS;
let stopping = false;

// Track message delivery state in memory
const statusMap = new Map(); // mid -> status (1 server, 2 delivered, 3 read)

// Create and start socket
async function startSocket() {
  const { state, saveCreds } = await useMultiFileAuthState(SESSION_DIR);
  const { version } = await fetchLatestBaileysVersion();
  logger.info({ version }, 'baileys.version');

  sock = makeWASocket({
    version,
    auth: state,
    logger
  });

  // Persist credentials
  sock.ev.on('creds.update', saveCreds);

  // Connection lifecycle
  sock.ev.on('connection.update', (update) => {
    const { connection, lastDisconnect, qr, receivedPendingNotifications } = update;

    if (qr) {
      lastQR = qr;
      logger.info('QR atualizado; acesse /qr para escanear.');
    }

    if (connection === 'open') {
      lastQR = null;
      reconnectDelay = RECONNECT_MIN_DELAY_MS; // reset backoff
      logger.info({ receivedPendingNotifications }, 'whatsapp.connected');
    }

    if (connection === 'close') {
      const statusCode = lastDisconnect?.error?.output?.statusCode;
      const isLoggedOut = statusCode === DisconnectReason.loggedOut;
      logger.warn({ statusCode }, 'whatsapp.disconnected');

      if (!stopping && !isLoggedOut) {
        const delay = Math.min(reconnectDelay, RECONNECT_MAX_DELAY_MS);
        logger.warn({ delay }, 'whatsapp.reconnect.scheduled');
        setTimeout(() => {
          reconnectDelay = Math.min(reconnectDelay * 2, RECONNECT_MAX_DELAY_MS);
          startSocket().catch(err => logger.error({ err }, 'whatsapp.reconnect.failed'));
        }, delay);
      } else if (isLoggedOut) {
        logger.error('Sessão deslogada. Remova a pasta de sessão para parear novamente.');
      }
    }
  });

  // Message receive
  sock.ev.on('messages.upsert', async (evt) => {
    logger.info({ type: evt.type, count: evt.messages?.length || 0 }, 'messages.upsert');

    // Optional webhook relay
    if (WEBHOOK_URL && evt?.messages?.length) {
      try {
        const body = JSON.stringify(evt);
        const sig = buildSignature(body, API_KEYS[0] || 'change-me');
        await fetch(WEBHOOK_URL, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-Signature-256': sig
          },
          body
        }).catch(() => {}); // swallow network errors here
      } catch (e) {
        logger.warn({ err: e?.message }, 'webhook.relay.error');
      }
    }
  });

  // Delivery acks
  sock.ev.on('messages.update', (updates) => {
    for (const u of updates) {
      const mid = u.key?.id;
      const st = u.update?.status;
      if (mid && st != null) {
        statusMap.set(mid, st); // 1,2,3
        const waiter = ackWaiters.get(mid);
        if (waiter) {
          clearTimeout(waiter.timer);
          ackWaiters.delete(mid);
          waiter.resolve(st); // resolve pending waiters
        }
      }
      logger.info({ mid, status: st }, 'messages.status');
    }
  });

  return sock;
}

// ------------------------------ Routes --------------------------------

app.get('/health', (req, res) => res.json({ ok: true, service: SERVICE_NAME }));

app.get('/qr', asyncHandler(async (req, res) => {
  if (!lastQR) return res.status(404).send('QR não disponível. Talvez já esteja conectado.');
  const dataUrl = await QRCode.toDataURL(lastQR);
  res.type('html').send(`
    <html><body>
      <h3>Escaneie este QR no WhatsApp (Aparelhos Conectados)</h3>
      <img alt="QR" src="${dataUrl}" />
    </body></html>
  `);
}));

app.get('/whoami', (req, res) => {
  if (!sock || !sock.user) return res.status(503).json({ error: 'socket indisponível' });
  res.json({ user: sock.user });
});

app.get('/status', auth, (req, res) => {
  const id = String(req.query.id || '');
  if (!id) return res.status(400).json({ error: 'id obrigatório' });
  const status = statusMap.get(id) ?? null;
  res.json({ id, status }); // 1=server, 2=delivered, 3=read
});

app.get('/groups', auth, asyncHandler(async (req, res) => {
  if (!sock) return res.status(503).json({ error: 'socket indisponível' });
  const all = await sock.groupFetchAllParticipating();
  const list = Object.values(all).map(g => ({ id: g.id, subject: g.subject }));
  res.json(list);
}));

app.post('/pair', auth, asyncHandler(async (req, res) => {
  const phoneNumberRaw = req.body?.phoneNumber;
  if (!phoneNumberRaw) return res.status(400).json({ error: 'phoneNumber obrigatório (ex: 5544...)' });
  if (!sock) return res.status(503).json({ error: 'socket indisponível' });
  const code = await sock.requestPairingCode(String(phoneNumberRaw));
  res.json({ pairingCode: code });
}));

app.post('/exists', auth, asyncHandler(async (req, res) => {
  if (!sock) return res.status(503).json({ error: 'socket indisponível' });
  const normalized = normalizeToE164BR(req.body?.to);
  if (!normalized) return res.status(400).json({ error: 'to inválido. Use E.164: 55DDDNUMERO' });
  const results = await sock.onWhatsApp(normalized);
  res.json({ results });
}));

// Basic global rate limiter using sliding window timestamps
const sendTimestamps = [];
function allowSend() {
  const now = Date.now();
  // Remove timestamps older than window
  while (sendTimestamps.length && now - sendTimestamps[0] > RATE_WINDOW_MS) sendTimestamps.shift();
  if (sendTimestamps.length >= RATE_MAX_SENDS) return false;
  sendTimestamps.push(now);
  return true;
}

async function sendWithTimeout(jid, content) {
  return await Promise.race([
    sock.sendMessage(jid, content),
    new Promise((_, reject) => setTimeout(() => reject(new Error('send timeout')), SEND_TIMEOUT_MS))
  ]);
}

app.post('/send-text', auth, asyncHandler(async (req, res) => {
  if (!sock) return res.status(503).json({ error: 'socket indisponível' });
  if (!allowSend()) return res.status(429).json({ error: 'rate limit exceeded' });

  const { to, message, waitAckMs } = req.body || {};
  if (!to || !message) return res.status(400).json({ error: 'parâmetros to e message são obrigatórios' });

  // Resolve JID via onWhatsApp
  const normalized = normalizeToE164BR(to);
  if (!normalized) return res.status(400).json({ error: 'to inválido. Use E.164: 55DDDNUMERO' });
  const check = await sock.onWhatsApp(normalized);
  const entry = Array.isArray(check) ? check[0] : null;
  if (!entry || !entry.exists) return res.status(404).json({ error: 'número não está no WhatsApp', to: normalized });

  const jid = entry.jid;
  const result = await sendWithTimeout(jid, { text: String(message) });
  const id = result?.key?.id || null;

  let status = null;
  const ms = Number(waitAckMs || 0);
  if (id && ms > 0) {
    status = await waitForAck(id, Math.min(ms, 20000)); // 20s cap
  }

  res.json({ ok: true, id, to: jid, status });
}));

app.post('/send-image', auth, asyncHandler(async (req, res) => {
  if (!sock) return res.status(503).json({ error: 'socket indisponível' });
  if (!allowSend()) return res.status(429).json({ error: 'rate limit exceeded' });

  const { to, url, caption } = req.body || {};
  if (!to || !url) return res.status(400).json({ error: 'to e url são obrigatórios' });

  const normalized = normalizeToE164BR(to);
  if (!normalized) return res.status(400).json({ error: 'to inválido. Use E.164: 55DDDNUMERO' });
  const check = await sock.onWhatsApp(normalized);
  const entry = Array.isArray(check) ? check[0] : null;
  if (!entry || !entry.exists) return res.status(404).json({ error: 'número não está no WhatsApp', to: normalized });

  const jid = entry.jid;
  const result = await sendWithTimeout(jid, { image: { url: String(url) }, caption: caption ? String(caption) : undefined });
  const id = result?.key?.id || null;
  let status = null;
  const ms = Number(req.body?.waitAckMs || 0);
  if (id && ms > 0) status = await waitForAck(id, Math.min(ms, 20000));
  res.json({ ok: true, id, to: jid, status });
}));

app.post('/send-group', auth, asyncHandler(async (req, res) => {
  if (!sock) return res.status(503).json({ error: 'socket indisponível' });
  if (!allowSend()) return res.status(429).json({ error: 'rate limit exceeded' });

  const { groupId, message } = req.body || {};
  if (!groupId || !message) return res.status(400).json({ error: 'groupId e message são obrigatórios' });

  const result = await sendWithTimeout(String(groupId), { text: String(message) });
  const id = result?.key?.id || null;
  let status = null;
  const ms = Number(req.body?.waitAckMs || 0);
  if (id && ms > 0) status = await waitForAck(id, Math.min(ms, 20000));
  res.json({ ok: true, id, to: String(groupId), status });
}));

app.post('/send-me', auth, asyncHandler(async (req, res) => {
  if (!sock || !sock.user?.id) return res.status(503).json({ error: 'socket indisponível' });
  if (!allowSend()) return res.status(429).json({ error: 'rate limit exceeded' });

  const message = req.body?.message;
  if (!message) return res.status(400).json({ error: 'message obrigatório' });

  const result = await sendWithTimeout(sock.user.id, { text: String(message) });
  const id = result?.key?.id || null;
  let status = null;
  const ms = Number(req.body?.waitAckMs || 0);
  if (id && ms > 0) status = await waitForAck(id, Math.min(ms, 20000));
  res.json({ ok: true, id, to: sock.user.id, status });
}));

// --------------------------- Logout ---------------------------
app.post('/logout', auth, asyncHandler(async (req, res) => {
  if (!sock) return res.status(503).json({ error: 'socket indisponível' });

  try {
    await sock.logout(); // força logout no WhatsApp
    res.json({ ok: true, message: 'Sessão desconectada. Escaneie um novo QR em /qr' });
  } catch (e) {
    res.status(500).json({ error: 'falha ao desconectar', detail: e.message });
  }
}));

// --------------------------- Error handling ---------------------------

app.use((err, req, res, next) => {
  logger.error({ reqId: req?.id, err: err?.message, stack: err?.stack }, 'unhandled.error');
  if (res.headersSent) return next(err);
  res.status(500).json({ error: 'internal_error', detail: err?.message || 'unknown' });
});

// --------------------------- Boot & shutdown --------------------------

let server;

startSocket()
  .then(() => {
    server = app.listen(PORT, () => logger.info({ port: PORT }, 'http.started'));
  })
  .catch(err => {
    logger.error({ err }, 'socket.start.failed');
    process.exit(1);
  });

async function shutdown(signal) {
  try {
    stopping = true;
    logger.warn({ signal }, 'shutdown.begin');
    server && server.close();
    // give Baileys a moment to flush events
    setTimeout(() => process.exit(0), 500);
  } catch (e) {
    logger.error({ err: e?.message }, 'shutdown.error');
    process.exit(1);
  }
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
