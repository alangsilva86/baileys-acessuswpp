import { fetchJson } from './api';

type SseTokenResponse = {
  token: string;
  expiresAt: number;
  ttlSeconds?: number;
};

type TokenCache = {
  apiKey: string;
  token: string;
  expiresAt: number;
};

const MIN_TOKEN_VALIDITY_MS = 60_000;

let cached: TokenCache | null = null;
let inFlight: Promise<TokenCache> | null = null;

export function clearSseTokenCache() {
  cached = null;
  inFlight = null;
}

function isCacheValid(entry: TokenCache | null, apiKey: string): boolean {
  if (!entry) return false;
  if (entry.apiKey !== apiKey) return false;
  return entry.expiresAt - Date.now() > MIN_TOKEN_VALIDITY_MS;
}

export async function getSseToken(apiKey: string): Promise<string | null> {
  const key = apiKey.trim();
  if (!key) return null;
  if (isCacheValid(cached, key)) return cached!.token;

  if (inFlight) {
    const result = await inFlight.catch(() => null);
    return result?.token ?? null;
  }

  inFlight = fetchJson<SseTokenResponse>('/instances/sse-token', key, { method: 'POST' })
    .then((response) => {
      const expiresAt = Number(response?.expiresAt ?? 0);
      const token = typeof response?.token === 'string' ? response.token : '';
      if (!token || !Number.isFinite(expiresAt) || expiresAt <= Date.now()) {
        throw new Error('invalid_sse_token_response');
      }
      const next: TokenCache = { apiKey: key, token, expiresAt };
      cached = next;
      return next;
    })
    .finally(() => {
      inFlight = null;
    });

  const result = await inFlight.catch(() => null);
  return result?.token ?? null;
}

