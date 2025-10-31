import { mkdir, readFile, writeFile, rm, rename } from 'fs/promises';
import path from 'path';
import { EventEmitter } from 'events';
import pino from 'pino';
import type { WASocket } from '@whiskeysockets/baileys';
import { startWhatsAppInstance, stopWhatsAppInstance, type InstanceContext } from './whatsapp.js';
import { LidMappingStore } from './lidMappingStore.js';

const SESSIONS_ROOT = process.env.SESSION_DIR || './sessions';
const INSTANCES_INDEX = path.join(SESSIONS_ROOT, 'instances.json');
const logger = pino({ level: process.env.LOG_LEVEL || 'info' });
export interface MetricsTimelineEntry {
  ts: number;
  iso: string;
  sent: number;
  pending: number;
  serverAck: number;
  delivered: number;
  read: number;
  played: number;
  failed: number;
  rateInWindow: number;
}

export interface NoteRevisionDiff {
  before: string;
  after: string;
  summary: string;
}

export interface NoteRevision {
  timestamp: string;
  author: string | null;
  diff: NoteRevisionDiff;
}

export interface InstanceMetadata {
  note: string;
  createdAt: string | null;
  updatedAt: string | null;
  revisions: NoteRevision[];
}

export interface InstanceMetrics {
  startedAt: number;
  sent: number;
  sent_by_type: {
    text: number;
    image: number;
    video: number;
    audio: number;
    document: number;
    group: number;
    buttons: number;
    lists: number;
  };
  status_counts: Record<string, number>;
  last: {
    sentId: string | null;
    lastStatusId: string | null;
    lastStatusCode: number | null;
  };
  timeline: MetricsTimelineEntry[];
}

export interface Instance {
  id: string;
  name: string;
  dir: string;
  sock: WASocket | null;
  socketId: number;
  lastQR: string | null;
  qrVersion: number;
  reconnectDelay: number;
  stopping: boolean;
  reconnectTimer: NodeJS.Timeout | null;
  metadata: InstanceMetadata;
  metrics: InstanceMetrics;
  statusMap: Map<string, number>;
  statusTimestamps: Map<string, number>;
  statusCleanupTimer: NodeJS.Timeout | null;
  ackWaiters: Map<string, Set<(status: number | null) => void>>;
  rateWindow: number[];
  context: InstanceContext | null;
  connectionState: 'connecting' | 'open' | 'close' | 'qr_timeout';
  connectionUpdatedAt: number | null;
  connectionStateDetail: {
    statusCode: number | null;
    reason: string | null;
    isLoggedOut: boolean;
    isTimedOut: boolean;
  } | null;
  qrReceivedAt: number | null;
  qrExpiresAt: number | null;
  pairingAttempts: number;
  lastError: string | null;
  phoneNumber: string | null;
  lidMapping: LidMappingStore;
}

const instances = new Map<string, Instance>();

export type InstanceEventReason = 'connection' | 'qr' | 'pairing' | 'error' | 'metadata';

export interface InstanceEventPayload {
  reason: InstanceEventReason;
  instance: Instance;
  detail?: Record<string, unknown> | null;
}

const instanceEventEmitter = new EventEmitter<{ event: [InstanceEventPayload] }>();
instanceEventEmitter.setMaxListeners(0);

function emitInstanceEvent(event: InstanceEventPayload): void {
  instanceEventEmitter.emit('event', event);
}

function onInstanceEvent(listener: (event: InstanceEventPayload) => void): () => void {
  instanceEventEmitter.on('event', listener);
  return () => {
    instanceEventEmitter.off('event', listener);
  };
}

const MAX_NOTE_REVISIONS = 20;
const NOTE_MAX_LENGTH = 280;

function sanitizeNote(value: unknown): string {
  if (typeof value !== 'string') return '';
  return value.trim().slice(0, NOTE_MAX_LENGTH);
}

function toIsoTimestamp(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return date.toISOString();
}

