import { Router, type NextFunction, type Request, type Response } from 'express';
import crypto from 'node:crypto';
import multer from 'multer';
import pino from 'pino';
import type { WAMessage } from '@whiskeysockets/baileys';
import {
  ensureInstanceStarted,
  getInstance,
  getAllInstances,
} from '../instanceManager.js';
import { allowSend, getSendTimeoutMs, normalizeToE164BR } from '../utils.js';
import { MAX_MEDIA_BYTES, type MediaMessageType } from '../baileys/messageService.js';
import {
  PIPEDRIVE_CLIENT_ID,
  PIPEDRIVE_CLIENT_SECRET,
  PIPEDRIVE_OAUTH_BASE_URL,
  PIPEDRIVE_OAUTH_SCOPE,
  PIPEDRIVE_PROVIDER_TYPE,
  PIPEDRIVE_PUBLIC_BASE_URL,
  PIPEDRIVE_REDIRECT_URI,
  PIPEDRIVE_TEMPLATE_SUPPORT,
  PIPEDRIVE_CHANNEL_AVATAR_URL,
  PIPEDRIVE_CHANNELS_MODE,
  PIPEDRIVE_FALLBACK_NOTES_ENABLED,
  PIPEDRIVE_WEBHOOK_USER,
  PIPEDRIVE_WEBHOOK_PASS,
  PIPEDRIVE_WEBHOOK_EVENTS,
} from '../services/pipedrive/config.js';
import { pipedriveClient } from '../services/pipedrive/client.js';
import { syncMessageToPipedrive } from '../services/pipedrive/sync.js';
import { maybeRunPipedriveAutomation } from '../services/pipedrive/automation.js';
import { recordPipedriveWebhookEvent as recordPipedriveWebhookEventStore, listPipedriveWebhookEvents } from '../services/pipedrive/webhookStore.js';
import {
  exportPipedriveMetricsCsv,
  getPipedriveMetrics,
  recordPipedriveAutomation,
  recordPipedriveWebhookEvent,
} from '../services/pipedrive/metrics.js';
import {
  findMessage,
  findParticipant,
  getChannelByProviderId,
  getSourceUserId,
  listChannels,
  listConversations,
  removeChannelByProviderId,
  removeConversationsByProviderId,
  getConversation,
  upsertChannel,
} from '../services/pipedrive/store.js';
import type { PipedriveChannelRecord } from '../services/pipedrive/store.js';
import { markPipedriveOutbound } from '../services/pipedrive/bridge.js';
import type { PipedriveMessage, PipedriveParticipant } from '../services/pipedrive/types.js';

const router = Router();
const logger = pino({ level: process.env.LOG_LEVEL || 'info', base: { service: 'pipedrive-routes' } });

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_MEDIA_BYTES },
});

const API_KEYS = String(process.env.API_KEY || 'change-me')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

function safeEquals(a: unknown, b: unknown): boolean {
  const A = Buffer.from(String(a ?? ''));
  const B = Buffer.from(String(b ?? ''));
  if (A.length !== B.length) return false;
  return crypto.timingSafeEqual(A, B);
}

function extractApiKey(req: Request): string {
  const headerKey = req.header('x-api-key');
  if (headerKey && headerKey.trim()) return headerKey.trim();
  const queryKey = req.query.apiKey;
  if (typeof queryKey === 'string' && queryKey.trim()) return queryKey.trim();
  if (Array.isArray(queryKey)) {
    const [first] = queryKey;
    if (typeof first === 'string') {
      const trimmed = first.trim();
      if (trimmed) return trimmed;
    }
  }
  return '';
}

function apiKeyAuth(req: Request, res: Response, next: NextFunction): void {
  const key = extractApiKey(req);
  if (!key) {
    res.status(401).json({ error: 'unauthorized' });
    return;
  }
  if (!API_KEYS.some((candidate) => safeEquals(candidate, key))) {
    res.status(401).json({ error: 'unauthorized' });
    return;
  }
  next();
}

function parseBasicAuth(header: string | undefined): { user: string; pass: string } | null {
  if (!header) return null;
  const [scheme, value] = header.split(' ');
  if (!scheme || scheme.toLowerCase() !== 'basic' || !value) return null;
  const decoded = Buffer.from(value, 'base64').toString('utf8');
  const sepIndex = decoded.indexOf(':');
  if (sepIndex === -1) return null;
  return { user: decoded.slice(0, sepIndex), pass: decoded.slice(sepIndex + 1) };
}

function parseScopes(scope: string): string[] {
  return scope
    .split(/[,\s]+/g)
    .map((token) => token.trim())
    .filter(Boolean);
}

function getScopeWarnings(scope: string): string[] {
  const trimmed = (scope || '').trim();
  if (!trimmed) return ['scope_missing'];
  const scopes = parseScopes(trimmed).map((s) => s.toLowerCase());
  const warnings: string[] = [];

  const has = (needle: RegExp) => scopes.some((s) => needle.test(s));
  if (PIPEDRIVE_CHANNELS_MODE !== 'v2' && !has(/channel|messenger/)) warnings.push('missing_channels_scope');
  if (PIPEDRIVE_FALLBACK_NOTES_ENABLED && !has(/notes/)) warnings.push('missing_notes_scope');
  if (PIPEDRIVE_FALLBACK_NOTES_ENABLED && !has(/persons?|contacts?/)) warnings.push('missing_persons_scope');

  return warnings;
}

