import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { resolvePipedriveDataDir } from './dataDir.js';

const DATA_DIR = resolvePipedriveDataDir();
const FALLBACK_FILE = path.join(DATA_DIR, 'pipedrive-fallback-notes.json');
const SAVE_DEBOUNCE_MS = 500;
const MAX_RECORDS = 5000;

interface FallbackNoteEntry {
  message_key: string;
  note_id: number;
  created_at: string;
  updated_at: string;
}

interface FallbackStoreData {
  version: number;
  notes: Record<string, FallbackNoteEntry>;
}

const defaultStore: FallbackStoreData = { version: 1, notes: {} };
let storeCache: FallbackStoreData | null = null;
let saveTimer: NodeJS.Timeout | null = null;

async function ensureDataDir(): Promise<void> {
  await mkdir(DATA_DIR, { recursive: true });
}

async function loadStore(): Promise<FallbackStoreData> {
  if (storeCache) return storeCache;
  try {
    const raw = await readFile(FALLBACK_FILE, 'utf8');
    if (!raw.trim()) {
      storeCache = { ...defaultStore };
      return storeCache;
    }
    storeCache = JSON.parse(raw) as FallbackStoreData;
  } catch (err: any) {
    if (err?.code === 'ENOENT') {
      storeCache = { ...defaultStore };
    } else {
      storeCache = { ...defaultStore };
    }
  }
  if (!storeCache.notes) storeCache.notes = {};
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
  await writeFile(FALLBACK_FILE, `${JSON.stringify(storeCache, null, 2)}\n`, 'utf8');
}

function nowIso(): string {
  return new Date().toISOString();
}

function trimStore(data: FallbackStoreData): void {
  const entries = Object.values(data.notes);
  if (entries.length <= MAX_RECORDS) return;
  const sorted = entries.sort((a, b) => {
    const at = new Date(a.updated_at).getTime();
    const bt = new Date(b.updated_at).getTime();
    return bt - at;
  });
  const keep = new Set(sorted.slice(0, MAX_RECORDS).map((entry) => entry.message_key));
  for (const key of Object.keys(data.notes)) {
    if (!keep.has(key)) delete data.notes[key];
  }
}

export function buildFallbackMessageKey(options: { instanceId: string; messageId: string }): string {
  return `${options.instanceId}:${options.messageId}`;
}

export async function getFallbackNoteId(messageKey: string): Promise<number | null> {
  const data = await loadStore();
  const found = data.notes[messageKey];
  return typeof found?.note_id === 'number' && Number.isFinite(found.note_id) ? found.note_id : null;
}

export async function upsertFallbackNoteMapping(options: { messageKey: string; noteId: number }): Promise<void> {
  const data = await loadStore();
  const now = nowIso();
  const existing = data.notes[options.messageKey];
  data.notes[options.messageKey] = {
    message_key: options.messageKey,
    note_id: options.noteId,
    created_at: existing?.created_at ?? now,
    updated_at: now,
  };
  trimStore(data);
  scheduleSave();
}