function sanitizeRevisionAuthor(author: unknown): string | null {
  if (typeof author !== 'string') return null;
  const trimmed = author.trim();
  if (!trimmed) return null;
  return trimmed.slice(0, 120);
}

function sanitizeRevisionDiff(raw: any): NoteRevisionDiff {
  const before = sanitizeNote(raw?.before);
  const after = sanitizeNote(raw?.after);
  const summary = typeof raw?.summary === 'string' ? raw.summary.trim().slice(0, 400) : '';
  return { before, after, summary };
}

function normalizeRevision(raw: any): NoteRevision | null {
  if (!raw || typeof raw !== 'object') return null;
  const timestamp = toIsoTimestamp((raw as NoteRevision)?.timestamp ?? (raw as any)?.timestamp);
  if (!timestamp) return null;
  const author = sanitizeRevisionAuthor((raw as NoteRevision)?.author ?? (raw as any)?.author);
  const diff = sanitizeRevisionDiff((raw as NoteRevision)?.diff ?? (raw as any)?.diff ?? {});
  return { timestamp, author, diff };
}

function normalizeRevisions(raw: any): NoteRevision[] {
  if (!Array.isArray(raw)) return [];
  const normalized: NoteRevision[] = [];
  for (const entry of raw) {
    const norm = normalizeRevision(entry);
    if (norm) normalized.push(norm);
  }
  normalized.sort((a, b) => {
    const aTs = new Date(a.timestamp).getTime();
    const bTs = new Date(b.timestamp).getTime();
    return Number.isNaN(bTs) ? -1 : Number.isNaN(aTs) ? 1 : bTs - aTs;
  });
  return normalized.slice(0, MAX_NOTE_REVISIONS);
}

function summarizeNoteDiff(before: string, after: string): string {
  if (before === after) return 'sem alterações';
  const beforeLines = before.split(/\r?\n/);
  const afterLines = after.split(/\r?\n/);
  const result: string[] = [];
  let i = 0;
  let j = 0;
  while (i < beforeLines.length || j < afterLines.length) {
    const prevLine = beforeLines[i] ?? null;
    const nextLine = afterLines[j] ?? null;
    if (prevLine !== null && nextLine !== null && prevLine === nextLine) {
      result.push(` ${prevLine}`);
      i += 1;
      j += 1;
      continue;
    }
    const nextIndex = nextLine !== null ? beforeLines.indexOf(nextLine, i) : -1;
    const prevIndex = prevLine !== null ? afterLines.indexOf(prevLine, j) : -1;
    if (nextIndex === -1 && prevIndex === -1) {
      if (prevLine !== null) result.push(`-${prevLine}`);
      if (nextLine !== null) result.push(`+${nextLine}`);
      i += 1;
      j += 1;
      continue;
    }
    if (nextIndex !== -1 && (prevIndex === -1 || nextIndex - i <= prevIndex - j)) {
      if (nextLine !== null) result.push(`+${nextLine}`);
      j += 1;
      continue;
    }
    if (prevLine !== null) result.push(`-${prevLine}`);
    i += 1;
  }
  const joined = result.join('\n').trim();
  return joined.slice(0, 400) || 'alteração registrada';
}

function recordNoteRevision(instance: Instance, revision: NoteRevision): void {
  const normalized = normalizeRevision(revision);
  if (!normalized) return;
  const current = Array.isArray(instance.metadata.revisions) ? instance.metadata.revisions : [];
  instance.metadata.revisions = normalizeRevisions([normalized, ...current]);
}

function createEmptyMetrics(): InstanceMetrics {
  return {
    startedAt: Date.now(),
    sent: 0,
    sent_by_type: { text: 0, image: 0, video: 0, audio: 0, document: 0, group: 0, buttons: 0, lists: 0 },
    status_counts: { '0': 0, '1': 0, '2': 0, '3': 0, '4': 0, '5': 0 },
    last: { sentId: null, lastStatusId: null, lastStatusCode: null },
    timeline: [],
  };
}

