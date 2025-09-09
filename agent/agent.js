import 'dotenv/config';
import express from 'express';
import crypto from 'node:crypto';
import pino from 'pino';
import dayjs from 'dayjs';
import OpenAI from 'openai';
import { z } from 'zod';

// --------------------------- Config ---------------------------
const PORT = Number(process.env.PORT || 8080);
const SERVICE_NAME = process.env.SERVICE_NAME || 'acessus-agent';
const LOG_LEVEL = process.env.LOG_LEVEL || 'info';

const BAILEYS_BASE_URL = process.env.BAILEYS_BASE_URL || '';
const BAILEYS_API_KEY = process.env.BAILEYS_API_KEY || '';
const BAILEYS_WEBHOOK_HMAC_SECRET = process.env.BAILEYS_WEBHOOK_HMAC_SECRET || '';
const DEFAULT_INSTANCE_ID_ENV = process.env.DEFAULT_INSTANCE_ID || '';

const N8N_CHECK_MARGIN_URL = process.env.N8N_CHECK_MARGIN_URL || '';
const N8N_CREATE_LEAD_URL = process.env.N8N_CREATE_LEAD_URL || '';

const OPENAI_API_KEY = process.env.OPENAI_API_KEY || '';
const LLM_MODEL = process.env.LLM_MODEL || 'gpt-4o-mini';

const ADMIN_KEY = process.env.ADMIN_KEY || '';

// Runtime-configurable values (can be overridden by config file)
let REQUEST_TIMEOUT_MS = Number(process.env.REQUEST_TIMEOUT_MS || 10_000);
let REQUEST_RETRIES = Number(process.env.REQUEST_RETRIES || 1);
let BUSINESS_HOURS = process.env.BUSINESS_HOURS || 'Mon-Fri 08:00-20:00';
let DEFAULT_INSTANCE_ID = DEFAULT_INSTANCE_ID_ENV;
let SESSION_TTL_MS = Number(process.env.SESSION_TTL_MS || 86_400_000);

if (!BAILEYS_BASE_URL || !BAILEYS_API_KEY) {
  console.warn('[WARN] Configure BAILEYS_BASE_URL e BAILEYS_API_KEY no .env');
}
if (!OPENAI_API_KEY) console.warn('[WARN] Configure OPENAI_API_KEY no .env');

const logger = pino({ level: LOG_LEVEL, base: { service: SERVICE_NAME } });

// --------------------------- Config (file + schema) -----------
import fs from 'node:fs/promises';
import path from 'node:path';

const CONFIG_PATH = path.join(process.cwd(), 'agent', 'agent.config.json');
let CONFIG = null;

const ConfigSchema = z.object({
  general: z.object({
    timezone: z.string().default('America/Sao_Paulo'),
    businessHours: z.string().default('Mon-Fri 08:00-20:00')
  }).default({}),
  prompt: z.object({
    system: z.string().default('')
  }).default({}),
  templates: z.object({
    outOfHours: z.string().default('Estamos fora do horário de atendimento humano (Seg–Sex 08:00–20:00). Posso seguir com a consulta de margem agora ou prefere falar com um atendente depois? Responda: CONSULTA ou ATENDENTE.'),
    llmError: z.string().default('Desculpe, estou instável agora. Podemos tentar novamente?'),
    toolError: z.string().default('Não consegui executar essa etapa agora. Posso tentar de novo?')
  }).default({}),
  integrations: z.object({
    http: z.object({ requestTimeoutMs: z.number().int().positive().default(10_000), requestRetries: z.number().int().min(0).max(3).default(1) }).default({}),
    n8n: z.object({ checkMarginUrl: z.string().default(''), createLeadUrl: z.string().default('') }).default({})
  }).default({}),
  whatsapp: z.object({ defaultInstanceId: z.string().default('') }).default({}),
  limits: z.object({
    sessionTtlMs: z.number().int().positive().default(86_400_000),
    dedupeTtlMs: z.number().int().positive().default(7_200_000),
    dedupeMax: z.number().int().positive().default(5000),
    historyMax: z.number().int().positive().default(12)
  }).default({})
}).strict();

async function loadConfig() {
  try {
    const raw = await fs.readFile(CONFIG_PATH, 'utf8');
    const json = JSON.parse(raw);
    const parsed = ConfigSchema.parse(json);
    applyConfig(parsed);
    CONFIG = parsed;
  } catch (e) {
    CONFIG = ConfigSchema.parse({
      general: { businessHours: BUSINESS_HOURS },
      prompt: { system: '' },
      templates: {},
      integrations: { http: { requestTimeoutMs: REQUEST_TIMEOUT_MS, requestRetries: REQUEST_RETRIES }, n8n: { checkMarginUrl: N8N_CHECK_MARGIN_URL, createLeadUrl: N8N_CREATE_LEAD_URL } },
      whatsapp: { defaultInstanceId: DEFAULT_INSTANCE_ID },
      limits: { sessionTtlMs: SESSION_TTL_MS, dedupeTtlMs: 2 * 60 * 60 * 1000, dedupeMax: 5000, historyMax: 12 }
    });
    applyConfig(CONFIG);
  }
}

async function saveConfig(newConfig) {
  await fs.mkdir(path.dirname(CONFIG_PATH), { recursive: true }).catch(() => {});
  const data = JSON.stringify(newConfig, null, 2);
  await fs.writeFile(CONFIG_PATH, data);
}

