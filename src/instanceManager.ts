import { mkdir, readFile, writeFile, rm, rename } from 'fs/promises';
import path from 'path';
import pino from 'pino';
import type { WASocket } from '@whiskeysockets/baileys';
import { startWhatsAppInstance, stopWhatsAppInstance, type InstanceContext } from './whatsapp.js';

const SESSIONS_ROOT = process.env.SESSION_DIR || './sessions';
const INSTANCES_INDEX = path.join(SESSIONS_ROOT, 'instances.json');
const logger = pino({ level: process.env.LOG_LEVEL || 'info' });
type AckStatusCode = number;

interface AckWaiter {
  resolve: (value: AckStatusCode | null) => void;
  timer: NodeJS.Timeout;
}

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

export interface InstanceMetadata {
  note: string;
  createdAt: string | null;
  updatedAt: string | null;
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
    lastStatusCode: AckStatusCode | null;
  };
  ack: {
    totalMs: number;
    count: number;
    avgMs: number;
    lastMs: number | null;
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
  reconnectDelay: number;
  stopping: boolean;
  reconnectTimer: NodeJS.Timeout | null;
  metadata: InstanceMetadata;
  metrics: InstanceMetrics;
  statusMap: Map<string, AckStatusCode>;
  statusTimestamps: Map<string, number>;
  statusCleanupTimer: NodeJS.Timeout | null;
  ackWaiters: Map<string, AckWaiter>;
  rateWindow: number[];
  ackSentAt: Map<string, number>;
  context: InstanceContext | null;
  connectionState: 'connecting' | 'open' | 'close';
  connectionUpdatedAt: number | null;
}

const instances = new Map<string, Instance>();

function createEmptyMetrics(): InstanceMetrics {
  return {
    startedAt: Date.now(),
    sent: 0,
    sent_by_type: { text: 0, image: 0, video: 0, audio: 0, document: 0, group: 0, buttons: 0, lists: 0 },
    status_counts: { '1': 0, '2': 0, '3': 0, '4': 0, '5': 0 },
    last: { sentId: null, lastStatusId: null, lastStatusCode: null },
    ack: { totalMs: 0, count: 0, avgMs: 0, lastMs: null },
    timeline: [],
  };
}

function createMetadata(base?: Partial<InstanceMetadata>): InstanceMetadata {
  const nowIso = new Date().toISOString();
  return {
    note: base?.note?.slice(0, 280) || '',
    createdAt: base?.createdAt ?? nowIso,
    updatedAt: base?.updatedAt ?? nowIso,
  };
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
    ackSentAt: new Map(),
    context: null,
    connectionState: 'close',
    connectionUpdatedAt: Date.now(),
  };
}

async function saveInstancesIndex(): Promise<void> {
  const index = [...instances.values()].map((instance) => ({
    id: instance.id,
    name: instance.name,
    dir: instance.dir,
    metadata: {
      note: instance.metadata?.note || '',
      createdAt: instance.metadata?.createdAt || null,
      updatedAt: instance.metadata?.updatedAt || null,
    },
  }));

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
};
