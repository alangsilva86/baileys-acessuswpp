import { mkdir, readFile, writeFile } from 'node:fs/promises';
import crypto from 'node:crypto';
import path from 'node:path';
import { resolvePipedriveDataDir } from './dataDir.js';

const DATA_DIR = resolvePipedriveDataDir();
const WEBHOOKS_FILE = path.join(DATA_DIR, 'pipedrive-webhooks.json');
const SAVE_DEBOUNCE_MS = 500;
const MAX_EVENTS = 500;
const MAX_SEEN = 5000;

export interface StoredPipedriveWebhookEvent {
  key: string;
  received_at: string;
  object: string | null;
  action: string | null;
  entity_id: number | null;
  duplicate: boolean;
  payload: unknown;
}

interface WebhookStoreData {
  version: number;
  events: StoredPipedriveWebhookEvent[];
  seen: Record<string, string>;
}

const defaultStore: WebhookStoreData = { version: 1, events: [], seen: {} };
let storeCache: WebhookStoreData | null = null;
let saveTimer: NodeJS.Timeout | null = null;

async function ensureDataDir(): Promise<void> {
  await mkdir(DATA_DIR, { recursive: true });
}

async function loadStore(): Promise<WebhookStoreData> {
  if (storeCache) return storeCache;
  try {
    const raw = await readFile(WEBHOOKS_FILE, 'utf8');
    storeCache = raw.trim() ? (JSON.parse(raw) as WebhookStoreData) : { ...defaultStore };
  } catch (err: any) {
    if (err?.code === 'ENOENT') {
      storeCache = { ...defaultStore };
    } else {
      storeCache = { ...defaultStore };
    }
  }
  if (!storeCache.events) storeCache.events = [];
  if (!storeCache.seen) storeCache.seen = {};
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
  await ensureDataDir();
  await writeFile(WEBHOOKS_FILE, `${JSON.stringify(storeCache, null, 2)}\n`, 'utf8');
}

function nowIso(): string {
  return new Date().toISOString();
}

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function hashPayload(payload: unknown): string {
  return crypto.createHash('sha256').update(safeStringify(payload)).digest('hex').slice(0, 16);
}

function parseNumber(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string' && value.trim()) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  if (value && typeof value === 'object') {
    const inner = (value as any).value;
    return parseNumber(inner);
  }
  return null;
}

function extractMeta(payload: any): { object: string | null; action: string | null; entityId: number | null; eventId: string | null; ts: string | number | null } {
  const event = typeof payload?.event === 'string' ? payload.event.trim() : null;
  const eventObject = typeof payload?.event_object === 'string' ? payload.event_object.trim() : null;
  const eventAction = typeof payload?.event_action === 'string' ? payload.event_action.trim() : null;

  let object = eventObject;
  let action = eventAction;
  if (event && (!object || !action)) {
    const parts = event.split('.');
    if (parts.length === 2) {
      const [a, o] = parts;
      action = action || a;
      object = object || o;
    }
  }

  const entityId =
    parseNumber(payload?.meta?.id) ??
    parseNumber(payload?.meta?.entity_id) ??
    parseNumber(payload?.current?.id) ??
    null;

  const eventId =
    typeof payload?.event_id === 'string'
      ? payload.event_id.trim()
      : typeof payload?.event_id === 'number'
      ? String(payload.event_id)
      : typeof payload?.meta?.event_id === 'string'
      ? payload.meta.event_id.trim()
      : null;

  const ts =
    payload?.meta?.timestamp ??
    payload?.meta?.time ??
    payload?.timestamp ??
    null;

  return { object: object || null, action: action || null, entityId, eventId, ts };
}

function buildEventKey(meta: ReturnType<typeof extractMeta>, payload: unknown): string {
  const base = meta.eventId ? `event:${meta.eventId}` : `hash:${hashPayload(payload)}`;
  const ts = meta.ts != null ? String(meta.ts) : '';
  return ts ? `${base}:${ts}` : base;
}

function trimEvents(data: WebhookStoreData): void {
  if (data.events.length <= MAX_EVENTS) return;
  data.events = data.events.slice(-MAX_EVENTS);
}

function trimSeen(data: WebhookStoreData): void {
  const keys = Object.keys(data.seen);
  if (keys.length <= MAX_SEEN) return;
  const sorted = keys.sort((a, b) => {
    const at = new Date(data.seen[a] || 0).getTime();
    const bt = new Date(data.seen[b] || 0).getTime();
    return bt - at;
  });
  const keep = new Set(sorted.slice(0, MAX_SEEN));
  for (const key of keys) {
    if (!keep.has(key)) delete data.seen[key];
  }
}

export async function recordPipedriveWebhookEvent(payload: unknown): Promise<{ key: string; duplicate: boolean; meta: { object: string | null; action: string | null; entityId: number | null } }> {
  const data = await loadStore();
  const meta = extractMeta(payload as any);
  const key = buildEventKey(meta, payload);
  const duplicate = Boolean(data.seen[key]);
  const receivedAt = nowIso();

  data.seen[key] = receivedAt;
  trimSeen(data);

  data.events.push({
    key,
    received_at: receivedAt,
    object: meta.object,
    action: meta.action,
    entity_id: meta.entityId,
    duplicate,
    payload,
  });
  trimEvents(data);
  scheduleSave();

  return { key, duplicate, meta: { object: meta.object, action: meta.action, entityId: meta.entityId } };
}

export async function listPipedriveWebhookEvents(options: { limit?: number } = {}): Promise<StoredPipedriveWebhookEvent[]> {
  const data = await loadStore();
  const limit = typeof options.limit === 'number' && Number.isFinite(options.limit) && options.limit > 0 ? Math.floor(options.limit) : 50;
  return data.events.slice(-limit);
}
