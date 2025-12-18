import { Queue, Worker, type JobsOptions, type WorkerOptions } from 'bullmq';
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
    }
> {
  if (!queue || !ENABLE_SEND_QUEUE) return null;
  const counts = await queue.getJobCounts();
  return {
    waiting: counts.waiting ?? 0,
    active: counts.active ?? 0,
    delayed: counts.delayed ?? 0,
    failed: counts.failed ?? 0,
    completed: counts.completed ?? 0,
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
