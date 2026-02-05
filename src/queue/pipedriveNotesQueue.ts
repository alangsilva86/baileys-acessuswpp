import { Queue, Worker, type JobsOptions, type WorkerOptions } from 'bullmq';
import IORedis from 'ioredis';
import pino from 'pino';
import { normalizeToE164BR } from '../utils.js';
import {
  PIPEDRIVE_FALLBACK_CREATE_PERSON,
  PIPEDRIVE_NOTES_FLUSH_DEBOUNCE_MS,
  PIPEDRIVE_NOTES_MAX_BYTES,
} from '../services/pipedrive/config.js';
import { pipedriveClient } from '../services/pipedrive/client.js';
import { pipedriveV2Client } from '../services/pipedrive/v2Client.js';
import { resolvePipedriveStoreBackend } from '../services/pipedrive/storeBackend.js';
import { getPipedriveRedisStore } from '../services/pipedrive/redisStoreInstance.js';
import {
  buildNoteAppendHtml,
  buildNoteHeaderHtml,
  computeAdaptiveWindowMinutes,
  estimateHtmlBytes,
  shouldStartNewBlockByWindow,
  type PipedrivePendingNoteEvent,
} from '../services/pipedrive/notesEngine.js';
import { PIPEDRIVE_REDIS_URL } from '../services/pipedrive/config.js';

const logger = pino({ level: process.env.LOG_LEVEL || 'info', base: { service: 'pipedrive-notes-queue' } });

interface NoteFlushJobPayload {
  companyId: number;
  conversationKey: string;
}

const QUEUE_NAME = 'pipedrive-notes-flush';
const FLUSH_SCHEDULE_TTL_SECONDS = 600;

const backend = resolvePipedriveStoreBackend();
const ENABLED = backend === 'redis' && Boolean((PIPEDRIVE_REDIS_URL || '').trim());

let queue: Queue<NoteFlushJobPayload> | null = null;
let worker: Worker<NoteFlushJobPayload> | null = null;
let redisClient: IORedis | null = null;
let redisWorkerConn: IORedis | null = null;

export function isPipedriveNotesQueueEnabled(): boolean {
  return ENABLED;
}

export async function initPipedriveNotesQueue(): Promise<void> {
  if (!ENABLED) return;
  if (!redisClient) {
    redisClient = new IORedis(PIPEDRIVE_REDIS_URL!, { maxRetriesPerRequest: null });
    redisWorkerConn = redisClient.duplicate();
  }
  queue = new Queue<NoteFlushJobPayload>(QUEUE_NAME, { connection: redisClient });
}

function extractDigitsFromConversationKey(key: string): string | null {
  const digits = (key || '').replace(/\D+/g, '');
  if (!digits) return null;
  const normalized = normalizeToE164BR(digits);
  return normalized ?? digits;
}

async function ensurePersonId(options: {
  phone: string;
  nameHint?: string | null;
  companyId: number;
  apiDomain?: string | null;
}): Promise<number> {
  const found = await pipedriveV2Client.findPersonByPhone({
    phone: options.phone,
    companyId: options.companyId,
    apiDomain: options.apiDomain ?? null,
  });
  if (found) return found.id;
  if (!PIPEDRIVE_FALLBACK_CREATE_PERSON) throw new Error('pipedrive_person_not_found');
  const created = await pipedriveV2Client.createPerson({
    name: options.nameHint?.trim() || options.phone,
    phone: options.phone.startsWith('+') ? options.phone : `+${options.phone}`,
    companyId: options.companyId,
    apiDomain: options.apiDomain ?? null,
  });
  return created.id;
}

async function loadOrFetchNoteHtml(options: { companyId: number; apiDomain?: string | null; noteId: number }): Promise<string> {
  const store = getPipedriveRedisStore();
  const cached = await store.getNoteContent(options.companyId, options.noteId);
  if (cached != null) return cached;
  const note = await pipedriveClient.getNote({
    id: options.noteId,
    companyId: options.companyId,
    apiDomain: options.apiDomain ?? null,
  });
  const html = note.content || '';
  await store.setNoteContent(options.companyId, options.noteId, html);
  return html;
}

