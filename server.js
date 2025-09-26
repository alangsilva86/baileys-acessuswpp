/**
 * Baileys HTTP Service + Dashboard (Multi-Instância, retrocompatível)
 * - Node 18+, CommonJS
 * - Pino logs, x-api-key, reconexão com backoff
 * - Webhook (opcional), onWhatsApp, tracking de status
 * - Envio: texto, imagem, grupo, quick-reply buttons, list message
 * - Dashboard em "/": status, QR, métricas + gráfico, ações
 * - **NOVO**: Suporte a múltiplas instâncias WhatsApp (sem quebrar rotas antigas)
 *
 * Rotas novas (por instância):
 *   POST   /instances                         -> cria instância
 *   GET    /instances                         -> lista instâncias
 *   GET    /instances/:iid                    -> detalhes
 *   GET    /instances/:iid/qr.png             -> QR
 *   POST   /instances/:iid/pair               -> pairing code
 *   POST   /instances/:iid/logout             -> logout
 *   POST   /instances/:iid/session/wipe       -> wipe + reinício
 *   GET    /instances/:iid/groups             -> grupos
 *   GET    /instances/:iid/status?id=...      -> status de mensagem
 *   GET    /instances/:iid/metrics            -> métricas
 *   POST   /instances/:iid/exists             -> checa número
 *   POST   /instances/:iid/send-text          -> envia texto
 *   POST   /instances/:iid/send-image         -> envia imagem
 *   POST   /instances/:iid/send-group         -> envia texto em grupo
 *   POST   /instances/:iid/send-me            -> envia p/ si mesmo
 *   POST   /instances/:iid/send-buttons       -> buttons com fallback
 *   POST   /instances/:iid/send-list          -> list message com fallback
 *
 * Rotas antigas seguem funcionando usando a instância "default".
 */

require('dotenv').config();

const path = require('path');
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
const SESSIONS_ROOT = process.env.SESSION_DIR || './sessions';
const LOG_LEVEL = process.env.LOG_LEVEL || 'info';
const WEBHOOK_URL = process.env.WEBHOOK_URL || '';
const SERVICE_NAME = process.env.SERVICE_NAME || 'baileys-api';

const SEND_TIMEOUT_MS = 25_000;
const RECONNECT_MIN_DELAY_MS = 1_000;
const RECONNECT_MAX_DELAY_MS = 30_000;

const RATE_MAX_SENDS = Number(process.env.RATE_MAX_SENDS || 20);
const RATE_WINDOW_MS = Number(process.env.RATE_WINDOW_MS || 15_000);
const E164_BRAZIL = /^55\d{10,11}$/;

const INSTANCES_INDEX = path.join(process.cwd(), 'instances.json');

// Métricas avançadas
const METRICS_TIMELINE_MAX = 288; // ~24h com amostragem de 5min
const METRICS_TIMELINE_MIN_INTERVAL_MS = 5 * 60_000; // ignora deltas menores que 5min
const ACK_SAMPLE_MAX_AGE_MS = 5 * 60_000;

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

// --------------------------- Instâncias ---------------------------
/**
 * Estrutura de cada instância:
 * {
 *  id, name, dir,
 *  sock, lastQR, reconnectDelay, stopping,
 *  metrics: { startedAt, sent, sent_by_type, status_counts, last },
 *  statusMap: Map(),
 *  ackWaiters: Map(),
 *  rateWindow: number[]
 * }
 */
const instances = new Map();

async function saveInstancesIndex() {
  const index = [...instances.values()].map(i => ({
    id: i.id,
    name: i.name,
    dir: i.dir,
    metadata: {
      note: i.metadata?.note || i.notes || '',
      createdAt: i.metadata?.createdAt || null,
      updatedAt: i.metadata?.updatedAt || null,
    },
  }));
  try { await fs.writeFile(INSTANCES_INDEX, JSON.stringify(index, null, 2)); } catch {}
}
async function loadInstancesIndex() {
  try {
    const raw = await fs.readFile(INSTANCES_INDEX, 'utf8');
    const list = JSON.parse(raw);
    if (!Array.isArray(list)) return [];
    return list.map(item => ({
      id: item?.id,
      name: item?.name,
      dir: item?.dir,
      metadata: item?.metadata && typeof item.metadata === 'object'
        ? {
            note: typeof item.metadata.note === 'string' ? item.metadata.note : (item?.notes || ''),
            createdAt: item.metadata.createdAt || null,
            updatedAt: item.metadata.updatedAt || null,
          }
        : { note: item?.notes || '', createdAt: null, updatedAt: null },
    })).filter(it => it.id);
  } catch {
    return [];
  }
}

function getInstanceByReq(req) {
  const iid = req.params.iid || req.header('x-instance-id') || 'default';
  const inst = instances.get(iid);
  return { iid, inst };
}

// ------------- Métricas helpers (por instância) ----------------
function allowSend(inst) {
  const now = Date.now();
  while (inst.rateWindow.length && now - inst.rateWindow[0] > RATE_WINDOW_MS) inst.rateWindow.shift();
  if (inst.rateWindow.length >= RATE_MAX_SENDS) return false;
  inst.rateWindow.push(now);
  return true;
}
async function sendWithTimeout(inst, jid, content) {
  return await Promise.race([
    inst.sock.sendMessage(jid, content),
    new Promise((_, reject) => setTimeout(() => reject(new Error('send timeout')), SEND_TIMEOUT_MS))
  ]);
}
function waitForAck(inst, messageId, timeoutMs = 10000) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      inst.ackWaiters.delete(messageId);
      resolve(null);
    }, timeoutMs);
    inst.ackWaiters.set(messageId, { resolve, timer });
  });
}

// ----------------------- Métricas auxiliares ----------------------
function recordMetricsSnapshot(inst, force = false) {
  if (!inst) return;
  if (!inst.metrics.timeline) inst.metrics.timeline = [];
  const now = Date.now();
  const last = inst.metrics.timeline[inst.metrics.timeline.length - 1];
  const failed = (inst.metrics.status_counts?.['3'] || 0) + (inst.metrics.status_counts?.['4'] || 0);

  if (last && now - last.ts < METRICS_TIMELINE_MIN_INTERVAL_MS) {
    last.sent = inst.metrics.sent;
    last.delivered = inst.metrics.status_counts?.['2'] || 0;
    last.failed = failed;
    last.rateInWindow = inst.rateWindow.length;
    if (!last.iso) last.iso = new Date(last.ts).toISOString();
    if (!force) return;
  }

  inst.metrics.timeline.push({
    ts: now,
    iso: new Date(now).toISOString(),
    sent: inst.metrics.sent,
    delivered: inst.metrics.status_counts?.['2'] || 0,
    failed,
    rateInWindow: inst.rateWindow.length,
  });
  if (inst.metrics.timeline.length > METRICS_TIMELINE_MAX) {
    inst.metrics.timeline.splice(0, inst.metrics.timeline.length - METRICS_TIMELINE_MAX);
  }
}

function serializeInstance(inst) {
  if (!inst) return null;
  const connected = !!(inst.sock && inst.sock.user);
  return {
    id: inst.id,
    name: inst.name,
    connected,
    user: connected ? inst.sock.user : null,
    note: inst.metadata?.note || inst.notes || '',
    metadata: {
      note: inst.metadata?.note || inst.notes || '',
      createdAt: inst.metadata?.createdAt || null,
      updatedAt: inst.metadata?.updatedAt || null,
    },
    counters: {
      sent: inst.metrics.sent,
      byType: { ...inst.metrics.sent_by_type },
      statusCounts: { ...inst.metrics.status_counts },
    },
    last: { ...inst.metrics.last },
    rate: {
      limit: RATE_MAX_SENDS,
      windowMs: RATE_WINDOW_MS,
      inWindow: inst.rateWindow.length,
      usage: RATE_MAX_SENDS ? inst.rateWindow.length / RATE_MAX_SENDS : 0,
    },
    metricsStartedAt: inst.metrics.startedAt,
  };
}

async function stopInstance(iid, { removeDir = false, logout = false } = {}) {
  const inst = instances.get(iid);
  if (!inst) return null;

  inst.stopping = true;
  if (inst.reconnectTimer) {
    try { clearTimeout(inst.reconnectTimer); } catch {}
    inst.reconnectTimer = null;
  }

  if (logout && inst.sock) {
    try { await inst.sock.logout().catch(() => {}); } catch {}
  }

  try { inst.sock?.end?.(); } catch {}

  instances.delete(iid);
  await saveInstancesIndex();

  if (removeDir) {
    try { await fs.rm(inst.dir, { recursive: true, force: true }); }
    catch (err) { logger.warn({ iid, err: err?.message }, 'instance.dir.remove.failed'); }
  }

  return inst;
}

