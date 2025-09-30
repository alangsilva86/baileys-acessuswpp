import fs from 'node:fs/promises';
import path from 'node:path';
import pino from 'pino';

import { env } from './env';
import { startWhatsAppInstance } from './whatsapp';

export interface AckWaiter {
  resolve: (status: number | null) => void;
  timer: NodeJS.Timeout;
}

export interface ManagedInstance {
  id: string;
  name: string;
  dir: string;
  sock: any;
  lastQR: string | null;
  reconnectDelay: number;
  stopping: boolean;
  reconnectTimer: NodeJS.Timeout | null;
  metadata: {
    note: string;
    createdAt: string;
    updatedAt: string;
  };
  metrics: {
    startedAt: number;
    sent: number;
    sent_by_type: Record<string, number>;
    status_counts: Record<string, number>;
    last: {
      sentId: string | null;
      lastStatusId: string | null;
      lastStatusCode: number | null;
    };
    ack: {
      totalMs: number;
      count: number;
      avgMs: number;
      lastMs: number | null;
    };
    timeline: Array<Record<string, unknown>>;
  };
  statusMap: Map<string, number>;
  ackWaiters: Map<string, AckWaiter>;
  rateWindow: number[];
  ackSentAt: Map<string, number>;
}

export interface RuntimeContext {
  logger: pino.Logger;
  instance: ManagedInstance;
}

export async function createRuntimeContext(): Promise<RuntimeContext> {
  await fs.mkdir(env.authDir, { recursive: true });
  const instanceDir = path.join(env.authDir, env.instanceId);
  await fs.mkdir(instanceDir, { recursive: true });

  const nowIso = new Date().toISOString();
  const managedInstance: ManagedInstance = {
    id: env.instanceId,
    name: env.instanceId,
    dir: instanceDir,
    sock: null,
    lastQR: null,
    reconnectDelay: 1_000,
    stopping: false,
    reconnectTimer: null,
    metadata: {
      note: '',
      createdAt: nowIso,
      updatedAt: nowIso,
    },
    metrics: {
      startedAt: Date.now(),
      sent: 0,
      sent_by_type: { text: 0, image: 0, group: 0, buttons: 0, lists: 0 },
      status_counts: { '1': 0, '2': 0, '3': 0, '4': 0, '5': 0 },
      last: {
        sentId: null,
        lastStatusId: null,
        lastStatusCode: null,
      },
      ack: {
        totalMs: 0,
        count: 0,
        avgMs: 0,
        lastMs: null,
      },
      timeline: [],
    },
    statusMap: new Map(),
    ackWaiters: new Map(),
    rateWindow: [],
    ackSentAt: new Map(),
  };

  await startWhatsAppInstance(managedInstance);

  const logger = pino({ level: env.logLevel, base: { service: env.serviceName } });

  return {
    logger,
    instance: managedInstance,
  };
}