function uniqueByMessageId(events: PipedrivePendingNoteEvent[]): PipedrivePendingNoteEvent[] {
  const map = new Map<string, PipedrivePendingNoteEvent>();
  for (const ev of events) {
    if (!ev?.message_id) continue;
    if (!map.has(ev.message_id)) map.set(ev.message_id, ev);
  }
  return Array.from(map.values());
}

function parseEvents(payloads: string[]): PipedrivePendingNoteEvent[] {
  const parsed: PipedrivePendingNoteEvent[] = [];
  for (const raw of payloads) {
    try {
      const ev = JSON.parse(raw) as Partial<PipedrivePendingNoteEvent>;
      if (!ev?.message_id || !ev?.direction || typeof ev.text !== 'string') continue;
      const ts = typeof ev.ts_ms === 'number' && Number.isFinite(ev.ts_ms) ? ev.ts_ms : Date.now();
      const direction = ev.direction === 'inbound' ? 'inbound' : 'outbound';
      parsed.push({
        message_id: String(ev.message_id),
        ts_ms: Math.floor(ts),
        direction,
        text: ev.text,
        instance_id: typeof ev.instance_id === 'string' ? ev.instance_id : null,
        wa_link: typeof ev.wa_link === 'string' ? ev.wa_link : null,
        created_at_iso: typeof ev.created_at_iso === 'string' ? ev.created_at_iso : null,
        contact_name: typeof ev.contact_name === 'string' ? ev.contact_name : null,
        contact_phone: typeof ev.contact_phone === 'string' ? ev.contact_phone : null,
      });
    } catch {
      // ignore
    }
  }
  return parsed;
}

function filterAlreadyPresent(html: string, events: PipedrivePendingNoteEvent[]): PipedrivePendingNoteEvent[] {
  if (!html) return events;
  return events.filter((ev) => !html.includes(`<!--mid:${ev.message_id}-->`));
}

export async function enqueuePipedriveNoteEvent(options: {
  companyId: number;
  conversationKey: string;
  messageId: string;
  direction: 'inbound' | 'outbound';
  text: string;
  instanceId?: string | null;
  contactName?: string | null;
  contactPhone?: string | null;
  createdAtIso?: string | null;
}): Promise<void> {
  if (!ENABLED) return;
  const store = getPipedriveRedisStore();
  const digits = extractDigitsFromConversationKey(options.conversationKey);
  const waLink = digits ? `https://wa.me/${digits}` : null;
  const tsMs = options.createdAtIso ? new Date(options.createdAtIso).getTime() : Date.now();
  const payload: PipedrivePendingNoteEvent = {
    message_id: options.messageId,
    ts_ms: Number.isFinite(tsMs) ? Math.floor(tsMs) : Date.now(),
    direction: options.direction,
    text: options.text,
    instance_id: options.instanceId ?? null,
    wa_link: waLink,
    created_at_iso: options.createdAtIso ?? null,
    contact_name: options.contactName ?? null,
    contact_phone: options.contactPhone ?? null,
  };
  const payloadJson = JSON.stringify(payload);

  const enqueued = await store.tryEnqueueNoteEvent({
    companyId: options.companyId,
    conversationKey: options.conversationKey,
    messageId: options.messageId,
    payloadJson,
  });
  if (!enqueued) return;

  const scheduled = await store.scheduleNoteFlush({
    companyId: options.companyId,
    conversationKey: options.conversationKey,
    ttlSeconds: FLUSH_SCHEDULE_TTL_SECONDS,
  });
  if (!scheduled) return;
  if (!queue) return;

  const jobId = `note_flush:${options.companyId}:${options.conversationKey}`;
  const delay = Math.max(0, Math.floor(PIPEDRIVE_NOTES_FLUSH_DEBOUNCE_MS));
  const opts: JobsOptions = {
    jobId,
    delay,
    removeOnComplete: true,
    removeOnFail: { count: 50 },
    attempts: 8,
    backoff: { type: 'exponential', delay: 1_000 },
  };

  try {
    await queue.add(QUEUE_NAME, { companyId: options.companyId, conversationKey: options.conversationKey }, opts);
  } catch (err: any) {
    logger.debug({ err: err?.message ?? err, jobId }, 'notes.enqueue.job.exists');
  }
}