function createMetadata(base?: Partial<InstanceMetadata>): InstanceMetadata {
  const nowIso = new Date().toISOString();
  const note = sanitizeNote(base?.note ?? '');
  const createdAt =
    base?.createdAt === null ? null : toIsoTimestamp(base?.createdAt) ?? (base ? nowIso : null);
  const updatedAt =
    base?.updatedAt === null ? null : toIsoTimestamp(base?.updatedAt) ?? (base ? nowIso : null);
  const revisions = normalizeRevisions(base?.revisions ?? []);
  return { note, createdAt: createdAt ?? nowIso, updatedAt: updatedAt ?? nowIso, revisions };
}

function createInstanceRecord(
  id: string,
  name: string,
  dir: string,
  meta?: Partial<InstanceMetadata>,
): Instance {
  return {
    id,
    name,
    dir,
    sock: null,
    socketId: 0,
    lastQR: null,
    qrVersion: 0,
    reconnectDelay: 1000,
    stopping: false,
    reconnectTimer: null,
    metadata: createMetadata(meta),
    metrics: createEmptyMetrics(),
    statusMap: new Map(),
    statusTimestamps: new Map(),
    statusCleanupTimer: null,
    ackWaiters: new Map(),
    rateWindow: [],
    context: null,
    connectionState: 'close',
    connectionUpdatedAt: Date.now(),
    connectionStateDetail: null,
    qrReceivedAt: null,
    qrExpiresAt: null,
    pairingAttempts: 0,
    lastError: null,
    phoneNumber: null,
    lidMapping: new LidMappingStore(),
  };
}

async function saveInstancesIndex(): Promise<void> {
  const index = [...instances.values()].map((instance) => {
    const metadata = createMetadata(instance.metadata);
    instance.metadata = metadata;
    return {
      id: instance.id,
      name: instance.name,
      dir: instance.dir,
      phoneNumber: instance.phoneNumber,
      metadata: {
        note: metadata.note,
        createdAt: metadata.createdAt || null,
        updatedAt: metadata.updatedAt || null,
        revisions: metadata.revisions,
      },
    };
  });

  try {
    await mkdir(SESSIONS_ROOT, { recursive: true });
    await writeFile(INSTANCES_INDEX, JSON.stringify(index, null, 2));
  } catch (err) {
    logger.error({ err }, 'instance_index.save.failed');
  }
}

async function loadInstances(): Promise<void> {
  try {
    await mkdir(SESSIONS_ROOT, { recursive: true });
    const raw = await readFile(INSTANCES_INDEX, 'utf8');
    const list = JSON.parse(raw);
    if (!Array.isArray(list)) return;

    for (const item of list) {
      if (!item?.id) continue;
      const metadata = createMetadata(item.metadata);
      const instance = createInstanceRecord(
        item.id,
        item.name || item.id,
        item.dir || path.join(SESSIONS_ROOT, item.id),
        metadata,
      );
      if (typeof item.phoneNumber === 'string' && item.phoneNumber.trim()) {
        instance.phoneNumber = item.phoneNumber.trim();
      }
      instances.set(item.id, instance);
    }

    logger.info({ count: instances.size }, 'instances.loaded');
  } catch (err: any) {
    if (err?.code !== 'ENOENT') {
      logger.error({ err }, 'instance_index.load.failed');
    }
    logger.info('instance_index.json not found, starting fresh.');
  }
}

async function startAllInstances(): Promise<void> {
  logger.info({ count: instances.size }, 'instances.starting');
  for (const instance of instances.values()) {
    try {
      await startWhatsAppInstance(instance);
    } catch (err) {
      logger.error({ iid: instance.id, err }, 'instance.start.failed');
    }
  }
}

interface CreateInstanceOptions {
  persist?: boolean;
  autoStart?: boolean;
  dir?: string;
}

