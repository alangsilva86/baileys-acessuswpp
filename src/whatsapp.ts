import pino from 'pino';
import {
  DisconnectReason,
  fetchLatestBaileysVersion,
  makeWASocket,
  useMultiFileAuthState,
} from '@whiskeysockets/baileys';
import type { BaileysEventMap } from '@whiskeysockets/baileys';
import { HttpsProxyAgent } from 'https-proxy-agent';
import { recordMetricsSnapshot, resolveAckWaiters } from './utils.js';
import {
  type Instance,
  resetInstanceSession,
  emitInstanceEvent,
  type InstanceEventReason,
} from './instanceManager.js';
import { MessageService } from './baileys/messageService.js';
import { PollService } from './baileys/pollService.js';
import { WebhookClient } from './services/webhook.js';
import { brokerEventStore } from './broker/eventStore.js';
import { riskGuardian } from './risk/guardian.js';
import { filterClientMessages } from './baileys/messageUtils.js';
import {
  applyStatus,
  deriveStatusFromReceipt,
  normalizeStatusCode,
  clearStatusTimers,
} from './whatsapp/statusTracker.js';
import type { MessageReceipt } from './whatsapp/statusTracker.js';
import {
  QR_INITIAL_TTL_MS,
  QR_SUBSEQUENT_TTL_MS,
  updateConnectionState,
  updateLastQr,
  clearPairingState,
  clearLastError,
  setLastError,
  setConnectionDetail,
  incrementPairingAttempts,
} from './whatsapp/connectionLifecycle.js';
import { validateProxyUrl } from './network/proxyValidator.js';
import { createBrightDataProxyUrl } from './network/brightData.js';

const logger = pino({ level: process.env.LOG_LEVEL || 'info' });
const PHONE_NUMBER_SHARE_EVENT = 'chats.phoneNumberShare';
type PhoneNumberSharePayload =
  | {
      jid?: unknown;
      lid?: unknown;
    }
  | null
  | undefined;

function extractPhoneNumberShare(payload: PhoneNumberSharePayload): { jid: string | null; lid: string | null } {
  const jid = typeof payload?.jid === 'string' && payload.jid.trim() ? payload.jid : null;
  const lid = typeof payload?.lid === 'string' && payload.lid.trim() ? payload.lid : null;
  return { jid, lid };
}

const RECONNECT_MIN_DELAY_MS = 1_000;
const RECONNECT_MAX_DELAY_MS = 30_000;

const API_KEYS = String(process.env.API_KEY || 'change-me').split(',').map((s) => s.trim()).filter(Boolean);

export interface InstanceContext {
  messageService: MessageService;
  pollService: PollService;
  webhook: WebhookClient;
}

