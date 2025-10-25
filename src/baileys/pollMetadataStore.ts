import { promises as fs } from 'fs';
import { dirname, join } from 'path';
import { pathToFileURL } from 'url';

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

class FilePollMetadataStore implements PollMetadataStore {
  private readonly filePath: string;
  private writeQueue: Promise<void> = Promise.resolve();

  constructor(filePath: string = resolveDefaultPath()) {
    this.filePath = filePath;
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
    });
    await this.writeQueue;
  }

  private async readAll(): Promise<Map<string, PollMetadataRecord>> {
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
      );
    } catch (err: any) {
      if (err && err.code === 'ENOENT') {
        return new Map();
      }
      throw err;
    }
  }

  private async writeAll(data: Map<string, PollMetadataRecord>): Promise<void> {
    await ensureDirectory(this.filePath);
    const plain: Record<string, PollMetadataRecord> = {};
    for (const [pollKey, value] of data.entries()) {
      plain[pollKey] = { ...value, pollKey };
    }
    await fs.writeFile(this.filePath, JSON.stringify(plain, null, 2), 'utf-8');
  }
}

export const pollMetadataStore: PollMetadataStore = new FilePollMetadataStore();
