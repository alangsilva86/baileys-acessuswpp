const fs = require('fs/promises');
const path = require('path');
const pino = require('pino');
const { startWhatsAppInstance, stopWhatsAppInstance } = require('./whatsapp');

const SESSIONS_ROOT = process.env.SESSION_DIR || './sessions';
const INSTANCES_INDEX = path.join(process.cwd(), 'instances.json');
const logger = pino({ level: process.env.LOG_LEVEL || 'info' });

const instances = new Map();

async function saveInstancesIndex() {
  const index = [...instances.values()].map(i => ({
    id: i.id,
    name: i.name,
    dir: i.dir,
    metadata: {
      note: i.metadata?.note || '',
      createdAt: i.metadata?.createdAt || null,
      updatedAt: i.metadata?.updatedAt || null
    }
  }));
  try {
    await fs.writeFile(INSTANCES_INDEX, JSON.stringify(index, null, 2));
  } catch (err) {
    logger.error({ err }, 'instance_index.save.failed');
  }
}

async function loadInstances() {
  try {
    await fs.mkdir(SESSIONS_ROOT, { recursive: true });
    const raw = await fs.readFile(INSTANCES_INDEX, 'utf8');
    const list = JSON.parse(raw);
    if (!Array.isArray(list)) return;

    for (const item of list) {
        if (!item.id) continue;
        const inst = {
            id: item.id,
            name: item.name,
            dir: item.dir || path.join(SESSIONS_ROOT, item.id),
            sock: null,
            lastQR: null,
            reconnectDelay: 1000,
            stopping: false,
            reconnectTimer: null,
            metadata: item.metadata || { note: '', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() },
            metrics: {
                startedAt: Date.now(),
                sent: 0,
                sent_by_type: { text: 0, image: 0, group: 0, buttons: 0, lists: 0 },
                status_counts: { "1": 0, "2": 0, "3": 0, "4": 0, "5": 0 },
                last: { sentId: null, lastStatusId: null, lastStatusCode: null },
                ack: { totalMs: 0, count: 0, avgMs: 0, lastMs: null },
                timeline: []
            },
            statusMap: new Map(),
            ackWaiters: new Map(),
            rateWindow: [],
            ackSentAt: new Map(),
            context: null
        };
        instances.set(item.id, inst);
    }
    logger.info({ count: instances.size }, 'instances.loaded');
  } catch (err) {
    if (err.code !== 'ENOENT') {
        logger.error({ err }, 'instance_index.load.failed');
    }
    logger.info('instance_index.json not found, starting fresh.');
  }
}

async function startAllInstances() {
    logger.info(`starting ${instances.size} instances...`);
    for (const inst of instances.values()) {
        try {
            await startWhatsAppInstance(inst);
        } catch (err) {
            logger.error({ iid: inst.id, err }, 'instance.start.failed');
        }
    }
}

async function createInstance(id, name, meta) {
    const dir = path.join(SESSIONS_ROOT, id);
    await fs.mkdir(dir, { recursive: true });

    const nowIso = new Date().toISOString();
    const mergedMeta = {
        note: meta?.note || '',
        createdAt: nowIso,
        updatedAt: nowIso
    };

    const inst = {
        id: id,
        name: name,
        dir: dir,
        sock: null,
        lastQR: null,
        reconnectDelay: 1000,
        stopping: false,
        reconnectTimer: null,
        metadata: mergedMeta,
        metrics: {
            startedAt: Date.now(),
            sent: 0,
            sent_by_type: { text: 0, image: 0, group: 0, buttons: 0, lists: 0 },
            status_counts: { "1": 0, "2": 0, "3": 0, "4": 0, "5": 0 },
            last: { sentId: null, lastStatusId: null, lastStatusCode: null },
            ack: { totalMs: 0, count: 0, avgMs: 0, lastMs: null },
            timeline: []
        },
        statusMap: new Map(),
        ackWaiters: new Map(),
        rateWindow: [],
        ackSentAt: new Map(),
        context: null
    };

    instances.set(id, inst);
    await startWhatsAppInstance(inst);
    await saveInstancesIndex();
    return inst;
}

async function deleteInstance(iid, { removeDir = false, logout = false } = {}) {
    const inst = instances.get(iid);
    if (!inst) return null;

    await stopWhatsAppInstance(inst, { logout });
    instances.delete(iid);
    await saveInstancesIndex();

    if (removeDir) {
        try {
            await fs.rm(inst.dir, { recursive: true, force: true });
        } catch (err) {
            logger.warn({ iid, err: err?.message }, 'instance.dir.remove.failed');
        }
    }
    return inst;
}

function getInstance(iid) {
    return instances.get(iid);
}

function getAllInstances() {
    return [...instances.values()];
}

module.exports = {
    loadInstances,
    saveInstancesIndex,
    startAllInstances,
    createInstance,
    deleteInstance,
    getInstance,
    getAllInstances,
};