function applyConfig(cfg) {
  BUSINESS_HOURS = cfg.general.businessHours || BUSINESS_HOURS;
  REQUEST_TIMEOUT_MS = cfg.integrations.http.requestTimeoutMs ?? REQUEST_TIMEOUT_MS;
  REQUEST_RETRIES = cfg.integrations.http.requestRetries ?? REQUEST_RETRIES;
  DEFAULT_INSTANCE_ID = cfg.whatsapp.defaultInstanceId || DEFAULT_INSTANCE_ID_ENV;
  SESSION_TTL_MS = cfg.limits.sessionTtlMs ?? SESSION_TTL_MS;
  // Dedupe/limits (only used later, but applied here)
  // These variables will be referenced in dedupe/session cleanup
  globalThis.__DEDUPE_TTL_MS__ = cfg.limits.dedupeTtlMs;
  globalThis.__DEDUPE_MAX__ = cfg.limits.dedupeMax;
  globalThis.__HISTORY_MAX__ = cfg.limits.historyMax;
}

// --------------------------- OpenAI ---------------------------
const openai = new OpenAI({ apiKey: OPENAI_API_KEY });

// --------------------------- App ------------------------------
const app = express();
app.use(express.json({ limit: '2mb' }));

// Log requests simples
app.use((req, res, next) => {
  req.id = crypto.randomUUID();
  const start = Date.now();
  logger.info({ reqId: req.id, method: req.method, url: req.url }, 'request.start');
  res.on('finish', () => {
    logger.info({ reqId: req.id, statusCode: res.statusCode, ms: Date.now() - start }, 'request.end');
  });
  next();
});

// --------------------------- Utils ----------------------------
function timingSafeEqual(a, b) {
  const A = Buffer.from(String(a));
  const B = Buffer.from(String(b));
  if (A.length !== B.length) return false;
  return crypto.timingSafeEqual(A, B);
}
function hmacSignature(body, secret) {
  const h = crypto.createHmac('sha256', String(secret));
  h.update(body);
  return `sha256=${h.digest('hex')}`;
}
function verifyWebhookSignature(req) {
  if (!BAILEYS_WEBHOOK_HMAC_SECRET) return true; // opcional
  try {
    const raw = JSON.stringify(req.body);
    const sent = req.header('X-Signature-256') || '';
    const calc = hmacSignature(raw, BAILEYS_WEBHOOK_HMAC_SECRET);
    return timingSafeEqual(sent, calc);
  } catch {
    return false;
  }
}

// E.164 BR
const E164_BRAZIL = /^55\d{10,11}$/;
function normalizeBRPhone(val) {
  const digits = String(val || '').replace(/\D+/g, '');
  if (digits.startsWith('55') && E164_BRAZIL.test(digits)) return digits;
  if (/^\d{10,11}$/.test(digits)) return `55${digits}`;
  return null;
}

function isValidCPF(cpf) {
  const s = String(cpf || '').replace(/\D/g, '');
  if (!/^\d{11}$/.test(s)) return false;
  if (/^(\d)\1{10}$/.test(s)) return false;
  const calc = (base) => {
    let sum = 0;
    for (let i = 0; i < base.length; i++) sum += parseInt(base[i]) * (base.length + 1 - i);
    const mod = sum % 11;
    return mod < 2 ? 0 : 11 - mod;
  };
  const d1 = calc(s.slice(0, 9));
  const d2 = calc(s.slice(0, 9) + d1);
  return s.endsWith(`${d1}${d2}`);
}

function parseBirthDate(val) {
  const m = String(val || '').match(/(\d{2})[\/\-](\d{2})[\/\-](\d{4})/);
  if (!m) return null;
  const [_, d, mo, y] = m;
  const iso = `${y}-${mo}-${d}`;
  if (!dayjs(iso).isValid()) return null;
  return iso; // YYYY-MM-DD
}

// ---------------------- Sessão e Filas -----------------------
const SESSIONS = new Map(); // chatKey -> { state, slots, history, pausedUntil, lastSeen }
const DEFAULT_STATE = 'START';
const HISTORY_MAX = 12;
const QUEUE = new Map(); // chatKey -> Promise
const CHAT_INSTANCE = new Map(); // chatKey -> instanceId

function getSession(chatKey) {
  let s = SESSIONS.get(chatKey);
  if (!s) {
    s = { state: DEFAULT_STATE, slots: {}, history: [], pausedUntil: 0, lastSeen: Date.now() };
    SESSIONS.set(chatKey, s);
  }
  s.lastSeen = Date.now();
  return s;
}
function pushHistory(session, role, content) {
  session.history.push({ role, content });
  const max = (globalThis.__HISTORY_MAX__ ?? HISTORY_MAX);
  if (session.history.length > max) session.history.shift();
}

// TTL cleanup
setInterval(() => {
  const now = Date.now();
  for (const [k, s] of SESSIONS.entries()) {
    if (now - (s.lastSeen || 0) > SESSION_TTL_MS) SESSIONS.delete(k);
  }
}, Math.min(SESSION_TTL_MS, 30 * 60 * 1000));

// Simple business hours parser: "Mon-Fri 08:00-20:00"
const DOW = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
function isBusinessHours(now = new Date()) {
  try {
    const [days, hours] = BUSINESS_HOURS.split(' ');
    const [hStart, hEnd] = hours.split('-');
    const [startH, startM] = hStart.split(':').map(Number);
    const [endH, endM] = hEnd.split(':').map(Number);
    const dow = DOW[now.getDay()];
    let allowed = false;
    for (const part of days.split(',')) {
      if (part.includes('-')) {
        const [a, b] = part.split('-');
        if (DOW.indexOf(a) <= DOW.indexOf(dow) && DOW.indexOf(dow) <= DOW.indexOf(b)) allowed = true;
      } else if (part === dow) allowed = true;
    }
    const minutes = now.getHours() * 60 + now.getMinutes();
    const minStart = startH * 60 + (startM || 0);
    const minEnd = endH * 60 + (endM || 0);
    return allowed && minutes >= minStart && minutes <= minEnd;
  } catch { return true; }
}

