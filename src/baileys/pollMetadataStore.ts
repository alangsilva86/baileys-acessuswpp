import { promises as fs } from 'fs';
import { dirname, join } from 'path';
import { pathToFileURL } from 'url';

export interface PollMetadataRecord {
  pollId: string;
  remoteJid: string | null;
  encKeyHex: string | null;
  question: string | null;
  options: string[];
  selectableCount: number | null;
  updatedAt: number;
}

export interface PollMetadataStore {
  get(pollId: string): Promise<PollMetadataRecord | null>;
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

  async get(pollId: string): Promise<PollMetadataRecord | null> {
    const data = await this.readAll();
    return data.get(pollId) ?? null;
  }

  async put(record: PollMetadataRecord): Promise<void> {
    this.writeQueue = this.writeQueue.then(async () => {
      const data = await this.readAll();
      data.set(record.pollId, {
        ...record,
        updatedAt: record.updatedAt ?? Date.now(),
      });
      await this.writeAll(data);
    });
    await this.writeQueue;
  }

  private async readAll(): Promise<Map<string, PollMetadataRecord>> {
    try {
      const buffer = await fs.readFile(this.filePath);
      const json = JSON.parse(buffer.toString()) as Record<string, PollMetadataRecord>;
      return new Map(
        Object.entries(json).map(([pollId, value]) => [
          pollId,
          {
            ...value,
            pollId,
          },
        ]),
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
    for (const [pollId, value] of data.entries()) {
      plain[pollId] = { ...value, pollId };
    }
    await fs.writeFile(this.filePath, JSON.stringify(plain, null, 2), 'utf-8');
  }
}

export const pollMetadataStore: PollMetadataStore = new FilePollMetadataStore();
