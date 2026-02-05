import { Queue, Worker, type JobsOptions, type WorkerOptions, type Job } from 'bullmq';
import IORedis from 'ioredis';
import { riskGuardian } from '../risk/guardian.js';
import { getInstance } from '../instanceManager.js';
import { allowSend, sendWithTimeout } from '../utils.js';
import type { Instance } from '../instanceManager.js';

export type SendJobType = 'text' | 'buttons' | 'list' | 'media';

export interface SendJobPayload {
  iid: string;
  type: SendJobType;
  jid: string;
  content: any;
  options?: Record<string, unknown>;
}

export type SendQueueJobSummary = {
  id: string;
  iid: string;
  type: SendJobType;
  jid: string;
  to: string | null;
  attemptsMade: number;
  timestamp: number;
  processedOn: number | null;
  finishedOn: number | null;
  failedReason: string | null;
};

export type SendQueueJobDetails = SendQueueJobSummary & {
  state: string | null;
  stacktrace: string[] | null;
  opts: Record<string, unknown> | null;
  contentSummary: Record<string, unknown> | null;
};

const QUEUE_NAME = 'send-queue';
const REDIS_URL = process.env.REDIS_URL || process.env.REDIS_DSN || process.env.REDIS_CONNECTION_STRING || '';
const ENABLE_SEND_QUEUE = process.env.ENABLE_SEND_QUEUE !== '0' && !!REDIS_URL;

let queue: Queue<SendJobPayload> | null = null;
let worker: Worker<SendJobPayload> | null = null;
let redisClient: IORedis | null = null;
let redisCounter: IORedis | null = null;
let redisWorkerConn: IORedis | null = null;

const dailySends = new Map<string, { date: string; count: number }>();
const lastSendAt = new Map<string, number>();

export function isSendQueueEnabled(): boolean {
  return ENABLE_SEND_QUEUE;
}

export async function initSendQueue(): Promise<void> {
  if (!ENABLE_SEND_QUEUE) return;
  if (!redisClient) {
    redisClient = new IORedis(REDIS_URL!, { maxRetriesPerRequest: null });
    redisCounter = redisClient.duplicate();
    redisWorkerConn = redisClient.duplicate();
  }
  queue = new Queue<SendJobPayload>(QUEUE_NAME, { connection: redisClient });
}

export async function enqueueSendJob(payload: SendJobPayload, opts: JobsOptions = {}): Promise<string> {
  if (!queue || !ENABLE_SEND_QUEUE) throw new Error('send_queue_disabled');
  const job = await queue.add(QUEUE_NAME, payload, opts);
  return job.id as string;
}

export async function getQueueMetrics(): Promise<
  | null
  | {
      waiting: number;
      active: number;
      delayed: number;
      failed: number;
      completed: number;
      etaSeconds?: number | null;
    }
> {
  if (!queue || !ENABLE_SEND_QUEUE) return null;
  const counts = await queue.getJobCounts();
  let etaSeconds: number | null = null;
  try {
    const waiting = await queue.getWaiting();
    if (waiting.length) {
      const first = waiting[0];
      const now = Date.now();
      const diff = first.timestamp ? now - first.timestamp : 0;
      const processed = counts.completed ?? 0;
      const total = waiting.length + (counts.active ?? 0);
      if (total > 0 && diff > 0) {
        const avgPerJob = diff / Math.max(1, processed + 1);
        etaSeconds = Math.max(1, Math.round((total - 1) * (avgPerJob / 1000)));
      }
    }
  } catch {
    etaSeconds = null;
  }
  return {
    waiting: counts.waiting ?? 0,
    active: counts.active ?? 0,
    delayed: counts.delayed ?? 0,
    failed: counts.failed ?? 0,
    completed: counts.completed ?? 0,
    etaSeconds,
  };
}