// --------------------- HTTP helpers (retry) ------------------
async function fetchWithRetry(url, opts = {}, retries = REQUEST_RETRIES, timeoutMs = REQUEST_TIMEOUT_MS) {
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const r = await fetch(url, { ...opts, signal: ctrl.signal });
      clearTimeout(t);
      return r;
    } catch (e) {
      clearTimeout(t);
      lastErr = e;
      // retry only on abort or network errors
      const transient = e.name === 'AbortError' || /network/i.test(String(e));
      if (!transient || attempt === retries) throw e;
      await new Promise(res => setTimeout(res, 300 * (attempt + 1)));
    }
  }
  throw lastErr;
}

async function baileysPOST(path, body, instanceId) {
  const base = String(BAILEYS_BASE_URL || '').replace(/\/+$/,'');
  const p = String(path || '');
  const fullPath = p.startsWith('/') ? p : `/${p}`;
  const url = `${base}${fullPath}`;
  const headers = { 'Content-Type': 'application/json', 'x-api-key': BAILEYS_API_KEY };
  if (instanceId) headers['x-instance-id'] = instanceId;
  const r = await fetchWithRetry(url, { method: 'POST', headers, body: JSON.stringify(body) });
  if (!r.ok) {
    const text = await r.text().catch(() => '');
    throw new Error(`Baileys ${path} HTTP ${r.status} ${text}`);
  }
  return r.json();
}
async function n8nPOST(url, body) {
  if (!url) throw new Error('n8n URL não configurada');
  const r = await fetchWithRetry(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  if (!r.ok) {
    const text = await r.text().catch(() => '');
    throw new Error(`n8n HTTP ${r.status} ${text}`);
  }
  return r.json().catch(() => ({}));
}

// --------------------- Send helpers (+sanitize) ---------------
async function sendText(to, message, instanceId, waitAckMs = 8000) {
  const normalized = normalizeBRPhone(to);
  if (!normalized) throw new Error('to inválido');
  return await baileysPOST('/send-text', { to: normalized, message, waitAckMs }, instanceId);
}
async function sendButtons(to, text, buttons, instanceId, waitAckMs = 8000) {
  const normalized = normalizeBRPhone(to);
  if (!normalized) throw new Error('to inválido');
  const safe = (buttons || [])
    .filter(b => b && (b.id || b.text))
    .slice(0, 3)
    .map(b => ({ id: String(b.id || b.text).slice(0,128), text: String(b.text || b.id).slice(0,24) }));
  if (!safe.length) throw new Error('no buttons');
  return await baileysPOST('/send-buttons', { to: normalized, text, buttons: safe, waitAckMs }, instanceId);
}
async function sendList(to, text, buttonText, sections, instanceId, footer = 'Acessus', waitAckMs = 8000) {
  const normalized = normalizeBRPhone(to);
  if (!normalized) throw new Error('to inválido');
  const fixed = (sections || [])
    .map(s => ({
      title: s.title ? String(s.title).slice(0,24) : undefined,
      rows: (s.rows || [])
        .filter(r => r && (r.rowId || r.title))
        .slice(0, 10)
        .map(r => ({
          rowId: String(r.rowId || r.title).slice(0,256),
          title: String(r.title || r.rowId).slice(0,72),
          description: r.description ? String(r.description).slice(0,256) : undefined,
        }))
    }))
    .filter(s => s.rows && s.rows.length);
  if (!fixed.length) throw new Error('sections sem rows válidas');
  const payload = { to: normalized, text, buttonText: String(buttonText).slice(0,24), sections: fixed, footer, waitAckMs };
  return await baileysPOST('/send-list', payload, instanceId);
}

// ------------------------ LLM Tools (zod) --------------------
const Z = {
  send_text: z.object({ to: z.string(), message: z.string() }),
  send_buttons: z.object({
    to: z.string(),
    text: z.string(),
    buttons: z.array(z.object({ id: z.string(), text: z.string() })).min(1).max(3)
  }),
  send_list: z.object({
    to: z.string(),
    text: z.string(),
    buttonText: z.string(),
    footer: z.string().optional(),
    sections: z.array(z.object({
      title: z.string().optional(),
      rows: z.array(z.object({ rowId: z.string(), title: z.string(), description: z.string().optional() })).min(1)
    })).min(1)
  }),
  check_margin: z.object({ cpf: z.string(), matricula: z.string(), nascimento: z.string() }),
  create_lead: z.object({ cpf: z.string(), matricula: z.string().optional(), nascimento: z.string().optional(), origem: z.string().optional(), chatKey: z.string().optional() }),
  get_knowledge: z.object({ query: z.string().optional() })
};

const openAITools = [
  { type: 'function', function: { name: 'send_text', description: 'Enviar texto simples', parameters: { type: 'object', properties: { to: { type: 'string' }, message: { type: 'string' } }, required: ['to','message'] } } },
  { type: 'function', function: { name: 'send_buttons', description: 'Enviar até 3 botões', parameters: { type: 'object', properties: { to: { type: 'string' }, text: { type: 'string' }, buttons: { type: 'array', items: { type: 'object', properties: { id: { type: 'string' }, text: { type: 'string' } }, required: ['id','text'] } } }, required: ['to','text','buttons'] } } },
  { type: 'function', function: { name: 'send_list', description: 'Enviar list message', parameters: { type: 'object', properties: { to: { type: 'string' }, text: { type: 'string' }, buttonText: { type: 'string' }, footer: { type: 'string' }, sections: { type: 'array', items: { type: 'object', properties: { title: { type: 'string' }, rows: { type: 'array', items: { type: 'object', properties: { rowId: { type: 'string' }, title: { type: 'string' }, description: { type: 'string' } }, required: ['rowId','title'] } } }, required: ['rows'] } } }, required: ['to','text','buttonText','sections'] } } },
  { type: 'function', function: { name: 'check_margin', description: 'Consultar margem via n8n', parameters: { type: 'object', properties: { cpf: { type: 'string' }, matricula: { type: 'string' }, nascimento: { type: 'string' } }, required: ['cpf','matricula','nascimento'] } } },
  { type: 'function', function: { name: 'create_lead', description: 'Criar/atualizar lead via n8n', parameters: { type: 'object', properties: { cpf: { type: 'string' }, matricula: { type: 'string' }, nascimento: { type: 'string' }, origem: { type: 'string' }, chatKey: { type: 'string' } }, required: ['cpf','origem','chatKey'] } } },
  { type: 'function', function: { name: 'get_knowledge', description: 'Buscar trecho da base de conhecimento', parameters: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] } } },
];

