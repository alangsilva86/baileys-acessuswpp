import pino from 'pino';
import {
  DisconnectReason,
  fetchLatestBaileysVersion,
  makeWASocket,
  useMultiFileAuthState,
} from '@whiskeysockets/baileys';
import type { BaileysEventMap } from '@whiskeysockets/baileys';
import { recordMetricsSnapshot } from './utils.js';
import { type Instance, resetInstanceSession } from './instanceManager.js';
import { MessageService } from './baileys/messageService.js';
import { PollService } from './baileys/pollService.js';
import { WebhookClient } from './services/webhook.js';
import { brokerEventStore } from './broker/eventStore.js';
import { filterClientMessages } from './baileys/messageUtils.js';

const logger = pino({ level: process.env.LOG_LEVEL || 'info' });

const RECONNECT_MIN_DELAY_MS = 1_000;
const RECONNECT_MAX_DELAY_MS = 30_000;

const DEFAULT_STATUS_TTL_MS = 10 * 60_000;
const DEFAULT_STATUS_SWEEP_INTERVAL_MS = 60_000;
const FINAL_STATUS_THRESHOLD = 3;
const FINAL_STATUS_CODES = new Set([0]);

function dec(inst: Instance, status: number): void {
  const key = String(status);
  const cur = inst.metrics.status_counts[key] || 0;
  inst.metrics.status_counts[key] = cur > 0 ? cur - 1 : 0;
}
function inc(inst: Instance, status: number): void {
  const key = String(status);
  inst.metrics.status_counts[key] = (inst.metrics.status_counts[key] || 0) + 1;
}
function parsePosInt(v: string | undefined, fb: number): number {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : fb;
}
const STATUS_TTL_MS = parsePosInt(process.env.STATUS_TTL_MS, DEFAULT_STATUS_TTL_MS);
const STATUS_SWEEP_INTERVAL_MS = parsePosInt(process.env.STATUS_SWEEP_INTERVAL_MS, DEFAULT_STATUS_SWEEP_INTERVAL_MS);

function isFinal(status: number): boolean {
  return status >= FINAL_STATUS_THRESHOLD || FINAL_STATUS_CODES.has(status);
}
function removeStatus(inst: Instance, messageId: string): void {
  if (!inst.statusMap.has(messageId)) return;
  const prev = inst.statusMap.get(messageId);
  recordMetricsSnapshot(inst);
  if (prev != null) dec(inst, prev);
  inst.statusMap.delete(messageId);
  inst.statusTimestamps.delete(messageId);
  inst.ackSentAt.delete(messageId);
}
function prune(inst: Instance): void {
  if (!inst.statusMap.size) return;
  const now = Date.now();
  for (const [mid, status] of inst.statusMap.entries()) {
    const updatedAt = inst.statusTimestamps.get(mid) ?? 0;
    if (isFinal(status) || now - updatedAt >= STATUS_TTL_MS) removeStatus(inst, mid);
  }
}
function ensureCleanup(inst: Instance): void {
  if (inst.statusCleanupTimer) return;
  inst.statusCleanupTimer = setInterval(() => prune(inst), STATUS_SWEEP_INTERVAL_MS);
}

const API_KEYS = String(process.env.API_KEY || 'change-me').split(',').map((s) => s.trim()).filter(Boolean);

export interface InstanceContext {
  messageService: MessageService;
  pollService: PollService;
  webhook: WebhookClient;
}

function updateConnectionState(inst: Instance, state: Instance['connectionState']): void {
  inst.connectionState = state;
  inst.connectionUpdatedAt = Date.now();
}