function safeJsonStringify(value: unknown, maxLen = 2000): string {
  try {
    const raw = JSON.stringify(value);
    if (raw.length <= maxLen) return raw;
    return `${raw.slice(0, maxLen)}…`;
  } catch {
    return String(value);
  }
}

function serializeAxiosError(err: unknown): { message: string; status: number | null; url: string | null; responseBody: string | null } | null {
  const anyErr = err as any;
  const message = anyErr?.message ? String(anyErr.message) : String(err);
  const status = typeof anyErr?.response?.status === 'number' ? anyErr.response.status : null;
  const url = typeof anyErr?.config?.url === 'string' ? anyErr.config.url : null;
  const responseBody = anyErr?.response?.data != null ? safeJsonStringify(anyErr.response.data) : null;
  if (!status && !url && !anyErr?.isAxiosError) return null;
  return { message, status, url, responseBody };
}

function classifyUpstreamFailure(err: unknown): { type: string; status: number | null } {
  const anyErr = err as any;
  const status = typeof anyErr?.response?.status === 'number' ? anyErr.response.status : null;
  if (anyErr?.message === 'pipedrive_token_missing') return { type: 'token_missing', status };
  if (status === 401 || status === 403) return { type: 'auth_failed', status };
  if (status === 404 || status === 410) return { type: 'endpoint_missing', status };
  const responseBody = anyErr?.response?.data;
  if (responseBody) {
    const raw = safeJsonStringify(responseBody).toLowerCase();
    if (raw.includes('deprecated') || raw.includes('deprecat') || raw.includes('sunset')) {
      return { type: 'deprecated', status };
    }
  }
  return { type: 'upstream_error', status };
}

async function requireLinkedChannel(providerChannelId: string, res: Response): Promise<PipedriveChannelRecord | null> {
  const channel = await getChannelByProviderId(providerChannelId);
  if (!channel) {
    res.status(404).json({ error: 'channel_inactive' });
    return null;
  }
  return channel;
}

async function requireRealChannel(providerChannelId: string, res: Response): Promise<PipedriveChannelRecord | null> {
  const channel = await requireLinkedChannel(providerChannelId, res);
  if (!channel) return null;
  if (String(channel.id ?? '').startsWith('fallback:')) {
    res.status(410).json({ error: 'channels_unavailable' });
    return null;
  }
  return channel;
}

function pipedriveAuth(req: Request, res: Response, next: NextFunction): void {
  if (!PIPEDRIVE_CLIENT_ID || !PIPEDRIVE_CLIENT_SECRET) {
    res.status(503).json({ error: 'pipedrive_not_configured' });
    return;
  }
  const creds = parseBasicAuth(req.header('authorization'));
  if (!creds) {
    res.setHeader('WWW-Authenticate', 'Basic');
    res.status(401).json({ error: 'unauthorized' });
    return;
  }
  if (!safeEquals(creds.user, PIPEDRIVE_CLIENT_ID) || !safeEquals(creds.pass, PIPEDRIVE_CLIENT_SECRET)) {
    res.setHeader('WWW-Authenticate', 'Basic');
    res.status(401).json({ error: 'unauthorized' });
    return;
  }
  next();
}

function pipedriveWebhookAuth(req: Request, res: Response, next: NextFunction): void {
  if (!PIPEDRIVE_WEBHOOK_USER || !PIPEDRIVE_WEBHOOK_PASS) {
    res.status(503).json({ error: 'pipedrive_webhook_not_configured' });
    return;
  }
  const creds = parseBasicAuth(req.header('authorization'));
  if (!creds) {
    res.setHeader('WWW-Authenticate', 'Basic');
    res.status(401).json({ error: 'unauthorized' });
    return;
  }
  if (!safeEquals(creds.user, PIPEDRIVE_WEBHOOK_USER) || !safeEquals(creds.pass, PIPEDRIVE_WEBHOOK_PASS)) {
    res.setHeader('WWW-Authenticate', 'Basic');
    res.status(401).json({ error: 'unauthorized' });
    return;
  }
  next();
}

function resolveBaseUrl(req: Request): string {
  if (PIPEDRIVE_PUBLIC_BASE_URL) return PIPEDRIVE_PUBLIC_BASE_URL.replace(/\/$/, '');
  const forwardedProto = req.header('x-forwarded-proto');
  const proto = forwardedProto ? forwardedProto.split(',')[0].trim() : req.protocol;
  const forwardedHost = req.header('x-forwarded-host');
  const host = forwardedHost ? forwardedHost.split(',')[0].trim() : req.get('host');
  return `${proto}://${host}`;
}

function resolveRedirectUri(req: Request): string {
  if (typeof req.query.redirect_uri === 'string' && req.query.redirect_uri.trim()) {
    return req.query.redirect_uri.trim();
  }
  if (PIPEDRIVE_REDIRECT_URI) return PIPEDRIVE_REDIRECT_URI;
  return `${resolveBaseUrl(req)}/pipedrive/oauth/callback`;
}