function systemPrompt() {
  return `Você é um especialista brasileiro em Cartão Benefício da Acessus.\n` +
  `Fale de forma humana, empática e objetiva. Objetivo: coletar CPF, Matrícula e Nascimento para consulta de margem.\n` +
  `Não invente regras. Se necessário, use get_knowledge. Faça uma pergunta por vez.\n` +
  `Respeite horário humano: Seg–Sex 08:00–20:00.\n` +
  `Ferramentas: send_text, send_buttons, send_list, check_margin, create_lead, get_knowledge.\n` +
  `Valide se já temos CPF/Matrícula/Nascimento antes de check_margin.\n` +
  `Limite botões a 3 e títulos curtos.`;
}

function deriveNextState(session) {
  const { slots } = session;
  if (!slots.cpf) return 'GET_CPF';
  if (!slots.matricula) return 'GET_MATRICULA';
  if (!slots.nascimento) return 'GET_NASC';
  if (!slots.confirmed) return 'CONFIRM';
  if (slots.confirmed && !slots.marginChecked) return 'CHECK_MARGIN';
  if (slots.marginChecked) return 'POST_MARGIN';
  return 'START';
}

async function llmDecide({ session, userMsg, chatKey }) {
  const system = systemPrompt();
  const contextMsg = { role: 'system', content: `Estado: ${session.state}\nDados: ${JSON.stringify(session.slots)}\nChat: ${chatKey}` };
  const messages = [ { role: 'system', content: system }, contextMsg, ...session.history.map(h => ({ role: h.role, content: h.content })), { role: 'user', content: userMsg } ];

  const completion = await openai.chat.completions.create({ model: LLM_MODEL, messages, tools: openAITools, tool_choice: 'auto', temperature: 0.4 });
  const msg = completion.choices[0].message;
  if (msg.tool_calls && msg.tool_calls.length) {
    const call = msg.tool_calls[0];
    return { type: 'tool', name: call.function.name, args: JSON.parse(call.function.arguments || '{}') };
  }
  return { type: 'text', message: msg.content || '' };
}

// ------------------- Dedupe de mensagens ---------------------
const DEDUPE = new Map(); // id -> timestamp
function seenAndStore(id) {
  if (!id) return false;
  const now = Date.now();
  const prev = DEDUPE.get(id);
  const ttl = (globalThis.__DEDUPE_TTL_MS__ ?? 2 * 60 * 60 * 1000);
  if (prev && now - prev < ttl) return true;
  DEDUPE.set(id, now);
  const max = (globalThis.__DEDUPE_MAX__ ?? 5000);
  if (DEDUPE.size > max) {
    // trim oldest ~10%
    const arr = [...DEDUPE.entries()].sort((a,b)=>a[1]-b[1]);
    for (let i=0; i<Math.floor(max*0.1); i++) DEDUPE.delete(arr[i][0]);
  }
  return false;
}

// ------------------- Tool dispatcher ------------------------
async function runToolCall(tool, { chatKey, session, instanceId }) {
  const to = chatKey.replace(/@s\.whatsapp\.net$/, '');
  switch (tool.name) {
    case 'send_text': {
      const { to: rawTo, message } = Z.send_text.parse(tool.args);
      await sendText(rawTo || to, message, instanceId);
      return { ok: true };
    }
    case 'send_buttons': {
      const { to: rawTo, text, buttons } = Z.send_buttons.parse(tool.args);
      await sendButtons(rawTo || to, text, buttons, instanceId);
      return { ok: true };
    }
    case 'send_list': {
      const { to: rawTo, text, buttonText, sections, footer } = Z.send_list.parse(tool.args);
      await sendList(rawTo || to, text, buttonText, sections, instanceId, footer);
      return { ok: true };
    }
    case 'check_margin': {
      const { cpf, matricula, nascimento } = Z.check_margin.parse(tool.args);
      if (!isValidCPF(cpf)) return { ok: false, error: 'CPF inválido' };
      const payload = { cpf, matricula, nascimento, chatKey };
      const checkUrl = (CONFIG?.integrations?.n8n?.checkMarginUrl || N8N_CHECK_MARGIN_URL);
      const r = await n8nPOST(checkUrl, payload);
      session.slots.margin = r?.margin ?? null;
      session.slots.marginChecked = true;
      return { ok: true, data: r };
    }
    case 'create_lead': {
      const { cpf, matricula, nascimento, origem, chatKey: ck } = Z.create_lead.parse(tool.args);
      const payload = { cpf, matricula, nascimento, origem: origem || 'WhatsApp — Cartão Benefício', chatKey: ck || chatKey };
      const createUrl = (CONFIG?.integrations?.n8n?.createLeadUrl || N8N_CREATE_LEAD_URL);
      const r = await n8nPOST(createUrl, payload);
      return { ok: true, data: r };
    }
    case 'get_knowledge': {
      return { ok: true, data: { snippets: [] } };
    }
    default:
      return { ok: false, error: 'unknown tool' };
  }
}

