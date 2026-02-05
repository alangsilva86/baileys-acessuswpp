import crypto from 'node:crypto';

type SseTokenEntry = {
  createdAt: number;
  expiresAt: number;
  keyId: string | null;
};

const TOKENS = new Map<string, SseTokenEntry>();
const DEFAULT_TTL_MS = 15 * 60 * 1000;
const MAX_TOKENS = 2000;
const PRUNE_INTERVAL_MS = 60 * 1000;

let lastPruneAt = 0;

function pruneExpired(now = Date.now()): void {
  if (now - lastPruneAt < PRUNE_INTERVAL_MS) return;
  lastPruneAt = now;
  for (const [token, entry] of TOKENS.entries()) {
    if (entry.expiresAt <= now) {
      TOKENS.delete(token);
    }
  }
}

function enforceMaxSize(): void {
  if (TOKENS.size <= MAX_TOKENS) return;
  const overflow = TOKENS.size - MAX_TOKENS;
  let removed = 0;
  for (const token of TOKENS.keys()) {
    TOKENS.delete(token);
    removed += 1;
    if (removed >= overflow) break;
  }
}

export function mintSseToken(options: { keyId?: string | null; ttlMs?: number } = {}) {
  const now = Date.now();
  pruneExpired(now);
  enforceMaxSize();

  const ttlMs = Number.isFinite(options.ttlMs) ? Math.max(30_000, Number(options.ttlMs)) : DEFAULT_TTL_MS;
  const expiresAt = now + ttlMs;

  let token = '';
  for (let i = 0; i < 3; i += 1) {
    token = crypto.randomBytes(32).toString('base64url');
    if (!TOKENS.has(token)) break;
    token = '';
  }
  if (!token) {
    token = crypto.randomBytes(48).toString('base64url');
  }

  TOKENS.set(token, { createdAt: now, expiresAt, keyId: options.keyId ?? null });
  enforceMaxSize();

  return {
    token,
    expiresAt,
    ttlSeconds: Math.floor(ttlMs / 1000),
  };
}

export function resolveSseToken(raw: string | null | undefined): SseTokenEntry | null {
  if (!raw) return null;
  const token = String(raw).trim();
  if (!token) return null;
  const now = Date.now();
  pruneExpired(now);
  const entry = TOKENS.get(token) ?? null;
  if (!entry) return null;
  if (entry.expiresAt <= now) {
    TOKENS.delete(token);
    return null;
  }
  return entry;
}

