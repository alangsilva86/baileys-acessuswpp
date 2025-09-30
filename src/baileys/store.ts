import type { WAMessage } from '@whiskeysockets/baileys';

type StoredPollMessage = {
  message: WAMessage;
  expiresAt: number;
  timeout: NodeJS.Timeout;
};

const DEFAULT_TTL_MS = Number(process.env.POLL_STORE_TTL_MS ?? 6 * 60 * 60 * 1000);

export class PollMessageStore {
  private readonly ttl: number;

  private readonly store = new Map<string, StoredPollMessage>();

  constructor(ttlMs: number = DEFAULT_TTL_MS) {
    this.ttl = ttlMs;
  }

  remember(message: WAMessage, ttlMs?: number): void {
    const id = message.key?.id;
    if (!id) {
      return;
    }

    const ttl = ttlMs ?? this.ttl;
    const expiresAt = Date.now() + ttl;

    const previous = this.store.get(id);
    if (previous) {
      clearTimeout(previous.timeout);
    }

    const timeout = setTimeout(() => {
      this.store.delete(id);
    }, ttl);
    if (typeof timeout.unref === 'function') {
      timeout.unref();
    }

    this.store.set(id, { message, expiresAt, timeout });
  }

  get(id?: string | null): WAMessage | undefined {
    if (!id) {
      return undefined;
    }
    const entry = this.store.get(id);
    if (!entry) {
      return undefined;
    }
    if (entry.expiresAt <= Date.now()) {
      clearTimeout(entry.timeout);
      this.store.delete(id);
      return undefined;
    }
    return entry.message;
  }

  clear(): void {
    for (const entry of this.store.values()) {
      clearTimeout(entry.timeout);
    }
    this.store.clear();
  }
}

