import { promises as fs } from 'fs';
import { basename, dirname, join } from 'path';

export interface PollMetadataRecord {
  pollKey: string;
  pollId: string;
  remoteJid: string | null;
  encKeyHex: string | null;
  question: string | null;
  options: string[];
  selectableCount: number | null;
  updatedAt: number;
}

export interface PollMetadataStore {
  get(pollKey: string): Promise<PollMetadataRecord | null>;
  put(record: PollMetadataRecord): Promise<void>;
}

async function ensureDirectory(filePath: string): Promise<void> {
  const dir = dirname(filePath);
  await fs.mkdir(dir, { recursive: true });
}

function resolveDefaultPath(): string {
  const cwd = process.cwd();
  return join(cwd, 'data', 'poll-metadata.json');
}

interface FilePollMetadataStoreOptions {
  filePath?: string;
  ttlMs?: number;
  compactionInterval?: number;
}

const DEFAULT_TTL_MS = 7 * 24 * 60 * 60 * 1000; // seven days
const DEFAULT_COMPACTION_INTERVAL = 50;

class FilePollMetadataStore implements PollMetadataStore {
  private readonly filePath: string;
  private readonly ttlMs: number;
  private readonly compactionInterval: number;
  private writeQueue: Promise<void> = Promise.resolve();
  private writesSinceCompaction = 0;

  constructor(options: FilePollMetadataStoreOptions = {}) {
    this.filePath = options.filePath ?? resolveDefaultPath();
    this.ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
    this.compactionInterval = Math.max(1, options.compactionInterval ?? DEFAULT_COMPACTION_INTERVAL);

    // Compact on start-up to purge any stale entries left behind by previous runs.
    this.writeQueue = this.writeQueue.then(() => this.compact()).catch((err) => {
      // The queue should never reject to avoid blocking future writes; surface
      // the failure via stderr while keeping the store usable.
      console.warn('Failed to compact poll metadata store on start-up:', err);
    });
  }

  async get(pollKey: string): Promise<PollMetadataRecord | null> {
    const data = await this.readAll();
    return data.get(pollKey) ?? null;
  }

  async put(record: PollMetadataRecord): Promise<void> {
    this.writeQueue = this.writeQueue.then(async () => {
      const data = await this.readAll();
      data.set(record.pollKey, {
        ...record,
        updatedAt: record.updatedAt ?? Date.now(),
      });

      if (record.remoteJid) {
        const fallbackKey = `#${record.pollId}`;
        if (fallbackKey !== record.pollKey) {
          data.delete(fallbackKey);
        }
      }

      await this.writeAll(data);
      this.writesSinceCompaction += 1;
      if (this.writesSinceCompaction >= this.compactionInterval) {
        await this.compact();
      }
    });
    await this.writeQueue;
  }

  private async readAll(): Promise<Map<string, PollMetadataRecord>> {
    const { data } = await this.loadData();
    return data;
  }

  private async writeAll(data: Map<string, PollMetadataRecord>): Promise<void> {
    await ensureDirectory(this.filePath);
    this.pruneExpiredEntries(data);

    const plain: Record<string, PollMetadataRecord> = {};
    for (const [pollId, value] of data.entries()) {
      plain[pollId] = { ...value, pollId };
    }

    const dir = dirname(this.filePath);
    const fileName = basename(this.filePath);
    const tempPath = join(dir, `.${fileName}.${process.pid}.${Date.now()}.tmp`);
    const json = JSON.stringify(plain, null, 2);

    try {
      await fs.writeFile(tempPath, json, 'utf-8');
      await fs.rename(tempPath, this.filePath);
    } finally {
      try {
        await fs.unlink(tempPath);
      } catch (err: any) {
        if (!err || err.code !== 'ENOENT') {
          throw err;
        }
      }
    }
  }

  private async loadData(): Promise<{ data: Map<string, PollMetadataRecord>; pruned: boolean }> {
    try {
      const buffer = await fs.readFile(this.filePath);
      const json = JSON.parse(buffer.toString()) as Record<string, PollMetadataRecord>;
      return new Map(
        Object.entries(json).map(([storedKey, value]) => {
          const pollKey = value.pollKey ?? storedKey;
          const separatorIndex = pollKey.indexOf('#');
          const derivedRemote = separatorIndex >= 0 ? pollKey.slice(0, separatorIndex) : '';
          const derivedPollId =
            separatorIndex >= 0 ? pollKey.slice(separatorIndex + 1) : pollKey;
          const pollId = value.pollId ?? derivedPollId ?? pollKey;
          const remoteJid =
            value.remoteJid ?? (separatorIndex >= 0 ? derivedRemote || null : null);

          return [
            pollKey,
            {
              ...value,
              pollKey,
              pollId,
              remoteJid: remoteJid ?? null,
            },
          ];
        }),
      const data = new Map(
        Object.entries(json).map(([pollId, value]) => [
          pollId,
          {
            ...value,
            pollId,
          },
        ]),
      );

      const pruned = this.pruneExpiredEntries(data);
      return { data, pruned };
    } catch (err: any) {
      if (err && err.code === 'ENOENT') {
        return { data: new Map(), pruned: false };
      }
      throw err;
    }
  }

  private async writeAll(data: Map<string, PollMetadataRecord>): Promise<void> {
    await ensureDirectory(this.filePath);
    const plain: Record<string, PollMetadataRecord> = {};
    for (const [pollKey, value] of data.entries()) {
      plain[pollKey] = { ...value, pollKey };
  private pruneExpiredEntries(data: Map<string, PollMetadataRecord>): boolean {
    if (this.ttlMs <= 0 || !Number.isFinite(this.ttlMs)) {
      return false;
    }

    const now = Date.now();
    let changed = false;

    for (const [pollId, value] of data.entries()) {
      const updatedAt = value.updatedAt ?? 0;
      if (now - updatedAt > this.ttlMs) {
        data.delete(pollId);
        changed = true;
      }
    }

    return changed;
  }

  private async compact(): Promise<void> {
    const { data, pruned } = await this.loadData();
    if (!pruned) {
      this.writesSinceCompaction = 0;
      return;
    }

    await this.writeAll(data);
    this.writesSinceCompaction = 0;
  }
}

export const pollMetadataStore: PollMetadataStore = new FilePollMetadataStore();
