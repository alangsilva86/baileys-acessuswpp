import { els, showError } from './state.js';

export function getApiKeyValue() {
  return els.inpApiKey?.value?.trim() || '';
}

export function getSelectedInstanceId() {
  return els.selInstance?.value || '';
}

function buildHeaders({ auth = true, headers = {} } = {}) {
  const composed = { 'Content-Type': 'application/json', ...headers };
  if (auth) {
    const key = getApiKeyValue();
    if (key) composed['x-api-key'] = key;
    const iid = getSelectedInstanceId();
    if (iid) composed['x-instance-id'] = iid;
  }
  return composed;
}

export function requireKey() {
  const k = getApiKeyValue();
  if (!k) {
    showError('Informe x-api-key para usar ações');
    try { els.inpApiKey?.focus(); } catch (err) { console.warn(err); }
    throw new Error('missing_api_key');
  }
  return k;
}

export async function fetchJSON(path, auth = true, opts = {}) {
  const headers = buildHeaders({ auth, headers: opts.headers || {} });
  const response = await fetch(path, { cache: 'no-store', ...opts, headers });
  if (!response.ok) {
    const text = await response.text().catch(() => '');
    let body = null;
    if (text) {
      try {
        body = JSON.parse(text);
      } catch (err) {
        console.warn('[api] resposta sem JSON válido para erro', err);
      }
    }
    const error = new Error('HTTP ' + response.status + (text ? ' — ' + text : ''));
    error.status = response.status;
    error.body = body;
    error.text = text;
    throw error;
  }
  try {
    return await response.json();
  } catch (err) {
    console.warn('[api] resposta sem JSON válido', err);
    return {};
  }
}

export function buildAuthHeaders(extra = {}) {
  return buildHeaders({ auth: true, headers: extra });
}