function notifyInstanceEvent(inst: Instance, reason: InstanceEventReason, detail?: Record<string, unknown>): void {
  emitInstanceEvent({ reason, instance: inst, detail: detail ?? null });
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

  let agent: HttpsProxyAgent<string> | undefined;
  const allowProxyFallback = process.env.ALLOW_PROXY_FALLBACK === '1';
  const proxyRequired = process.env.PROXY_REQUIRED !== '0';
  // Se a instância não tem proxy, tenta montar via Bright Data a partir das envs
  if (!inst.network?.proxyUrl) {
    const bdUrl = createBrightDataProxyUrl(inst.id);
    if (bdUrl) {
      inst.network.proxyUrl = bdUrl;
    }
  }

  if (inst.network?.proxyUrl) {
    try {
      const validation = await validateProxyUrl(inst.network.proxyUrl);
      inst.network = {
        ...inst.network,
        ip: validation.ip,
        isp: validation.isp,
        asn: validation.asn,
        latencyMs: validation.latencyMs,
        status: validation.status === 'ok' ? 'ok' : validation.status === 'blocked' ? 'blocked' : 'failed',
        blockReason: validation.blockReason,
        lastCheckAt: validation.lastCheckAt,
        validatedAt: validation.status === 'ok' ? validation.lastCheckAt : inst.network.validatedAt,
      };
      if (validation.status === 'blocked') {
        setLastError(inst, validation.blockReason);
        updateConnectionState(inst, 'close');
        throw new Error(validation.blockReason || 'proxy_blocked_datacenter');
      }
      if (validation.status !== 'ok') {
        const reason = validation.blockReason || 'proxy_validation_failed';
        setLastError(inst, reason);
        logger.warn({ iid: inst.id, reason }, 'network.proxy.validation_failed');
        if (proxyRequired && !allowProxyFallback) {
          updateConnectionState(inst, 'close');
          throw new Error(reason);
        }
      } else {
        agent = new HttpsProxyAgent(inst.network.proxyUrl);
        logger.info(
          { iid: inst.id, proxy: inst.network.proxyUrl, asn: validation.asn, isp: validation.isp, latencyMs: validation.latencyMs },
          'network.proxy.enabled',
        );
      }
    } catch (err: any) {
      logger.error({ iid: inst.id, err: err?.message }, 'network.proxy.invalid');
    }
  }

  const sock = makeWASocket({
    version,
    auth: state,
    logger,
    agent,
    browser: ['Windows', 'Chrome', '10.0.0'],
    connectTimeoutMs: 60_000,
  });
  inst.sock = sock;
  inst.context = null;

  sock.ev.on('creds.update', saveCreds);
  sock.ev.on(PHONE_NUMBER_SHARE_EVENT as any, (payload: PhoneNumberSharePayload) => {
    const { jid, lid } = extractPhoneNumberShare(payload);
    const added = inst.lidMapping.rememberMapping(jid, lid);
    if (added) {
      logger.debug({ iid: inst.id, jid, lid }, 'lidMapping.share');
    }
  });
  sock.ev.on('lid-mapping.update' as unknown as keyof BaileysEventMap, (payload: unknown) => {
    try {
      const count = inst.lidMapping.ingestUpdate(payload);
      if (count > 0) {
        logger.debug({ iid: inst.id, count }, 'lidMapping.update');
      }
    } catch (err) {
      logger.warn({ iid: inst.id, err }, 'lidMapping.update.failed');
    }
  });

  const webhook = new WebhookClient({
    instanceId: inst.id,
    logger,
    hmacSecret: process.env.WEBHOOK_HMAC_SECRET || API_KEYS[0] || null,
    eventStore: brokerEventStore,
  });

  const messageService = new MessageService(sock, webhook, logger, {
    eventStore: brokerEventStore,
    instanceId: inst.id,
    mappingStore: inst.lidMapping,
  });
  const pollService = new PollService(sock, webhook, logger, {
    messageService,
    eventStore: brokerEventStore,
    instanceId: inst.id,
    mappingStore: inst.lidMapping,
  });

  inst.context = { messageService, pollService, webhook };
  inst.stopping = false;
  try {
    riskGuardian.setConfig(inst.id, inst.risk || {});
  } catch (err) {
    logger.warn({ iid: inst.id, err }, 'risk.guardian.config.failed');
  }

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

    if (qr) {
      updateLastQr(inst, qr, {
        onEvent: (reason, detail) => notifyInstanceEvent(inst, reason, detail),
      });
      logger.info({ iid }, 'qr.updated');
    }
    if (connection === 'connecting') {
      updateConnectionState(inst, 'connecting');
      setConnectionDetail(inst, null);
      clearLastError(inst);
      notifyInstanceEvent(inst, 'connection', { connection: 'connecting' });
    }
    if (connection === 'open') {
      updateConnectionState(inst, 'open');
      updateLastQr(inst, null);
      inst.reconnectDelay = RECONNECT_MIN_DELAY_MS;
      clearPairingState(inst);
      clearLastError(inst);
      setConnectionDetail(inst, null);
      if (!inst.pairedAt) {
        inst.pairedAt = Date.now();
      }
      logger.info({ iid, receivedPendingNotifications }, 'whatsapp.connected');
      notifyInstanceEvent(inst, 'connection', {
        connection: 'open',
        receivedPendingNotifications,
      });
    }

    if (connection === 'close') {
      updateConnectionState(inst, 'close');
      const statusCode = lastDisconnect?.error?.output?.statusCode;
      const payloadMessage = lastDisconnect?.error?.output?.payload?.message;
      const errorMessageRaw = lastDisconnect?.error?.message;
      const errorFallback = typeof lastDisconnect?.error === 'string' ? lastDisconnect?.error : '';
      const combinedError = String(payloadMessage || errorMessageRaw || errorFallback || '');
      const errorMessage = combinedError.toLowerCase();
      const isLoggedOut = statusCode === DisconnectReason.loggedOut;
      const isTimedOut =
        statusCode === DisconnectReason.timedOut || errorMessage.includes('qr refs attempts ended');
      logger.warn({ iid, statusCode }, 'whatsapp.disconnected');

      const detail = {
        statusCode: Number.isFinite(Number(statusCode)) ? Number(statusCode) : null,
        reason: combinedError || null,
        isLoggedOut,
        isTimedOut,
      };
      setConnectionDetail(inst, detail);
      setLastError(inst, combinedError);
      notifyInstanceEvent(inst, 'connection', {
        connection: 'close',
        detail,
      });
      if (detail.reason) {
        notifyInstanceEvent(inst, 'error', {
          source: 'disconnect',
          detail,
        });
      }

      if (isTimedOut) {
        updateLastQr(inst, null);
        const storedPhone = inst.phoneNumber?.trim();
        if (storedPhone) {
          const maskedPhone = storedPhone.replace(/.(?=.{4})/g, '*');
          logger.warn({ iid, maskedPhone }, 'whatsapp.qr_timeout.retrying_pairing');
          const attempt = incrementPairingAttempts(inst);
          notifyInstanceEvent(inst, 'pairing', {
            via: 'auto',
            attempt,
            maskedPhone,
          });
          void inst.sock
            ?.requestPairingCode(storedPhone)
            .then(() => {
              logger.info({ iid, maskedPhone }, 'whatsapp.qr_timeout.pairing_requested');
              clearLastError(inst);
              notifyInstanceEvent(inst, 'pairing', {
                via: 'auto',
                attempt,
                maskedPhone,
                status: 'ok',
              });
            })
            .catch((err: any) => {
              logger.error({ iid, err: err?.message }, 'whatsapp.qr_timeout.pairing_failed');
              setLastError(inst, err?.message);
              notifyInstanceEvent(inst, 'error', {
                source: 'pairing',
                attempt,
                detail: {
                  message: err?.message || null,
                },
              });
            });
        } else {
          updateConnectionState(inst, 'qr_timeout');
          setConnectionDetail(inst, {
            statusCode: detail.statusCode,
            reason: 'qr_timeout',
            isLoggedOut: detail.isLoggedOut,
            isTimedOut: true,
          });
          logger.warn({ iid }, 'whatsapp.qr_timeout.no_phone');
          notifyInstanceEvent(inst, 'connection', { connection: 'qr_timeout' });
        }
      }

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
      const mid = u.key?.id ?? null;
      const rawStatus = u.update ? ((u.update as Record<string, unknown>).statusV3 ?? (u.update as Record<string, unknown>).status) : null;
      const status = normalizeStatusCode(rawStatus);
      const changed = mid && status != null ? applyStatus(inst, mid, status) : false;

      logger.info({ iid, mid, status, changed, source: 'messages.update', rawStatus }, 'messages.status');
    }

    try { await webhook.emit('WHATSAPP_MESSAGES_UPDATE', { iid, raw: { updates } }); }
    catch (err: any) { logger.warn({ iid, err: err?.message }, 'webhook.emit.messages.update.failed'); }
  });

  sock.ev.on('message-receipt.update', (updates: BaileysEventMap['message-receipt.update']) => {
    const iid = inst.id;

    for (const update of updates) {
      const mid = update?.key?.id ?? null;
      if (!mid) continue;
      const receipt = update.receipt as MessageReceipt;
      const status = deriveStatusFromReceipt(receipt);
      const changed = status != null ? applyStatus(inst, mid, status) : false;

      logger.info({ iid, mid, status, changed, source: 'message-receipt.update' }, 'messages.status');
    }
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
  clearStatusTimers(inst);

  if (inst.ackWaiters.size) {
    const pending = [...inst.ackWaiters.keys()];
    for (const messageId of pending) {
      resolveAckWaiters(inst, messageId, null);
    }
  }

  updateLastQr(inst, null);

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
