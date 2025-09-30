import axios from 'axios';
import pino from 'pino';
import {
  DisconnectReason,
  default as makeWASocket,
  fetchLatestBaileysVersion,
  useMultiFileAuthState,
} from '@whiskeysockets/baileys';
import { recordMetricsSnapshot, buildSignature } from './utils.js';
import type { Instance } from './instanceManager.js';

const logger = pino({ level: process.env.LOG_LEVEL || 'info' });

const RECONNECT_MIN_DELAY_MS = 1_000;
const RECONNECT_MAX_DELAY_MS = 30_000;
const WEBHOOK_URL = process.env.WEBHOOK_URL || '';
const API_KEYS = String(process.env.API_KEY || 'change-me')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

export async function startWhatsAppInstance(inst: Instance): Promise<Instance> {
  const { state, saveCreds } = await useMultiFileAuthState(inst.dir);
  const { version } = await fetchLatestBaileysVersion();
  logger.info({ iid: inst.id, version }, 'baileys.version');

  const sock = makeWASocket({ version, auth: state, logger });
  inst.sock = sock;

  sock.ev.on('creds.update', saveCreds);

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

  sock.ev.on('messages.upsert', async (evt: any) => {
    const count = evt.messages?.length || 0;
    const iid = inst.id;
    logger.info({ iid, type: evt.type, count }, 'messages.upsert');

    if (count) {
      for (const message of evt.messages) {
        const from = message.key?.remoteJid;

        const button =
          message.message?.templateButtonReplyMessage || message.message?.buttonsResponseMessage;
        if (button) {
          logger.info(
            {
              iid,
              from,
              selectedId: button?.selectedId || button?.selectedButtonId,
              selectedText: button?.selectedDisplayText,
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

    if (WEBHOOK_URL && count) {
      try {
        const payload = { iid, ...evt };
        const serialized = JSON.stringify(payload);
        const signature = buildSignature(serialized, API_KEYS[0] || 'change-me');
        await axios
          .post(WEBHOOK_URL, serialized, {
            headers: {
              'Content-Type': 'application/json',
              'X-Signature-256': signature,
            },
          })
          .catch(() => undefined);
      } catch (err: any) {
        logger.warn({ iid, err: err?.message }, 'webhook.relay.error');
      }
    }
  });

  sock.ev.on('messages.update', (updates: any[]) => {
    const iid = inst.id;
    for (const update of updates) {
      const messageId = update.key?.id;
      const status = update.update?.status;
      if (messageId && status != null) {
        inst.statusMap.set(messageId, status);
        inst.metrics.status_counts[String(status)] =
          (inst.metrics.status_counts[String(status)] || 0) + 1;
        inst.metrics.last.lastStatusId = messageId;
        inst.metrics.last.lastStatusCode = status;

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

        recordMetricsSnapshot(inst);

        const waiter = inst.ackWaiters.get(messageId);
        if (waiter) {
          clearTimeout(waiter.timer);
          inst.ackWaiters.delete(messageId);
          waiter.resolve(status);
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

  if (inst.reconnectTimer) {
    try {
      clearTimeout(inst.reconnectTimer);
    } catch {
      // ignore
    }
    inst.reconnectTimer = null;
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
