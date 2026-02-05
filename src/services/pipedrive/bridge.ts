import pino from 'pino';
import { brokerEventEmitter, type BrokerEvent } from '../../broker/eventStore.js';
import { getInstance } from '../../instanceManager.js';
import { normalizeToE164BR } from '../../utils.js';
import {
  PIPEDRIVE_ENABLED,
  PIPEDRIVE_SYNC_INBOUND,
  PIPEDRIVE_SYNC_OUTBOUND,
} from './config.js';
import {
  getChannelByProviderId,
  getSourceUserId,
  upsertConversationMessage,
} from './store.js';
import type { PipedriveMessage, PipedriveParticipant } from './types.js';
import { syncMessageToPipedrive } from './sync.js';
import { resolvePipedriveStoreBackend } from './storeBackend.js';
import { getPipedriveRedisStore } from './redisStoreInstance.js';
import { enqueuePipedriveNoteEvent } from '../../queue/pipedriveNotesQueue.js';

const logger = pino({ level: process.env.LOG_LEVEL || 'info', base: { service: 'pipedrive-bridge' } });
const OUTBOUND_SKIP_TTL_MS = 10 * 60_000;
const outboundSkip = new Map<string, number>();
const storeBackend = resolvePipedriveStoreBackend();

interface StructuredMessageEventPayload {
  contact?: {
    remoteJid?: string | null;
    phone?: string | null;
    displayName?: string | null;
    isGroup?: boolean;
  };
  message?: {
    id?: string | null;
    chatId?: string | null;
    type?: string | null;
    text?: string | null;
    interactive?: { type?: string | null; [key: string]: unknown } | null;
    media?: { mediaType?: string | null; fileName?: string | null; caption?: string | null } | null;
  };
  metadata?: {
    timestamp?: string | null;
  };
}

function buildConversationLink(contact?: StructuredMessageEventPayload['contact']): string | null {
  const raw = contact?.phone ?? null;
  if (!raw) return null;
  const digits = raw.replace(/\D+/g, '');
  if (!digits) return null;
  return `https://wa.me/${digits}`;
}

function buildMessageText(payload: StructuredMessageEventPayload): string {
  const text = payload.message?.text;
  if (typeof text === 'string' && text.trim()) return text.trim();
  const media = payload.message?.media;
  if (media?.caption && media.caption.trim()) return media.caption.trim();
  if (media?.fileName) return `Arquivo: ${media.fileName}`;
  if (media?.mediaType) return `Midia: ${media.mediaType}`;
  const interactive = payload.message?.interactive;
  if (interactive?.type) return `Interativo: ${interactive.type}`;
  if (payload.message?.type) return `Mensagem: ${payload.message.type}`;
  return 'Mensagem sem texto';
}

function extractPhoneDigits(input: string): string | null {
  const raw = input.trim();
  if (!raw) return null;
  let target = raw;
  const atIndex = raw.indexOf('@');
  if (atIndex >= 0) {
    target = raw.slice(0, atIndex);
    const colonIndex = target.indexOf(':');
    if (colonIndex >= 0) target = target.slice(0, colonIndex);
  }
  const digits = target.replace(/\D+/g, '');
  return digits ? digits : null;
}

function resolveConversationKey(options: { phone?: string | null; conversationId?: string | null }): string | null {
  const candidates = [options.phone ?? null, options.conversationId ?? null].filter(Boolean) as string[];
  for (const candidate of candidates) {
    const digits = extractPhoneDigits(candidate);
    if (!digits) continue;
    const normalized = normalizeToE164BR(digits) ?? digits;
    return normalized ? `+${normalized}` : null;
  }
  return null;
}

function toIso(value: string | null | undefined): string {
  if (!value) return new Date().toISOString();
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? new Date().toISOString() : parsed.toISOString();
}

function cleanupSkipSet(): void {
  const now = Date.now();
  for (const [id, ts] of outboundSkip.entries()) {
    if (now - ts > OUTBOUND_SKIP_TTL_MS) outboundSkip.delete(id);
  }
}

export function markPipedriveOutbound(messageId: string): void {
  if (!messageId) return;
  outboundSkip.set(messageId, Date.now());
  cleanupSkipSet();
}

function shouldSkipOutbound(messageId: string | null): boolean {
  if (!messageId) return false;
  const ts = outboundSkip.get(messageId);
  if (!ts) return false;
  if (Date.now() - ts > OUTBOUND_SKIP_TTL_MS) {
    outboundSkip.delete(messageId);
    return false;
  }
  return true;
}

