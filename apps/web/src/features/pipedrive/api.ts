export type UiApiError = Error & {
  status?: number;
  body?: unknown;
  text?: string;
};

function buildHeaders(token: string, extra?: HeadersInit): HeadersInit {
  const base: Record<string, string> = { 'Content-Type': 'application/json' };
  if (token) base.Authorization = `Bearer ${token}`;
  return { ...base, ...(extra || {}) };
}

export async function fetchUiJson<T>(path: string, token: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(path, {
    ...init,
    cache: 'no-store',
    headers: buildHeaders(token, init.headers),
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
    const error: UiApiError = new Error(`HTTP ${response.status}`);
    error.status = response.status;
    error.text = text;
    error.body = body;
    throw error;
  }

  if (response.status === 204) return {} as T;
  return (await response.json()) as T;
}

export function formatUiError(err: unknown): string {
  if (!err || typeof err !== 'object') return 'Falha inesperada.';
  const apiErr = err as UiApiError;
  if (apiErr.status === 401) return 'Sessão expirada ou token inválido.';
  if (apiErr.body && typeof apiErr.body === 'object') {
    const body = apiErr.body as Record<string, unknown>;
    if (typeof body.message === 'string' && body.message.trim()) return body.message;
    if (typeof body.error === 'string' && body.error.trim()) return body.error;
  }
  if (typeof apiErr.message === 'string' && apiErr.message.trim()) return apiErr.message;
  return 'Falha inesperada.';
}