export async function startSendWorker(): Promise<void> {
  if (!ENABLE_SEND_QUEUE) return;
  const connection = redisWorkerConn ?? redisClient;
  const workerOpts: WorkerOptions = { connection };
  worker = new Worker<SendJobPayload>(
    QUEUE_NAME,
    async (job) => {
      const data = job.data;
      const inst = getInstance(data.iid);
      if (!inst?.sock) throw new Error('instance_offline');

      await enforceTier(inst);

      if (!allowSend(inst)) {
        throw new Error('rate_limit_window');
      }

      switch (data.type) {
        case 'text':
          await inst.context?.messageService?.sendText(data.jid, data.content?.text ?? '', data.options as any);
          break;
        case 'buttons':
          await inst.context?.messageService?.sendButtons(data.jid, data.content, data.options as any);
          break;
        case 'list':
          await inst.context?.messageService?.sendList(data.jid, data.content, data.options as any);
          break;
        case 'media':
          await inst.context?.messageService?.sendMedia(
            data.jid,
            data.content?.type,
            data.content?.media,
            data.options as any,
          );
          break;
        default:
          throw new Error(`job_type_unsupported:${data.type}`);
      }
    },
    workerOpts,
  );
}

function toPhoneFromJid(jid: string | null | undefined): string | null {
  if (!jid) return null;
  const raw = String(jid);
  const base = raw.split('@')[0] ?? raw;
  const digits = base.replace(/\D+/g, '');
  return digits || null;
}

function summarizeJobContent(payload: SendJobPayload | null | undefined): Record<string, unknown> | null {
  if (!payload) return null;
  const content = payload.content ?? null;
  if (!content || typeof content !== 'object') {
    return { hasContent: Boolean(content) };
  }

  if (payload.type === 'text') {
    const text = typeof (content as any).text === 'string' ? String((content as any).text) : '';
    return { textLength: text.length, preview: text ? `${text.slice(0, 120)}${text.length > 120 ? '…' : ''}` : null };
  }

  if (payload.type === 'buttons') {
    const buttons = Array.isArray((content as any).buttons) ? (content as any).buttons : null;
    return { buttonsCount: Array.isArray(buttons) ? buttons.length : null };
  }

  if (payload.type === 'list') {
    const sections = Array.isArray((content as any).sections) ? (content as any).sections : null;
    const sectionsCount = Array.isArray(sections) ? sections.length : null;
    const optionsCount =
      Array.isArray(sections)
        ? sections.reduce((acc: number, section: any) => acc + (Array.isArray(section?.options) ? section.options.length : 0), 0)
        : null;
    return { sectionsCount, optionsCount };
  }

  if (payload.type === 'media') {
    const media = (content as any)?.media;
    const hasUrl = Boolean(media && typeof media === 'object' && typeof media.url === 'string' && media.url);
    const base64 = media && typeof media === 'object' && typeof media.base64 === 'string' ? media.base64 : '';
    return {
      mediaType: typeof (content as any)?.type === 'string' ? (content as any).type : null,
      hasUrl,
      base64Chars: base64 ? base64.length : 0,
    };
  }

  return null;
}

function summarizeJob(job: Job<SendJobPayload>, state: string | null): SendQueueJobDetails {
  const data = job.data as SendJobPayload;
  const jid = data?.jid ? String(data.jid) : '';
  const iid = data?.iid ? String(data.iid) : '';
  const type = (data?.type as SendJobType) ?? 'text';

  return {
    id: String(job.id ?? ''),
    iid,
    type,
    jid,
    to: toPhoneFromJid(jid),
    attemptsMade: Number(job.attemptsMade ?? 0),
    timestamp: Number(job.timestamp ?? 0),
    processedOn: job.processedOn ?? null,
    finishedOn: job.finishedOn ?? null,
    failedReason: job.failedReason ?? null,
    state,
    stacktrace: Array.isArray(job.stacktrace) ? job.stacktrace : null,
    opts: job.opts ? { ...job.opts } : null,
    contentSummary: summarizeJobContent(data),
  };
}