function parseLimit(value: unknown, fallback: number, max = 100): number {
  const raw = typeof value === 'string' ? Number(value) : Array.isArray(value) ? Number(value[0]) : NaN;
  if (!Number.isFinite(raw) || raw <= 0) return fallback;
  return Math.min(Math.floor(raw), max);
}

function parseRecipientIds(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.flatMap((item) => (typeof item === 'string' ? [item] : [])).filter(Boolean);
  }
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!trimmed) return [];
    try {
      const parsed = JSON.parse(trimmed);
      if (Array.isArray(parsed)) {
        return parsed.filter((item) => typeof item === 'string' && item.trim());
      }
    } catch {
      // ignore JSON parse errors
    }
    if (trimmed.includes(',')) {
      return trimmed.split(',').map((item) => item.trim()).filter(Boolean);
    }
    return [trimmed];
  }
  return [];
}

function resolveTargetJid(conversationId: string): string | null {
  if (conversationId.includes('@')) return conversationId;
  const normalized = normalizeToE164BR(conversationId);
  if (!normalized) return null;
  return `${normalized}@s.whatsapp.net`;
}

function guessMediaType(mimetype: string | undefined): MediaMessageType {
  if (!mimetype) return 'document';
  if (mimetype.startsWith('image/')) return 'image';
  if (mimetype.startsWith('video/')) return 'video';
  if (mimetype.startsWith('audio/')) return 'audio';
  return 'document';
}

function buildManifest(baseUrl: string, options: { version?: string | null } = {}): Record<string, unknown> {
  const normalized = baseUrl.replace(/\/$/, '');
  const endpoints: Record<string, string> = {
    getConversations: `${normalized}/pipedrive/channels/:providerChannelId/conversations`,
    getConversationById: `${normalized}/pipedrive/channels/:providerChannelId/conversations/:sourceConversationId`,
    getSenderById: `${normalized}/pipedrive/channels/:providerChannelId/senders/:senderId`,
    getMessageById: `${normalized}/pipedrive/channels/:providerChannelId/conversations/:sourceConversationId/messages/:sourceMessageId`,
    postMessage: `${normalized}/pipedrive/channels/:providerChannelId/conversations/:sourceConversationId/messages`,
    deleteChannelById: `${normalized}/pipedrive/channels/:providerChannelId`,
  };
  if (PIPEDRIVE_TEMPLATE_SUPPORT) {
    endpoints.getTemplates = `${normalized}/pipedrive/channels/:providerChannelId/templates`;
  }
  return {
    provider_type: PIPEDRIVE_PROVIDER_TYPE,
    endpoints,
    ...(options.version ? { version: options.version } : {}),
  };
}

router.get('/manifest.json', (req, res) => {
  const version = typeof req.query.version === 'string' && req.query.version.trim() ? req.query.version.trim() : null;
  res.json(buildManifest(resolveBaseUrl(req), { version }));
});

router.get('/oauth/start', (req, res) => {
  if (!PIPEDRIVE_CLIENT_ID || !PIPEDRIVE_CLIENT_SECRET) {
    res.status(503).json({ error: 'pipedrive_not_configured' });
    return;
  }
  const redirectUri = resolveRedirectUri(req);
  const query = new URLSearchParams({
    client_id: PIPEDRIVE_CLIENT_ID,
    redirect_uri: redirectUri,
  });
  if (typeof req.query.state === 'string' && req.query.state.trim()) {
    query.set('state', req.query.state.trim());
  }
  const scope =
    (typeof req.query.scope === 'string' && req.query.scope.trim())
      ? req.query.scope.trim()
      : PIPEDRIVE_OAUTH_SCOPE;
  if (scope) query.set('scope', scope);
  const authUrl = `${PIPEDRIVE_OAUTH_BASE_URL.replace(/\/$/, '')}/oauth/authorize?${query.toString()}`;
  const scopeWarnings = getScopeWarnings(scope || '');

  const shouldRedirect =
    req.query.redirect === '1' ||
    (req.headers.accept ?? '').includes('text/html');

  if (shouldRedirect) {
    if (scopeWarnings.length) {
      logger.warn({ warnings: scopeWarnings, scope: scope || null }, 'oauth.scope.warning');
    }
    res.redirect(authUrl);
    return;
  }

  res.json({ url: authUrl, scope: scope || null, warnings: scopeWarnings.length ? scopeWarnings : undefined });
});

router.get('/oauth/callback', async (req, res) => {
  const code = typeof req.query.code === 'string' ? req.query.code.trim() : '';
  const error = typeof req.query.error === 'string' ? req.query.error.trim() : '';
  if (error) {
    res.status(400).json({ error, description: req.query.error_description ?? null });
    return;
  }
  if (!code) {
    res.status(400).json({ error: 'missing_code' });
    return;
  }
  try {
    const redirectUri = resolveRedirectUri(req);
    const token = await pipedriveClient.exchangeToken(code, redirectUri);
    res.json({
      success: true,
      data: {
        id: token.id,
        company_id: token.company_id,
        user_id: token.user_id,
        api_domain: token.api_domain,
        scope: token.scope,
        expires_at: token.expires_at,
      },
    });
  } catch (err: any) {
    logger.error({ err: err?.message ?? err }, 'oauth.callback.failed');
    res.status(500).json({ error: 'oauth_exchange_failed' });
  }
});

