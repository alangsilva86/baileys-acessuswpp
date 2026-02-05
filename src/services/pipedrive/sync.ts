import pino from 'pino';
import {
  PIPEDRIVE_CHANNELS_MODE,
  PIPEDRIVE_FALLBACK_NOTES_ENABLED,
} from './config.js';
import type { PipedriveChannelRecord } from './store.js';
import type { PipedriveAttachment, PipedriveParticipant } from './types.js';
import { pipedriveClient } from './client.js';
import { createFallbackNote, type PipedriveMessageDirection } from './fallbackNotes.js';
import {
  recordPipedriveChannelsResult,
  recordPipedriveFallbackNote,
  recordPipedriveMessage,
} from './metrics.js';

const logger = pino({ level: process.env.LOG_LEVEL || 'info', base: { service: 'pipedrive-sync' } });

function toIso(value: string | number | Date | null | undefined): string {
  if (value == null) return new Date().toISOString();
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? new Date().toISOString() : value.toISOString();
  if (typeof value === 'number') {
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? new Date().toISOString() : date.toISOString();
  }
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? new Date().toISOString() : parsed.toISOString();
}

function getAxiosStatus(err: unknown): number | null {
  const anyErr = err as any;
  const status = anyErr?.response?.status;
  return typeof status === 'number' ? status : null;
}

export type PipedriveSyncResult =
  | { mode: 'channels' }
  | { mode: 'fallback_note'; noteId: number; reused: boolean; personId: number | null };

export async function syncMessageToPipedrive(options: {
  providerChannelId: string;
  channel: PipedriveChannelRecord | null;
  direction: PipedriveMessageDirection;
  conversationId: string;
  conversationLink?: string | null;
  messageId: string;
  messageText: string;
  createdAt?: string | number | Date | null;
  status?: string;
  sender: PipedriveParticipant;
  attachments?: PipedriveAttachment[];
  contactPhone?: string | null;
  contactName?: string | null;
  companyId?: number | null;
  apiDomain?: string | null;
}): Promise<PipedriveSyncResult> {
  try {
    await recordPipedriveMessage(options.direction);
  } catch {
    // ignore metrics errors
  }

  const createdAt = toIso(options.createdAt ?? null);
  const status = options.status ?? 'sent';

  const companyId = options.companyId ?? options.channel?.company_id ?? null;
  const apiDomain = options.apiDomain ?? options.channel?.api_domain ?? null;

  const fallback = async (): Promise<PipedriveSyncResult> => {
    if (!PIPEDRIVE_FALLBACK_NOTES_ENABLED) {
      throw new Error('pipedrive_fallback_notes_disabled');
    }
    try {
      const note = await createFallbackNote({
        instanceId: options.providerChannelId,
        direction: options.direction,
        messageId: options.messageId,
        conversationId: options.conversationId,
        messageText: options.messageText,
        contactPhone: options.contactPhone ?? null,
        contactName: options.contactName ?? null,
        createdAt,
        companyId,
        apiDomain,
      });
      try {
        await recordPipedriveFallbackNote(note.reused ? 'reused' : 'created');
      } catch {
        // ignore metrics errors
      }
      return { mode: 'fallback_note', noteId: note.noteId, reused: note.reused, personId: note.personId };
    } catch (err) {
      try {
        await recordPipedriveFallbackNote('failed');
      } catch {
        // ignore metrics errors
      }
      throw err;
    }
  };

  if (PIPEDRIVE_CHANNELS_MODE === 'v2') {
    return await fallback();
  }

  const canUseChannels = Boolean(options.channel) && !String(options.channel?.id ?? '').startsWith('fallback:');
  if (!canUseChannels) {
    if (PIPEDRIVE_CHANNELS_MODE === 'channels') {
      throw new Error('pipedrive_channel_missing');
    }
    return await fallback();
  }

  try {
    await pipedriveClient.receiveMessage(options.channel as PipedriveChannelRecord, {
      conversation_id: options.conversationId,
      conversation_link: options.conversationLink ?? undefined,
      message_id: options.messageId,
      message: options.messageText,
      created_at: createdAt,
      status,
      sender: options.sender,
      attachments: options.attachments ?? [],
    });
    try {
      await recordPipedriveChannelsResult('ok');
    } catch {
      // ignore metrics errors
    }
    return { mode: 'channels' };
  } catch (err: any) {
    const statusCode = getAxiosStatus(err);
    logger.warn(
      { err: err?.message ?? err, statusCode, providerChannelId: options.providerChannelId, messageId: options.messageId },
      'sync.channels.failed',
    );
    try {
      await recordPipedriveChannelsResult('failed');
    } catch {
      // ignore metrics errors
    }
    if (PIPEDRIVE_CHANNELS_MODE === 'dual') {
      return await fallback();
    }
    throw err;
  }
}