// --------------------- Extração de mensagem ------------------
function messageType(m) {
  if (m.message?.conversation) return 'conversation';
  if (m.message?.extendedTextMessage?.text) return 'extendedText';
  if (m.message?.imageMessage) return 'image';
  if (m.message?.buttonsResponseMessage) return 'buttonsResponse';
  if (m.message?.listResponseMessage) return 'listResponse';
  return 'unknown';
}
function messageText(m) {
  return (
    m.message?.conversation ||
    m.message?.extendedTextMessage?.text ||
    m.message?.buttonsResponseMessage?.selectedDisplayText ||
    m.message?.listResponseMessage?.title ||
    ''
  ).trim();
}

function extractIncoming(body) {
  // Prefer iid at top-level if present (Baileys webhook from our server includes it)
  const iid = body?.iid || body?.instanceId || null;

  if (Array.isArray(body) && body.length && body[0]?.chatKey) {
    return body.map(it => ({ id: it.id, fromMe: it.fromMe, chatKey: it.chatKey, text: String(it.text || '').trim(), type: it.type || 'conversation', iid }));
  }
  if (body?.messages && Array.isArray(body.messages)) {
    return body.messages.map((m) => {
      const jid = m.key?.remoteJid;
      const text = messageText(m);
      const type = messageType(m);
      return { id: m.key?.id, fromMe: !!m.key?.fromMe, chatKey: jid, text, type, iid };
    }).filter(x => x.chatKey);
  }
  return [];
}

// --------------------- Processamento por fila ----------------
async function handleEvent(evt) {
  if (!evt.chatKey || evt.fromMe) return;

  // Mapear instância
  if (evt.iid) CHAT_INSTANCE.set(evt.chatKey, evt.iid);
  const instanceId = CHAT_INSTANCE.get(evt.chatKey) || DEFAULT_INSTANCE_ID || undefined;

  const session = getSession(evt.chatKey);

  // Anti-flood / pausa
  const now = Date.now();
  if (session.pausedUntil && now < session.pausedUntil) return;

  const userMsg = String(evt.text || '').trim();
  if (!userMsg) return;

  // Fora do horário comercial – mensagem e pausa curta (ex.: 30 min)
  if (!isBusinessHours(new Date())) {
    const msg = (CONFIG?.templates?.outOfHours || 'Estamos fora do horário de atendimento humano (Seg–Sex 08:00–20:00). Posso seguir com a consulta de margem agora ou prefere falar com um atendente depois? Responda: CONSULTA ou ATENDENTE.');
    try { await sendText(evt.chatKey.replace(/@s\.whatsapp\.net$/, ''), msg, instanceId); } catch {}
    // não interrompe o fluxo; apenas avisa
  }

  pushHistory(session, 'user', userMsg);

  // Regras locais para populacao de slots
  if (!session.slots.cpf) {
    const cpf = userMsg.replace(/\D/g, '');
    if (isValidCPF(cpf)) session.slots.cpf = cpf;
  }
  if (!session.slots.nascimento) {
    const iso = parseBirthDate(userMsg);
    if (iso) session.slots.nascimento = iso;
  }
  if (!session.slots.matricula) {
    const mat = userMsg.match(/\b\d{5,}\b/);
    if (mat) session.slots.matricula = mat[0];
  }
  if (/^(sim|confirmo|isso|ok)$/i.test(userMsg) && !session.slots.confirmed && session.slots.cpf && session.slots.matricula && session.slots.nascimento) {
    session.slots.confirmed = true;
  }

  session.state = deriveNextState(session);

  // 1) Decisão via LLM
  let decision;
  try {
    decision = await llmDecide({ session, userMsg, chatKey: evt.chatKey });
  } catch (e) {
    logger.error({ err: e?.message, chatKey: evt.chatKey }, 'llm.error');
    const msg = (CONFIG?.templates?.llmError || 'Desculpe, estou instável agora. Podemos tentar novamente?');
    try { await sendText(evt.chatKey.replace(/@s\.whatsapp\.net$/, ''), msg, instanceId); } catch {}
    return;
  }

  // 2) Executa ferramenta ou envia texto
  if (decision.type === 'tool') {
    try {
      const r = await runToolCall(decision, { chatKey: evt.chatKey, session, instanceId });
      pushHistory(session, 'assistant', `[Ferramenta ${decision.name} ⇒ ${r.ok ? 'ok' : 'erro'}]`);
      if (decision.name === 'check_margin') {
        const follow = await llmDecide({ session, userMsg: 'resultado da margem disponível recebido', chatKey: evt.chatKey });
        if (follow.type === 'tool') await runToolCall(follow, { chatKey: evt.chatKey, session, instanceId });
        else if (follow.type === 'text' && follow.message) {
          await sendText(evt.chatKey.replace(/@s\.whatsapp\.net$/, ''), follow.message, instanceId);
          pushHistory(session, 'assistant', follow.message);
        }
      }
    } catch (e) {
      logger.error({ tool: decision.name, err: e?.message, chatKey: evt.chatKey }, 'tool.error');
      const msg = (CONFIG?.templates?.toolError || 'Não consegui executar essa etapa agora. Posso tentar de novo?');
      try { await sendText(evt.chatKey.replace(/@s\.whatsapp\.net$/, ''), msg, instanceId); } catch {}
    }
  } else if (decision.type === 'text') {
    if (decision.message) {
      await sendText(evt.chatKey.replace(/@s\.whatsapp\.net$/, ''), decision.message, instanceId);
      pushHistory(session, 'assistant', decision.message);
    }
  }
}