router.get('/admin/channels', apiKeyAuth, async (_req, res) => {
  const channels = await listChannels();
  res.json({ success: true, data: channels });
});

router.post('/admin/register-channel', apiKeyAuth, async (req, res) => {
  const body = (req.body || {}) as Record<string, unknown>;
  const providerChannelId = typeof body.providerChannelId === 'string' && body.providerChannelId.trim()
    ? body.providerChannelId.trim()
    : typeof body.instanceId === 'string' && body.instanceId.trim()
    ? body.instanceId.trim()
    : '';

  if (!providerChannelId) {
    res.status(400).json({ error: 'provider_channel_id_required' });
    return;
  }

  const instance = getInstance(providerChannelId);
  const name = typeof body.name === 'string' && body.name.trim()
    ? body.name.trim()
    : instance?.name || providerChannelId;

  const providerType = typeof body.providerType === 'string' && body.providerType.trim()
    ? body.providerType.trim()
    : PIPEDRIVE_PROVIDER_TYPE;

  const avatarUrl = typeof body.avatarUrl === 'string' && body.avatarUrl.trim()
    ? body.avatarUrl.trim()
    : PIPEDRIVE_CHANNEL_AVATAR_URL || null;

  const templateSupport =
    typeof body.templateSupport === 'boolean'
      ? body.templateSupport
      : PIPEDRIVE_TEMPLATE_SUPPORT;

  const companyIdRaw = typeof body.companyId === 'number'
    ? body.companyId
    : typeof body.companyId === 'string'
    ? Number(body.companyId)
    : null;
  const companyId = Number.isFinite(companyIdRaw as number) ? Number(companyIdRaw) : null;
  const apiDomain =
    typeof body.apiDomain === 'string' && body.apiDomain.trim()
      ? body.apiDomain.trim()
      : null;

  try {
    const tokenInfo = await pipedriveClient.getAccessToken({ companyId, apiDomain });
    if (!tokenInfo) {
      res.status(503).json({ error: 'pipedrive_token_missing' });
      return;
    }

    if (PIPEDRIVE_CHANNELS_MODE === 'v2') {
      const channel = await upsertChannel({
        id: `fallback:${providerChannelId}`,
        provider_channel_id: providerChannelId,
        name,
        provider_type: providerType,
        template_support: templateSupport,
        avatar_url: avatarUrl ?? null,
        company_id: tokenInfo.token.company_id ?? companyId ?? null,
        api_domain: tokenInfo.token.api_domain ?? apiDomain ?? null,
      });
      res.json({
        success: true,
        data: channel,
        warning: 'channels_mode_v2_skip_register',
      });
      return;
    }

    const channel = await pipedriveClient.registerChannel({
      providerChannelId,
      name,
      providerType,
      avatarUrl,
      templateSupport,
      companyId,
      apiDomain,
    });
    res.json({ success: true, data: channel });
  } catch (err: any) {
    const upstream = serializeAxiosError(err);
    const classification = classifyUpstreamFailure(err);
    logger.error(
      { err: err?.message ?? err, upstream, classification, providerChannelId },
      'admin.register-channel.failed',
    );

    if (PIPEDRIVE_CHANNELS_MODE === 'dual' && PIPEDRIVE_FALLBACK_NOTES_ENABLED) {
      const tokenInfo = await pipedriveClient.getAccessToken({ companyId, apiDomain });
      const channel = await upsertChannel({
        id: `fallback:${providerChannelId}`,
        provider_channel_id: providerChannelId,
        name,
        provider_type: providerType,
        template_support: templateSupport,
        avatar_url: avatarUrl ?? null,
        company_id: tokenInfo?.token.company_id ?? companyId ?? null,
        api_domain: tokenInfo?.token.api_domain ?? apiDomain ?? null,
      });
      res.json({
        success: true,
        data: channel,
        warning: {
          message: 'channels_register_failed_using_fallback_notes',
          classification,
          upstream,
        },
      });
      return;
    }

    const status = classification.type === 'token_missing' ? 503 : upstream?.status ? 502 : 500;
    res.status(status).json({
      error: classification.type === 'token_missing' ? 'pipedrive_token_missing' : 'register_channel_failed',
      classification,
      upstream,
    });
  }
});

