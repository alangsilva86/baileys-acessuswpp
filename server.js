/**
 * Baileys HTTP Service + Dashboard
 * - Node 18+, CommonJS
 * - Pino logs, x-api-key, reconexão com backoff
 * - Webhook (opcional), onWhatsApp, tracking de status
 * - Envio: texto, imagem, grupo, quick-reply buttons
 * - Dashboard em "/": status, QR, métricas + gráfico, ações
 */

require('dotenv').config();

const express = require('express');
const crypto = require('crypto');
const pino = require('pino');
const QRCode = require('qrcode');
const fs = require('fs/promises');

const {
  default: makeWASocket,
  useMultiFileAuthState,
  fetchLatestBaileysVersion,
  DisconnectReason
} = require('@whiskeysockets/baileys');

// --------------------------- Config ---------------------------
const PORT = Number(process.env.PORT || 3000);
const API_KEYS = String(process.env.API_KEY || 'change-me')
  .split(',')
  .map(s => s.trim())
  .filter(Boolean);
const SESSION_DIR = process.env.SESSION_DIR || './sessions';
const LOG_LEVEL = process.env.LOG_LEVEL || 'info';
const WEBHOOK_URL = process.env.WEBHOOK_URL || '';
const SERVICE_NAME = process.env.SERVICE_NAME || 'baileys-api';

const SEND_TIMEOUT_MS = 25_000;
const RECONNECT_MIN_DELAY_MS = 1_000;
const RECONNECT_MAX_DELAY_MS = 30_000;

const RATE_MAX_SENDS = Number(process.env.RATE_MAX_SENDS || 20);
const RATE_WINDOW_MS = Number(process.env.RATE_WINDOW_MS || 15_000);
const E164_BRAZIL = /^55\d{10,11}$/;

// --------------------------- Logger ---------------------------
const logger = pino({ level: LOG_LEVEL, base: { service: SERVICE_NAME } });

// --------------------------- App ------------------------------
const app = express();
app.use(express.json({ limit: '1mb' }));

// Log simples por requisição
app.use((req, res, next) => {
  req.id = crypto.randomUUID();
  const start = Date.now();
  logger.info({ reqId: req.id, method: req.method, url: req.url }, 'request.start');
  res.on('finish', () => {
    logger.info({
      reqId: req.id, method: req.method, url: req.url,
      statusCode: res.statusCode, ms: Date.now() - start
    }, 'request.end');
  });
  next();
});

// ---------------------- Auth & Utils --------------------------
function safeEquals(a, b) {
  const A = Buffer.from(String(a));
  const B = Buffer.from(String(b));
  if (A.length !== B.length) return false;
  return crypto.timingSafeEqual(A, B);
}
function isAuthorized(req) {
  const key = req.header('x-api-key') || '';
  return API_KEYS.some(k => safeEquals(k, key));
}
function auth(req, res, next) {
  if (!isAuthorized(req)) return res.status(401).json({ error: 'unauthorized' });
  next();
}
const asyncHandler = fn => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

function normalizeToE164BR(val) {
  const digits = String(val || '').replace(/\D+/g, '');
  if (digits.startsWith('55') && E164_BRAZIL.test(digits)) return digits;
  if (/^\d{10,11}$/.test(digits)) return `55${digits}`;
  return null;
}
function buildSignature(payload, secret) {
  const h = crypto.createHmac('sha256', String(secret));
  h.update(payload);
  return `sha256=${h.digest('hex')}`;
}

// --------------------------- Métricas --------------------------
const metrics = {
  startedAt: Date.now(),
  sent: 0,
  sent_by_type: { text: 0, image: 0, group: 0, buttons: 0 },
  status_counts: { "1": 0, "2": 0, "3": 0, "4": 0 },
  last: { sentId: null, lastStatusId: null, lastStatusCode: null }
};

// ACK waiters (aguarda status até N ms)
const ackWaiters = new Map(); // mid -> {resolve, timer}
function waitForAck(messageId, timeoutMs = 10000) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      ackWaiters.delete(messageId);
      resolve(null);
    }, timeoutMs);
    ackWaiters.set(messageId, { resolve, timer });
  });
}

// ----------------------- WhatsApp Socket ----------------------
let sock = null;
let lastQR = null;
let reconnectDelay = RECONNECT_MIN_DELAY_MS;
let stopping = false;