export async function listFailedSendJobs(limit = 50): Promise<SendQueueJobSummary[] | null> {
  if (!queue || !ENABLE_SEND_QUEUE) return null;
  const limitRaw = Number(limit);
  const safeLimit = Number.isFinite(limitRaw) ? Math.max(1, Math.min(Math.floor(limitRaw), 200)) : 50;
  const jobs = await queue.getFailed(0, safeLimit - 1);
  return jobs.map((job) => {
    const data = job.data as SendJobPayload;
    const jid = data?.jid ? String(data.jid) : '';
    return {
      id: String(job.id ?? ''),
      iid: data?.iid ? String(data.iid) : '',
      type: (data?.type as SendJobType) ?? 'text',
      jid,
      to: toPhoneFromJid(jid),
      attemptsMade: Number(job.attemptsMade ?? 0),
      timestamp: Number(job.timestamp ?? 0),
      processedOn: job.processedOn ?? null,
      finishedOn: job.finishedOn ?? null,
      failedReason: job.failedReason ?? null,
    };
  });
}

export async function getSendJobDetails(jobId: string): Promise<SendQueueJobDetails | null> {
  if (!queue || !ENABLE_SEND_QUEUE) return null;
  const job = await queue.getJob(jobId);
  if (!job) return null;
  let state: string | null = null;
  try {
    state = await job.getState();
  } catch {
    state = null;
  }
  return summarizeJob(job, state);
}

export async function retrySendJob(jobId: string): Promise<{ ok: boolean; state: string | null } | null> {
  if (!queue || !ENABLE_SEND_QUEUE) return null;
  const job = await queue.getJob(jobId);
  if (!job) return null;
  const state = await job.getState().catch(() => null);
  if (state !== 'failed') {
    return { ok: false, state };
  }
  await job.retry();
  const next = await job.getState().catch(() => null);
  return { ok: true, state: next };
}

async function enforceTier(inst: Instance): Promise<void> {
  const now = Date.now();
  const ageMs = inst.pairedAt ? now - inst.pairedAt : 0;
  const ageDays = ageMs / (24 * 60 * 60 * 1000);
  const tier = ageDays < 5 ? 'tier1' : 'tier2';
  const today = new Date().toISOString().slice(0, 10);
  const maxPerDay = tier === 'tier1' ? 100 : Number.POSITIVE_INFINITY;
  const minIntervalMs = tier === 'tier1' ? 5_000 : 0;

  // Persist daily counters in Redis when available
  if (redisCounter) {
    const key = `tier:daily:${inst.id}:${today}`;
    const count = await redisCounter.incr(key);
    await redisCounter.expire(key, 86_400);
    if (count > maxPerDay) {
      throw new Error('tier_daily_limit');
    }

    if (minIntervalMs) {
      const lastKey = `tier:last:${inst.id}`;
      const last = Number(await redisCounter.get(lastKey)) || 0;
      if (last > 0 && now - last < minIntervalMs) {
        await new Promise((resolve) => setTimeout(resolve, minIntervalMs - (now - last)));
      }
      await redisCounter.set(lastKey, String(Date.now()), 'EX', 86_400);
    }
    return;
  }

  // Fallback in-memory if Redis unavailable
  const bucket = dailySends.get(inst.id);
  if (!bucket || bucket.date !== today) {
    dailySends.set(inst.id, { date: today, count: 0 });
  }
  const state = dailySends.get(inst.id)!;
  if (state.count >= maxPerDay) {
    throw new Error('tier_daily_limit');
  }
  state.count += 1;
  dailySends.set(inst.id, state);

  const last = lastSendAt.get(inst.id) ?? 0;
  if (minIntervalMs && now - last < minIntervalMs) {
    await new Promise((resolve) => setTimeout(resolve, minIntervalMs - (now - last)));
  }
  lastSendAt.set(inst.id, Date.now());
}

export async function stopSendWorker(): Promise<void> {
  await worker?.close();
  await queue?.close();
  worker = null;
  queue = null;
  if (redisWorkerConn) {
    redisWorkerConn.quit().catch(() => undefined);
    redisWorkerConn = null;
  }
  if (redisCounter) {
    redisCounter.quit().catch(() => undefined);
    redisCounter = null;
  }
  if (redisClient) {
    redisClient.quit().catch(() => undefined);
    redisClient = null;
  }
}