router.post('/admin/unregister-channel', apiKeyAuth, async (req, res) => {
  const body = (req.body || {}) as Record<string, unknown>;
  const providerChannelId = typeof body.providerChannelId === 'string' && body.providerChannelId.trim()
    ? body.providerChannelId.trim()
    : typeof body.instanceId === 'string' && body.instanceId.trim()
    ? body.instanceId.trim()
    : '';

  if (!providerChannelId) {
    res.status(400).json({ error: 'provider_channel_id_required' });
    return;
  }

  const deleteRemote = body.deleteRemote === true || body.deleteRemote === '1' || body.deleteRemote === 'true';
  const purge = body.purge === true || body.purge === '1' || body.purge === 'true';

  const channel = await getChannelByProviderId(providerChannelId);
  if (!channel) {
    res.json({ success: true, data: { provider_channel_id: providerChannelId, removed: false, remote_deleted: false, purged: false } });
    return;
  }

  let remoteDeleted = false;
  let remoteWarning: unknown = null;
  if (deleteRemote && !String(channel.id ?? '').startsWith('fallback:')) {
    try {
      await pipedriveClient.deleteChannel(channel);
      remoteDeleted = true;
    } catch (err: any) {
      remoteWarning = {
        message: 'remote_delete_failed',
        upstream: serializeAxiosError(err),
      };
    }
  }

  await removeChannelByProviderId(providerChannelId);
  if (purge) {
    await removeConversationsByProviderId(providerChannelId);
  }

  res.json({
    success: true,
    data: {
      provider_channel_id: providerChannelId,
      removed: true,
      remote_deleted: remoteDeleted,
      purged: purge,
    },
    ...(remoteWarning ? { warning: remoteWarning } : {}),
  });
});

router.post('/admin/register-all', apiKeyAuth, async (_req, res) => {
  const instances = getAllInstances();
  const results: Array<{ id: string; status: string; detail?: string; warning?: unknown }>= [];
  const tokenInfo = await pipedriveClient.getAccessToken();
  for (const inst of instances) {
    try {
      if (!tokenInfo) {
        results.push({ id: inst.id, status: 'error', detail: 'pipedrive_token_missing' });
        continue;
      }

      if (PIPEDRIVE_CHANNELS_MODE === 'v2') {
        const channel = await upsertChannel({
          id: `fallback:${inst.id}`,
          provider_channel_id: inst.id,
          name: inst.name || inst.id,
          provider_type: PIPEDRIVE_PROVIDER_TYPE,
          template_support: PIPEDRIVE_TEMPLATE_SUPPORT,
          avatar_url: PIPEDRIVE_CHANNEL_AVATAR_URL || null,
          company_id: tokenInfo.token.company_id ?? null,
          api_domain: tokenInfo.token.api_domain ?? null,
        });
        results.push({ id: channel.provider_channel_id, status: 'fallback', warning: 'channels_mode_v2_skip_register' });
        continue;
      }

      const channel = await pipedriveClient.registerChannel({
        providerChannelId: inst.id,
        name: inst.name || inst.id,
        providerType: PIPEDRIVE_PROVIDER_TYPE,
        avatarUrl: PIPEDRIVE_CHANNEL_AVATAR_URL || null,
        templateSupport: PIPEDRIVE_TEMPLATE_SUPPORT,
      });
      results.push({ id: channel.provider_channel_id, status: 'ok' });
    } catch (err: any) {
      const upstream = serializeAxiosError(err);
      const classification = classifyUpstreamFailure(err);

      if (PIPEDRIVE_CHANNELS_MODE === 'dual' && PIPEDRIVE_FALLBACK_NOTES_ENABLED) {
        const channel = await upsertChannel({
          id: `fallback:${inst.id}`,
          provider_channel_id: inst.id,
          name: inst.name || inst.id,
          provider_type: PIPEDRIVE_PROVIDER_TYPE,
          template_support: PIPEDRIVE_TEMPLATE_SUPPORT,
          avatar_url: PIPEDRIVE_CHANNEL_AVATAR_URL || null,
          company_id: tokenInfo?.token.company_id ?? null,
          api_domain: tokenInfo?.token.api_domain ?? null,
        });
        results.push({
          id: channel.provider_channel_id,
          status: 'fallback',
          warning: { message: 'channels_register_failed_using_fallback_notes', classification, upstream },
        });
        continue;
      }

      results.push({ id: inst.id, status: 'error', detail: err?.message ?? String(err), warning: { classification, upstream } });
    }
  }
  res.json({ success: true, data: results });
});

