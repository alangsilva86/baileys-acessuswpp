import pino from 'pino';
import {
  DisconnectReason,
  fetchLatestBaileysVersion,
  makeWASocket,
  useMultiFileAuthState,
} from '@whiskeysockets/baileys';
import type { BaileysEventMap } from '@whiskeysockets/baileys';
import { recordMetricsSnapshot, resolveAckWaiters } from './utils.js';
import { type Instance, resetInstanceSession } from './instanceManager.js';
import { recordMetricsSnapshot } from './utils.js';
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
import { filterClientMessages } from './baileys/messageUtils.js';

const logger = pino({ level: process.env.LOG_LEVEL || 'info' });
const PHONE_NUMBER_SHARE_EVENT = 'chats.phoneNumberShare' as const;
type PhoneNumberSharePayload = BaileysEventMap[typeof PHONE_NUMBER_SHARE_EVENT];

const RECONNECT_MIN_DELAY_MS = 1_000;
const RECONNECT_MAX_DELAY_MS = 30_000;

const DEFAULT_STATUS_TTL_MS = 10 * 60_000;
const DEFAULT_STATUS_SWEEP_INTERVAL_MS = 60_000;
const FINAL_STATUS_THRESHOLD = 3;
const FINAL_STATUS_CODES = new Set([0]);
const QR_INITIAL_TTL_MS = 60_000;
const QR_SUBSEQUENT_TTL_MS = 20_000;

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
function removeStatus(inst: Instance, messageId: string, options: { record?: boolean } = {}): void {
  if (!inst.statusMap.has(messageId)) return;
  const prev = inst.statusMap.get(messageId);
  if (options.record ?? true) {
    recordMetricsSnapshot(inst);
  }
  if (prev != null) dec(inst, prev);
  inst.statusMap.delete(messageId);
  inst.statusTimestamps.delete(messageId);
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

function toNumber(val: unknown): number | null {
  if (val == null) return null;
  if (typeof val === 'number') {
    return Number.isFinite(val) ? val : null;
  }
  if (typeof val === 'string' && val.trim()) {
    const parsed = Number(val);
    return Number.isFinite(parsed) ? parsed : null;
  }
  if (typeof val === 'object' && typeof (val as { toNumber?: () => number }).toNumber === 'function') {
    try {
      const parsed = (val as { toNumber: () => number }).toNumber();
      return Number.isFinite(parsed) ? parsed : null;
    } catch {
      return null;
    }
  }
  return null;
}

const STATUS_TEXT_MAP: Record<string, number> = {
  ERROR: 0,
  FAILED: 0,
  PENDING: 1,
  QUEUED: 1,
  SENT: 1,
  SERVER_ACK: 2,
  ACK: 2,
  DELIVERY_ACK: 3,
  DELIVERED: 3,
  READ: 4,
  PLAYED: 5,
};

type ReceiptLike = Partial<{
  receiptTimestamp: unknown;
  readTimestamp: unknown;
  playedTimestamp: unknown;
  pendingDeviceJid: unknown;
  deliveredDeviceJid: unknown;
}>;

function normalizeStatusCode(raw: unknown): number | null {
  if (raw == null) return null;
  if (typeof raw === 'number') {
    const normalized = Math.trunc(raw);
    return Number.isFinite(normalized) ? normalized : null;
  }
  if (typeof raw === 'string') {
    const trimmed = raw.trim();
    if (!trimmed) return null;
    const numeric = Number(trimmed);
    if (Number.isFinite(numeric)) return Math.trunc(numeric);
    const mapped = STATUS_TEXT_MAP[trimmed.toUpperCase()];
    if (mapped != null) return mapped;
    return null;
  }
  if (typeof raw === 'object') {
    const candidateKeys = ['status', 'code', 'value'];
    for (const key of candidateKeys) {
      if (Object.prototype.hasOwnProperty.call(raw, key)) {
        const result = normalizeStatusCode((raw as Record<string, unknown>)[key]);
        if (result != null) return result;
      }
    }
  }
  return null;
}

function deriveStatusFromReceipt(receipt: ReceiptLike): number | null {
  if (!receipt) return null;
  const played = toNumber(receipt.playedTimestamp);
  if (played && played > 0) return 5;
  const read = toNumber(receipt.readTimestamp);
  if (read && read > 0) return 4;
  const deliveredList = Array.isArray(receipt.deliveredDeviceJid)
    ? receipt.deliveredDeviceJid.filter(Boolean)
    : [];
  if (deliveredList.length > 0) return 3;
  const receiptTs = toNumber(receipt.receiptTimestamp);
  if (receiptTs && receiptTs > 0) return 2;
  const pendingList = Array.isArray(receipt.pendingDeviceJid)
    ? receipt.pendingDeviceJid.filter(Boolean)
    : [];
  if (pendingList.length > 0) return 1;
  return null;
}

function applyStatus(inst: Instance, messageId: string, status: number): boolean {
  if (status == null) return false;
  const now = Date.now();
  const prev = inst.statusMap.get(messageId);
  if (prev != null && status <= prev) {
    inst.statusTimestamps.set(messageId, now);
    return false;
  }

  if (prev != null) {
    dec(inst, prev);
  }

  inst.statusMap.set(messageId, status);
  inst.statusTimestamps.set(messageId, now);
  ensureCleanup(inst);
  inc(inst, status);

  inst.metrics.last.lastStatusId = messageId;
  inst.metrics.last.lastStatusCode = status;

  recordMetricsSnapshot(inst, true);
  resolveAckWaiters(inst, messageId, status);

  if (isFinal(status)) {
    removeStatus(inst, messageId, { record: false });
    recordMetricsSnapshot(inst, true);
  }

  return true;
}

const API_KEYS = String(process.env.API_KEY || 'change-me').split(',').map((s) => s.trim()).filter(Boolean);

export interface InstanceContext {
  messageService: MessageService;
  pollService: PollService;
  webhook: WebhookClient;
}

function notifyInstanceEvent(inst: Instance, reason: InstanceEventReason, detail?: Record<string, unknown>): void {
  emitInstanceEvent({ reason, instance: inst, detail: detail ?? null });
}

function updateConnectionState(inst: Instance, state: Instance['connectionState']): void {
  inst.connectionState = state;
  inst.connectionUpdatedAt = Date.now();
}

function updateLastQr(inst: Instance, qr: string | null): void {
  if (inst.lastQR === qr) return;
  inst.lastQR = qr;
  inst.qrVersion += 1;
  if (qr) {
    const now = Date.now();
    const ttl = inst.qrVersion > 1 ? QR_SUBSEQUENT_TTL_MS : QR_INITIAL_TTL_MS;
    inst.qrReceivedAt = now;
    inst.qrExpiresAt = now + ttl;
    const attempt = incrementPairingAttempts(inst);
    notifyInstanceEvent(inst, 'qr', {
      qrVersion: inst.qrVersion,
      expiresAt: inst.qrExpiresAt,
      attempt,
    });
  } else {
    inst.qrReceivedAt = null;
    inst.qrExpiresAt = null;
  }
}

function clearPairingState(inst: Instance): void {
  inst.pairingAttempts = 0;
}

function clearLastError(inst: Instance): void {
  inst.lastError = null;
}

function setLastError(inst: Instance, message: string | null | undefined): void {
  inst.lastError = message && message.trim() ? message.trim() : null;
}

function setConnectionDetail(inst: Instance, detail: Instance['connectionStateDetail']): void {
  inst.connectionStateDetail = detail;
}

function incrementPairingAttempts(inst: Instance): number {
  inst.pairingAttempts = Math.max(inst.pairingAttempts + 1, 1);
  return inst.pairingAttempts;
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
  sock.ev.on(PHONE_NUMBER_SHARE_EVENT, (payload: PhoneNumberSharePayload) => {
    const added = inst.lidMapping.rememberMapping(payload?.jid, payload?.lid);
    if (added) {
      logger.debug({ iid: inst.id, jid: payload?.jid, lid: payload?.lid }, 'lidMapping.share');
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
      updateLastQr(inst, qr);
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
      const receipt = update.receipt as ReceiptLike;
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
  if (inst.statusCleanupTimer) {
    try {
      clearInterval(inst.statusCleanupTimer);
    } catch {}
    inst.statusCleanupTimer = null;
  }

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
