const API_KEY_STORAGE = 'baileys_api_key';

export type ApiError = Error & {
  status?: number;
  body?: unknown;
  text?: string;
};

export function readStoredApiKey(): string {
  if (typeof window === 'undefined') return '';
  return window.localStorage.getItem(API_KEY_STORAGE) ?? '';
}

export function writeStoredApiKey(value: string): void {
  if (typeof window === 'undefined') return;
  window.localStorage.setItem(API_KEY_STORAGE, value);
}

function buildHeaders(apiKey: string, extra?: HeadersInit): HeadersInit {
  const base: Record<string, string> = { 'Content-Type': 'application/json' };
  if (apiKey) base['x-api-key'] = apiKey;
  return { ...base, ...(extra || {}) };
}

export async function fetchJson<T>(path: string, apiKey: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(path, {
    ...init,
    cache: 'no-store',
    headers: buildHeaders(apiKey, init.headers),
  });

  if (!response.ok) {
    const text = await response.text().catch(() => '');
    let body: unknown = null;
    if (text) {
      try {
        body = JSON.parse(text);
      } catch {
        body = null;
      }
    }
    const error: ApiError = new Error(`HTTP ${response.status}`);
    error.status = response.status;
    error.text = text;
    error.body = body;
    throw error;
  }

  if (response.status === 204) return {} as T;
  return (await response.json()) as T;
}

export function formatApiError(err: unknown): string {
  if (!err || typeof err !== 'object') return 'Falha inesperada.';
  const apiErr = err as ApiError;
  if (apiErr.status === 401) return 'API key inválida ou ausente.';
  if (apiErr.status === 404) return 'Recurso não encontrado.';
  if (apiErr.body && typeof apiErr.body === 'object') {
    const body = apiErr.body as Record<string, unknown>;
    if (typeof body.message === 'string' && body.message.trim()) return body.message;
    if (typeof body.error === 'string' && body.error.trim()) return body.error;
  }
  if (typeof apiErr.message === 'string' && apiErr.message.trim()) return apiErr.message;
  return 'Falha inesperada.';
}