router.post('/admin/webhooks/subscribe', apiKeyAuth, async (req, res) => {
  if (!PIPEDRIVE_WEBHOOK_USER || !PIPEDRIVE_WEBHOOK_PASS) {
    res.status(503).json({ error: 'pipedrive_webhook_not_configured' });
    return;
  }

  const body = (req.body || {}) as Record<string, unknown>;
  const unsubscribe =
    body.unsubscribe === true ||
    body.action === 'unsubscribe' ||
    body.mode === 'unsubscribe';
  const deleteAll = body.all === true || body.deleteAll === true;

  const companyIdRaw = typeof body.companyId === 'number'
    ? body.companyId
    : typeof body.companyId === 'string'
    ? Number(body.companyId)
    : null;
  const companyId = Number.isFinite(companyIdRaw as number) ? Number(companyIdRaw) : null;
  const apiDomain =
    typeof body.apiDomain === 'string' && body.apiDomain.trim()
      ? body.apiDomain.trim()
      : null;

  const actionsInput = Array.isArray(body.actions) ? body.actions : null;
  const actions = actionsInput
    ? actionsInput
      .filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
      .map((item) => item.trim())
    : ['added', 'updated'];

  const objectsInput = Array.isArray(body.objects) ? body.objects : null;
  const objects = objectsInput
    ? objectsInput
      .filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
      .map((item) => item.trim())
    : PIPEDRIVE_WEBHOOK_EVENTS;

  const subscriptionUrl = `${resolveBaseUrl(req)}/pipedrive/webhooks`;
  const desired = new Set(objects.flatMap((obj) => actions.map((action) => `${action}:${obj}`)));

  try {
    const existing = await pipedriveClient.listWebhooks({ companyId, apiDomain });
    const ours = existing.filter((hook) => hook?.subscription_url === subscriptionUrl);

    const created: any[] = [];
    const deleted: any[] = [];
    const kept: any[] = [];

    if (unsubscribe) {
      const toDelete = ours.filter((hook) => {
        const key = `${hook?.event_action}:${hook?.event_object}`;
        return deleteAll ? true : desired.has(key);
      });
      for (const hook of toDelete) {
        const id = typeof hook?.id === 'number' ? hook.id : typeof hook?.id === 'string' ? Number(hook.id) : NaN;
        if (!Number.isFinite(id) || id <= 0) continue;
        await pipedriveClient.deleteWebhook({ id, companyId, apiDomain });
        deleted.push({ id, event_action: hook.event_action, event_object: hook.event_object });
      }

      res.json({
        success: true,
        data: {
          mode: 'unsubscribe',
          subscription_url: subscriptionUrl,
          deleted,
          kept: ours.length - deleted.length,
        },
      });
      return;
    }

    for (const obj of objects) {
      for (const action of actions) {
        const key = `${action}:${obj}`;
        const found = ours.find((hook) => `${hook?.event_action}:${hook?.event_object}` === key);
        if (found) {
          kept.push(found);
          continue;
        }
        const createdHook = await pipedriveClient.createWebhook({
          subscriptionUrl,
          eventAction: action,
          eventObject: obj,
          httpAuthUser: PIPEDRIVE_WEBHOOK_USER,
          httpAuthPassword: PIPEDRIVE_WEBHOOK_PASS,
          companyId,
          apiDomain,
        });
        created.push({ id: createdHook.id, event_action: action, event_object: obj });
      }
    }

    const stale = ours.filter((hook) => !desired.has(`${hook?.event_action}:${hook?.event_object}`));
    for (const hook of stale) {
      const id = typeof hook?.id === 'number' ? hook.id : typeof hook?.id === 'string' ? Number(hook.id) : NaN;
      if (!Number.isFinite(id) || id <= 0) continue;
      await pipedriveClient.deleteWebhook({ id, companyId, apiDomain });
      deleted.push({ id, event_action: hook.event_action, event_object: hook.event_object, reason: 'stale' });
    }

    res.json({
      success: true,
      data: {
        mode: 'subscribe',
        subscription_url: subscriptionUrl,
        actions,
        objects,
        created,
        deleted,
        kept: kept.length,
      },
    });
  } catch (err: any) {
    const upstream = serializeAxiosError(err);
    logger.error({ err: err?.message ?? err, upstream }, 'admin.webhooks.subscribe.failed');
    res.status(upstream?.status ? 502 : 500).json({ error: 'webhook_subscribe_failed', upstream });
  }
});

router.get('/admin/webhooks/status', apiKeyAuth, async (req, res) => {
  const companyIdRaw = typeof req.query.companyId === 'string' ? Number(req.query.companyId) : NaN;
  const companyId = Number.isFinite(companyIdRaw) ? companyIdRaw : null;
  const apiDomain = typeof req.query.apiDomain === 'string' && req.query.apiDomain.trim() ? req.query.apiDomain.trim() : null;

  const subscriptionUrl = `${resolveBaseUrl(req)}/pipedrive/webhooks`;
  try {
    const hooks = await pipedriveClient.listWebhooks({ companyId, apiDomain });
    const ours = hooks.filter((hook) => hook?.subscription_url === subscriptionUrl);
    const recent = await listPipedriveWebhookEvents({ limit: 20 });
    res.json({
      success: true,
      data: {
        subscription_url: subscriptionUrl,
        expected_objects: PIPEDRIVE_WEBHOOK_EVENTS,
        hooks: ours,
        recent_events: recent,
      },
    });
  } catch (err: any) {
    const upstream = serializeAxiosError(err);
    logger.error({ err: err?.message ?? err, upstream }, 'admin.webhooks.status.failed');
    res.status(upstream?.status ? 502 : 500).json({ error: 'webhook_status_failed', upstream });
  }
});

router.get('/admin/metrics', apiKeyAuth, async (_req, res) => {
  const metrics = await getPipedriveMetrics();
  res.json({ success: true, data: metrics });
});

router.get('/admin/metrics/export', apiKeyAuth, async (req, res) => {
  const format = typeof req.query.format === 'string' ? req.query.format.trim().toLowerCase() : 'json';
  const download = req.query.download === '1' || req.query.download === 'true';
  const metrics = await getPipedriveMetrics();
  if (format === 'csv') {
    const csv = exportPipedriveMetricsCsv(metrics);
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    if (download) {
      res.setHeader('Content-Disposition', `attachment; filename="pipedrive-metrics.csv"`);
    }
    res.send(csv);
    return;
  }
  res.json({ success: true, data: metrics });
});