// ----------------------- WhatsApp Socket (por instância) ----------------------
async function startInstance(iid, nameOrMeta, extraMeta = {}) {
  const dir = path.join(SESSIONS_ROOT, iid);
  await fs.mkdir(dir, { recursive: true }).catch(() => {});

  // se já existir uma instância com o mesmo id, encerra o socket anterior
  const existing = instances.get(iid);
  if (existing && existing.sock) {
    try { existing.stopping = true; existing.sock.end?.(); } catch {}
    if (existing.reconnectTimer) { try { clearTimeout(existing.reconnectTimer); } catch {} }
  }

  const meta = (typeof nameOrMeta === 'object' && nameOrMeta !== null && !Array.isArray(nameOrMeta))
    ? (nameOrMeta)
    : { name: nameOrMeta };
  const displayName = String(meta?.name || iid).trim() || iid;
  // Unificar notas/metadata
  const nowIso = new Date().toISOString();
  const mergedMeta = {
    note: typeof (extraMeta?.note ?? meta?.note ?? meta?.notes) === 'string' ? (extraMeta?.note ?? meta?.note ?? meta?.notes) : '',
    createdAt: meta?.createdAt || nowIso,
    updatedAt: nowIso,
  };

  const inst = {
    id: iid,
    name: displayName,
    dir,
    sock: null,
    lastQR: null,
    reconnectDelay: RECONNECT_MIN_DELAY_MS,
    stopping: false,
    reconnectTimer: null,
    metadata: mergedMeta,
    metrics: {
      startedAt: Date.now(),
      sent: 0,
      sent_by_type: { text: 0, image: 0, group: 0, buttons: 0, lists: 0 },
      status_counts: { "1": 0, "2": 0, "3": 0, "4": 0 },
      last: { sentId: null, lastStatusId: null, lastStatusCode: null },
      ack: { totalMs: 0, count: 0, avgMs: 0, lastMs: null },
      timeline: [],
    },
    statusMap: new Map(),
    ackWaiters: new Map(),
    rateWindow: [],
    ackSentAt: new Map(),
  };
  instances.set(iid, inst);

  // primeiro snapshot
  recordMetricsSnapshot(inst, true);

  const { state, saveCreds } = await useMultiFileAuthState(dir);
  const { version } = await fetchLatestBaileysVersion();
  logger.info({ iid, version }, 'baileys.version');

  const sock = makeWASocket({ version, auth: state, logger });
  inst.sock = sock;

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', (update) => {
    const { connection, lastDisconnect, qr, receivedPendingNotifications } = update;

    if (qr) {
      inst.lastQR = qr;
      logger.info({ iid }, 'qr.updated');
    }
    if (connection === 'open') {
      inst.lastQR = null;
      inst.reconnectDelay = RECONNECT_MIN_DELAY_MS;
      logger.info({ iid, receivedPendingNotifications }, 'whatsapp.connected');
    }
    if (connection === 'close') {
      const statusCode = lastDisconnect?.error?.output?.statusCode;
      const isLoggedOut = statusCode === DisconnectReason.loggedOut;
      logger.warn({ iid, statusCode }, 'whatsapp.disconnected');

      if (!inst.stopping && !isLoggedOut) {
        const delay = Math.min(inst.reconnectDelay, RECONNECT_MAX_DELAY_MS);
        logger.warn({ iid, delay }, 'whatsapp.reconnect.scheduled');
        // evita múltiplos agendamentos de reconexão concorrentes
        if (inst.reconnectTimer) clearTimeout(inst.reconnectTimer);
        const currentSock = sock;
          inst.reconnectTimer = setTimeout(() => {
            // só reconecta se ainda estamos falando do mesmo socket
            if (inst.sock !== currentSock) return;
            inst.reconnectDelay = Math.min(inst.reconnectDelay * 2, RECONNECT_MAX_DELAY_MS);
            startInstance(iid, inst.name, { note: inst.metadata?.note || inst.notes || '' })
              .catch(err => logger.error({ iid, err }, 'whatsapp.reconnect.failed'));
          }, delay);
      } else if (isLoggedOut) {
        logger.error({ iid }, 'session.loggedOut');
      }
    }
  });

  sock.ev.on('messages.upsert', async (evt) => {
    const count = evt.messages?.length || 0;
    logger.info({ iid, type: evt.type, count }, 'messages.upsert');

    if (count) {
      for (const m of evt.messages) {
        const from = m.key?.remoteJid;

        const btn = m.message?.templateButtonReplyMessage || m.message?.buttonsResponseMessage;
        if (btn) {
          logger.info({
            iid, from,
            selectedId: btn?.selectedId || btn?.selectedButtonId,
            selectedText: btn?.selectedDisplayText
          }, 'button.reply');
        }

        const list = m.message?.listResponseMessage;
        if (list) {
          logger.info({
            iid, from,
            selectedId: list?.singleSelectReply?.selectedRowId,
            selectedTitle: list?.title,
          }, 'list.reply');
        }
      }
    }

    // Webhook (apenas 1x por upsert)
    if (WEBHOOK_URL && count) {
      try {
        const body = JSON.stringify({ iid, ...evt });
        const sig = buildSignature(body, API_KEYS[0] || 'change-me');
        await fetch(WEBHOOK_URL, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-Signature-256': sig },
          body
        }).catch(() => {});
      } catch (e) {
        logger.warn({ iid, err: e?.message }, 'webhook.relay.error');
      }
    }
  });

  sock.ev.on('messages.update', (updates) => {
    for (const u of updates) {
      const mid = u.key?.id;
      const st = u.update?.status;
      if (mid && st != null) {
        inst.statusMap.set(mid, st);
        inst.metrics.status_counts[String(st)] = (inst.metrics.status_counts[String(st)] || 0) + 1;
        inst.metrics.last.lastStatusId = mid;
        inst.metrics.last.lastStatusCode = st;

        // atualizar métricas de ACK
        if (st >= 2 && inst.ackSentAt?.has(mid)) {
          const sentAt = inst.ackSentAt.get(mid);
          inst.ackSentAt.delete(mid);
          if (sentAt) {
            const delta = Math.max(0, Date.now() - sentAt);
            inst.metrics.ack.totalMs += delta;
            inst.metrics.ack.count += 1;
            inst.metrics.ack.lastMs = delta;
            inst.metrics.ack.avgMs = Math.round(inst.metrics.ack.totalMs / inst.metrics.ack.count);
          }
        }

        // snapshot periódico
        recordMetricsSnapshot(inst);

        const waiter = inst.ackWaiters.get(mid);
        if (waiter) {
          clearTimeout(waiter.timer);
          inst.ackWaiters.delete(mid);
          waiter.resolve(st);
        }
      }
      logger.info({ iid, mid, status: st }, 'messages.status');
    }
  });

  await saveInstancesIndex();
  return inst;
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

    <section class="p-4 bg-white rounded-2xl shadow">
      <div class="flex items-center gap-3 flex-wrap">
        <select id="selInstance" class="border rounded-lg px-3 py-2"></select>
        <button id="btnNew" class="px-3 py-2 bg-emerald-600 hover:bg-emerald-700 text-white rounded-lg">+ Nova instância</button>
        <span class="text-sm text-slate-500">Sessões em: <code id="sessionsRoot"></code></span>
      </div>
    </section>

    <section id="cards" class="grid sm:grid-cols-2 lg:grid-cols-3 gap-4"></section>

    <section class="grid md:grid-cols-3 gap-6">
      <div class="p-4 bg-white rounded-2xl shadow">
        <h2 class="font-semibold mb-2">QR Code (instância selecionada)</h2>
        <div id="qrWrap" class="border rounded-xl p-3 text-center">
          <img id="qrImg" alt="QR" class="mx-auto hidden" />
          <div id="qrHint" class="text-sm text-slate-500">Selecione uma instância desconectada para ver o QR.</div>
        </div>
        <div class="mt-3 flex gap-2 flex-wrap">
          <button id="btnLogout" class="px-3 py-2 bg-amber-600 hover:bg-amber-700 text-white rounded-lg">Desconectar</button>
          <button id="btnWipe" class="px-3 py-2 bg-rose-600 hover:bg-rose-700 text-white rounded-lg">Limpar sessão</button>
          <button id="btnPair" class="px-3 py-2 bg-indigo-600 hover:bg-indigo-700 text-white rounded-lg">Parear por código</button>
        </div>
      </div>

      <div class="p-4 bg-white rounded-2xl shadow md:col-span-2">
        <h2 class="font-semibold mb-2">Gráfico — enviados vs status (instância selecionada)</h2>
        <div class="relative w-full h-64 md:h-80 xl:h-96 overflow-hidden">
          <canvas id="metricsChart" class="absolute inset-0 w-full h-full"></canvas>
        </div>
      </div>
    </section>

    <section class="p-4 bg-white rounded-2xl shadow">
      <h2 class="font-semibold mb-3">Teste rápido de envio (instância selecionada)</h2>
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

    <div id="modalDelete" class="hidden fixed inset-0 bg-black/50 backdrop-blur-sm items-center justify-center z-50">
      <div class="bg-white rounded-2xl shadow-xl max-w-md w-full mx-4 p-6 space-y-4">
        <div>
          <h3 class="text-lg font-semibold">Confirmar exclusão</h3>
          <p class="text-sm text-slate-500 mt-1">Deseja excluir a instância <span id="modalInstanceName" class="font-medium text-slate-900"></span>? A sessão será arquivada.</p>
        </div>
        <div class="flex justify-end gap-2">
          <button data-act="modal-cancel" class="px-3 py-2 border rounded-lg">Cancelar</button>
          <button data-act="modal-confirm" class="px-3 py-2 bg-rose-600 hover:bg-rose-700 text-white rounded-lg">Excluir</button>
        </div>
      </div>
    </div>

  <script>
  const els = {
    badge: document.getElementById('badge'),
    sessionsRoot: document.getElementById('sessionsRoot'),
    selInstance: document.getElementById('selInstance'),
    btnNew: document.getElementById('btnNew'),
    cards: document.getElementById('cards'),
    qrImg: document.getElementById('qrImg'),
    qrHint: document.getElementById('qrHint'),
    btnLogout: document.getElementById('btnLogout'),
    btnWipe: document.getElementById('btnWipe'),
    btnPair: document.getElementById('btnPair'),
    inpApiKey: document.getElementById('inpApiKey'),
    inpPhone: document.getElementById('inpPhone'),
    inpMsg: document.getElementById('inpMsg'),
    btnSend: document.getElementById('btnSend'),
    sendOut: document.getElementById('sendOut'),
    modalDelete: document.getElementById('modalDelete'),
    modalInstanceName: document.getElementById('modalInstanceName'),
    modalConfirm: document.querySelector('[data-act="modal-confirm"]'),
    modalCancel: document.querySelector('[data-act="modal-cancel"]'),
  };

  const BADGE_STYLES = {
    'status-connected': 'bg-emerald-100 text-emerald-800',
    'status-disconnected': 'bg-rose-100 text-rose-800',
    logout: 'bg-amber-100 text-amber-800',
    wipe: 'bg-rose-200 text-rose-900',
    delete: 'bg-rose-600 text-white',
    update: 'bg-sky-100 text-sky-800',
    error: 'bg-amber-100 text-amber-800',
    info: 'bg-slate-200 text-slate-800'
  };
  let badgeLockUntil = 0;

  function applyBadge(type, msg) {
    const cls = BADGE_STYLES[type] || BADGE_STYLES.info;
    els.badge.className = 'px-3 py-1 rounded-full text-sm ' + cls;
    els.badge.textContent = msg;
  }

  function setBadgeState(type, msg, holdMs = 4000) {
    applyBadge(type, msg);
    badgeLockUntil = holdMs ? Date.now() + holdMs : 0;
  }

  function canUpdateBadge() {
    return Date.now() >= badgeLockUntil;
  }

  function setStatusBadge(connected, name) {
    if (!canUpdateBadge()) return;
    applyBadge(connected ? 'status-connected' : 'status-disconnected', connected ? 'Conectado (' + name + ')' : 'Desconectado (' + name + ')');
  }

  els.inpApiKey.value = localStorage.getItem('x_api_key') || '';