function enqueueByChat(evt) {
  const key = evt.chatKey;
  const prev = QUEUE.get(key) || Promise.resolve();
  const task = prev.then(async () => {
    try { await handleEvent(evt); } finally { /* noop */ }
  });
  QUEUE.set(key, task.finally(() => {
    // prevent unbounded growth
    if (QUEUE.get(key) === task) setTimeout(() => QUEUE.delete(key), 2000);
  }));
}

// ---------------------- Webhook de entrada -------------------
app.post('/webhook/baileys', async (req, res) => {
  try {
    if (!verifyWebhookSignature(req)) {
      return res.status(401).json({ ok: false, error: 'invalid signature' });
    }
    const incoming = extractIncoming(req.body);
    if (!incoming.length) return res.json({ ok: true, received: 0 });

    let received = 0;
    for (const evt of incoming) {
      if (seenAndStore(evt.id)) continue;
      received++;
      enqueueByChat(evt);
    }
    res.json({ ok: true, received });
  } catch (e) {
    logger.error({ err: e?.message }, 'webhook.handler.error');
    res.status(500).json({ ok: false, error: 'internal_error' });
  }
});

// Health + basic metrics
let METRIC = { webhook_calls: 0 };
app.use((req, _res, next) => { if (req.path === '/webhook/baileys') METRIC.webhook_calls++; next(); });
app.get('/health', (req, res) => res.json({ ok: true, service: SERVICE_NAME }));
app.get('/metrics', (req, res) => res.json({ sessions: SESSIONS.size, queueSize: QUEUE.size, dedupeSize: DEDUPE.size, webhookCalls: METRIC.webhook_calls }));

// ---------------------- Admin Config API ---------------------
function adminAuth(req, res, next) {
  if (!ADMIN_KEY) {
    if (process.env.NODE_ENV === 'development') return next();
    return res.status(403).json({ ok: false, error: 'admin_disabled' });
  }
  const k = req.header('x-admin-key') || '';
  if (timingSafeEqual(k, ADMIN_KEY)) return next();
  return res.status(401).json({ ok: false, error: 'unauthorized' });
}

app.get('/admin/config', adminAuth, (req, res) => {
  res.json({ config: CONFIG });
});

app.put('/admin/config', adminAuth, express.json({ limit: '1mb' }), async (req, res) => {
  try {
    const parsed = ConfigSchema.parse(req.body?.config || {});
    applyConfig(parsed);
    CONFIG = parsed;
    await saveConfig(parsed);
    res.json({ ok: true, config: CONFIG });
  } catch (e) {
    res.status(400).json({ ok: false, error: 'invalid_config', detail: String(e?.message || e) });
  }
});

await loadConfig();
app.listen(PORT, () => logger.info({ port: PORT }, 'agent.started'));