router.post('/webhooks', pipedriveWebhookAuth, async (req, res) => {
  const payload = req.body ?? null;
  const record = await recordPipedriveWebhookEventStore(payload);
  const allowed = record.meta.object ? PIPEDRIVE_WEBHOOK_EVENTS.includes(record.meta.object) : false;

  try {
    await recordPipedriveWebhookEvent(record.meta.object);
  } catch {
    // ignore metrics errors
  }

  let automation: unknown = null;
  if (allowed && !record.duplicate) {
    try {
      automation = await maybeRunPipedriveAutomation(payload);
    } catch (err: any) {
      logger.warn({ err: err?.message ?? err, key: record.key }, 'webhooks.automation.failed');
      automation = { sent: false, skippedReason: 'error', error: err?.message ?? String(err) };
    }
  } else if (!allowed) {
    automation = { sent: false, skippedReason: 'event_not_allowed' };
  } else if (record.duplicate) {
    automation = { sent: false, skippedReason: 'duplicate' };
  }

  if (allowed) {
    const result = automation as any;
    const metric =
      result?.sent === true
        ? 'sent'
        : result?.skippedReason === 'error'
        ? 'failed'
        : 'skipped';
    try {
      await recordPipedriveAutomation(metric);
    } catch {
      // ignore metrics errors
    }
  }

  res.json({
    success: true,
    data: {
      key: record.key,
      duplicate: record.duplicate,
      object: record.meta.object,
      action: record.meta.action,
      entity_id: record.meta.entityId,
      automation,
    },
  });
});

router.get('/channels/:providerChannelId/conversations', pipedriveAuth, async (req, res) => {
  const providerChannelId = req.params.providerChannelId;
  const channel = await requireRealChannel(providerChannelId, res);
  if (!channel) return;
  const limit = parseLimit(req.query.limit, 20, 100);
  const messagesLimit = parseLimit(req.query.messages_limit, 20, 100);
  const after = typeof req.query.after === 'string' ? req.query.after : null;

  const { items, nextAfter } = await listConversations({
    providerChannelId,
    limit,
    after,
    messagesLimit,
  });

  const response: Record<string, unknown> = {
    success: true,
    data: items,
  };
  if (nextAfter) response.additional_data = { after: nextAfter };
  res.json(response);
});

router.get('/channels/:providerChannelId/conversations/:sourceConversationId', pipedriveAuth, async (req, res) => {
  const providerChannelId = req.params.providerChannelId;
  const channel = await requireRealChannel(providerChannelId, res);
  if (!channel) return;
  const messagesLimit = parseLimit(req.query.messages_limit, 20, 100);
  const after = typeof req.query.after === 'string' ? req.query.after : null;
  const conversation = await getConversation({
    providerChannelId,
    conversationId: req.params.sourceConversationId,
    messagesLimit,
    after,
  });
  if (!conversation) {
    res.status(404).json({ error: 'conversation_not_found' });
    return;
  }
  res.json({ success: true, data: conversation });
});

router.get('/channels/:providerChannelId/conversations/:sourceConversationId/messages/:sourceMessageId', pipedriveAuth, async (req, res) => {
  const providerChannelId = req.params.providerChannelId;
  const channel = await requireRealChannel(providerChannelId, res);
  if (!channel) return;
  const message = await findMessage({
    providerChannelId,
    conversationId: req.params.sourceConversationId,
    messageId: req.params.sourceMessageId,
  });
  if (!message) {
    res.status(404).json({ error: 'message_not_found' });
    return;
  }
  res.json(message);
});

router.get('/channels/:providerChannelId/messages/:sourceMessageId', pipedriveAuth, async (req, res) => {
  const providerChannelId = req.params.providerChannelId;
  const channel = await requireRealChannel(providerChannelId, res);
  if (!channel) return;
  const message = await findMessage({
    providerChannelId,
    messageId: req.params.sourceMessageId,
  });
  if (!message) {
    res.status(404).json({ error: 'message_not_found' });
    return;
  }
  res.json(message);
});

router.get('/channels/:providerChannelId/senders/:senderId', pipedriveAuth, async (req, res) => {
  const providerChannelId = req.params.providerChannelId;
  const channel = await requireRealChannel(providerChannelId, res);
  if (!channel) return;
  const participant = await findParticipant({
    providerChannelId,
    participantId: req.params.senderId,
  });
  if (!participant) {
    res.status(404).json({ error: 'sender_not_found' });
    return;
  }
  const response: Record<string, unknown> = {
    id: participant.id,
    name: participant.name,
  };
  if (participant.avatar_url) response.avatar_url = participant.avatar_url;
  if (participant.avatar_expires) response.avatar_expires = participant.avatar_expires;
  res.json({ success: true, data: response });
});

router.get('/channels/:providerChannelId/templates', pipedriveAuth, async (req, res) => {
  const providerChannelId = req.params.providerChannelId;
  const channel = await requireRealChannel(providerChannelId, res);
  if (!channel) return;
  res.json({ success: true, data: [] });
});

