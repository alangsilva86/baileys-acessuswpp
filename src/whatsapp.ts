import pino from 'pino';
import {
  DisconnectReason,
  fetchLatestBaileysVersion,
  makeWASocket,
  useMultiFileAuthState,
} from '@whiskeysockets/baileys';
import type { BaileysEventMap } from '@whiskeysockets/baileys';
import { recordMetricsSnapshot } from './utils.js';
import type { Instance } from './instanceManager.js';
import { MessageService } from './baileys/messageService.js';
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

function decrementStatusCount(inst: Instance, status: number): void {
  const key = String(status);
  const current = inst.metrics.status_counts[key] || 0;
  inst.metrics.status_counts[key] = current > 0 ? current - 1 : 0;
}

function incrementStatusCount(inst: Instance, status: number): void {
  const key = String(status);
  inst.metrics.status_counts[key] = (inst.metrics.status_counts[key] || 0) + 1;
}

function parsePositiveInt(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  if (Number.isFinite(parsed) && parsed > 0) return parsed;
  return fallback;
}

const STATUS_TTL_MS = parsePositiveInt(process.env.STATUS_TTL_MS, DEFAULT_STATUS_TTL_MS);
const STATUS_SWEEP_INTERVAL_MS = parsePositiveInt(
  process.env.STATUS_SWEEP_INTERVAL_MS,
  DEFAULT_STATUS_SWEEP_INTERVAL_MS,
);

function isFinalStatus(status: number): boolean {
  return status >= FINAL_STATUS_THRESHOLD || FINAL_STATUS_CODES.has(status);
}

function removeMessageStatus(
  inst: Instance,
  messageId: string,
  { recordSnapshot = true }: { recordSnapshot?: boolean } = {},
): void {
  if (!inst.statusMap.has(messageId)) return;
  const previous = inst.statusMap.get(messageId);
  if (recordSnapshot) {
    recordMetricsSnapshot(inst);
  }
  if (previous != null) {
    decrementStatusCount(inst, previous);
  }
  inst.statusMap.delete(messageId);
  inst.statusTimestamps.delete(messageId);
  inst.ackSentAt.delete(messageId);
}

function pruneStaleStatuses(inst: Instance): void {
  if (!inst.statusMap.size) return;
  const now = Date.now();
  for (const [messageId, status] of inst.statusMap.entries()) {
    const updatedAt = inst.statusTimestamps.get(messageId) ?? 0;
    if (isFinalStatus(status) || now - updatedAt >= STATUS_TTL_MS) {
      removeMessageStatus(inst, messageId);
    }
  }
}

function ensureStatusCleanupTimer(inst: Instance): void {
  if (inst.statusCleanupTimer) return;
  inst.statusCleanupTimer = setInterval(() => pruneStaleStatuses(inst), STATUS_SWEEP_INTERVAL_MS);
}

const API_KEYS = String(process.env.API_KEY || 'change-me')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

export interface InstanceContext {
  messageService: MessageService;
  webhook: WebhookClient;
}

