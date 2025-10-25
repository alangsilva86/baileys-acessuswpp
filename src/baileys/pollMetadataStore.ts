import { promises as fs } from 'fs';
import { basename, dirname, join } from 'path';

/* ========================================================================== */
/* Tipos públicos                                                             */
/* ========================================================================== */

export interface PollMetadataRecord {
  /** chave composta <jid>#<pollId> (ou #<pollId> se jid ausente) */
  pollKey: string;
  pollId: string;
  remoteJid: string | null;
  /** já armazenado cifrado por quem chamou (secretEncryption) */
  encKeyHex: string | null;
  question: string | null;
  options: string[];
  selectableCount: number | null;
  /** epoch ms de última atualização */
  updatedAt: number;
}

export interface PollMetadataStore {
  get(pollKey: string): Promise<PollMetadataRecord | null>;
  put(record: PollMetadataRecord): Promise<void>;
}

/* ========================================================================== */
/* Config/constantes                                                          */
/* ========================================================================== */

interface FilePollMetadataStoreOptions {
  filePath?: string;
  /** TTL de um registro em ms. Se <= 0, desabilita expiração. */
  ttlMs?: number;
  /** Após quantas escritas rodar compactação automática. Mínimo 1. */
  compactionInterval?: number;
}

const DEFAULT_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 dias
const DEFAULT_COMPACTION_INTERVAL = 50;

function resolveDefaultPath(): string {
  return join(process.cwd(), 'data', 'poll-metadata.json');
}

async function ensureDirectory(filePath: string): Promise<void> {
  await fs.mkdir(dirname(filePath), { recursive: true });
}

/* ========================================================================== */
/* Implementação baseada em arquivo                                           */
/* ========================================================================== */

class FilePollMetadataStore implements PollMetadataStore {
  private readonly filePath: string;
  private readonly ttlMs: number;
  private readonly compactionInterval: number;

  /** Serializa escritas dentro do processo para evitar interleaving. */
  private writeQueue: Promise<void> = Promise.resolve();
  private writesSinceCompaction = 0;

  constructor(options: FilePollMetadataStoreOptions = {}) {
    this.filePath = options.filePath ?? resolveDefaultPath();
    this.ttlMs = Number.isFinite(options.ttlMs ?? DEFAULT_TTL_MS)
      ? (options.ttlMs as number)
      : DEFAULT_TTL_MS;
    this.compactionInterval = Math.max(1, options.compactionInterval ?? DEFAULT_COMPACTION_INTERVAL);

    // Compacta no boot para já podar lixo antigo e normalizar o arquivo.
    this.writeQueue = this.writeQueue
      .then(() => this.compact())
      .catch((err) => {
        console.warn('poll metadata store: compact on start failed:', err);
      });
  }

  /* --------------------------------- API ---------------------------------- */

  async get(pollKey: string): Promise<PollMetadataRecord | null> {
    const { data } = await this.loadData();
    const record = data.get(pollKey) ?? null;

    if (!record) return null;

    // TTL estrito no read: se expirado, remove e retorna null.
    if (this.isExpired(record)) {
      // agenda remoção persistente sem bloquear o GET
      this.writeQueue = this.writeQueue
        .then(async () => {
          data.delete(pollKey);
          await this.writeAll(data);
        })
        .catch((err) => console.warn('poll metadata store: prune on get failed:', err));
      return null;
    }

    return record;
  }

  async put(record: PollMetadataRecord): Promise<void> {
    // encadeia na fila para manter ordem
    this.writeQueue = this.writeQueue
      .then(async () => {
        const { data } = await this.loadData();

        const normalized = this.normalizeRecord(record);

        // upsert
        data.set(normalized.pollKey, normalized);

        // se temos JID, remova o fallback "#<pollId>"
        if (normalized.remoteJid) {
          const fallbackKey = `#${normalized.pollId}`;
          if (fallbackKey !== normalized.pollKey) data.delete(fallbackKey);
        }

        await this.writeAll(data);

        this.writesSinceCompaction += 1;
        if (this.writesSinceCompaction >= this.compactionInterval) {
          await this.compact();
        }
      })
      .catch((err) => {
        console.warn('poll metadata store: write failed:', err);
      });

    // garante conclusão para o chamador
    await this.writeQueue;
  }

  /* ------------------------------- helpers -------------------------------- */

  private isExpired(rec: PollMetadataRecord): boolean {
    if (this.ttlMs <= 0 || !Number.isFinite(this.ttlMs)) return false;
    const updated = typeof rec.updatedAt === 'number' ? rec.updatedAt : 0;
    return Date.now() - updated > this.ttlMs;
  }