router.delete('/channels/:providerChannelId', pipedriveAuth, async (req, res) => {
  await removeChannelByProviderId(req.params.providerChannelId);
  await removeConversationsByProviderId(req.params.providerChannelId);
  res.json({ success: true });
});

router.post(
  '/channels/:providerChannelId/conversations/:sourceConversationId/messages',
  pipedriveAuth,
  upload.any(),
  async (req, res) => {
    const providerChannelId = req.params.providerChannelId;
    const channel = await requireRealChannel(providerChannelId, res);
    if (!channel) return;
    const conversationId = req.params.sourceConversationId;

    if (conversationId.endsWith('@g.us')) {
      res.status(400).json({ error: 'group_conversations_not_supported' });
      return;
    }

    const senderIdRaw = typeof req.body?.senderId === 'string'
      ? req.body.senderId.trim()
      : typeof req.body?.sender_id === 'string'
      ? req.body.sender_id.trim()
      : '';
    const recipientIds = parseRecipientIds(
      req.body?.recipientIds ?? req.body?.recipient_ids ?? req.body?.['recipientIds[]'],
    );
    if (!senderIdRaw || !recipientIds.length) {
      res.status(400).json({ error: 'senderId_and_recipientIds_required' });
      return;
    }

    const messageText = typeof req.body?.message === 'string' ? req.body.message.trim() : '';
    const files = (req.files || []) as Express.Multer.File[];
    if (!messageText && !files.length) {
      res.status(400).json({ error: 'message_or_attachments_required' });
      return;
    }

    const instance = await ensureInstanceStarted(providerChannelId, { name: providerChannelId });
    if (!instance.sock || !instance.context?.messageService) {
      res.status(503).json({ error: 'instance_unavailable' });
      return;
    }

    if (!allowSend(instance)) {
      res.status(429).json({ error: 'rate_limit_exceeded' });
      return;
    }

    const targetJid = resolveTargetJid(conversationId);
    if (!targetJid) {
      res.status(400).json({ error: 'invalid_conversation_id' });
      return;
    }

    const timeoutMs = getSendTimeoutMs();
    const sentMessages: Array<{ id: string; text: string }> = [];

    let sentMessage: WAMessage | null = null;
    if (messageText) {
      sentMessage = await instance.context.messageService.sendText(targetJid, messageText, { timeoutMs });
      const messageId = sentMessage?.key?.id ?? null;
      if (messageId) {
        sentMessages.push({ id: messageId, text: messageText || 'Mensagem enviada' });
        instance.metrics.sent += 1;
        instance.metrics.sent_by_type.text += 1;
        instance.metrics.last.sentId = messageId;
      }
    }

    for (const file of files) {
      const mediaType = guessMediaType(file.mimetype);
      const base64 = file.buffer.toString('base64');
      const mediaMessage = await instance.context.messageService.sendMedia(
        targetJid,
        mediaType,
        {
          base64,
          mimetype: file.mimetype,
          fileName: file.originalname,
        },
        { timeoutMs },
      );
      const mediaMessageId = mediaMessage?.key?.id ?? null;
      if (mediaMessageId) {
        const label = file.originalname?.trim() ? `Arquivo: ${file.originalname.trim()}` : 'Arquivo enviado';
        sentMessages.push({ id: mediaMessageId, text: label });
        instance.metrics.sent += 1;
        if (mediaType in instance.metrics.sent_by_type) {
          instance.metrics.sent_by_type[mediaType as keyof typeof instance.metrics.sent_by_type] += 1;
        }
        instance.metrics.last.sentId = mediaMessageId;
      }
      sentMessage = mediaMessage;
    }

    const responseId = sentMessage?.key?.id ?? sentMessages[sentMessages.length - 1]?.id ?? null;
    if (!responseId) {
      res.status(500).json({ error: 'message_id_missing' });
      return;
    }

    for (const msg of sentMessages) {
      markPipedriveOutbound(msg.id);
    }

    const sourceUserId = getSourceUserId(providerChannelId);
    if (senderIdRaw && senderIdRaw !== sourceUserId) {
      logger.debug({ senderIdRaw, expected: sourceUserId }, 'postMessage.senderId.mismatch');
    }
    const sender: PipedriveParticipant = {
      id: sourceUserId,
      name: instance.name || providerChannelId,
      role: 'source_user',
    };
    const nowIso = new Date().toISOString();
    for (const msg of sentMessages) {
      const messageId = msg.id;
      const message: PipedriveMessage = {
        id: messageId,
        status: 'sent',
        created_at: nowIso,
        message: msg.text,
        sender_id: sender.id,
        attachments: [],
      };
      try {
        await syncMessageToPipedrive({
          providerChannelId,
          channel,
          direction: 'outbound',
          conversationId,
          conversationLink: undefined,
          messageId,
          messageText: message.message,
          createdAt: message.created_at,
          status: message.status,
          sender,
          attachments: [],
        });
      } catch (err: any) {
        logger.warn({ err: err?.message ?? err, messageId }, 'postMessage.sync.failed');
      }
    }

    res.json({ success: true, data: { id: responseId } });
  },
);

export default router;
