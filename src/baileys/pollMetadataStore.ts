import { promises as fs } from 'fs';
import { basename, dirname, join } from 'path';

export interface PollMetadataRecord {
  pollKey: string;                // chave composta <jid>#<pollId> ou #<pollId> se jid ausente
  pollId: string;
  remoteJid: string | null;
  encKeyHex: string | null;       // valor já cifrado em disco por quem chamou (secretEncryption)
  question: string | null;
  options: string[];
  selectableCount: number | null;
  updatedAt: number;              // epoch ms
}

export interface PollMetadataStore {
  get(pollKey: string): Promise<PollMetadataRecord | null>;
  put(record: PollMetadataRecord): Promise<void>;
}

/* ------------------------- utils de FS ------------------------- */

async function ensureDirectory(filePath: string): Promise<void> {
  const dir = dirname(filePath);
  await fs.mkdir(dir, { recursive: true });
}

function resolveDefaultPath(): string {
  const cwd = process.cwd();
  return join(cwd, 'data', 'poll-metadata.json');
}

/* --------------------- opções e defaults ---------------------- */

interface FilePollMetadataStoreOptions {
  filePath?: string;
  ttlMs?: number;               // tempo de vida de um registro
  compactionInterval?: number;  // quantas escritas disparam compactação
}

const DEFAULT_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 dias
const DEFAULT_COMPACTION_INTERVAL = 50;

/* ------------------ implementação baseada em arquivo ------------------ */

class FilePollMetadataStore implements PollMetadataStore {
  private readonly filePath: string;
  private readonly ttlMs: number;
  private readonly compactionInterval: number;

  // serialize writes dentro do processo
  private writeQueue: Promise<void> = Promise.resolve();
  private writesSinceCompaction = 0;

  constructor(options: FilePollMetadataStoreOptions = {}) {
    this.filePath = options.filePath ?? resolveDefaultPath();
    this.ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
    this.compactionInterval = Math.max(1, options.compactionInterval ?? DEFAULT_COMPACTION_INTERVAL);

    // Compacta na inicialização para já podar lixo antigo
    this.writeQueue = this.writeQueue
      .then(() => this.compact())
      .catch((err) => {
        // não bloqueia futuras escritas
        console.warn('Failed to compact poll metadata store on start-up:', err);
      });
  }

  /* ------------------------ API pública ------------------------ */

  async get(pollKey: string): Promise<PollMetadataRecord | null> {
    const { data } = await this.loadData();
    return data.get(pollKey) ?? null;
  }

  async put(record: PollMetadataRecord): Promise<void> {
    // encadeia na fila para evitar interleaving no processo
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

        // se temos JID, remova o fallback "#<pollId>"
        if (normalized.remoteJid) {
          const fallbackKey = `#${normalized.pollId}`;
          if (fallbackKey !== normalized.pollKey) {
            data.delete(fallbackKey);
          }
        }

        // grava de forma atômica
        await this.writeAll(data);

        this.writesSinceCompaction += 1;
        if (this.writesSinceCompaction >= this.compactionInterval) {
          await this.compact();
        }
      })
      .catch((err) => {
        // Não deixa a queue quebrar para as próximas operações
        console.warn('poll metadata write failed:', err);
      });

    await this.writeQueue;
  }

  /* -------------------- helpers privados ---------------------- */

  private pruneExpiredEntries(data: Map<string, PollMetadataRecord>): boolean {
    if (this.ttlMs <= 0 || !Number.isFinite(this.ttlMs)) return false;

    const now = Date.now();
    let changed = false;

    for (const [key, value] of data.entries()) {
      const updatedAt = value.updatedAt ?? 0;
      if (now - updatedAt > this.ttlMs) {
        data.delete(key);
        changed = true;
      }
    }

    return changed;
  }

  /**
   * Lê todo o arquivo.
   * Tolera esquemas antigos (index por pollId) e reconstrói pollKey/jid quando possível.
   */
  private async loadData(): Promise<{ data: Map<string, PollMetadataRecord>; pruned: boolean }> {
    try {
      const buffer = await fs.readFile(this.filePath);
      const json = JSON.parse(buffer.toString()) as Record<string, Partial<PollMetadataRecord>>;

      const data = new Map<string, PollMetadataRecord>();

      for (const [storedKey, value] of Object.entries(json)) {
        // Deriva pollKey e pollId de forma resiliente
        const rawPollKey = value.pollKey ?? storedKey;
        const hasHash = rawPollKey.includes('#');

        const pollIdFromKey = hasHash ? rawPollKey.split('#')[1] : rawPollKey;
        const pollId = value.pollId ?? pollIdFromKey ?? storedKey;

        const remoteFromKey = hasHash ? rawPollKey.split('#')[0] : '';
        const remoteJid = value.remoteJid ?? (remoteFromKey ? remoteFromKey : null);

        const pollKey = hasHash ? rawPollKey : `${remoteJid ?? ''}#${pollId}`;

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

      const pruned = this.pruneExpiredEntries(data);
      return { data, pruned };
    } catch (err: any) {
      if (err && err.code === 'ENOENT') {
        return { data: new Map(), pruned: false };
      }
      throw err;
    }
  }

  /**
   * Escreve todo o mapa para disco, com rename atômico.
   * Sempre inclui a chave composta no valor.
   */
  private async writeAll(data: Map<string, PollMetadataRecord>): Promise<void> {
    await ensureDirectory(this.filePath);

    // Garante poda antes da escrita
    this.pruneExpiredEntries(data);

    // objeto plano para JSON
    const plain: Record<string, PollMetadataRecord> = {};
    for (const [pollKey, value] of data.entries()) {
      plain[pollKey] = { ...value, pollKey };
    }

    const dir = dirname(this.filePath);
    const fileName = basename(this.filePath);
    const tempPath = join(dir, `.${fileName}.${process.pid}.${Date.now()}.tmp`);
    const json = JSON.stringify(plain, null, 2);

    try {
      await fs.writeFile(tempPath, json, { encoding: 'utf-8', mode: 0o600 });
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

  /**
   * Recarrega, poda e regrava se necessário.
   */
  private async compact(): Promise<void> {
    const { data, pruned } = await this.loadData();
    if (pruned) {
      await this.writeAll(data);
    }
    this.writesSinceCompaction = 0;
  }
}

/* -------------------- instância exportada --------------------- */

export const pollMetadataStore: PollMetadataStore = new FilePollMetadataStore();