// ---------------------- Admin Panel (UI) ---------------------
app.get('/', (req, res) => res.redirect(302, '/admin'));
app.get('/admin', (req, res) => {
  res.type('html').send(`<!doctype html>
<html lang="pt-br">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Acessus Agent — Admin</title>
  <style>
    :root {
      --bg: #0b1220; --card: #0f172a; --muted: #94a3b8; --text: #e2e8f0; --accent: #22c55e; --danger: #ef4444; --border:#1f2937;
      --btn:#1f2937; --btn-hover:#334155; --input:#0b1220; --radius: 14px;
    }
    * { box-sizing: border-box }
    body { margin: 0; font: 15px/1.45 system-ui, -apple-system, Segoe UI, Roboto, Ubuntu, Cantarell, Noto Sans, sans-serif; background: radial-gradient(1200px 800px at 10% -10%, #0b1220 0, #0b1220 35%, #0a1328 60%, #09122a 100%); color: var(--text) }
    .wrap { max-width: 1080px; margin: 0 auto; padding: 28px }
    header { display:flex; align-items:center; justify-content:space-between; margin-bottom: 18px }
    .brand { font-weight:700; font-size:20px; letter-spacing:.3px }
    .badge { font-size:12px; padding:4px 10px; border-radius:999px; background:#0b1325; color: var(--muted); border:1px solid var(--border) }
    .grid { display:grid; gap:16px }
    @media(min-width: 900px){ .grid-2 { grid-template-columns: 1fr 1fr } }
    .card { background: linear-gradient(180deg, #0f172a, #0d1528); border:1px solid var(--border); border-radius: var(--radius); padding:18px; box-shadow: inset 0 1px rgba(255,255,255,.02) }
    .title { font-weight:600; margin:0 0 12px; font-size:14px; color:#cbd5e1 }
    .row { display:flex; gap:10px; align-items:center }
    .label { color: var(--muted); font-size:12px; margin-bottom:6px }
    input[type="text"], input[type="number"], textarea { width:100%; background: var(--input); border:1px solid var(--border); color: var(--text); padding:10px 12px; border-radius:12px; outline:none }
    textarea { min-height: 88px; resize: vertical }
    .hint { color: var(--muted); font-size:12px }
    .btn { background: var(--btn); color: var(--text); border:1px solid var(--border); padding:10px 14px; border-radius:12px; cursor:pointer }
    .btn:hover { background: var(--btn-hover) }
    .btn.primary { background: #16a34a; border-color: #16a34a }
    .btn.primary:hover { background: #22c55e }
    .btn.ghost { background: transparent }
    .toolbar { display:flex; gap:10px; align-items:center; flex-wrap: wrap }
    .ok { color:#22c55e }
    .err { color:#ef4444 }
    .spacer { flex:1 }
    .footer { margin-top: 20px; color: var(--muted); font-size:12px; display:flex; align-items:center; gap:8px }
    .pill { padding:3px 8px; border-radius:999px; border:1px solid var(--border); background:#0b1325; color: #9ca3af; font-size:11px }
  </style>
</head>
<body>
  <div class="wrap">
    <header>
      <div class="brand">Acessus Agent — Admin</div>
      <div class="toolbar">
        <span id="status" class="badge">Pronto</span>
        <div class="row">
          <input id="adminKey" type="text" placeholder="x-admin-key" style="width:260px" />
          <button class="btn" id="btnUseKey">Usar</button>
        </div>
      </div>
    </header>

    <div class="grid grid-2">
      <section class="card">
        <h3 class="title">Geral</h3>
        <label class="label">Business Hours</label>
        <input id="businessHours" type="text" placeholder="Mon-Fri 08:00-20:00" />
        <div class="hint">Faixas simples, ex: Mon-Fri 08:00-20:00; Tue,Thu 09:00-17:00</div>
      </section>

      <section class="card">
        <h3 class="title">WhatsApp</h3>
        <label class="label">Instância padrão</label>
        <input id="defaultInstanceId" type="text" placeholder="default" />
        <div class="hint">Usada quando o webhook não informar a instância.</div>
      </section>

      <section class="card">
        <h3 class="title">Prompt do Agente</h3>
        <textarea id="promptSystem" placeholder="Texto do sistema (substitui o padrão)"></textarea>
      </section>

      <section class="card">
        <h3 class="title">Templates</h3>
        <label class="label">Fora de horário</label>
        <textarea id="tplOutOfHours"></textarea>
        <label class="label" style="margin-top:10px">Erro do LLM</label>
        <textarea id="tplLlmError"></textarea>
        <label class="label" style="margin-top:10px">Erro de ferramenta</label>
        <textarea id="tplToolError"></textarea>
      </section>

      <section class="card">
        <h3 class="title">Integrações HTTP</h3>
        <div class="row">
          <div style="flex:1">
            <label class="label">Timeout (ms)</label>
            <input id="httpTimeout" type="number" min="1000" step="500" />
          </div>
          <div style="width:180px">
            <label class="label">Retries</label>
            <input id="httpRetries" type="number" min="0" max="3" />
          </div>
        </div>
        <div style="height:10px"></div>
        <label class="label">n8n — Check Margin URL</label>
        <input id="n8nCheck" type="text" placeholder="https://n8n/webhook/check-margin" />
        <label class="label" style="margin-top:10px">n8n — Create Lead URL</label>
        <input id="n8nCreate" type="text" placeholder="https://n8n/webhook/create-lead" />
      </section>

      <section class="card">
        <h3 class="title">Limites</h3>
        <div class="row">
          <div style="flex:1">
            <label class="label">Session TTL (ms)</label>
            <input id="limitSessionTtl" type="number" min="60000" step="60000" />
          </div>
          <div style="flex:1">
            <label class="label">Dedupe TTL (ms)</label>
            <input id="limitDedupeTtl" type="number" min="60000" step="60000" />
          </div>
        </div>
        <div class="row" style="margin-top:10px">
          <div style="flex:1">
            <label class="label">Dedupe Max</label>
            <input id="limitDedupeMax" type="number" min="100" step="100" />
          </div>
          <div style="flex:1">
            <label class="label">History Max</label>
            <input id="limitHistoryMax" type="number" min="4" step="1" />
          </div>
        </div>
      </section>

      <section class="card">
        <h3 class="title">Ações</h3>
        <div class="toolbar">
          <button class="btn" id="btnLoad">Carregar</button>
          <button class="btn primary" id="btnSave">Salvar</button>
          <button class="btn" id="btnReset">Restaurar padrão</button>
          <span class="spacer"></span>
          <button class="btn ghost" id="btnExport">Exportar</button>
          <label class="btn ghost">
            Importar <input id="fileImport" type="file" accept="application/json" style="display:none" />
          </label>
        </div>
      </section>

      <section class="card" style="grid-column: 1 / -1">
        <h3 class="title">Pré‑visualização</h3>
        <pre id="preview" style="white-space:pre-wrap; background:#0b1325; border:1px solid var(--border); padding:12px; border-radius:12px; color:#9ca3af; max-height:260px; overflow:auto"></pre>
      </section>
    </div>

    <div class="footer">
      <span class="pill">Acessus</span>
      <span class="pill">Agent Admin</span>
      <span class="pill">Fintech‑grade UX</span>
    </div>
  </div>

<script>
const els = {
  status: document.getElementById('status'),
  adminKey: document.getElementById('adminKey'),
  btnUseKey: document.getElementById('btnUseKey'),
  businessHours: document.getElementById('businessHours'),
  defaultInstanceId: document.getElementById('defaultInstanceId'),
  promptSystem: document.getElementById('promptSystem'),
  tplOutOfHours: document.getElementById('tplOutOfHours'),
  tplLlmError: document.getElementById('tplLlmError'),
  tplToolError: document.getElementById('tplToolError'),
  httpTimeout: document.getElementById('httpTimeout'),
  httpRetries: document.getElementById('httpRetries'),
  n8nCheck: document.getElementById('n8nCheck'),
  n8nCreate: document.getElementById('n8nCreate'),
  limitSessionTtl: document.getElementById('limitSessionTtl'),
  limitDedupeTtl: document.getElementById('limitDedupeTtl'),
  limitDedupeMax: document.getElementById('limitDedupeMax'),
  limitHistoryMax: document.getElementById('limitHistoryMax'),
  btnLoad: document.getElementById('btnLoad'),
  btnSave: document.getElementById('btnSave'),
  btnReset: document.getElementById('btnReset'),
  btnExport: document.getElementById('btnExport'),
  fileImport: document.getElementById('fileImport'),
  preview: document.getElementById('preview')
};

els.adminKey.value = localStorage.getItem('x_admin_key') || '';

function setStatus(msg, ok=true){
  els.status.textContent = msg;
  els.status.style.color = ok ? 'var(--text)' : 'var(--danger)';
}

function headers(){
  const h = { 'Content-Type':'application/json' };
  const k = els.adminKey.value.trim();
  if (k) h['x-admin-key'] = k;
  return h;
}

async function getConfig(){
  const r = await fetch('/admin/config', { headers: headers(), cache:'no-store' });
  if (!r.ok) throw new Error('HTTP '+r.status);
  return r.json();
}
async function putConfig(config){
  const r = await fetch('/admin/config', { method:'PUT', headers: headers(), body: JSON.stringify({ config }) });
  if (!r.ok) throw new Error('HTTP '+r.status+': '+await r.text());
  return r.json();
}

function fillForm(cfg){
  els.businessHours.value = cfg.general?.businessHours || '';
  els.defaultInstanceId.value = cfg.whatsapp?.defaultInstanceId || '';
  els.promptSystem.value = cfg.prompt?.system || '';
  els.tplOutOfHours.value = (cfg.templates?.outOfHours || '');
  els.tplLlmError.value = (cfg.templates?.llmError || '');
  els.tplToolError.value = (cfg.templates?.toolError || '');
  els.httpTimeout.value = cfg.integrations?.http?.requestTimeoutMs ?? 10000;
  els.httpRetries.value = cfg.integrations?.http?.requestRetries ?? 1;
  els.n8nCheck.value = cfg.integrations?.n8n?.checkMarginUrl || '';
  els.n8nCreate.value = cfg.integrations?.n8n?.createLeadUrl || '';
  els.limitSessionTtl.value = cfg.limits?.sessionTtlMs ?? 86400000;
  els.limitDedupeTtl.value = cfg.limits?.dedupeTtlMs ?? 7200000;
  els.limitDedupeMax.value = cfg.limits?.dedupeMax ?? 5000;
  els.limitHistoryMax.value = cfg.limits?.historyMax ?? 12;
  renderPreview();
}

function readForm(){
  const cfg = {
    general: { businessHours: els.businessHours.value.trim(), timezone: 'America/Sao_Paulo' },
    prompt: { system: els.promptSystem.value },
    templates: {
      outOfHours: els.tplOutOfHours.value,
      llmError: els.tplLlmError.value,
      toolError: els.tplToolError.value
    },
    integrations: {
      http: { requestTimeoutMs: Number(els.httpTimeout.value||10000), requestRetries: Number(els.httpRetries.value||1) },
      n8n: { checkMarginUrl: els.n8nCheck.value.trim(), createLeadUrl: els.n8nCreate.value.trim() }
    },
    whatsapp: { defaultInstanceId: els.defaultInstanceId.value.trim() },
    limits: {
      sessionTtlMs: Number(els.limitSessionTtl.value||86400000),
      dedupeTtlMs: Number(els.limitDedupeTtl.value||7200000),
      dedupeMax: Number(els.limitDedupeMax.value||5000),
      historyMax: Number(els.limitHistoryMax.value||12)
    }
  };
  return cfg;
}

function renderPreview(){
  const cfg = readForm();
  els.preview.textContent = JSON.stringify(cfg, null, 2);
}

['businessHours','defaultInstanceId','promptSystem','tplOutOfHours','tplLlmError','tplToolError','httpTimeout','httpRetries','n8nCheck','n8nCreate','limitSessionTtl','limitDedupeTtl','limitDedupeMax','limitHistoryMax']
.forEach(id => { els[id].addEventListener('input', renderPreview); });

els.btnUseKey.onclick = () => {
  localStorage.setItem('x_admin_key', els.adminKey.value.trim());
  setStatus('Chave aplicada');
};

els.btnLoad.onclick = async () => {
  try {
    const data = await getConfig();
    fillForm(data.config || {});
    setStatus('Config carregada');
  } catch(e){ setStatus('Falha ao carregar: '+e.message, false); }
};

els.btnSave.onclick = async () => {
  try {
    const cfg = readForm();
    await putConfig(cfg);
    setStatus('Config salva', true);
  } catch(e){ setStatus('Falha ao salvar: '+e.message, false); }
};

els.btnReset.onclick = () => {
  fillForm({
    general:{ businessHours:'Mon-Fri 08:00-20:00' },
    prompt:{ system:'' },
    templates:{ outOfHours:'Estamos fora do horário de atendimento humano (Seg–Sex 08:00–20:00). Posso seguir com a consulta de margem agora ou prefere falar com um atendente depois? Responda: CONSULTA ou ATENDENTE.', llmError:'Desculpe, estou instável agora. Podemos tentar novamente?', toolError:'Não consegui executar essa etapa agora. Posso tentar de novo?' },
    integrations:{ http:{ requestTimeoutMs:10000, requestRetries:1 }, n8n:{ checkMarginUrl:'', createLeadUrl:'' } },
    whatsapp:{ defaultInstanceId:'default' },
    limits:{ sessionTtlMs:86400000, dedupeTtlMs:7200000, dedupeMax:5000, historyMax:12 }
  });
  setStatus('Valores padrão restaurados');
};

els.btnExport.onclick = () => {
  const cfg = readForm();
  const blob = new Blob([JSON.stringify(cfg, null, 2)], { type:'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'agent.config.json'; a.click();
};

els.fileImport.onchange = async (ev) => {
  const f = ev.target.files?.[0]; if (!f) return;
  const text = await f.text().catch(()=>null); if (!text) return;
  try { const cfg = JSON.parse(text); fillForm(cfg); setStatus('Config carregada do arquivo'); }
  catch(e){ setStatus('JSON inválido: '+e.message, false) }
};

// Auto-load on open
els.btnLoad.click();
</script>
</body>
</html>`);
});
