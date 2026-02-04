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
} from '../services/pipedrive/config.js';
import { pipedriveClient } from '../services/pipedrive/client.js';
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
} from '../services/pipedrive/store.js';
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

function buildManifest(baseUrl: string): Record<string, unknown> {
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
  };
}

router.get('/manifest.json', (req, res) => {
  res.json(buildManifest(resolveBaseUrl(req)));
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

  const shouldRedirect =
    req.query.redirect === '1' ||
    (req.headers.accept ?? '').includes('text/html');

  if (shouldRedirect) {
    res.redirect(authUrl);
    return;
  }

  res.json({ url: authUrl });
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

  const companyId = typeof body.companyId === 'number' ? body.companyId : null;
  const apiDomain = typeof body.apiDomain === 'string' ? body.apiDomain : null;

  try {
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
    logger.error({ err: err?.message ?? err }, 'admin.register-channel.failed');
    res.status(500).json({ error: 'register_channel_failed' });
  }
});

router.post('/admin/register-all', apiKeyAuth, async (_req, res) => {
  const instances = getAllInstances();
  const results: Array<{ id: string; status: string; detail?: string }>= [];
  for (const inst of instances) {
    try {
      const channel = await pipedriveClient.registerChannel({
        providerChannelId: inst.id,
        name: inst.name || inst.id,
        providerType: PIPEDRIVE_PROVIDER_TYPE,
        avatarUrl: PIPEDRIVE_CHANNEL_AVATAR_URL || null,
        templateSupport: PIPEDRIVE_TEMPLATE_SUPPORT,
      });
      results.push({ id: channel.provider_channel_id, status: 'ok' });
    } catch (err: any) {
      results.push({ id: inst.id, status: 'error', detail: err?.message ?? String(err) });
    }
  }
  res.json({ success: true, data: results });
});

router.get('/channels/:providerChannelId/conversations', pipedriveAuth, async (req, res) => {
  const limit = parseLimit(req.query.limit, 20, 100);
  const messagesLimit = parseLimit(req.query.messages_limit, 20, 100);
  const after = typeof req.query.after === 'string' ? req.query.after : null;

  const { items, nextAfter } = await listConversations({
    providerChannelId: req.params.providerChannelId,
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
  const messagesLimit = parseLimit(req.query.messages_limit, 20, 100);
  const after = typeof req.query.after === 'string' ? req.query.after : null;
  const conversation = await getConversation({
    providerChannelId: req.params.providerChannelId,
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
  const message = await findMessage({
    providerChannelId: req.params.providerChannelId,
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
  const message = await findMessage({
    providerChannelId: req.params.providerChannelId,
    messageId: req.params.sourceMessageId,
  });
  if (!message) {
    res.status(404).json({ error: 'message_not_found' });
    return;
  }
  res.json(message);
});

router.get('/channels/:providerChannelId/senders/:senderId', pipedriveAuth, async (req, res) => {
  const participant = await findParticipant({
    providerChannelId: req.params.providerChannelId,
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

router.get('/channels/:providerChannelId/templates', pipedriveAuth, async (_req, res) => {
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

    const channel = await getChannelByProviderId(providerChannelId);
    if (channel) {
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
          await pipedriveClient.receiveMessage(channel, {
            conversation_id: conversationId,
            conversation_link: undefined,
            message_id: messageId,
            message: message.message,
            created_at: message.created_at,
            status: message.status,
            sender,
            attachments: [],
          });
        } catch (err: any) {
          logger.warn({ err: err?.message ?? err, messageId }, 'postMessage.receive.failed');
        }
      }
    }

    res.json({ success: true, data: { id: responseId } });
  },
);

export default router;