els.sessionsRoot.textContent = ${JSON.stringify(SESSIONS_ROOT)};
els.inpApiKey.addEventListener('input', () => {
  localStorage.setItem('x_api_key', els.inpApiKey.value.trim());
});

  function showError(msg) {
    console.error('[dashboard] erro:', msg);
    setBadgeState('error', msg, 5000);
  }
function requireKey() {
  const k = els.inpApiKey.value.trim();
  if (!k) {
    showError('Informe x-api-key para usar ações');
    try { els.inpApiKey.focus(); } catch {}
    throw new Error('missing_api_key');
  }
  return k;
}

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

async function fetchJSON(path, auth=true, opts={}) {
  const headers = { 'Content-Type': 'application/json' };
  if (auth) {
    const k = els.inpApiKey.value.trim();
    if (k) headers['x-api-key'] = k;
    const sel = els.selInstance.value;
    if (sel) headers['x-instance-id'] = sel;
  }
  const r = await fetch(path, { headers, cache: 'no-store', ...opts });
  if (!r.ok) {
    const txt = await r.text().catch(() => '');
    throw new Error('HTTP ' + r.status + (txt ? ' — ' + txt : ''));
  }
  try { return await r.json(); } catch { return {}; }
}

  function option(v, t) { const o = document.createElement('option'); o.value=v; o.textContent=t; return o; }

  const HTML_ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
  function escapeHtml(val) {
    return String(val ?? '').replace(/[&<>"']/g, ch => HTML_ESCAPES[ch] || ch);
  }

  async function refreshInstances() {
    try {
      const data = await fetchJSON('/instances', true);
      const prev = els.selInstance.value;
      els.selInstance.textContent = '';
      data.forEach(i => {
        els.selInstance.appendChild(option(i.id, i.name + (i.connected ? ' (on)' : ' (off)')));
      });

      if (prev && data.some(i => i.id === prev)) {
        els.selInstance.value = prev;
      } else if (data[0]) {
        els.selInstance.value = data[0].id;
      } else {
        els.selInstance.value = '';
      }

      els.cards.innerHTML = '';
      if (!data.length) {
        els.cards.innerHTML = '<p class="text-sm text-slate-500">Nenhuma instância cadastrada.</p>';
      } else {
        data.forEach(i => {
          const card = document.createElement('div');
          card.className = 'p-4 bg-white rounded-2xl shadow space-y-3';
          card.dataset.card = i.id;
          card.dataset.iid = i.id;
          const statusCls = i.connected ? 'bg-emerald-100 text-emerald-800' : 'bg-rose-100 text-rose-800';
          card.innerHTML = \`
            <div class="flex items-start justify-between gap-3">
              <div class="flex-1">
                <label class="text-xs font-medium text-slate-500">Nome</label>
                <input data-field="name" data-iid="\${i.id}" class="mt-1 w-full border rounded-lg px-2 py-1 text-sm" value="\${escapeHtml(i.name)}" />
              </div>
              <span class="px-2 py-0.5 rounded text-xs \${statusCls}">
                \${i.connected ? 'Conectado' : 'Desconectado'}
              </span>
            </div>
            <div class="text-xs text-slate-500 break-all">\${escapeHtml(i.user?.id || '—')}</div>
            <div class="text-sm">
              <div>Enviadas: <b>\${i.counters.sent||0}</b></div>
              <div>Status 2: <b>\${(i.counters.status||{})['2']||0}</b> • Status 3: <b>\${(i.counters.status||{})['3']||0}</b></div>
            </div>
            <div>
              <label class="text-xs font-medium text-slate-500">Notas</label>
              <textarea data-field="notes" data-iid="\${i.id}" rows="3" class="mt-1 w-full border rounded-lg px-2 py-1 text-sm">\${escapeHtml(i.notes || '')}</textarea>
            </div>
            <div class="flex gap-2 flex-wrap">
              <button data-act="qr" data-iid="\${i.id}" class="px-2 py-1 border rounded">Ver QR</button>
              <button data-act="logout" data-iid="\${i.id}" class="px-2 py-1 border rounded">Logout</button>
              <button data-act="wipe" data-iid="\${i.id}" class="px-2 py-1 border rounded">Wipe</button>
              <button data-act="select" data-iid="\${i.id}" class="px-2 py-1 border rounded">Selecionar</button>
              <button data-act="save" data-iid="\${i.id}" class="px-2 py-1 border rounded bg-sky-50">Salvar</button>
              <button data-act="delete" data-iid="\${i.id}" class="px-2 py-1 border border-rose-500 text-rose-600 rounded">Excluir</button>
            </div>
          \`;
          els.cards.appendChild(card);
        });
      }

      if (els.selInstance.value) {
        await refreshSelected();
      }

    } catch (e) {
      const msg = String(e?.message||'');
      if (msg.includes('HTTP 401')) showError('API key inválida');
      else if (msg.includes('HTTP 502')) showError('Serviço reiniciando/indisponível (502)');
      else showError('Erro ao listar instâncias');
    }
  }

async function refreshSelected() {
  const iid = els.selInstance.value;
  if (!iid) return;
  try {
    const m = await fetchJSON('/instances/' + iid, true);

    const connected = !!m.connected;
    setStatusBadge(connected, m.name);

    chart.data.datasets[0].data = [
      m.counters.sent || 0,
      (m.counters.statusCounts||{})['1']||0,
      (m.counters.statusCounts||{})['2']||0,
      (m.counters.statusCounts||{})['3']||0,
      (m.counters.statusCounts||{})['4']||0
    ];
    chart.update('none');

    if (!connected) {
      const r = await fetch('/instances/' + iid + '/qr.png', {
        headers: { 'x-api-key': els.inpApiKey.value.trim(), 'x-instance-id': iid },
        cache: 'no-store'
      });
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
  } catch {}
}

  function findCardByIid(iid) {
    return Array.from(els.cards.querySelectorAll('[data-card]')).find(el => el.dataset.card === iid) || null;
  }

  function getInstanceDisplayName(iid) {
    const card = findCardByIid(iid);
    const value = card?.querySelector('[data-field="name"]')?.value?.trim();
    if (value) return value;
    const opt = Array.from(els.selInstance.options).find(o => o.value === iid);
    if (opt) {
      const label = (opt.textContent || '').replace(/\s+\((on|off)\)$/i, '').trim();
      if (label) return label;
    }
    return iid;
  }

  function openDeleteModal(iid, name) {
    els.modalDelete.dataset.iid = iid;
    els.modalDelete.dataset.name = name;
    els.modalInstanceName.textContent = name;
    els.modalDelete.classList.remove('hidden');
    els.modalDelete.classList.add('flex');
  }

  function closeDeleteModal() {
    delete els.modalDelete.dataset.iid;
    delete els.modalDelete.dataset.name;
    els.modalDelete.classList.add('hidden');
    els.modalDelete.classList.remove('flex');
  }

  async function performInstanceAction(action, iid, key, context = {}) {
    const endpoints = {
      logout: '/instances/' + iid + '/logout',
      wipe: '/instances/' + iid + '/session/wipe'
    };
    const badgeTypes = { logout: 'logout', wipe: 'wipe' };
    const fallbackMessages = {
      logout: (name) => 'Logout solicitado (' + name + ')',
      wipe: (name) => 'Wipe solicitado (' + name + ')'
    };
    const holdTimes = { logout: 5000, wipe: 7000 };
    const url = endpoints[action];
    if (!url) return false;
    const button = context.button || null;
    const name = context.name || getInstanceDisplayName(iid);
    if (button) button.disabled = true;
    try {
      const r = await fetch(url, { method: 'POST', headers: { 'x-api-key': key } });
      if (!r.ok) {
        const txt = await r.text().catch(() => '');
        alert('Falha ao executar ' + action + ': HTTP ' + r.status + (txt ? ' — ' + txt : ''));
        setBadgeState('error', 'Falha em ' + action + ' (' + name + ')', 5000);
        return false;
      }
      const payload = await r.json().catch(() => ({}));
      const message = payload?.message || fallbackMessages[action](name);
      setBadgeState(badgeTypes[action], message, holdTimes[action]);
      console.info('[dashboard] ação ' + action, { iid, payload });
      if (context.refresh !== false) await refreshInstances();
      return true;
    } catch (err) {
      console.error('[dashboard] erro em ' + action, err);
      showError('Erro ao executar ' + action);
      return false;
    } finally {
      if (button) button.disabled = false;
    }
  }

  async function handleSaveMetadata(iid) {
    const card = findCardByIid(iid);
    const nameInput = card?.querySelector('[data-field="name"]');
    const notesInput = card?.querySelector('[data-field="notes"]');
    const payload = {
      name: nameInput?.value || '',
      notes: notesInput?.value || ''
    };
    try {
      const result = await fetchJSON('/instances/' + iid, true, { method: 'PATCH', body: JSON.stringify(payload) });
      const displayName = result?.name || iid;
      setBadgeState('update', 'Metadados salvos (' + displayName + ')', 4000);
      console.info('[dashboard] instância atualizada', { iid, result });
      await refreshInstances();
    } catch (err) {
      console.error('[dashboard] erro ao atualizar instância', err);
      showError('Falha ao atualizar instância');
      alert('Falha ao atualizar: ' + err.message);
    }
  }

  els.modalDelete.addEventListener('click', (ev) => {
    if (ev.target === els.modalDelete) closeDeleteModal();
  });

  document.addEventListener('keydown', (ev) => {
    if (ev.key === 'Escape' && !els.modalDelete.classList.contains('hidden')) closeDeleteModal();
  });

  document.addEventListener('click', async (ev) => {
    const btn = ev.target.closest('[data-act]');
    if (!btn) return;
    const act = btn.dataset.act;

    if (act === 'modal-cancel') {
      ev.preventDefault();
      closeDeleteModal();
      return;
    }

    if (act === 'delete') {
      const card = btn.closest('[data-card]');
      const iidTarget = btn.dataset.iid || card?.dataset.iid;
      if (!iidTarget) return;
      const name = getInstanceDisplayName(iidTarget);
      openDeleteModal(iidTarget, name);
      return;
    }

    if (act === 'modal-confirm') {
      const iidTarget = els.modalDelete.dataset.iid;
      if (!iidTarget) { closeDeleteModal(); return; }
      let key;
      try { key = requireKey(); } catch { return; }
      localStorage.setItem('x_api_key', els.inpApiKey.value.trim());
      btn.disabled = true;
      try {
        const r = await fetch('/instances/' + iidTarget, { method: 'DELETE', headers: { 'x-api-key': key } });
        if (!r.ok) {
          const txt = await r.text().catch(() => '');
          alert('Falha ao excluir: HTTP ' + r.status + (txt ? ' — ' + txt : ''));
          setBadgeState('error', 'Falha ao excluir ' + iidTarget, 5000);
          return;
        }
        const payload = await r.json().catch(() => ({}));
        const name = els.modalDelete.dataset.name || iidTarget;
        setBadgeState('delete', payload?.message || ('Instância removida (' + name + ')'), 7000);
        console.info('[dashboard] instância removida', { iid: iidTarget, payload });
        closeDeleteModal();
        await refreshInstances();
      } catch (err) {
        console.error('[dashboard] erro ao excluir instância', err);
        showError('Erro ao excluir instância');
      } finally {
        btn.disabled = false;
      }
      return;
    }

    const iid = btn.dataset.iid;
    if (!iid) return;

    let key;
    try { key = requireKey(); } catch { return; }
    localStorage.setItem('x_api_key', els.inpApiKey.value.trim());

    if (act === 'qr') {
      els.selInstance.value = iid;
      await refreshSelected();
      return;
    }
    if (act === 'logout') {
      await performInstanceAction('logout', iid, key, { button: btn });
      return;
    }
    if (act === 'wipe') {
      await performInstanceAction('wipe', iid, key, { button: btn });
      return;
    }
    if (act === 'select') {
      els.selInstance.value = iid;
      await refreshSelected();
      return;
    }
    if (act === 'save') {
      await handleSaveMetadata(iid);
      return;
    }
  });

  els.btnNew.onclick = async () => {
    const name = prompt('Nome da nova instância (ex: suporte-goiania)');
    if (!name) return;
    localStorage.setItem('x_api_key', els.inpApiKey.value.trim());
    try {
      const payload = await fetchJSON('/instances', true, { method:'POST', body: JSON.stringify({ name }) });
      setBadgeState('update', 'Instância criada (' + (payload?.name || payload?.id || name) + ')', 4000);
      console.info('[dashboard] instância criada', payload);
      await refreshInstances();
    } catch (err) {
      console.error('[dashboard] erro ao criar instância', err);
      showError('Falha ao criar instância');
      alert('Falha ao criar instância: ' + err.message);
    }
  };

els.selInstance.onchange = refreshSelected;

  els.btnLogout.onclick = async () => {
    try {
      localStorage.setItem('x_api_key', els.inpApiKey.value.trim());
      const iid = els.selInstance.value;
      if (!iid) return;
      const key = requireKey();
      const name = getInstanceDisplayName(iid);
      const ok = await performInstanceAction('logout', iid, key, { name, button: null });
      if (ok) {
        els.qrHint.textContent = 'Desconectando… o serviço pode reiniciar e exibir um novo QR.';
      }
    } catch {}
  };

  els.btnWipe.onclick = async () => {
    try {
      localStorage.setItem('x_api_key', els.inpApiKey.value.trim());
      const iid = els.selInstance.value;
      if (!iid) return;
      const key = requireKey();
      const name = getInstanceDisplayName(iid);
      const ok = await performInstanceAction('wipe', iid, key, { name, button: null });
      if (ok) {
        els.qrHint.textContent = 'Limpando sessão… o serviço vai reiniciar e exibir um novo QR.';
      }
    } catch {}
  };

els.btnPair.onclick = async () => {
  try {
    const iid = els.selInstance.value;
    const phone = prompt('Número no formato E.164 (ex: 5544999999999):');
    if (!phone) return;
    const j = await fetchJSON('/instances/'+iid+'/pair', true, { method:'POST', body: JSON.stringify({ phoneNumber: phone }) });
    const code = j?.pairingCode || '(sem código)';
    els.qrHint.textContent = 'Código de pareamento: ' + code + ' (copiado)';
    try { await navigator.clipboard.writeText(code); } catch {}
  } catch (e) {
    alert('Falha ao gerar código: ' + e.message);
  }
};

els.btnSend.onclick = async () => {
  try {
    localStorage.setItem('x_api_key', els.inpApiKey.value.trim());
    const iid = els.selInstance.value;
    const body = JSON.stringify({ to: els.inpPhone.value.trim(), message: els.inpMsg.value.trim(), waitAckMs: 8000 });
    const r = await fetch('/instances/'+iid+'/send-text', { method: 'POST', headers: { 'x-api-key': els.inpApiKey.value.trim(), 'Content-Type':'application/json' }, body });
    const j = await r.json();
    els.sendOut.textContent = 'Resposta: ' + JSON.stringify(j);
  } catch (e) {
    els.sendOut.textContent = 'Falha no envio: ' + e.message;
  }
};

setInterval(refreshInstances, 3000);
refreshInstances();
</script>
</body>
</html>`);
});

// --------------------------- Endpoints API (saúde) --------------------
app.get('/health', (req, res) => res.json({ ok: true, service: SERVICE_NAME }));

// --------------------------- Rotas de Instância ------------------------
app.post('/instances', auth, asyncHandler(async (req, res) => {
  const name = String(req.body?.name || '').trim() || null;
  const noteRaw = typeof req.body?.note === 'string' ? req.body.note.trim() : (typeof req.body?.notes === 'string' ? req.body.notes.trim() : '');
  const note = noteRaw ? noteRaw.slice(0, 280) : '';
  const iid = (name ? name.toLowerCase().replace(/[^\w]+/g, '-') : crypto.randomUUID());
  if (instances.has(iid)) return res.status(409).json({ error: 'instance_exists' });
  const inst = await startInstance(iid, name || iid, { note });
  logger.info({ iid: inst.id, name: inst.name }, 'instance.created');
  res.json({ id: inst.id, name: inst.name, dir: inst.dir, metadata: inst.metadata });
}));

app.get('/instances', auth, (req, res) => {
  const list = [...instances.values()].map(inst => {
    const s = serializeInstance(inst);
    return {
      id: s.id,
      name: s.name,
      note: s.note,
      notes: s.note,
      metadata: s.metadata,
      connected: s.connected,
      user: s.user,
      counters: { sent: s.counters.sent, status: s.counters.statusCounts },
      rate: s.rate,
    };
  });
  res.json(list);
});

app.get('/instances/:iid', auth, (req, res) => {
  const inst = instances.get(req.params.iid);
  if (!inst) return res.status(404).json({ error: 'instance_not_found' });
  const s = serializeInstance(inst);
  res.json({ ...s, notes: s.note });
});

app.patch('/instances/:iid', auth, asyncHandler(async (req, res) => {
  const inst = instances.get(req.params.iid);
  if (!inst) return res.status(404).json({ error: 'instance_not_found' });

  const body = req.body || {};
  let touched = false;
  if (Object.prototype.hasOwnProperty.call(body, 'name')) {
    if (typeof body.name !== 'string') return res.status(400).json({ error: 'name_invalid' });
    const nextName = body.name.trim();
    if (!nextName) return res.status(400).json({ error: 'name_empty' });
    inst.name = nextName.slice(0, 80);
    touched = true;
  }
  const patchNote = Object.prototype.hasOwnProperty.call(body, 'note') ? body.note
                   : (Object.prototype.hasOwnProperty.call(body, 'notes') ? body.notes : undefined);
  if (patchNote !== undefined) {
    if (typeof patchNote !== 'string') return res.status(400).json({ error: 'note_invalid' });
    inst.metadata = inst.metadata || {};
    inst.metadata.note = String(patchNote).trim().slice(0, 280);
    touched = true;
  }
  if (!touched) return res.status(400).json({ error: 'no_updates' });
  inst.metadata.updatedAt = new Date().toISOString();
  await saveInstancesIndex();
  res.json(serializeInstance(inst));
}));

app.delete('/instances/:iid', auth, asyncHandler(async (req, res) => {
  const iid = req.params.iid;
  if (iid === 'default') return res.status(400).json({ error: 'default_instance_cannot_be_deleted' });
  const inst = instances.get(iid);
  if (!inst) return res.status(404).json({ error: 'instance_not_found' });
  await stopInstance(iid, { removeDir: true, logout: true });
  res.json({ ok: true, message: 'Instância removida permanentemente.' });
}));

app.get('/instances/:iid/qr.png', auth, asyncHandler(async (req, res) => {
  const i = instances.get(req.params.iid);
  if (!i) return res.status(404).send('instance_not_found');
  if (!i.lastQR) return res.status(404).send('no-qr');
  const png = await QRCode.toBuffer(i.lastQR, { type: 'png', margin: 1, scale: 6 });
  res.type('png').send(png);
}));

app.post('/instances/:iid/pair', auth, asyncHandler(async (req, res) => {
  const i = instances.get(req.params.iid);
  if (!i || !i.sock) return res.status(503).json({ error: 'socket indisponível' });
  const phoneNumberRaw = req.body?.phoneNumber;
  if (!phoneNumberRaw) return res.status(400).json({ error: 'phoneNumber obrigatório (ex: 5544...)' });
  const code = await i.sock.requestPairingCode(String(phoneNumberRaw));
  res.json({ pairingCode: code });
}));

app.post('/instances/:iid/logout', auth, asyncHandler(async (req, res) => {
  const i = instances.get(req.params.iid);
  if (!i || !i.sock) return res.status(503).json({ error: 'socket indisponível' });
  try {
    await i.sock.logout();
    res.json({ ok: true, message: 'Sessão desconectada. Um novo QR aparecerá em breve.' });
  } catch (e) {
    res.status(500).json({ error: 'falha ao desconectar', detail: e.message });
  }
}));

app.post('/instances/:iid/session/wipe', auth, asyncHandler(async (req, res) => {
  const i = instances.get(req.params.iid);
  if (!i) return res.status(404).json({ error: 'instance_not_found' });

  try {
    i.stopping = true;
    if (i.sock) {
      try { await i.sock.logout().catch(() => {}); } catch {}
      try { i.sock.end?.(); } catch {}
    }
  } catch {}

  try {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const bak = `${i.dir}.bak-${stamp}`;
    await fs.rename(i.dir, bak).catch(() => {});
    await fs.mkdir(i.dir, { recursive: true }).catch(() => {});

    res.json({ ok: true, message: 'Sessão isolada. Reiniciando para gerar novo QR.' });

    setTimeout(() => process.exit(0), 200);
    setTimeout(async () => { try { await fs.rm(bak, { recursive: true, force: true }); } catch {} }, 1000);

  } catch (e) {
    try {
      await fs.rm(i.dir, { recursive: true, force: true });
      await fs.mkdir(i.dir, { recursive: true });
      res.json({ ok: true, message: 'Sessão limpa. Reiniciando para gerar novo QR.' });
      setTimeout(() => process.exit(0), 200);
    } catch (err) {
      res.status(500).json({ error: 'falha ao limpar sessão', detail: err?.message || String(err) });
    }
  }
}));

app.get('/instances/:iid/status', auth, (req, res) => {
  const i = instances.get(req.params.iid);
  if (!i) return res.status(404).json({ error: 'instance_not_found' });
  const id = String(req.query.id || '');
  if (!id) return res.status(400).json({ error: 'id obrigatório' });
  const status = i.statusMap.get(id) ?? null;
  res.json({ id, status });
});

app.get('/instances/:iid/groups', auth, asyncHandler(async (req, res) => {
  const i = instances.get(req.params.iid);
  if (!i || !i.sock) return res.status(503).json({ error: 'socket indisponível' });
  const all = await i.sock.groupFetchAllParticipating();
  const list = Object.values(all).map(g => ({ id: g.id, subject: g.subject }));
  res.json(list);
}));

app.get('/instances/:iid/metrics', auth, (req, res) => {
  const inst = instances.get(req.params.iid);
  if (!inst) return res.status(404).json({ error: 'instance_not_found' });

  const summary = serializeInstance(inst);
  const { metricsStartedAt, ...rest } = summary;
  const timeline = (inst.metrics.timeline || []).map(entry => ({
    ts: entry.ts,
    iso: entry.iso || new Date(entry.ts).toISOString(),
    sent: entry.sent,
    delivered: entry.delivered,
    failed: entry.failed,
    rateInWindow: entry.rateInWindow,
  }));

  res.json({
    service: SERVICE_NAME,
    ...rest,
    startedAt: metricsStartedAt,
    timeline,
    ack: {
      avgMs: inst.metrics.ack?.avgMs || 0,
      lastMs: inst.metrics.ack?.lastMs || null,
      samples: inst.metrics.ack?.count || 0,
    },
    sessionDir: inst.dir,
  });
});

app.post('/instances/:iid/exists', auth, asyncHandler(async (req, res) => {
  const i = instances.get(req.params.iid);
  if (!i || !i.sock) return res.status(503).json({ error: 'socket indisponível' });
  const normalized = normalizeToE164BR(req.body?.to);
  if (!normalized) return res.status(400).json({ error: 'to inválido. Use E.164: 55DDDNUMERO' });
  const results = await i.sock.onWhatsApp(normalized);
  res.json({ results });
}));

// --- Envio por instância
app.post('/instances/:iid/send-text', auth, asyncHandler(async (req, res) => {
  const i = instances.get(req.params.iid);
  if (!i || !i.sock) return res.status(503).json({ error: 'socket indisponível' });
  if (!allowSend(i)) return res.status(429).json({ error: 'rate limit exceeded' });

  const { to, message, waitAckMs } = req.body || {};
  if (!to || !message) return res.status(400).json({ error: 'parâmetros to e message são obrigatórios' });

  const normalized = normalizeToE164BR(to);
  if (!normalized) return res.status(400).json({ error: 'to inválido. Use E.164: 55DDDNUMERO' });

  const check = await i.sock.onWhatsApp(normalized);
  const entry = Array.isArray(check) ? check[0] : null;
  if (!entry || !entry.exists) return res.status(404).json({ error: 'número não está no WhatsApp', to: normalized });

  const jid = entry.jid;
  const result = await sendWithTimeout(i, jid, { text: String(message) });
  const id = result?.key?.id || null;

  if (id) {
    i.metrics.last.sentId = id;
    i.ackSentAt.set(id, Date.now());
    setTimeout(() => i.ackSentAt.delete(id), ACK_SAMPLE_MAX_AGE_MS).unref?.();
  }

  i.metrics.sent++;
  i.metrics.sent_by_type.text++;
  recordMetricsSnapshot(i, true);

  let status = null;
  const ms = Number(waitAckMs || 0);
  if (id && ms > 0) status = await waitForAck(i, id, Math.min(ms, 20000));

  res.json({ ok: true, id, to: jid, status });
}));

app.post('/instances/:iid/send-image', auth, asyncHandler(async (req, res) => {
  const i = instances.get(req.params.iid);
  if (!i || !i.sock) return res.status(503).json({ error: 'socket indisponível' });
  if (!allowSend(i)) return res.status(429).json({ error: 'rate limit exceeded' });

  const { to, url, caption, waitAckMs } = req.body || {};
  if (!to || !url) return res.status(400).json({ error: 'to e url são obrigatórios' });

  const normalized = normalizeToE164BR(to);
  if (!normalized) return res.status(400).json({ error: 'to inválido. Use E.164: 55DDDNUMERO' });

  const check = await i.sock.onWhatsApp(normalized);
  const entry = Array.isArray(check) ? check[0] : null;
  if (!entry || !entry.exists) return res.status(404).json({ error: 'número não está no WhatsApp', to: normalized });

  const jid = entry.jid;
  const result = await sendWithTimeout(i, jid, { image: { url: String(url) }, caption: caption ? String(caption) : undefined });
  const id = result?.key?.id || null;

  if (id) {
    i.metrics.last.sentId = id;
    i.ackSentAt.set(id, Date.now());
    setTimeout(() => i.ackSentAt.delete(id), ACK_SAMPLE_MAX_AGE_MS).unref?.();
  }

  i.metrics.sent++;
  i.metrics.sent_by_type.image++;
  recordMetricsSnapshot(i, true);

  let status = null;
  const ms = Number(waitAckMs || 0);
  if (id && ms > 0) status = await waitForAck(i, id, Math.min(ms, 20000));

  res.json({ ok: true, id, to: jid, status });
}));

app.post('/instances/:iid/send-group', auth, asyncHandler(async (req, res) => {
  const i = instances.get(req.params.iid);
  if (!i || !i.sock) return res.status(503).json({ error: 'socket indisponível' });
  if (!allowSend(i)) return res.status(429).json({ error: 'rate limit exceeded' });

  const { groupId, message, waitAckMs } = req.body || {};
  if (!groupId || !message) return res.status(400).json({ error: 'groupId e message são obrigatórios' });

  const result = await sendWithTimeout(i, String(groupId), { text: String(message) });
  const id = result?.key?.id || null;

  if (id) {
    i.metrics.last.sentId = id;
    i.ackSentAt.set(id, Date.now());
    setTimeout(() => i.ackSentAt.delete(id), ACK_SAMPLE_MAX_AGE_MS).unref?.();
  }

  i.metrics.sent++;
  i.metrics.sent_by_type.group++;
  recordMetricsSnapshot(i, true);

  let status = null;
  const ms = Number(waitAckMs || 0);
  if (id && ms > 0) status = await waitForAck(i, id, Math.min(ms, 20000));

  res.json({ ok: true, id, to: String(groupId), status });
}));

app.post('/instances/:iid/send-me', auth, asyncHandler(async (req, res) => {
  const i = instances.get(req.params.iid);
  if (!i || !i.sock || !i.sock.user?.id) return res.status(503).json({ error: 'socket indisponível' });
  if (!allowSend(i)) return res.status(429).json({ error: 'rate limit exceeded' });

  const { message, waitAckMs } = req.body || {};
  if (!message) return res.status(400).json({ error: 'message obrigatório' });

  const result = await sendWithTimeout(i, i.sock.user.id, { text: String(message) });
  const id = result?.key?.id || null;

  if (id) {
    i.metrics.last.sentId = id;
    i.ackSentAt.set(id, Date.now());
    setTimeout(() => i.ackSentAt.delete(id), ACK_SAMPLE_MAX_AGE_MS).unref?.();
  }

  i.metrics.sent++;
  recordMetricsSnapshot(i, true);

  let status = null;
  const ms = Number(waitAckMs || 0);
  if (id && ms > 0) status = await waitForAck(i, id, Math.min(ms, 20000));

  res.json({ ok: true, id, to: i.sock.user.id, status });
}));

// List Message (menu expansível) por instância
app.post('/instances/:iid/send-list', auth, asyncHandler(async (req, res) => {
  const i = instances.get(req.params.iid);
  if (!i || !i.sock) return res.status(503).json({ error: 'socket indisponível' });
  if (!allowSend(i)) return res.status(429).json({ error: 'rate limit exceeded' });

  const { to, text, footer, buttonText, sections, waitAckMs } = req.body || {};
  if (!to || !text || !buttonText || !Array.isArray(sections) || !sections.length) {
    return res.status(400).json({ error: 'parâmetros obrigatórios: to, text, buttonText, sections[]' });
  }

  const normalized = normalizeToE164BR(to);
  if (!normalized) return res.status(400).json({ error: 'to inválido. Use E.164: 55DDDNUMERO' });

  const check = await i.sock.onWhatsApp(normalized);
  const entry = Array.isArray(check) ? check[0] : null;
  if (!entry || !entry.exists) return res.status(404).json({ error: 'número não está no WhatsApp', to: normalized });
  const jid = entry.jid;

  const fixedSections = sections.map(sec => {
    const title = String(sec.title || '').slice(0, 24) || undefined;
    const rows = (sec.rows || [])
      .filter(r => r && (r.title || r.rowId))
      .slice(0, 10)
      .map(r => ({
        title: String(r.title || r.rowId).slice(0, 72),
        rowId: String(r.rowId || r.title).slice(0, 256),
        description: r.description ? String(r.description).slice(0, 256) : undefined,
      }));
    return { title, rows };
  }).filter(s => s.rows && s.rows.length);

  if (!fixedSections.length) return res.status(400).json({ error: 'sections sem rows válidas' });

  const payload = {
    text: String(text),
    footer: footer ? String(footer) : undefined,
    buttonText: String(buttonText).slice(0, 24),
    sections: fixedSections,
  };

  let result, id = null, status = null;
  try {
    result = await sendWithTimeout(i, jid, payload);
    id = result?.key?.id || null;

    if (id) {
      i.metrics.last.sentId = id;
      i.ackSentAt.set(id, Date.now());
      setTimeout(() => i.ackSentAt.delete(id), ACK_SAMPLE_MAX_AGE_MS).unref?.();
    }

    i.metrics.sent++;
    i.metrics.sent_by_type.lists++;
    recordMetricsSnapshot(i, true);

    const ms = Number(waitAckMs || 0);
    if (id && ms > 0) status = await waitForAck(i, id, Math.min(ms, 20000));

    return res.json({ ok: true, id, to: jid, status });
  } catch (err) {
    const fallback = [
      String(text),
      '',
      ...fixedSections.flatMap((sec, si) => {
        const head = sec.title ? ['*' + sec.title + '*'] : [];
        const rows = sec.rows.map((r, i2) => `${si + 1}.${i2 + 1}) ${r.title}`);
        return [...head, ...rows, ''];
      }),
      'Responda com o número da opção.'
    ].join('\n');

    try {
      const fb = await sendWithTimeout(i, jid, { text: fallback });
      id = fb?.key?.id || null;

      i.metrics.sent++;
      i.metrics.sent_by_type.text++;
      if (id) {
        i.metrics.last.sentId = id;
        i.ackSentAt.set(id, Date.now());
        setTimeout(() => i.ackSentAt.delete(id), ACK_SAMPLE_MAX_AGE_MS).unref?.();
      }
      recordMetricsSnapshot(i, true);

      return res.json({ ok: true, id, to: jid, status: null, fallback: true, error: String(err?.message || err) });
    } catch (err2) {
      return res.status(500).json({ error: 'falha ao enviar lista e fallback', detail: String(err2?.message || err2) });
    }
  }
}));

// Quick-reply buttons (até 3) — com fallback numerado (por instância)
app.post('/instances/:iid/send-buttons', auth, asyncHandler(async (req, res) => {
  const i = instances.get(req.params.iid);
  if (!i || !i.sock) return res.status(503).json({ error: 'socket indisponível' });
  if (!allowSend(i)) return res.status(429).json({ error: 'rate limit exceeded' });

  const { to, text, buttons, waitAckMs } = req.body || {};
  if (!to || !text || !Array.isArray(buttons) || !buttons.length) {
    return res.status(400).json({ error: 'to, text e buttons[] são obrigatórios' });
  }

  const normalized = normalizeToE164BR(to);
  if (!normalized) return res.status(400).json({ error: 'to inválido. Use E.164: 55DDDNUMERO' });

  const check = await i.sock.onWhatsApp(normalized);
  const entry = Array.isArray(check) ? check[0] : null;
  if (!entry || !entry.exists) return res.status(404).json({ error: 'número não está no WhatsApp', to: normalized });
  const jid = entry.jid;

  const cleaned = buttons
    .filter(b => b && (b.text || b.id))
    .slice(0, 3)
    .map((b, idx) => ({
      index: idx + 1,
      quickReplyButton: {
        displayText: String(b.text || b.id).slice(0, 24),
        id: String(b.id || b.text).slice(0, 128)
      }
    }));

  if (!cleaned.length) return res.status(400).json({ error: 'buttons[] sem itens válidos' });

  let id = null;
  let status = null;

  try {
    const result = await sendWithTimeout(i, jid, { text: String(text), templateButtons: cleaned });
    id = result?.key?.id || null;

    if (id) {
      i.metrics.last.sentId = id;
      i.ackSentAt.set(id, Date.now());
      setTimeout(() => i.ackSentAt.delete(id), ACK_SAMPLE_MAX_AGE_MS).unref?.();
    }
    i.metrics.sent++;
    i.metrics.sent_by_type.buttons++;
    recordMetricsSnapshot(i, true);

    const ms = Number(waitAckMs || 0);
    if (id && ms > 0) status = await waitForAck(i, id, Math.min(ms, 20000));

    return res.json({ ok: true, id, to: jid, status });

  } catch (err) {
    const numbered = [
      String(text),
      '',
      ...cleaned.map((b, idx) => `${idx + 1}) ${b.quickReplyButton.displayText}`),
      '',
      'Responda com o número da opção.'
    ].join('\n');

    try {
      const fb = await sendWithTimeout(i, jid, { text: numbered });
      id = fb?.key?.id || null;

      i.metrics.sent++;
      i.metrics.sent_by_type.text++;
      if (id) {
        i.metrics.last.sentId = id;
        i.ackSentAt.set(id, Date.now());
        setTimeout(() => i.ackSentAt.delete(id), ACK_SAMPLE_MAX_AGE_MS).unref?.();
      }
      recordMetricsSnapshot(i, true);

      const ms = Number(waitAckMs || 0);
      if (id && ms > 0) status = await waitForAck(i, id, Math.min(ms, 20000));

      return res.json({ ok: true, id, to: jid, status, fallback: true, error: String(err?.message || err) });
    } catch (err2) {
      return res.status(500).json({ error: 'falha ao enviar buttons e fallback', detail: String(err2?.message || err2) });
    }
  }
}));

// --------------------------- Retrocompat (instância "default") -----------------
// Mantém as rotas antigas funcionando, apontando para /instances/default/*

app.get('/qr', asyncHandler(async (req, res) => {
  // proxy para /instances/default/qr.png (HTML)
  const i = instances.get('default');
  if (!i) return res.status(404).send('instância default não encontrada');
  if (!i.lastQR) return res.status(404).send('QR não disponível. Talvez já esteja conectado.');
  const dataUrl = await QRCode.toDataURL(i.lastQR);
  res.type('html').send(`<html><body><h3>Escaneie este QR no WhatsApp</h3><img alt="QR" src="${dataUrl}" /></body></html>`);
}));

app.get('/qr.png', asyncHandler(async (req, res) => {
  const i = instances.get('default');
  if (!i || !i.lastQR) return res.status(404).send('no-qr');
  const png = await QRCode.toBuffer(i.lastQR, { type: 'png', margin: 1, scale: 6 });
  res.type('png').send(png);
}));

app.get('/whoami', auth, (req, res) => {
  const i = instances.get('default');
  if (!i || !i.sock || !i.sock.user) return res.status(503).json({ error: 'socket indisponível' });
  res.json({ user: i.sock.user });
});

app.get('/status', auth, (req, res) => {
  const i = instances.get('default');
  if (!i) return res.status(503).json({ error: 'socket indisponível' });
  const id = String(req.query.id || '');
  if (!id) return res.status(400).json({ error: 'id obrigatório' });
  const status = i.statusMap.get(id) ?? null;
  res.json({ id, status });
});

app.get('/groups', auth, asyncHandler(async (req, res) => {
  const i = instances.get('default');
  if (!i || !i.sock) return res.status(503).json({ error: 'socket indisponível' });
  const all = await i.sock.groupFetchAllParticipating();
  const list = Object.values(all).map(g => ({ id: g.id, subject: g.subject }));
  res.json(list);
}));

app.get('/metrics', auth, (req, res) => {
  const i = instances.get('default');
  if (!i) return res.status(503).json({ error: 'instância default indisponível' });
  const connected = !!(i.sock && i.sock.user);
  res.json({
    service: SERVICE_NAME,
    connected,
    user: connected ? i.sock.user : null,
    startedAt: i.metrics.startedAt,
    counters: {
      sent: i.metrics.sent,
      byType: i.metrics.sent_by_type,
      statusCounts: i.metrics.status_counts
    },
    last: i.metrics.last,
    rate: {
      limit: RATE_MAX_SENDS,
      windowMs: RATE_WINDOW_MS,
      inWindow: i.rateWindow.length
    },
    sessionDir: i.dir
  });
});

app.post('/pair', auth, asyncHandler(async (req, res) => {
  const i = instances.get('default');
  if (!i || !i.sock) return res.status(503).json({ error: 'socket indisponível' });
  const phoneNumberRaw = req.body?.phoneNumber;
  if (!phoneNumberRaw) return res.status(400).json({ error: 'phoneNumber obrigatório (ex: 5544...)' });
  const code = await i.sock.requestPairingCode(String(phoneNumberRaw));
  res.json({ pairingCode: code });
}));

app.post('/exists', auth, asyncHandler(async (req, res) => {
  const i = instances.get('default');
  if (!i || !i.sock) return res.status(503).json({ error: 'socket indisponível' });
  const normalized = normalizeToE164BR(req.body?.to);
  if (!normalized) return res.status(400).json({ error: 'to inválido. Use E.164: 55DDDNUMERO' });
  const results = await i.sock.onWhatsApp(normalized);
  res.json({ results });
}));

app.post('/send-text', auth, asyncHandler(async (req, res) => {
  const i = instances.get('default');
  if (!i || !i.sock) return res.status(503).json({ error: 'socket indisponível' });
  if (!allowSend(i)) return res.status(429).json({ error: 'rate limit exceeded' });

  const { to, message, waitAckMs } = req.body || {};
  if (!to || !message) return res.status(400).json({ error: 'parâmetros to e message são obrigatórios' });

  const normalized = normalizeToE164BR(to);
  if (!normalized) return res.status(400).json({ error: 'to inválido. Use E.164: 55DDDNUMERO' });

  const check = await i.sock.onWhatsApp(normalized);
  const entry = Array.isArray(check) ? check[0] : null;
  if (!entry || !entry.exists) return res.status(404).json({ error: 'número não está no WhatsApp', to: normalized });

  const jid = entry.jid;
  const result = await sendWithTimeout(i, jid, { text: String(message) });
  const id = result?.key?.id || null;

  i.metrics.sent++; i.metrics.sent_by_type.text++; i.metrics.last.sentId = id;

  let status = null;
  const ms = Number(waitAckMs || 0);
  if (id && ms > 0) status = await waitForAck(i, id, Math.min(ms, 20000));

  res.json({ ok: true, id, to: jid, status });
}));

app.post('/send-image', auth, asyncHandler(async (req, res) => {
  const i = instances.get('default');
  if (!i || !i.sock) return res.status(503).json({ error: 'socket indisponível' });
  if (!allowSend(i)) return res.status(429).json({ error: 'rate limit exceeded' });

  const { to, url, caption, waitAckMs } = req.body || {};
  if (!to || !url) return res.status(400).json({ error: 'to e url são obrigatórios' });

  const normalized = normalizeToE164BR(to);
  if (!normalized) return res.status(400).json({ error: 'to inválido. Use E.164: 55DDDNUMERO' });

  const check = await i.sock.onWhatsApp(normalized);
  const entry = Array.isArray(check) ? check[0] : null;
  if (!entry || !entry.exists) return res.status(404).json({ error: 'número não está no WhatsApp', to: normalized });

  const jid = entry.jid;
  const result = await sendWithTimeout(i, jid, { image: { url: String(url) }, caption: caption ? String(caption) : undefined });
  const id = result?.key?.id || null;

  i.metrics.sent++; i.metrics.sent_by_type.image++; i.metrics.last.sentId = id;

  let status = null;
  const ms = Number(waitAckMs || 0);
  if (id && ms > 0) status = await waitForAck(i, id, Math.min(ms, 20000));

  res.json({ ok: true, id, to: jid, status });
}));

app.post('/send-group', auth, asyncHandler(async (req, res) => {
  const i = instances.get('default');
  if (!i || !i.sock) return res.status(503).json({ error: 'socket indisponível' });
  if (!allowSend(i)) return res.status(429).json({ error: 'rate limit exceeded' });

  const { groupId, message, waitAckMs } = req.body || {};
  if (!groupId || !message) return res.status(400).json({ error: 'groupId e message são obrigatórios' });

  const result = await sendWithTimeout(i, String(groupId), { text: String(message) });
  const id = result?.key?.id || null;

  i.metrics.sent++; i.metrics.sent_by_type.group++; i.metrics.last.sentId = id;

  let status = null;
  const ms = Number(waitAckMs || 0);
  if (id && ms > 0) status = await waitForAck(i, id, Math.min(ms, 20000));

  res.json({ ok: true, id, to: String(groupId), status });
}));

app.post('/send-me', auth, asyncHandler(async (req, res) => {
  const i = instances.get('default');
  if (!i || !i.sock || !i.sock.user?.id) return res.status(503).json({ error: 'socket indisponível' });
  if (!allowSend(i)) return res.status(429).json({ error: 'rate limit exceeded' });

  const { message, waitAckMs } = req.body || {};
  if (!message) return res.status(400).json({ error: 'message obrigatório' });

  const result = await sendWithTimeout(i, i.sock.user.id, { text: String(message) });
  const id = result?.key?.id || null;

  i.metrics.sent++; i.metrics.last.sentId = id;

  let status = null;
  const ms = Number(waitAckMs || 0);
  if (id && ms > 0) status = await waitForAck(i, id, Math.min(ms, 20000));

  res.json({ ok: true, id, to: i.sock.user.id, status });
}));

app.post('/send-buttons', auth, asyncHandler(async (req, res) => {
  const i = instances.get('default');
  if (!i || !i.sock) return res.status(503).json({ error: 'socket indisponível' });
  if (!allowSend(i)) return res.status(429).json({ error: 'rate limit exceeded' });

  const { to, text, buttons, waitAckMs } = req.body || {};
  if (!to || !text || !Array.isArray(buttons) || !buttons.length) {
    return res.status(400).json({ error: 'to, text e buttons[] são obrigatórios' });
  }

  const normalized = normalizeToE164BR(to);
  if (!normalized) return res.status(400).json({ error: 'to inválido. Use E.164: 55DDDNUMERO' });

  const check = await i.sock.onWhatsApp(normalized);
  const entry = Array.isArray(check) ? check[0] : null;
  if (!entry || !entry.exists) return res.status(404).json({ error: 'número não está no WhatsApp', to: normalized });
  const jid = entry.jid;

  const cleaned = buttons
    .filter(b => b && (b.text || b.id))
    .slice(0, 3)
    .map((b, idx) => ({
      index: idx + 1,
      quickReplyButton: {
        displayText: String(b.text || b.id).slice(0, 24),
        id: String(b.id || b.text).slice(0, 128)
      }
    }));

  if (!cleaned.length) return res.status(400).json({ error: 'buttons[] sem itens válidos' });

  let id = null;
  let status = null;

  try {
    const result = await sendWithTimeout(i, jid, { text: String(text), templateButtons: cleaned });
    id = result?.key?.id || null;

    i.metrics.sent++;
    i.metrics.sent_by_type.buttons++;
    i.metrics.last.sentId = id;

    const ms = Number(waitAckMs || 0);
    if (id && ms > 0) status = await waitForAck(i, id, Math.min(ms, 20000));

    return res.json({ ok: true, id, to: jid, status });

  } catch (err) {
    const numbered = [
      String(text),
      '',
      ...cleaned.map((b, idx) => `${idx + 1}) ${b.quickReplyButton.displayText}`),
      '',
      'Responda com o número da opção.'
    ].join('\n');

    try {
      const fb = await sendWithTimeout(i, jid, { text: numbered });
      id = fb?.key?.id || null;

      i.metrics.sent++;
      i.metrics.sent_by_type.text++;
      i.metrics.last.sentId = id;

      const ms = Number(waitAckMs || 0);
      if (id && ms > 0) status = await waitForAck(i, id, Math.min(ms, 20000));

      return res.json({ ok: true, id, to: jid, status, fallback: true, error: String(err?.message || err) });
    } catch (err2) {
      return res.status(500).json({ error: 'falha ao enviar buttons e fallback', detail: String(err2?.message || err2) });
    }
  }
}));

app.post('/send-list', auth, asyncHandler(async (req, res) => {
  // Encaminha para a rota por instância (default) sem usar APIs privadas
  req.url = '/instances/default/send-list';
  return app.handle(req, res);
}));

// ---------------------- Error handling ------------------------
app.use((err, req, res, next) => {
  logger.error({ reqId: req?.id, err: err?.message, stack: err?.stack }, 'unhandled.error');
  if (res.headersSent) return next(err);
  res.status(500).json({ error: 'internal_error', detail: err?.message || 'unknown' });
});

// ---------------------- Boot & shutdown -----------------------
let server;

(async () => {
  await fs.mkdir(SESSIONS_ROOT, { recursive: true }).catch(() => {});
  const index = await loadInstancesIndex();
  if (!index.length) {
    await startInstance('default', 'default', { note: '' });
  } else {
    for (const it of index) {
      // se diretório mudou/env var, ainda assim tenta montar por id
      await startInstance(it.id, it.name, it.metadata || { note: '' });
    }
    if (!instances.has('default')) {
      // garante uma default para retrocompat
      await startInstance('default', 'default', { note: '' });
    }
  }
  server = app.listen(PORT, () => logger.info({ port: PORT }, 'http.started'));
})().catch(err => {
  logger.error({ err }, 'boot.failed');
  process.exit(1);
});

async function shutdown(signal) {
  try {
    logger.warn({ signal }, 'shutdown.begin');
    for (const i of instances.values()) {
      i.stopping = true;
      try { i.sock?.end?.(); } catch {}
    }
    server && server.close();
    setTimeout(() => process.exit(0), 500);
  } catch (e) {
    logger.error({ err: e?.message }, 'shutdown.error');
    process.exit(1);
  }
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