  private normalizeRecord(input: PollMetadataRecord): PollMetadataRecord {
    const options = Array.isArray(input.options) ? input.options.slice() : [];
    return {
      pollKey: String(input.pollKey || '').trim(),
      pollId: String(input.pollId || '').trim(),
      remoteJid: input.remoteJid ?? null,
      encKeyHex: input.encKeyHex ?? null,
      question: input.question ?? null,
      options,
      selectableCount:
        typeof input.selectableCount === 'number' && Number.isFinite(input.selectableCount)
          ? input.selectableCount
          : null,
      updatedAt: typeof input.updatedAt === 'number' && Number.isFinite(input.updatedAt)
          ? input.updatedAt
          : Date.now(),
    };
  }

  /**
   * Lê e normaliza todo o arquivo.
   * Tolera esquemas antigos (index por pollId) e reconstrói pollKey/jid quando possível.
   */
  private async loadData(): Promise<{ data: Map<string, PollMetadataRecord>; pruned: boolean }> {
    try {
      const buffer = await fs.readFile(this.filePath);
      const json = JSON.parse(buffer.toString()) as Record<string, Partial<PollMetadataRecord>>;

      const data = new Map<string, PollMetadataRecord>();

      for (const [storedKey, value] of Object.entries(json || {})) {
        // Deriva pollKey e pollId de forma resiliente
        const rawPollKey = (value.pollKey ?? storedKey) || '';
        const hasHash = rawPollKey.includes('#');

        const pollIdFromKey = hasHash ? rawPollKey.split('#')[1] : rawPollKey;
        const pollId = (value.pollId ?? pollIdFromKey ?? storedKey) || '';

        const remoteFromKey = hasHash ? rawPollKey.split('#')[0] : '';
        const remoteJid = value.remoteJid ?? (remoteFromKey ? remoteFromKey : null);

        const pollKey = hasHash ? rawPollKey : `${remoteJid ?? ''}#${pollId}`.trim();

        const rec: PollMetadataRecord = this.normalizeRecord({
          pollKey,
          pollId,
          remoteJid,
          encKeyHex: value.encKeyHex ?? null,
          question: value.question ?? null,
          options: Array.isArray(value.options) ? value.options.slice() : [],
          selectableCount:
            typeof value.selectableCount === 'number' ? value.selectableCount : null,
          updatedAt: typeof value.updatedAt === 'number' ? value.updatedAt : Date.now(),
        });

        data.set(pollKey, rec);
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

  /** Remove entradas expiradas conforme TTL. */
  private pruneExpiredEntries(data: Map<string, PollMetadataRecord>): boolean {
    if (this.ttlMs <= 0 || !Number.isFinite(this.ttlMs)) return false;

    let changed = false;
    for (const [key, value] of data.entries()) {
      if (this.isExpired(value)) {
        data.delete(key);
        changed = true;
      }
    }
    return changed;
  }

  /**
   * Escreve todo o mapa para disco com rename atômico
   * e permissões restritas (0600).
   */
  private async writeAll(data: Map<string, PollMetadataRecord>): Promise<void> {
    await ensureDirectory(this.filePath);

    // Garante poda antes da escrita
    this.pruneExpiredEntries(data);

    // Objeto plano para JSON
    const plain: Record<string, PollMetadataRecord> = {};
    for (const [pollKey, value] of data.entries()) {
      // garante que a chave composta esteja persistida dentro do value
      plain[pollKey] = { ...value, pollKey };
    }

    const dir = dirname(this.filePath);
    const fileName = basename(this.filePath);
    const tempPath = join(dir, `.${fileName}.${process.pid}.${Date.now()}.tmp`);
    const json = JSON.stringify(plain, null, 2) + '\n';

    try {
      await fs.writeFile(tempPath, json, { encoding: 'utf-8', mode: 0o600 });
      await fs.rename(tempPath, this.filePath);
    } finally {
      // melhor esforço para limpar o tmp
      try {
        await fs.unlink(tempPath);
      } catch (err: any) {
        if (!err || err.code !== 'ENOENT') {
          // se falhar por outro motivo, propaga
          throw err;
        }
      }
    }
  }

  /** Recarrega, poda e regrava se necessário. */
  private async compact(): Promise<void> {
    const { data, pruned } = await this.loadData();
    if (pruned) {
      await this.writeAll(data);
    }
    this.writesSinceCompaction = 0;
  }
}

/* ========================================================================== */
/* Instância exportada                                                        */
/* ========================================================================== */

export const pollMetadataStore: PollMetadataStore = new FilePollMetadataStore();