export async function startPipedriveNotesWorker(): Promise<void> {
  if (!ENABLED) return;
  const connection = redisWorkerConn ?? redisClient;
  const workerOpts: WorkerOptions = { connection };

  worker = new Worker<NoteFlushJobPayload>(
    QUEUE_NAME,
    async (job) => {
      const { companyId, conversationKey } = job.data;
      const store = getPipedriveRedisStore();

      const lockToken = await store.acquireLock({ companyId, conversationKey, ttlSeconds: 30 });
      if (!lockToken) {
        throw new Error('lock_busy');
      }

      try {
        // Drain pending into processing (best effort, bounded)
        for (;;) {
          const moved = await store.movePendingToProcessing({ companyId, conversationKey, max: 500 });
          if (!moved.length) break;
        }

        const payloads = await store.listProcessingPayloads(companyId, conversationKey);
        if (!payloads.length) {
          await store.clearNoteFlushSchedule(companyId, conversationKey);
          await store.clearProcessing(companyId, conversationKey);
          return;
        }

        const events = uniqueByMessageId(parseEvents(payloads)).sort((a, b) => a.ts_ms - b.ts_ms);
        const digits = extractDigitsFromConversationKey(conversationKey);
        const phone = digits ? `+${digits}` : conversationKey;

        const tokenInfo = await pipedriveClient.getAccessToken({ companyId });
        if (!tokenInfo) throw new Error('pipedrive_token_missing');
        const apiDomain = tokenInfo.token.api_domain ?? null;

        const block = await store.getNoteBlock(companyId, conversationKey);
        const existingNoteId = Number(block.note_id) || null;
        const startedAtIso = block.started_at_iso && block.started_at_iso.trim() ? block.started_at_iso.trim() : null;
        const windowMinutes = Number(block.window_minutes) || 0;
        const messageCount = Number(block.message_count) || 0;

        const nowIso = new Date().toISOString();

        const shouldNewByWindow =
          existingNoteId &&
          startedAtIso &&
          shouldStartNewBlockByWindow({
            startedAtIso,
            windowMinutes: windowMinutes || 15,
          });

        let noteId = existingNoteId;
        const startingNewBlock = !noteId || shouldNewByWindow;
        const startedAt = startingNewBlock
          ? new Date(events[0]!.ts_ms).toISOString()
          : (startedAtIso ?? new Date(events[0]!.ts_ms).toISOString());

        const header = buildNoteHeaderHtml({ conversationKey, startedAtIso: startedAt });

        let noteHtml = '';
        if (noteId && !startingNewBlock) {
          noteHtml = await loadOrFetchNoteHtml({ companyId, apiDomain, noteId });
        }

        const freshEvents = filterAlreadyPresent(noteHtml, events);
        if (!freshEvents.length) {
          await store.clearProcessing(companyId, conversationKey);
          await store.clearNoteFlushSchedule(companyId, conversationKey);
          return;
        }

        const appendHtml = buildNoteAppendHtml(freshEvents);

        if (startingNewBlock) {
          const personId = await ensurePersonId({
            phone,
            nameHint: freshEvents.find((e) => e.contact_name)?.contact_name ?? null,
            companyId,
            apiDomain,
          });
          await store.setConversationMeta(companyId, conversationKey, { person_id: personId });
          const initialHtml = `${header}\n${appendHtml}`;
          const bytes = estimateHtmlBytes(initialHtml);
          const created = await pipedriveClient.createNote({
            content: initialHtml,
            personId,
            companyId,
            apiDomain,
          });
          noteId = created.id;
          await store.setNoteContent(companyId, noteId, initialHtml);
          await store.setNoteBlock(companyId, conversationKey, {
            note_id: String(noteId),
            person_id: String(personId),
            started_at_iso: startedAt,
            window_minutes: String(computeAdaptiveWindowMinutes({ startedAtIso: startedAt, messageCount: freshEvents.length, bytes })),
            bytes: String(bytes),
            message_count: String(freshEvents.length),
            last_message_at_iso: new Date(freshEvents[freshEvents.length - 1]!.ts_ms).toISOString(),
            updated_at_iso: nowIso,
          });
          await store.incrMetric(companyId, 'notes_blocks_created', 1);
        } else {
          if (!noteHtml) noteHtml = await loadOrFetchNoteHtml({ companyId, apiDomain, noteId });
          const nextHtml = `${noteHtml}\n${appendHtml}`.trim();
          const nextBytes = estimateHtmlBytes(nextHtml);
          if (nextBytes > PIPEDRIVE_NOTES_MAX_BYTES) {
            const personIdRaw = Number(block.person_id) || null;
            const personId = personIdRaw ?? (await ensurePersonId({
              phone,
              nameHint: freshEvents.find((e) => e.contact_name)?.contact_name ?? null,
              companyId,
              apiDomain,
            }));
            await store.setConversationMeta(companyId, conversationKey, { person_id: personId });
            const initialHtml = `${header}\n${appendHtml}`;
            const bytes = estimateHtmlBytes(initialHtml);
            const created = await pipedriveClient.createNote({
              content: initialHtml,
              personId,
              companyId,
              apiDomain,
            });
            noteId = created.id;
            await store.setNoteContent(companyId, noteId, initialHtml);
            await store.setNoteBlock(companyId, conversationKey, {
              note_id: String(noteId),
              person_id: String(personId),
              started_at_iso: startedAt,
              window_minutes: String(computeAdaptiveWindowMinutes({ startedAtIso: startedAt, messageCount: freshEvents.length, bytes })),
              bytes: String(bytes),
              message_count: String(freshEvents.length),
              last_message_at_iso: new Date(freshEvents[freshEvents.length - 1]!.ts_ms).toISOString(),
              updated_at_iso: nowIso,
            });
            await store.incrMetric(companyId, 'notes_size_rollover', 1);
            await store.incrMetric(companyId, 'notes_blocks_created', 1);
          } else {
            await pipedriveClient.updateNote({ id: noteId, content: nextHtml, companyId, apiDomain });
            await store.setNoteContent(companyId, noteId, nextHtml);
            const nextMessageCount = messageCount + freshEvents.length;
            await store.setNoteBlock(companyId, conversationKey, {
              note_id: String(noteId),
              started_at_iso: startedAt,
              window_minutes: String(computeAdaptiveWindowMinutes({ startedAtIso: startedAt, messageCount: nextMessageCount, bytes: nextBytes })),
              bytes: String(nextBytes),
              message_count: String(nextMessageCount),
              last_message_at_iso: new Date(freshEvents[freshEvents.length - 1]!.ts_ms).toISOString(),
              updated_at_iso: nowIso,
            });
            await store.incrMetric(companyId, 'notes_blocks_updated', 1);
          }
        }

        await store.clearProcessing(companyId, conversationKey);
        await store.clearNoteFlushSchedule(companyId, conversationKey);

        // If new pending arrived while processing, schedule another flush.
        const pendingLen = await store.getPendingLength(companyId, conversationKey);
        if (pendingLen > 0) {
          const scheduled = await store.scheduleNoteFlush({
            companyId,
            conversationKey,
            ttlSeconds: FLUSH_SCHEDULE_TTL_SECONDS,
          });
          if (scheduled && queue) {
            const jobId = `note_flush:${companyId}:${conversationKey}`;
            const delay = Math.max(0, Math.floor(PIPEDRIVE_NOTES_FLUSH_DEBOUNCE_MS));
            await queue.add(
              QUEUE_NAME,
              { companyId, conversationKey },
              {
                jobId,
                delay,
                removeOnComplete: true,
                removeOnFail: { count: 50 },
                attempts: 8,
                backoff: { type: 'exponential', delay: 1_000 },
              },
            );
          }
        }
      } catch (err: any) {
        await store.incrMetric(companyId, 'notes_flush_failed', 1).catch(() => undefined);
        logger.warn({ err: err?.message ?? err, companyId, conversationKey }, 'notes.flush.failed');
        throw err;
      } finally {
        await store.releaseLock({ companyId, conversationKey, token: lockToken });
      }
    },
    workerOpts,
  );
}

export async function stopPipedriveNotesWorker(): Promise<void> {
  await worker?.close();
  await queue?.close();
  worker = null;
  queue = null;
  if (redisWorkerConn) {
    redisWorkerConn.quit().catch(() => undefined);
    redisWorkerConn = null;
  }
  if (redisClient) {
    redisClient.quit().catch(() => undefined);
    redisClient = null;
  }
}