const statusMap = new Map(); // mid -> status

async function startSocket() {
  const { state, saveCreds } = await useMultiFileAuthState(SESSION_DIR);
  const { version } = await fetchLatestBaileysVersion();
  logger.info({ version }, 'baileys.version');

  sock = makeWASocket({ version, auth: state, logger });
  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', (update) => {
    const { connection, lastDisconnect, qr, receivedPendingNotifications } = update;

    if (qr) {
      lastQR = qr;
      logger.info('QR atualizado; acesse /qr para escanear.');
    }
    if (connection === 'open') {
      lastQR = null;
      reconnectDelay = RECONNECT_MIN_DELAY_MS;
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
        logger.error('Sessão deslogada. Limpe a pasta de sessão para parear novamente.');
      }
    }
  });

  sock.ev.on('messages.upsert', async (evt) => {
    const count = evt.messages?.length || 0;
    logger.info({ type: evt.type, count }, 'messages.upsert');

    // Captura clique em quick replies
    if (count) {
      for (const m of evt.messages) {
        const btn = m.message?.templateButtonReplyMessage || m.message?.buttonsResponseMessage;
        if (btn) {
          logger.info({
            from: m.key?.remoteJid,
            selectedId: btn?.selectedId || btn?.selectedButtonId,
            selectedText: btn?.selectedDisplayText
          }, 'button.reply');
        }
      }
    }

    // Webhook opcional
    if (WEBHOOK_URL && count) {
      try {
        const body = JSON.stringify(evt);
        const sig = buildSignature(body, API_KEYS[0] || 'change-me');
        await fetch(WEBHOOK_URL, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-Signature-256': sig },
          body
        }).catch(() => {});
      } catch (e) {
        logger.warn({ err: e?.message }, 'webhook.relay.error');
      }
    }
  });

  sock.ev.on('messages.update', (updates) => {
    for (const u of updates) {
      const mid = u.key?.id;
      const st = u.update?.status;
      if (mid && st != null) {
        statusMap.set(mid, st);
        metrics.status_counts[String(st)] = (metrics.status_counts[String(st)] || 0) + 1;
        metrics.last.lastStatusId = mid;
        metrics.last.lastStatusCode = st;

        const waiter = ackWaiters.get(mid);
        if (waiter) {
          clearTimeout(waiter.timer);
          ackWaiters.delete(mid);
          waiter.resolve(st);
        }
      }
      logger.info({ mid, status: st }, 'messages.status');
    }
  });

  return sock;
}