export async function startWhatsAppInstance(inst: Instance): Promise<Instance> {
  const { state, saveCreds } = await useMultiFileAuthState(inst.dir);
  const { version } = await fetchLatestBaileysVersion();
  logger.info({ iid: inst.id, version }, 'baileys.version');

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
  const messageService = new MessageService(sock, webhook, logger, {
    eventStore: brokerEventStore,
    instanceId: inst.id,
  });
  inst.context = { messageService, webhook };
  inst.stopping = false;

  sock.ev.on('connection.update', (update: any) => {
    const { connection, lastDisconnect, qr, receivedPendingNotifications } = update;
    const iid = inst.id;

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
        if (inst.reconnectTimer) clearTimeout(inst.reconnectTimer);
        const currentSock = sock;
        inst.reconnectTimer = setTimeout(() => {
          if (inst.sock !== currentSock) return;
          inst.reconnectDelay = Math.min(inst.reconnectDelay * 2, RECONNECT_MAX_DELAY_MS);
          startWhatsAppInstance(inst).catch((err) =>
            logger.error({ iid, err }, 'whatsapp.reconnect.failed'),
          );
        }, delay);
      } else if (isLoggedOut) {
        logger.error({ iid }, 'session.loggedOut');
      }
    }
  });

  sock.ev.on('messages.upsert', async (evt: BaileysEventMap['messages.upsert']) => {
    const rawMessages = evt.messages || [];
    const filteredMessages = filterClientMessages(rawMessages);
    const normalizedEvent = { ...evt, messages: filteredMessages };
    const rawCount = rawMessages.length;
    const count = filteredMessages.length;
    const iid = inst.id;
    logger.info({ iid, type: evt.type, count, rawCount }, 'messages.upsert');

    if (count) {
      for (const message of filteredMessages) {
        const from = message.key?.remoteJid;

        const templateReply = message.message?.templateButtonReplyMessage;
        const buttonsReply = message.message?.buttonsResponseMessage;
        if (templateReply || buttonsReply) {
          const selectedId = templateReply?.selectedId ?? buttonsReply?.selectedButtonId ?? null;
          const selectedText =
            templateReply?.selectedDisplayText ?? buttonsReply?.selectedDisplayText ?? null;
          logger.info(
            {
              iid,
              from,
              selectedId,
              selectedText,
            },
            'button.reply',
          );
        }

        const list = message.message?.listResponseMessage;
        if (list) {
          logger.info(
            {
              iid,
              from,
              selectedId: list?.singleSelectReply?.selectedRowId,
              selectedTitle: list?.title,
            },
            'list.reply',
          );
        }
      }
    }

    try {
      await messageService.onMessagesUpsert(normalizedEvent);
    } catch (err: any) {
      logger.warn({ iid, err: err?.message }, 'message.service.messages.upsert.failed');
    }

    void webhook
      .emit('WHATSAPP_MESSAGES_UPSERT', { iid, raw: normalizedEvent })
      .catch((err: any) => logger.warn({ iid, err: err?.message }, 'webhook.emit.messages.upsert.failed'));
  });

  sock.ev.on('messages.update', (updates: any[]) => {
    const iid = inst.id;
    void webhook.emit('WHATSAPP_MESSAGES_UPDATE', { iid, raw: { updates } }).catch((err: any) =>
      logger.warn({ iid, err: err?.message }, 'webhook.emit.messages.update.failed'),
    );
    for (const update of updates) {
      const messageId = update.key?.id;
      const status = update.update?.status;
      if (messageId && status != null) {
        const previousStatus = inst.statusMap.get(messageId);
        if (previousStatus != null && previousStatus !== status) {
          decrementStatusCount(inst, previousStatus);
        }
        inst.statusMap.set(messageId, status);
        inst.statusTimestamps.set(messageId, Date.now());
        ensureStatusCleanupTimer(inst);
        incrementStatusCount(inst, status);
        inst.metrics.last.lastStatusId = messageId;
        inst.metrics.last.lastStatusCode = status;

        let snapshotRecorded = false;
        const ensureSnapshot = () => {
          if (!snapshotRecorded) {
            recordMetricsSnapshot(inst);
            snapshotRecorded = true;
          }
        };

        if (status >= 2 && inst.ackSentAt?.has(messageId)) {
          const sentAt = inst.ackSentAt.get(messageId);
          inst.ackSentAt.delete(messageId);
          if (sentAt) {
            const delta = Math.max(0, Date.now() - sentAt);
            inst.metrics.ack.totalMs += delta;
            inst.metrics.ack.count += 1;
            inst.metrics.ack.lastMs = delta;
            inst.metrics.ack.avgMs = Math.round(
              inst.metrics.ack.totalMs / Math.max(inst.metrics.ack.count, 1),
            );
          }
        }

        ensureSnapshot();

        const waiter = inst.ackWaiters.get(messageId);
        if (waiter) {
          clearTimeout(waiter.timer);
          inst.ackWaiters.delete(messageId);
          waiter.resolve(status);
        }

        if (isFinalStatus(status)) {
          ensureSnapshot();
          removeMessageStatus(inst, messageId, { recordSnapshot: false });
        }
      }
      logger.info({ iid, mid: messageId, status }, 'messages.status');
    }
  });

  recordMetricsSnapshot(inst, true);
  return inst;
}

export async function stopWhatsAppInstance(
  inst: Instance | undefined,
  { logout = false }: { logout?: boolean } = {},
): Promise<void> {
  if (!inst) return;

  inst.stopping = true;
  inst.context = null;

  if (inst.reconnectTimer) {
    try {
      clearTimeout(inst.reconnectTimer);
    } catch {
      // ignore
    }
    inst.reconnectTimer = null;
  }

  if (inst.statusCleanupTimer) {
    try {
      clearInterval(inst.statusCleanupTimer);
    } catch {
      // ignore
    }
    inst.statusCleanupTimer = null;
  }

  if (logout && inst.sock) {
    try {
      await inst.sock.logout().catch(() => undefined);
    } catch {
      // ignore
    }
  }

  try {
    inst.sock?.end?.(undefined);
  } catch {
    // ignore
  }
}
