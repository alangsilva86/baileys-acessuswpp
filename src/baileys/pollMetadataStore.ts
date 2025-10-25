import { promises as fs } from 'fs';
import { basename, dirname, join } from 'path';

export interface PollMetadataRecord {
  pollKey: string;              // <jid>#<pollId> ou #<pollId>
  pollId: string;
  remoteJid: string | null;
  encKeyHex: string | null;     // cifrado por secretEncryption
  question: string | null;
  options: string[];
  selectableCount: number | null;
  updatedAt: number;            // epoch ms
}

export interface PollMetadataStore {
  get(pollKey: string): Promise<PollMetadataRecord | null>;
  put(record: PollMetadataRecord): Promise<void>;
}

function resolveDefaultPath(): string {
  return join(process.cwd(), 'data', 'poll-metadata.json');
}
async function ensureDirectory(filePath: string): Promise<void> {
  await fs.mkdir(dirname(filePath), { recursive: true });
}

interface Options {
  filePath?: string;
  ttlMs?: number;
  compactionInterval?: number;
}

const DEFAULT_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 dias
const DEFAULT_COMPACTION = 50;

class FilePollMetadataStore implements PollMetadataStore {
  private readonly filePath: string;
  private readonly ttlMs: number;
  private readonly compactionInterval: number;

  private writeQueue: Promise<void> = Promise.resolve();
  private writes = 0;

  constructor(opts: Options = {}) {
    this.filePath = opts.filePath ?? resolveDefaultPath();
    this.ttlMs = Number.isFinite(opts.ttlMs) ? Number(opts.ttlMs) : DEFAULT_TTL_MS;
    this.compactionInterval = Math.max(1, opts.compactionInterval ?? DEFAULT_COMPACTION);

    this.writeQueue = this.writeQueue.then(() => this.compact()).catch((err) => {
      console.warn('poll-store.compact.startup.failed', err);
    });
  }

  async get(pollKey: string): Promise<PollMetadataRecord | null> {
    const { data } = await this.loadData();
    return data.get(pollKey) ?? null;
  }

  async put(record: PollMetadataRecord): Promise<void> {
    this.writeQueue = this.writeQueue
      .then(async () => {
        const { data } = await this.loadData();

        const normalized: PollMetadataRecord = {
          pollKey: record.pollKey,
          pollId: record.pollId,
          remoteJid: record.remoteJid ?? null,
          encKeyHex: record.encKeyHex ?? null,
          question: record.question ?? null,
          options: Array.isArray(record.options) ? record.options.slice() : [],
          selectableCount: record.selectableCount ?? null,
          updatedAt: record.updatedAt ?? Date.now(),
        };

        data.set(normalized.pollKey, normalized);

        if (normalized.remoteJid) {
          const fallback = `#${normalized.pollId}`;
          if (fallback !== normalized.pollKey) data.delete(fallback);
        }

        await this.writeAll(data);

        this.writes += 1;
        if (this.writes >= this.compactionInterval) {
          await this.compact();
        }
      })
      .catch((err) => console.warn('poll-store.put.failed', err));

    await this.writeQueue;
  }

  private prune(data: Map<string, PollMetadataRecord>): boolean {
    if (this.ttlMs <= 0) return false;
    const now = Date.now();
    let changed = false;
    for (const [k, v] of data.entries()) {
      const updated = v.updatedAt ?? 0;
      if (now - updated > this.ttlMs) {
        data.delete(k);
        changed = true;
      }
    }
    return changed;
  }

  private async loadData(): Promise<{ data: Map<string, PollMetadataRecord>; pruned: boolean }> {
    try {
      const raw = await fs.readFile(this.filePath, 'utf-8');
      const json = JSON.parse(raw) as Record<string, Partial<PollMetadataRecord>>;
      const data = new Map<string, PollMetadataRecord>();

      for (const [storedKey, value] of Object.entries(json)) {
        const rawKey = value.pollKey ?? storedKey;
        const hasHash = rawKey.includes('#');
        const pollIdFromKey = hasHash ? rawKey.split('#')[1] : rawKey;
        const pollId = value.pollId ?? pollIdFromKey ?? storedKey;

        const remoteFromKey = hasHash ? rawKey.split('#')[0] : '';
        const remoteJid = value.remoteJid ?? (remoteFromKey ? remoteFromKey : null);
        const pollKey = hasHash ? rawKey : `${remoteJid ?? ''}#${pollId}`;

        data.set(pollKey, {
          pollKey,
          pollId,
          remoteJid,
          encKeyHex: value.encKeyHex ?? null,
          question: value.question ?? null,
          options: Array.isArray(value.options) ? value.options.slice() : [],
          selectableCount: value.selectableCount ?? null,
          updatedAt: typeof value.updatedAt === 'number' ? value.updatedAt : Date.now(),
        });
      }

      const pruned = this.prune(data);
      return { data, pruned };
    } catch (err: any) {
      if (err?.code === 'ENOENT') {
        return { data: new Map(), pruned: false };
      }
      throw err;
    }
  }

  private async writeAll(data: Map<string, PollMetadataRecord>): Promise<void> {
    await ensureDirectory(this.filePath);
    this.prune(data);

    const plain: Record<string, PollMetadataRecord> = {};
    for (const [k, v] of data.entries()) plain[k] = { ...v, pollKey: k };

    const dir = dirname(this.filePath);
    const name = basename(this.filePath);
    const tmp = join(dir, `.${name}.${process.pid}.${Date.now()}.tmp`);
    const json = JSON.stringify(plain, null, 2);

    try {
      await fs.writeFile(tmp, json, { encoding: 'utf-8', mode: 0o600 });
      await fs.rename(tmp, this.filePath);
    } finally {
      try {
        await fs.unlink(tmp);
      } catch (e: any) {
        if (e?.code !== 'ENOENT') throw e;
      }
    }
  }

  private async compact(): Promise<void> {
    const { data, pruned } = await this.loadData();
    if (pruned) await this.writeAll(data);
    this.writes = 0;
  }
}

export const pollMetadataStore: PollMetadataStore = new FilePollMetadataStore();