// --------------------------- Rate Limit -----------------------
const sendTimestamps = [];
function allowSend() {
  const now = Date.now();
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

// --------------------------- Dashboard ------------------------
app.get('/', (req, res) => {
  res.type('html').send(`<!doctype html>
<html lang="pt-br">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width,initial-scale=1" />
  <title>Baileys API — Dashboard</title>
  <script src="https://cdn.tailwindcss.com"></script>
  <script src="https://cdn.jsdelivr.net/npm/chart.js"></script>
</head>
<body class="bg-slate-50 text-slate-800">
  <div class="max-w-6xl mx-auto p-6 space-y-6">
    <header class="flex items-center justify-between">
      <h1 class="text-2xl font-bold">Baileys API — Dashboard</h1>
      <span id="badge" class="px-3 py-1 rounded-full text-sm bg-slate-200">—</span>
    </header>

    <section class="grid md:grid-cols-3 gap-4">
      <div class="p-4 bg-white rounded-2xl shadow">
        <div class="text-sm text-slate-500">Conexão</div>
        <div id="whoami" class="mt-1 font-medium">—</div>
      </div>
      <div class="p-4 bg-white rounded-2xl shadow">
        <div class="text-sm text-slate-500">Mensagens enviadas</div>
        <div id="sent" class="mt-1 text-2xl font-semibold">0</div>
      </div>
      <div class="p-4 bg-white rounded-2xl shadow">
        <div class="text-sm text-slate-500">Status (2=entregue, 3=lida)</div>
        <div class="mt-1">
          <span class="mr-4">2: <b id="st2">0</b></span>
          <span class="mr-4">3: <b id="st3">0</b></span>
          <span class="mr-4">1: <b id="st1">0</b></span>
          <span>4: <b id="st4">0</b></span>
        </div>
      </div>
    </section>

    <section class="grid md:grid-cols-3 gap-6">
      <div class="p-4 bg-white rounded-2xl shadow">
        <h2 class="font-semibold mb-2">QR Code</h2>
        <div id="qrWrap" class="border rounded-xl p-3 text-center">
          <img id="qrImg" alt="QR" class="mx-auto hidden" />
          <div id="qrHint" class="text-sm text-slate-500">Se estiver desconectado, o QR aparece aqui.</div>
        </div>
        <div class="mt-3 flex gap-2">
          <button id="btnLogout" class="px-3 py-2 bg-amber-600 hover:bg-amber-700 text-white rounded-lg">Desconectar</button>
          <button id="btnWipe" class="px-3 py-2 bg-rose-600 hover:bg-rose-700 text-white rounded-lg">Limpar sessão</button>
        </div>
      </div>

      <div class="p-4 bg-white rounded-2xl shadow md:col-span-2">
        <h2 class="font-semibold mb-2">Gráfico — enviados vs status</h2>
        <div class="relative w-full h-64 md:h-80 xl:h-96 overflow-hidden">
          <canvas id="metricsChart" class="absolute inset-0 w-full h-full"></canvas>
        </div>
      </div>
    </section>

    <section class="p-4 bg-white rounded-2xl shadow">
      <h2 class="font-semibold mb-3">Teste rápido de envio</h2>
      <div class="grid md:grid-cols-2 gap-3">
        <input id="inpPhone" placeholder="Ex: 5544999999999" class="border rounded-lg px-3 py-2" />
        <input id="inpMsg" placeholder="Mensagem" class="border rounded-lg px-3 py-2" />
      </div>
      <div class="mt-3 flex items-center gap-2">
        <input id="inpApiKey" placeholder="x-api-key" class="border rounded-lg px-3 py-2 flex-1" />
        <button id="btnSend" class="px-3 py-2 bg-emerald-600 hover:bg-emerald-700 text-white rounded-lg">Enviar texto</button>
      </div>
      <div id="sendOut" class="text-sm text-slate-500 mt-2"></div>
    </section>

    <footer class="text-xs text-slate-400 pt-4">© ${SERVICE_NAME}</footer>
  </div>

<script>
const els = {
  badge: document.getElementById('badge'),
  whoami: document.getElementById('whoami'),
  sent: document.getElementById('sent'),
  st1: document.getElementById('st1'),
  st2: document.getElementById('st2'),
  st3: document.getElementById('st3'),
  st4: document.getElementById('st4'),
  qrImg: document.getElementById('qrImg'),
  qrHint: document.getElementById('qrHint'),
  btnLogout: document.getElementById('btnLogout'),
  btnWipe: document.getElementById('btnWipe'),
  inpApiKey: document.getElementById('inpApiKey'),
  inpPhone: document.getElementById('inpPhone'),
  inpMsg: document.getElementById('inpMsg'),
  btnSend: document.getElementById('btnSend'),
  sendOut: document.getElementById('sendOut'),
};

els.inpApiKey.value = localStorage.getItem('x_api_key') || '';

let chart;
function initChart() {
  const ctx = document.getElementById('metricsChart').getContext('2d');
  chart = new Chart(ctx, {
    type: window.matchMedia('(max-width: 640px)').matches ? 'bar' : 'line',
    data: {
      labels: ['Enviadas','Status 1','Status 2','Status 3','Status 4'],
      datasets: [{ label: 'Total', data: [0,0,0,0,0] }]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      animation: false,
      interaction: { intersect: false, mode: 'index' },
      scales: {
        x: { ticks: { maxRotation: 0, autoSkip: true } },
        y: { beginAtZero: true, grace: '5%' }
      }
    }
  });
}
initChart();

async function fetchJSON(path, auth=true) {
  const headers = { 'Content-Type': 'application/json' };
  if (auth) {
    const k = els.inpApiKey.value.trim();
    if (k) headers['x-api-key'] = k;
  }
  const r = await fetch(path, { headers, cache: 'no-store' });
  if (!r.ok) throw new Error('HTTP ' + r.status);
  try { return await r.json(); } catch { return {}; }
}

let lastRender = 0;
function safeUpdateChart() {
  const now = Date.now();
  if (now - lastRender < 2000) return; // no máx a cada 2s
  lastRender = now;
  chart.update('none');
}

async function refresh() {
  try {
    const m = await fetchJSON('/metrics', true);
    const connected = !!m.connected;

    els.badge.textContent = connected ? 'Conectado' : 'Desconectado';
    els.badge.className = 'px-3 py-1 rounded-full text-sm ' + (connected ? 'bg-emerald-100 text-emerald-800' : 'bg-rose-100 text-rose-800');
    els.whoami.textContent = connected && m.user ? (m.user.name ? (m.user.name + ' — ' + m.user.id) : m.user.id) : '—';
    els.sent.textContent = m.counters.sent;
    els.st1.textContent = m.counters.statusCounts['1'] || 0;
    els.st2.textContent = m.counters.statusCounts['2'] || 0;
    els.st3.textContent = m.counters.statusCounts['3'] || 0;
    els.st4.textContent = m.counters.statusCounts['4'] || 0;

    chart.data.datasets[0].data = [
      m.counters.sent,
      m.counters.statusCounts['1']||0,
      m.counters.statusCounts['2']||0,
      m.counters.statusCounts['3']||0,
      m.counters.statusCounts['4']||0
    ];
    safeUpdateChart();

    if (!connected) {
      const r = await fetch('/qr.png', { cache: 'no-store' });
      if (r.ok) {
        const blob = await r.blob();
        els.qrImg.src = URL.createObjectURL(blob);
        els.qrImg.classList.remove('hidden');
        els.qrHint.textContent = 'Abra WhatsApp > Aparelhos conectados > Conectar um aparelho e leia este QR.';
      } else {
        els.qrImg.classList.add('hidden');
        els.qrHint.textContent = 'Sem QR no momento. Aguarde alguns segundos…';
      }
    } else {
      els.qrImg.classList.add('hidden');
      els.qrHint.textContent = 'Conectado — QR oculto.';
    }
  } catch (e) {
    els.badge.textContent = 'Erro';
    els.badge.className = 'px-3 py-1 rounded-full text-sm bg-amber-100 text-amber-800';
  }
}
setInterval(refresh, 3000);
refresh();

els.btnLogout.onclick = async () => {
  try {
    localStorage.setItem('x_api_key', els.inpApiKey.value.trim());
    await fetch('/logout', { method:'POST', headers: { 'x-api-key': els.inpApiKey.value.trim(), 'Content-Type':'application/json' }});
    els.qrHint.textContent = 'Desconectando… o serviço pode reiniciar e exibir um novo QR.';
  } catch {}
};

els.btnWipe.onclick = async () => {
  try {
    localStorage.setItem('x_api_key', els.inpApiKey.value.trim());
    await fetch('/session/wipe', { method:'POST', headers: { 'x-api-key': els.inpApiKey.value.trim(), 'Content-Type':'application/json' }});
    els.qrHint.textContent = 'Limpando sessão… o serviço vai reiniciar e exibir um novo QR.';
  } catch {}
};

els.btnSend.onclick = async () => {
  try {
    localStorage.setItem('x_api_key', els.inpApiKey.value.trim());
    const body = JSON.stringify({ to: els.inpPhone.value.trim(), message: els.inpMsg.value.trim(), waitAckMs: 8000 });
    const r = await fetch('/send-text', { method: 'POST', headers: { 'x-api-key': els.inpApiKey.value.trim(), 'Content-Type':'application/json' }, body });
    const j = await r.json();
    els.sendOut.textContent = 'Resposta: ' + JSON.stringify(j);
  } catch (e) {
    els.sendOut.textContent = 'Falha no envio: ' + e.message;
  }
};
</script>
</body>
</html>`);
});

// --------------------------- Endpoints API --------------------
app.get('/health', (req, res) => res.json({ ok: true, service: SERVICE_NAME }));

app.get('/qr', asyncHandler(async (req, res) => {
  if (!lastQR) return res.status(404).send('QR não disponível. Talvez já esteja conectado.');
  const dataUrl = await QRCode.toDataURL(lastQR);
  res.type('html').send(`<html><body><h3>Escaneie este QR no WhatsApp</h3><img alt="QR" src="${dataUrl}" /></body></html>`);
}));
app.get('/qr.png', asyncHandler(async (req, res) => {
  if (!lastQR) return res.status(404).send('no-qr');
  const png = await QRCode.toBuffer(lastQR, { type: 'png', margin: 1, scale: 6 });
  res.type('png').send(png);
}));

app.get('/whoami', (req, res) => {
  if (!sock || !sock.user) return res.status(503).json({ error: 'socket indisponível' });
  res.json({ user: sock.user });
});

app.get('/status', auth, (req, res) => {
  const id = String(req.query.id || '');
  if (!id) return res.status(400).json({ error: 'id obrigatório' });
  const status = statusMap.get(id) ?? null;
  res.json({ id, status });
});

app.get('/groups', auth, asyncHandler(async (req, res) => {
  if (!sock) return res.status(503).json({ error: 'socket indisponível' });
  const all = await sock.groupFetchAllParticipating();
  const list = Object.values(all).map(g => ({ id: g.id, subject: g.subject }));
  res.json(list);
}));

app.get('/metrics', auth, (req, res) => {
  const connected = !!(sock && sock.user);
  res.json({
    service: SERVICE_NAME,
    connected,
    user: connected ? sock.user : null,
    startedAt: metrics.startedAt,
    counters: {
      sent: metrics.sent,
      byType: metrics.sent_by_type,
      statusCounts: metrics.status_counts
    },
    last: metrics.last
  });
});

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

app.post('/send-text', auth, asyncHandler(async (req, res) => {
  if (!sock) return res.status(503).json({ error: 'socket indisponível' });
  if (!allowSend()) return res.status(429).json({ error: 'rate limit exceeded' });

  const { to, message, waitAckMs } = req.body || {};
  if (!to || !message) return res.status(400).json({ error: 'parâmetros to e message são obrigatórios' });

  const normalized = normalizeToE164BR(to);
  if (!normalized) return res.status(400).json({ error: 'to inválido. Use E.164: 55DDDNUMERO' });

  const check = await sock.onWhatsApp(normalized);
  const entry = Array.isArray(check) ? check[0] : null;
  if (!entry || !entry.exists) return res.status(404).json({ error: 'número não está no WhatsApp', to: normalized });

  const jid = entry.jid;
  const result = await sendWithTimeout(jid, { text: String(message) });
  const id = result?.key?.id || null;

  metrics.sent++; metrics.sent_by_type.text++; metrics.last.sentId = id;

  let status = null;
  const ms = Number(waitAckMs || 0);
  if (id && ms > 0) status = await waitForAck(id, Math.min(ms, 20000));

  res.json({ ok: true, id, to: jid, status });
}));

app.post('/send-image', auth, asyncHandler(async (req, res) => {
  if (!sock) return res.status(503).json({ error: 'socket indisponível' });
  if (!allowSend()) return res.status(429).json({ error: 'rate limit exceeded' });

  const { to, url, caption, waitAckMs } = req.body || {};
  if (!to || !url) return res.status(400).json({ error: 'to e url são obrigatórios' });

  const normalized = normalizeToE164BR(to);
  if (!normalized) return res.status(400).json({ error: 'to inválido. Use E.164: 55DDDNUMERO' });

  const check = await sock.onWhatsApp(normalized);
  const entry = Array.isArray(check) ? check[0] : null;
  if (!entry || !entry.exists) return res.status(404).json({ error: 'número não está no WhatsApp', to: normalized });

  const jid = entry.jid;
  const result = await sendWithTimeout(jid, { image: { url: String(url) }, caption: caption ? String(caption) : undefined });
  const id = result?.key?.id || null;

  metrics.sent++; metrics.sent_by_type.image++; metrics.last.sentId = id;

  let status = null;
  const ms = Number(waitAckMs || 0);
  if (id && ms > 0) status = await waitForAck(id, Math.min(ms, 20000));

  res.json({ ok: true, id, to: jid, status });
}));

app.post('/send-group', auth, asyncHandler(async (req, res) => {
  if (!sock) return res.status(503).json({ error: 'socket indisponível' });
  if (!allowSend()) return res.status(429).json({ error: 'rate limit exceeded' });

  const { groupId, message, waitAckMs } = req.body || {};
  if (!groupId || !message) return res.status(400).json({ error: 'groupId e message são obrigatórios' });

  const result = await sendWithTimeout(String(groupId), { text: String(message) });
  const id = result?.key?.id || null;

  metrics.sent++; metrics.sent_by_type.group++; metrics.last.sentId = id;

  let status = null;
  const ms = Number(waitAckMs || 0);
  if (id && ms > 0) status = await waitForAck(id, Math.min(ms, 20000));

  res.json({ ok: true, id, to: String(groupId), status });
}));

app.post('/send-me', auth, asyncHandler(async (req, res) => {
  if (!sock || !sock.user?.id) return res.status(503).json({ error: 'socket indisponível' });
  if (!allowSend()) return res.status(429).json({ error: 'rate limit exceeded' });

  const { message, waitAckMs } = req.body || {};
  if (!message) return res.status(400).json({ error: 'message obrigatório' });

  const result = await sendWithTimeout(sock.user.id, { text: String(message) });
  const id = result?.key?.id || null;

  metrics.sent++; metrics.last.sentId = id;

  let status = null;
  const ms = Number(waitAckMs || 0);
  if (id && ms > 0) status = await waitForAck(id, Math.min(ms, 20000));

  res.json({ ok: true, id, to: sock.user.id, status });
}));

// Quick-reply buttons (até 3)
app.post('/send-buttons', auth, asyncHandler(async (req, res) => {
  if (!sock) return res.status(503).json({ error: 'socket indisponível' });
  if (!allowSend()) return res.status(429).json({ error: 'rate limit exceeded' });

  const { to, text, buttons, waitAckMs } = req.body || {};
  if (!to || !text || !Array.isArray(buttons) || !buttons.length) {
    return res.status(400).json({ error: 'to, text e buttons[] são obrigatórios' });
  }

  const normalized = normalizeToE164BR(to);
  if (!normalized) return res.status(400).json({ error: 'to inválido. Use E.164: 55DDDNUMERO' });

  const check = await sock.onWhatsApp(normalized);
  const entry = Array.isArray(check) ? check[0] : null;
  if (!entry || !entry.exists) return res.status(404).json({ error: 'número não está no WhatsApp', to: normalized });
  const jid = entry.jid;

  const templateButtons = buttons.slice(0, 3).map((b, i) => ({
    index: i + 1,
    quickReplyButton: { displayText: String(b.text), id: String(b.id) }
  }));

  const result = await sendWithTimeout(jid, { text: String(text), templateButtons });
  const id = result?.key?.id || null;

  metrics.sent++; metrics.sent_by_type.buttons++; metrics.last.sentId = id;

  let status = null;
  const ms = Number(waitAckMs || 0);
  if (id && ms > 0) status = await waitForAck(id, Math.min(ms, 20000));

  res.json({ ok: true, id, to: jid, status });
}));

// --------------------------- Admin ----------------------------
app.post('/logout', auth, asyncHandler(async (req, res) => {
  if (!sock) return res.status(503).json({ error: 'socket indisponível' });
  try {
    await sock.logout();
    res.json({ ok: true, message: 'Sessão desconectada. Um novo QR aparecerá em breve.' });
  } catch (e) {
    res.status(500).json({ error: 'falha ao desconectar', detail: e.message });
  }
}));

app.post('/session/wipe', auth, asyncHandler(async (req, res) => {
  try {
    await fs.rm(SESSION_DIR, { recursive: true, force: true });
    await fs.mkdir(SESSION_DIR, { recursive: true });
    res.json({ ok: true, message: 'Sessão limpa. Reiniciando para gerar novo QR.' });
    setTimeout(() => process.exit(0), 200);
  } catch (e) {
    res.status(500).json({ error: 'falha ao limpar sessão', detail: e.message });
  }
}));

// ---------------------- Error handling ------------------------
app.use((err, req, res, next) => {
  logger.error({ reqId: req?.id, err: err?.message, stack: err?.stack }, 'unhandled.error');
  if (res.headersSent) return next(err);
  res.status(500).json({ error: 'internal_error', detail: err?.message || 'unknown' });
});

// ---------------------- Boot & shutdown -----------------------
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
    setTimeout(() => process.exit(0), 500);
  } catch (e) {
    logger.error({ err: e?.message }, 'shutdown.error');
    process.exit(1);
  }
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