async function createInstance(
  id: string,
  name: string,
  meta?: Partial<InstanceMetadata>,
  options: CreateInstanceOptions = {},
): Promise<Instance> {
  const { persist = true, autoStart = true, dir } = options;
  const targetDir = dir ?? path.join(SESSIONS_ROOT, id);
  await mkdir(targetDir, { recursive: true });

  const instance = createInstanceRecord(id, name, targetDir, meta);
  instances.set(id, instance);

  if (autoStart) {
    await startWhatsAppInstance(instance);
  }

  if (persist) {
    await saveInstancesIndex();
  }

  return instance;
}

async function deleteInstance(
  iid: string,
  { removeDir = false, logout = false }: { removeDir?: boolean; logout?: boolean } = {},
): Promise<Instance | null> {
  const instance = instances.get(iid);
  if (!instance) return null;

  await stopWhatsAppInstance(instance, { logout });
  instances.delete(iid);
  await saveInstancesIndex();

  if (removeDir) {
    try {
      await rm(instance.dir, { recursive: true, force: true });
    } catch (err) {
      logger.warn({ iid, err: (err as Error)?.message }, 'instance.dir.remove.failed');
    }
  }

  return instance;
}

function getInstance(iid: string): Instance | undefined {
  return instances.get(iid);
}

function getAllInstances(): Instance[] {
  return [...instances.values()];
}

async function ensureInstance(
  id: string,
  options: { name?: string; meta?: Partial<InstanceMetadata>; autoStart?: boolean } = {},
): Promise<Instance> {
  const existing = getInstance(id);
  if (existing) {
    if (options.autoStart && !existing.sock) {
      await startWhatsAppInstance(existing);
    }
    return existing;
  }

  const name = options.name || id;
  const instance = await createInstance(id, name, options.meta, {
    persist: true,
    autoStart: options.autoStart ?? false,
  });
  return instance;
}

async function ensureInstanceStarted(id: string, options: { name?: string } = {}): Promise<Instance> {
  const instance = await ensureInstance(id, { ...options, autoStart: true });
  if (!instance.sock) {
    await startWhatsAppInstance(instance);
  }
  return instance;
}

async function removeInstance(id: string, options: { logout?: boolean; removeDir?: boolean } = {}): Promise<void> {
  const instance = instances.get(id);
  if (!instance) return;
  await deleteInstance(id, options);
}

async function resetInstanceSession(inst: Instance): Promise<void> {
  const iid = inst.id;

  try {
    await stopWhatsAppInstance(inst, { logout: true });
  } catch (err) {
    logger.warn({ iid, err }, 'instance.reset.stop.failed');
  }

  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backupDir = `${inst.dir}.bak-${stamp}`;
  let backupCreated = false;

  try {
    await rename(inst.dir, backupDir);
    backupCreated = true;
  } catch (err: any) {
    if (err?.code !== 'ENOENT') {
      logger.warn({ iid, err }, 'instance.reset.backup.failed');
      try {
        await rm(inst.dir, { recursive: true, force: true });
      } catch (rmErr) {
        logger.warn({ iid, err: rmErr }, 'instance.reset.cleanup.failed');
      }
    }
  }

  try {
    await mkdir(inst.dir, { recursive: true });
  } catch (err) {
    logger.error({ iid, err }, 'instance.reset.dir.create.failed');
    throw err;
  }

  if (backupCreated) {
    setTimeout(() => {
      rm(backupDir, { recursive: true, force: true }).catch((err) =>
        logger.warn({ iid, err }, 'instance.reset.backup.cleanup.failed'),
      );
    }, 0);
  }

  try {
    await startWhatsAppInstance(inst);
  } catch (err) {
    logger.error({ iid, err }, 'instance.reset.restart.failed');
    throw err;
  }
}

export {
  loadInstances,
  saveInstancesIndex,
  startAllInstances,
  createInstance,
  deleteInstance,
  resetInstanceSession,
  getInstance,
  getAllInstances,
  ensureInstance,
  ensureInstanceStarted,
  removeInstance,
  emitInstanceEvent,
  onInstanceEvent,
  recordNoteRevision,
  summarizeNoteDiff,
  MAX_NOTE_REVISIONS,
};
