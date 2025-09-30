import type { Logger } from 'pino';
import pino from 'pino';
import {
  default as makeWASocket,
  DisconnectReason,
  fetchLatestBaileysVersion,
  useMultiFileAuthState,
  type BaileysEventMap,
} from '@whiskeysockets/baileys';

import type { ManagedInstance } from './context';
import { env } from './env';
import { buildSignature, recordMetricsSnapshot } from './utils';

const RECONNECT_MIN_DELAY_MS = 1_000;
const RECONNECT_MAX_DELAY_MS = 30_000;

function createWhatsAppLogger(base: Logger, iid: string) {
  return base.child({ iid, component: 'whatsapp' });
}

export async function startWhatsAppInstance(
  inst: ManagedInstance,
  logger: Logger = pino({ level: env.logLevel, base: { service: env.serviceName } }),
): Promise<ManagedInstance> {
  const { state, saveCreds } = await useMultiFileAuthState(inst.dir);
  const { version } = await fetchLatestBaileysVersion();
  const log = createWhatsAppLogger(logger, inst.id);
  log.info({ version }, 'baileys.version');

  const sock = makeWASocket({ version, auth: state, logger: log });
  inst.sock = sock;

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', (update: BaileysEventMap['connection.update']) => {
    const { connection, lastDisconnect, qr, receivedPendingNotifications } = update;

    if (qr) {
      inst.lastQR = qr;
      log.info('qr.updated');
    }

    if (connection === 'open') {
      inst.lastQR = null;
      inst.reconnectDelay = RECONNECT_MIN_DELAY_MS;
      log.info({ receivedPendingNotifications }, 'whatsapp.connected');
    }

    if (connection === 'close') {
      const statusCode = (lastDisconnect?.error as any)?.output?.statusCode;
      const isLoggedOut = statusCode === DisconnectReason.loggedOut;
      log.warn({ statusCode }, 'whatsapp.disconnected');

      if (!inst.stopping && !isLoggedOut) {
        const delay = Math.min(inst.reconnectDelay, RECONNECT_MAX_DELAY_MS);
        log.warn({ delay }, 'whatsapp.reconnect.scheduled');
        if (inst.reconnectTimer) clearTimeout(inst.reconnectTimer);
        const currentSock = sock;
        inst.reconnectTimer = setTimeout(() => {
          if (inst.sock !== currentSock) return; // evita reconectar duas vezes
          inst.reconnectDelay = Math.min(inst.reconnectDelay * 2, RECONNECT_MAX_DELAY_MS);
          startWhatsAppInstance(inst, logger).catch((err) =>
            log.error({ err }, 'whatsapp.reconnect.failed'),
          );
        }, delay);
      } else if (isLoggedOut) {
        log.error('session.loggedOut');
      }
    }
  });

  sock.ev.on('messages.upsert', async (evt: BaileysEventMap['messages.upsert']) => {
    const count = evt.messages?.length ?? 0;
    log.info({ type: evt.type, count }, 'messages.upsert');

    if (count) {
      for (const m of evt.messages ?? []) {
        const from = m.key?.remoteJid;

        const btn =
          m.message?.templateButtonReplyMessage || m.message?.buttonsResponseMessage;
        if (btn) {
          const buttonInfo = btn as {
            selectedId?: string;
            selectedButtonId?: string;
            selectedDisplayText?: string;
          };
          const selectedId = buttonInfo.selectedId ?? buttonInfo.selectedButtonId;
          const selectedText = buttonInfo.selectedDisplayText;
          log.info(
            {
              from,
              selectedId,
              selectedText,
            },
            'button.reply',
          );
        }

        const list = m.message?.listResponseMessage;
        if (list) {
          const listInfo = list as {
            singleSelectReply?: { selectedRowId?: string };
            title?: string;
          };
          log.info(
            {
              from,
              selectedId: listInfo.singleSelectReply?.selectedRowId,
              selectedTitle: listInfo.title,
            },
            'list.reply',
          );
        }
      }
    }

    const webhookUrl = env.webhookUrl;
    if (webhookUrl && count) {
      try {
        const payload = JSON.stringify({ iid: inst.id, ...evt });
        const secret = env.webhookApiKey ?? env.apiKeys[0] ?? 'change-me';
        const signature = buildSignature(payload, secret);
        await fetch(webhookUrl, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-Signature-256': signature,
          },
          body: payload,
        });
      } catch (err) {
        log.warn({ err }, 'webhook.relay.error');
      }
    }
  });

  sock.ev.on('messages.update', (updates: BaileysEventMap['messages.update']) => {
    for (const u of updates) {
      const mid = u.key?.id;
      const status = u.update?.status;
      if (mid && status != null) {
        inst.statusMap.set(mid, status);
        inst.metrics.status_counts[String(status)] =
          (inst.metrics.status_counts[String(status)] || 0) + 1;
        inst.metrics.last.lastStatusId = mid;
        inst.metrics.last.lastStatusCode = status;

        if (status >= 2 && inst.ackSentAt?.has(mid)) {
          const sentAt = inst.ackSentAt.get(mid);
          inst.ackSentAt.delete(mid);
          if (sentAt) {
            const delta = Math.max(0, Date.now() - sentAt);
            inst.metrics.ack.totalMs += delta;
            inst.metrics.ack.count += 1;
            inst.metrics.ack.lastMs = delta;
            inst.metrics.ack.avgMs = Math.round(
              inst.metrics.ack.totalMs / Math.max(1, inst.metrics.ack.count),
            );
          }
        }

        recordMetricsSnapshot(inst);

        const waiter = inst.ackWaiters.get(mid);
        if (waiter) {
          clearTimeout(waiter.timer);
          inst.ackWaiters.delete(mid);
          waiter.resolve(status);
        }
      }
      log.info({ mid, status }, 'messages.status');
    }
  });

  recordMetricsSnapshot(inst, true);
  return inst;
}

export async function stopWhatsAppInstance(
  inst: ManagedInstance | null | undefined,
  { logout = false }: { logout?: boolean } = {},
): Promise<void> {
  if (!inst) return;

  inst.stopping = true;

  if (inst.reconnectTimer) {
    try {
      clearTimeout(inst.reconnectTimer);
    } catch (err) {
      // ignore cleanup errors
    }
    inst.reconnectTimer = null;
  }

  if (logout && inst.sock) {
    try {
      await inst.sock.logout().catch(() => undefined);
    } catch (err) {
      // ignore logout errors
    }
  }

  try {
    inst.sock?.end?.(undefined);
  } catch (err) {
    // ignore socket end errors
  }
}