export async function startWhatsAppInstance(inst: Instance): Promise<Instance> {
  const { state, saveCreds } = await useMultiFileAuthState(inst.dir);
  const { version } = await fetchLatestBaileysVersion();
  logger.info({ iid: inst.id, version }, 'baileys.version');

  if (inst.reconnectTimer) {
    try {
      clearTimeout(inst.reconnectTimer);
    } catch {
      // ignore
    }
    inst.reconnectTimer = null;
  }

  inst.socketId += 1;
  const currentSocketId = inst.socketId;
  updateConnectionState(inst, 'connecting');
  let resetScheduledForSocket = false;

  const sock = makeWASocket({ version, auth: state, logger });
  inst.sock = sock;
  inst.context = null;

  sock.ev.on('creds.update', saveCreds);

  const webhook = new WebhookClient({
    instanceId: inst.id,
    logger,
    hmacSecret: process.env.WEBHOOK_HMAC_SECRET || API_KEYS[0] || null,
    eventStore: brokerEventStore,
  });

  const messageService = new MessageService(sock, webhook, logger, { eventStore: brokerEventStore, instanceId: inst.id });
  const pollService = new PollService(sock, webhook, logger, { messageService, eventStore: brokerEventStore, instanceId: inst.id });

  inst.context = { messageService, pollService, webhook };
  inst.stopping = false;

  const hasEnc =
    !!process.env.POLL_METADATA_ENCRYPTION_KEY ||
    !!process.env.APP_ENCRYPTION_SECRET ||
    !!process.env.APP_ENCRYPTION_KEY;

  if (!hasEnc) {
    logger.warn({ iid: inst.id }, 'secret.encryption.missing — poll enc keys may not decrypt across restarts');
  }

  sock.ev.on('connection.update', (update: any) => {
    const { connection, lastDisconnect, qr, receivedPendingNotifications } = update;
    const iid = inst.id;

    if (inst.socketId !== currentSocketId) return;

    if (qr) { inst.lastQR = qr; logger.info({ iid }, 'qr.updated'); }
    if (connection === 'connecting') { updateConnectionState(inst, 'connecting'); }
    if (connection === 'open') {
      updateConnectionState(inst, 'open');
      inst.lastQR = null;
      inst.reconnectDelay = RECONNECT_MIN_DELAY_MS;
      logger.info({ iid, receivedPendingNotifications }, 'whatsapp.connected');
    }

    if (connection === 'close') {
      updateConnectionState(inst, 'close');
      const statusCode = lastDisconnect?.error?.output?.statusCode;
      const isLoggedOut = statusCode === DisconnectReason.loggedOut;
      logger.warn({ iid, statusCode }, 'whatsapp.disconnected');

      if (!inst.stopping && !isLoggedOut) {
        const delay = Math.min(inst.reconnectDelay, RECONNECT_MAX_DELAY_MS);
        logger.warn({ iid, delay }, 'whatsapp.reconnect.scheduled');

        if (inst.reconnectTimer) clearTimeout(inst.reconnectTimer);

        inst.reconnectTimer = setTimeout(() => {
          if (inst.socketId !== currentSocketId) return;
          inst.reconnectTimer = null;
          inst.reconnectDelay = Math.min(inst.reconnectDelay * 2, RECONNECT_MAX_DELAY_MS);
          startWhatsAppInstance(inst).catch((err) => logger.error({ iid, err }, 'whatsapp.reconnect.failed'));
        }, delay);
      } else if (isLoggedOut) {
        if (inst.stopping) {
          logger.info({ iid }, 'session.resetSkipped.stopping');
        } else if (!resetScheduledForSocket) {
          resetScheduledForSocket = true;
          logger.error({ iid }, 'session.loggedOut');
          inst.lastQR = null;
          updateConnectionState(inst, 'connecting');
          logger.warn({ iid }, 'session.resetScheduled');
          void resetInstanceSession(inst);
        } else {
          logger.debug({ iid }, 'session.resetScheduled.duplicate');
        }
      }

      inst.sock = null;
      inst.context = null;
    }
  });

  // messages.upsert — PollService antes do MessageService
  sock.ev.on('messages.upsert', async (evt: BaileysEventMap['messages.upsert']) => {
    const raw = evt.messages || [];
    const filtered = filterClientMessages(raw);
    const normalized: BaileysEventMap['messages.upsert'] = { ...evt, messages: filtered };

    const rawCount = raw.length;
    const count = filtered.length;
    const iid = inst.id;
    logger.info({ iid, type: evt.type, count, rawCount }, 'messages.upsert');

    if (count) {
      for (const m of filtered) {
        const from = m.key?.remoteJid;
        const t = m.message?.templateButtonReplyMessage;
        const b = m.message?.buttonsResponseMessage;
        if (t || b) {
          const selectedId = t?.selectedId ?? b?.selectedButtonId ?? null;
          const selectedText = t?.selectedDisplayText ?? b?.selectedDisplayText ?? null;
          logger.info({ iid, from, selectedId, selectedText }, 'button.reply');
        }
        const list = m.message?.listResponseMessage;
        if (list) {
          logger.info({ iid, from, selectedId: list?.singleSelectReply?.selectedRowId, selectedTitle: list?.title }, 'list.reply');
        }
      }
    }

    try { await pollService.onMessageUpsert(evt); } catch (err: any) { logger.warn({ iid, err: err?.message }, 'poll.service.messages.upsert.failed'); }
    try { await messageService.onMessagesUpsert(normalized); } catch (err: any) { logger.warn({ iid, err: err?.message }, 'message.service.messages.upsert.failed'); }
    try { await webhook.emit('WHATSAPP_MESSAGES_UPSERT', { iid, raw: evt, normalized, messages: filtered }); }
    catch (err: any) { logger.warn({ iid, err: err?.message }, 'webhook.emit.messages.upsert.failed'); }
  });

  // messages.update — processa, atualiza métricas, emite webhook
  sock.ev.on('messages.update', async (updates: BaileysEventMap['messages.update']) => {
    const iid = inst.id;

    try { await pollService.onMessageUpdate(updates); } catch (err: any) { logger.warn({ iid, err: err?.message }, 'poll.service.messages.update.failed'); }

    for (const u of updates) {
      const mid = u.key?.id;
      const status = u.update?.status;
      if (mid && status != null) {
        const prev = inst.statusMap.get(mid);
        if (prev != null && prev !== status) dec(inst, prev);

        inst.statusMap.set(mid, status);
        inst.statusTimestamps.set(mid, Date.now());
        ensureCleanup(inst);
        inc(inst, status);

        inst.metrics.last.lastStatusId = mid;
        inst.metrics.last.lastStatusCode = status;

        let snap = false;
        const ensureSnap = () => { if (!snap) { recordMetricsSnapshot(inst); snap = true; } };

        if (status >= 2 && inst.ackSentAt?.has(mid)) {
          const sentAt = inst.ackSentAt.get(mid);
          inst.ackSentAt.delete(mid);
          if (sentAt) {
            const delta = Math.max(0, Date.now() - sentAt);
            inst.metrics.ack.totalMs += delta;
            inst.metrics.ack.count += 1;
            inst.metrics.ack.lastMs = delta;
            inst.metrics.ack.avgMs = Math.round(inst.metrics.ack.totalMs / Math.max(inst.metrics.ack.count, 1));
          }
        }

        ensureSnap();

        const waiter = inst.ackWaiters.get(mid);
        if (waiter) {
          clearTimeout(waiter.timer);
          inst.ackWaiters.delete(mid);
          waiter.resolve(status);
        }

        if (isFinal(status)) {
          ensureSnap();
          removeStatus(inst, mid);
        }
      }

      logger.info({ iid, mid, status }, 'messages.status');
    }

    try { await webhook.emit('WHATSAPP_MESSAGES_UPDATE', { iid, raw: { updates } }); }
    catch (err: any) { logger.warn({ iid, err: err?.message }, 'webhook.emit.messages.update.failed'); }
  });

  recordMetricsSnapshot(inst, true);
  return inst;
}

export async function stopWhatsAppInstance(inst: Instance | undefined, { logout = false }: { logout?: boolean } = {}): Promise<void> {
  if (!inst) return;
  inst.stopping = true;
  inst.socketId += 1;
  inst.context = null;
  updateConnectionState(inst, 'close');
  inst.reconnectDelay = RECONNECT_MIN_DELAY_MS;

  if (inst.reconnectTimer) {
    try {
      clearTimeout(inst.reconnectTimer);
    } catch {}
    inst.reconnectTimer = null;
  }
  if (inst.statusCleanupTimer) {
    try {
      clearInterval(inst.statusCleanupTimer);
    } catch {}
    inst.statusCleanupTimer = null;
  }

  inst.lastQR = null;

  const sock = inst.sock;
  inst.sock = null;

  if (logout && sock) {
    try {
      await sock.logout().catch(() => undefined);
    } catch {}
  }
  try {
    sock?.end?.(undefined);
  } catch {}
}
