import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import pino from 'pino';
import { resolvePipedriveDataDir } from './dataDir.js';

const logger = pino({ level: process.env.LOG_LEVEL || 'info', base: { service: 'pipedrive-metrics' } });

const DATA_DIR = resolvePipedriveDataDir();
const METRICS_FILE = path.join(DATA_DIR, 'pipedrive-metrics.json');
const SAVE_DEBOUNCE_MS = 500;

export interface PipedriveMetricsCounters {
  messages_inbound: number;
  messages_outbound: number;
  channels_ok: number;
  channels_failed: number;
  fallback_notes_created: number;
  fallback_notes_reused: number;
  fallback_notes_failed: number;
  webhook_events_total: number;
  webhook_events_by_object: Record<string, number>;
  automations_sent: number;
  automations_skipped: number;
  automations_failed: number;
}

type NumericCounterKey = Exclude<keyof PipedriveMetricsCounters, 'webhook_events_by_object'>;

export interface PipedriveMetricsData {
  version: number;
  updated_at: string;
  counters: PipedriveMetricsCounters;
  last: {
    message_at: string | null;
    webhook_at: string | null;
    automation_at: string | null;
  };
}

const defaultCounters: PipedriveMetricsCounters = {
  messages_inbound: 0,
  messages_outbound: 0,
  channels_ok: 0,
  channels_failed: 0,
  fallback_notes_created: 0,
  fallback_notes_reused: 0,
  fallback_notes_failed: 0,
  webhook_events_total: 0,
  webhook_events_by_object: {},
  automations_sent: 0,
  automations_skipped: 0,
  automations_failed: 0,
};

const defaultStore: PipedriveMetricsData = {
  version: 1,
  updated_at: new Date().toISOString(),
  counters: { ...defaultCounters },
  last: { message_at: null, webhook_at: null, automation_at: null },
};

let storeCache: PipedriveMetricsData | null = null;
let saveTimer: NodeJS.Timeout | null = null;

async function ensureDataDir(): Promise<void> {
  await mkdir(DATA_DIR, { recursive: true });
}

async function loadStore(): Promise<PipedriveMetricsData> {
  if (storeCache) return storeCache;
  try {
    const raw = await readFile(METRICS_FILE, 'utf8');
    storeCache = raw.trim() ? (JSON.parse(raw) as PipedriveMetricsData) : { ...defaultStore };
  } catch (err: any) {
    if (err?.code === 'ENOENT') {
      storeCache = { ...defaultStore };
    } else {
      storeCache = { ...defaultStore };
    }
  }
  storeCache.counters = { ...defaultCounters, ...(storeCache.counters ?? {}) };
  storeCache.last = { message_at: null, webhook_at: null, automation_at: null, ...(storeCache.last ?? {}) };
  return storeCache;
}

function scheduleSave(): void {
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    void saveStore();
  }, SAVE_DEBOUNCE_MS);
}

async function saveStore(): Promise<void> {
  if (!storeCache) return;
  try {
    await ensureDataDir();
    await writeFile(METRICS_FILE, `${JSON.stringify(storeCache, null, 2)}\n`, 'utf8');
  } catch (err: any) {
    logger.warn({ err: err?.message ?? err }, 'metrics.save.failed');
  }
}

function touchUpdatedAt(store: PipedriveMetricsData): void {
  store.updated_at = new Date().toISOString();
}

function inc(store: PipedriveMetricsData, key: NumericCounterKey, by = 1): void {
  const value = store.counters[key];
  if (typeof value === 'number') {
    store.counters[key] = value + by;
  }
}

export async function getPipedriveMetrics(): Promise<PipedriveMetricsData> {
  const store = await loadStore();
  return JSON.parse(JSON.stringify(store)) as PipedriveMetricsData;
}

export async function recordPipedriveMessage(direction: 'inbound' | 'outbound'): Promise<void> {
  const store = await loadStore();
  if (direction === 'inbound') inc(store, 'messages_inbound', 1);
  else inc(store, 'messages_outbound', 1);
  store.last.message_at = new Date().toISOString();
  touchUpdatedAt(store);
  scheduleSave();
}

export async function recordPipedriveChannelsResult(result: 'ok' | 'failed'): Promise<void> {
  const store = await loadStore();
  inc(store, result === 'ok' ? 'channels_ok' : 'channels_failed', 1);
  touchUpdatedAt(store);
  scheduleSave();
}

export async function recordPipedriveFallbackNote(result: 'created' | 'reused' | 'failed'): Promise<void> {
  const store = await loadStore();
  if (result === 'created') inc(store, 'fallback_notes_created', 1);
  else if (result === 'reused') inc(store, 'fallback_notes_reused', 1);
  else inc(store, 'fallback_notes_failed', 1);
  touchUpdatedAt(store);
  scheduleSave();
}

export async function recordPipedriveWebhookEvent(object: string | null): Promise<void> {
  const store = await loadStore();
  inc(store, 'webhook_events_total', 1);
  const key = object ? object.toLowerCase() : 'unknown';
  store.counters.webhook_events_by_object[key] = (store.counters.webhook_events_by_object[key] ?? 0) + 1;
  store.last.webhook_at = new Date().toISOString();
  touchUpdatedAt(store);
  scheduleSave();
}

export async function recordPipedriveAutomation(result: 'sent' | 'skipped' | 'failed'): Promise<void> {
  const store = await loadStore();
  if (result === 'sent') inc(store, 'automations_sent', 1);
  else if (result === 'skipped') inc(store, 'automations_skipped', 1);
  else inc(store, 'automations_failed', 1);
  store.last.automation_at = new Date().toISOString();
  touchUpdatedAt(store);
  scheduleSave();
}

export function exportPipedriveMetricsCsv(metrics: PipedriveMetricsData): string {
  const flat: Record<string, string | number> = {
    updated_at: metrics.updated_at,
    messages_inbound: metrics.counters.messages_inbound,
    messages_outbound: metrics.counters.messages_outbound,
    channels_ok: metrics.counters.channels_ok,
    channels_failed: metrics.counters.channels_failed,
    fallback_notes_created: metrics.counters.fallback_notes_created,
    fallback_notes_reused: metrics.counters.fallback_notes_reused,
    fallback_notes_failed: metrics.counters.fallback_notes_failed,
    webhook_events_total: metrics.counters.webhook_events_total,
    automations_sent: metrics.counters.automations_sent,
    automations_skipped: metrics.counters.automations_skipped,
    automations_failed: metrics.counters.automations_failed,
  };
  const headers = Object.keys(flat);
  const values = headers.map((key) => String(flat[key] ?? ''));
  return `${headers.join(',')}\n${values.join(',')}\n`;
}