export function startPipedriveBridge(): void {
  if (!PIPEDRIVE_ENABLED) {
    logger.info('bridge.disabled');
    return;
  }

  brokerEventEmitter.on('broker:event', (event) => {
    void handleEvent(event);
  });
  logger.info('bridge.started');
}

async function handleEvent(event: BrokerEvent): Promise<void> {
  if (event.type !== 'MESSAGE_INBOUND' && event.type !== 'MESSAGE_OUTBOUND') return;
  const payload = event.payload as StructuredMessageEventPayload;
  const direction = event.direction === 'inbound' ? 'inbound' : 'outbound';

  const conversationId = payload.message?.chatId || payload.contact?.remoteJid || null;
  if (!conversationId) return;
  if (payload.contact?.isGroup || conversationId.endsWith('@g.us')) {
    logger.debug({ conversationId }, 'bridge.skip.group');
    return;
  }

  const providerChannelId = event.instanceId;
  const instance = getInstance(providerChannelId);
  const channel = await getChannelByProviderId(providerChannelId);
  if (!channel && storeBackend !== 'redis') {
    logger.debug({ providerChannelId }, 'bridge.channel.missing');
    return;
  }
  const sourceUserId = getSourceUserId(providerChannelId);
  const sourceUserName = instance?.name || providerChannelId;

  const endUserName = payload.contact?.displayName || payload.contact?.phone || conversationId;
  const endUser: PipedriveParticipant = {
    id: conversationId,
    name: endUserName,
    role: 'end_user',
  };
  const sourceUser: PipedriveParticipant = {
    id: sourceUserId,
    name: sourceUserName,
    role: 'source_user',
  };

  const sender = direction === 'inbound' ? endUser : sourceUser;
  const messageId = payload.message?.id || event.id;
  const createdAtIso = toIso(payload.metadata?.timestamp ?? null);
  const createdAtMs = new Date(createdAtIso).getTime();
  const messageText = buildMessageText(payload);

  const message: PipedriveMessage = {
    id: messageId,
    status: 'sent',
    created_at: createdAtIso,
    message: messageText,
    sender_id: sender.id,
    attachments: [],
  };

  const link = buildConversationLink(payload.contact);
  if (channel) {
    await upsertConversationMessage({
      providerChannelId,
      conversationId,
      message,
      participants: [endUser, sourceUser],
      link,
      seen: direction === 'outbound',
      direction,
    });
  }

  let companyId: number | null = channel?.company_id ?? null;
  if (storeBackend === 'redis') {
    try {
      const redisStore = getPipedriveRedisStore();
      companyId = (await redisStore.getInstanceCompany(providerChannelId)) ?? companyId;
      const conversationKey = resolveConversationKey({
        phone: payload.contact?.phone ?? null,
        conversationId,
      });
      if (companyId && conversationKey) {
        await redisStore.upsertConversationMessage({
          companyId,
          conversationKey,
          message: {
            id: messageId,
            ts_ms: Number.isFinite(createdAtMs) ? createdAtMs : Date.now(),
            created_at_iso: createdAtIso,
            direction,
            text: messageText,
            instance_id: providerChannelId,
          },
          incrementUnread: direction === 'inbound',
        });
        await enqueuePipedriveNoteEvent({
          companyId,
          conversationKey,
          messageId,
          direction,
          text: messageText,
          instanceId: providerChannelId,
          contactName: payload.contact?.displayName ?? null,
          contactPhone: payload.contact?.phone ?? null,
          createdAtIso,
        });
      }
    } catch (err: any) {
      logger.warn({ err: err?.message ?? err, providerChannelId, messageId }, 'bridge.redis.failed');
    }
  }

  if (direction === 'inbound' && !PIPEDRIVE_SYNC_INBOUND) return;
  if (direction === 'outbound' && !PIPEDRIVE_SYNC_OUTBOUND) return;
  if (direction === 'outbound' && shouldSkipOutbound(messageId)) {
    logger.debug({ messageId }, 'bridge.skip.outbound');
    return;
  }

  try {
    await syncMessageToPipedrive({
      providerChannelId,
      channel,
      direction,
      conversationId,
      conversationLink: link,
      messageId,
      messageText,
      createdAt: createdAtIso,
      sender,
      attachments: [],
      contactPhone: payload.contact?.phone ?? null,
      contactName: payload.contact?.displayName ?? null,
      companyId,
      apiDomain: channel?.api_domain ?? null,
    });
  } catch (err: any) {
    logger.warn({ err: err?.message ?? err, providerChannelId, messageId }, 'bridge.sync.failed');
  }
}
