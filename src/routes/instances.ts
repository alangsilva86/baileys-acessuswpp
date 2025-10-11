import { Router, type NextFunction, type Request, type Response } from 'express';
import type { WAMessage } from '@whiskeysockets/baileys';
import crypto from 'node:crypto';
import { mkdir, rename, rm } from 'fs/promises';
import QRCode from 'qrcode';
import {
  createInstance,
  deleteInstance,
  getAllInstances,
  getInstance,
  saveInstancesIndex,
  type Instance,
} from '../instanceManager.js';
import { brokerEventStore } from '../broker/eventStore.js';
import {
  allowSend,
  sendWithTimeout,
  waitForAck,
  normalizeToE164BR,
  getSendTimeoutMs,
} from '../utils.js';
import {
  buildMediaMessageContent,
  type BuiltMediaContent,
  type MediaMessageType,
  type MediaPayload,
  MAX_MEDIA_BYTES,
} from '../baileys/messageService.js';

const router = Router();

type AsyncHandler = (req: Request, res: Response, next: NextFunction) => Promise<void>;
const asyncHandler = (fn: AsyncHandler) =>
  (req: Request, res: Response, next: NextFunction) =>
    Promise.resolve(fn(req, res, next)).catch(next);

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

function isAuthorized(req: Request): boolean {
  const key = req.header('x-api-key') || '';
  return API_KEYS.some((k) => safeEquals(k, key));
}

function auth(req: Request, res: Response, next: NextFunction): void {
  if (!isAuthorized(req)) {
    res.status(401).json({ error: 'unauthorized' });
    return;
  }
  next();
}

router.use(auth);

router.post(
  '/',
  asyncHandler(async (req, res) => {
    const name = String((req.body as any)?.name || '').trim() || null;
    const noteRaw =
      typeof (req.body as any)?.note === 'string'
        ? (req.body as any).note.trim()
        : typeof (req.body as any)?.notes === 'string'
        ? (req.body as any).notes.trim()
        : '';
    const note = noteRaw ? noteRaw.slice(0, 280) : '';

    const iid = name ? name.toLowerCase().replace(/[^\w]+/g, '-') : crypto.randomUUID();
    if (getInstance(iid)) {
      res.status(409).json({ error: 'instance_exists' });
      return;
    }

    const inst = await createInstance(iid, name || iid, { note });
    res.json({ id: inst.id, name: inst.name, dir: inst.dir, metadata: inst.metadata });
  }),
);

router.get('/', (_req, res) => {
  const list = getAllInstances().map((inst) => {
    const serialized = serializeInstance(inst);
    return {
      id: serialized.id,
      name: serialized.name,
      note: serialized.note,
      notes: serialized.note,
      metadata: serialized.metadata,
      connected: serialized.connected,
      user: serialized.user,
      counters: { sent: serialized.counters.sent, status: serialized.counters.statusCounts },
      rate: serialized.rate,
    };
  });
  res.json(list);
});

router.get('/:iid', (req, res) => {
  const inst = getInstance(req.params.iid);
  if (!inst) {
    res.status(404).json({ error: 'instance_not_found' });
    return;
  }
  const serialized = serializeInstance(inst);
  res.json({ ...serialized, notes: serialized.note });
});

router.patch(
  '/:iid',
  asyncHandler(async (req, res) => {
    const inst = getInstance(req.params.iid);
    if (!inst) {
      res.status(404).json({ error: 'instance_not_found' });
      return;
    }

    const body = (req.body || {}) as Record<string, unknown>;
    let touched = false;

    if (Object.prototype.hasOwnProperty.call(body, 'name')) {
      if (typeof body.name !== 'string') {
        res.status(400).json({ error: 'name_invalid' });
        return;
      }
      const nextName = body.name.trim();
      if (!nextName) {
        res.status(400).json({ error: 'name_empty' });
        return;
      }
      inst.name = nextName.slice(0, 80);
      touched = true;
    }

    const patchNote =
      Object.prototype.hasOwnProperty.call(body, 'note')
        ? body.note
        : Object.prototype.hasOwnProperty.call(body, 'notes')
        ? body.notes
        : undefined;

    if (patchNote !== undefined) {
      if (typeof patchNote !== 'string') {
        res.status(400).json({ error: 'note_invalid' });
        return;
      }
      inst.metadata = inst.metadata || { note: '', createdAt: null, updatedAt: null };
      inst.metadata.note = String(patchNote).trim().slice(0, 280);
      touched = true;
    }

    if (!touched) {
      res.status(400).json({ error: 'no_updates' });
      return;
    }

    inst.metadata.updatedAt = new Date().toISOString();
    await saveInstancesIndex();
    res.json(serializeInstance(inst));
  }),
);

router.delete(
  '/:iid',
  asyncHandler(async (req, res) => {
    const iid = req.params.iid;
    if (iid === 'default') {
      res.status(400).json({ error: 'default_instance_cannot_be_deleted' });
      return;
    }
    const inst = getInstance(iid);
    if (!inst) {
      res.status(404).json({ error: 'instance_not_found' });
      return;
    }

    await deleteInstance(iid, { removeDir: true, logout: true });
    res.json({ ok: true, message: 'Instância removida permanentemente.' });
  }),
);

router.get(
  '/:iid/qr.png',
  asyncHandler(async (req, res) => {
    const inst = getInstance(req.params.iid);
    if (!inst) {
      res.status(404).send('instance_not_found');
      return;
    }
    if (!inst.lastQR) {
      res.status(404).send('no-qr');
      return;
    }
    const png = await QRCode.toBuffer(inst.lastQR, {
      type: 'png',
      margin: 1,
      scale: 6,
    });
    res.type('png').send(png);
  }),
);

router.post(
  '/:iid/pair',
  asyncHandler(async (req, res) => {
    const inst = getInstance(req.params.iid);
    if (!inst || !inst.sock) {
      res.status(503).json({ error: 'socket indisponível' });
      return;
    }
    const phoneNumberRaw = (req.body as any)?.phoneNumber;
    if (!phoneNumberRaw) {
      res.status(400).json({ error: 'phoneNumber obrigatório (ex: 5544...)' });
      return;
    }
    const code = await inst.sock.requestPairingCode(String(phoneNumberRaw));
    res.json({ pairingCode: code });
  }),
);

router.post(
  '/:iid/logout',
  asyncHandler(async (req, res) => {
    const inst = getInstance(req.params.iid);
    if (!inst || !inst.sock) {
      res.status(503).json({ error: 'socket indisponível' });
      return;
    }
    try {
      await inst.sock.logout();
      res.json({ ok: true, message: 'Sessão desconectada. Um novo QR aparecerá em breve.' });
    } catch (err: any) {
      res.status(500).json({ error: 'falha ao desconectar', detail: err?.message });
    }
  }),
);

router.post(
  '/:iid/session/wipe',
  asyncHandler(async (req, res) => {
    const inst = getInstance(req.params.iid);
    if (!inst) {
      res.status(404).json({ error: 'instance_not_found' });
      return;
    }

    try {
      inst.stopping = true;
      if (inst.sock) {
        try {
          await inst.sock.logout().catch(() => undefined);
        } catch {
          // ignore
        }
        try {
          inst.sock.end?.(undefined);
        } catch {
          // ignore
        }
      }
    } catch {
      // ignore
    }

    try {
      const stamp = new Date().toISOString().replace(/[:.]/g, '-');
      const backupDir = `${inst.dir}.bak-${stamp}`;
      await rename(inst.dir, backupDir).catch(() => undefined);
      await mkdir(inst.dir, { recursive: true }).catch(() => undefined);

      res.json({ ok: true, message: 'Sessão isolada. Reiniciando para gerar novo QR.' });

      setTimeout(() => process.exit(0), 200);
      setTimeout(async () => {
        try {
          await rm(backupDir, { recursive: true, force: true });
        } catch {
          // ignore
        }
      }, 1000);
    } catch (err) {
      try {
        await rm(inst.dir, { recursive: true, force: true });
        await mkdir(inst.dir, { recursive: true });
        res.json({ ok: true, message: 'Sessão limpa. Reiniciando para gerar novo QR.' });
        setTimeout(() => process.exit(0), 200);
      } catch (innerErr: any) {
        res
          .status(500)
          .json({ error: 'falha ao limpar sessão', detail: innerErr?.message || String(innerErr) });
      }
    }
  }),
);

router.get('/:iid/status', (req, res) => {
  const inst = getInstance(req.params.iid);
  if (!inst) {
    res.status(404).json({ error: 'instance_not_found' });
    return;
  }
  const id = String(req.query.id || '');
  if (!id) {
    res.status(400).json({ error: 'id obrigatório' });
    return;
  }
  const status = inst.statusMap.get(id) ?? null;
  res.json({ id, status });
});

router.get(
  '/:iid/groups',
  asyncHandler(async (req, res) => {
    const inst = getInstance(req.params.iid);
    if (!inst || !inst.sock) {
      res.status(503).json({ error: 'socket indisponível' });
      return;
    }
    const all = await inst.sock.groupFetchAllParticipating();
    const list = Object.values(all).map((group) => ({ id: group.id, subject: group.subject }));
    res.json(list);
  }),
);

router.get('/:iid/events', (req, res) => {
  const inst = getInstance(req.params.iid);
  if (!inst) {
    res.status(404).json({ error: 'instance_not_found' });
    return;
  }

  const direction =
    req.query.direction === 'inbound' || req.query.direction === 'outbound' || req.query.direction === 'system'
      ? req.query.direction
      : undefined;

  const events = brokerEventStore.list({
    instanceId: inst.id,
    limit: req.query.limit ? Number(req.query.limit) : undefined,
    after: typeof req.query.after === 'string' ? req.query.after : undefined,
    type: typeof req.query.type === 'string' ? req.query.type : undefined,
    direction,
  });

  res.json({ events, nextCursor: events.length ? events[events.length - 1].id : null });
});

router.post('/:iid/events/ack', (req, res) => {
  const inst = getInstance(req.params.iid);
  if (!inst) {
    res.status(404).json({ error: 'instance_not_found' });
    return;
  }

  const ids = Array.isArray((req.body as any)?.ids)
    ? ((req.body as any).ids as unknown[]).map((id) => String(id)).filter(Boolean)
    : [];

  if (!ids.length) {
    res.status(400).json({ error: 'ids_required' });
    return;
  }

  const result = brokerEventStore.ack(ids);
  res.json(result);
});

router.get('/:iid/metrics', (req, res) => {
  const inst = getInstance(req.params.iid);
  if (!inst) {
    res.status(404).json({ error: 'instance_not_found' });
    return;
  }

  const summary = serializeInstance(inst);
  const { metricsStartedAt, ...rest } = summary;
  const timeline = (inst.metrics.timeline || []).map((entry) => {
    const hasNewStatusFields =
      Object.prototype.hasOwnProperty.call(entry, 'serverAck') ||
      Object.prototype.hasOwnProperty.call(entry, 'pending') ||
      Object.prototype.hasOwnProperty.call(entry, 'read') ||
      Object.prototype.hasOwnProperty.call(entry, 'played');

    const serverAck = entry.serverAck ?? (hasNewStatusFields ? 0 : (entry as any).delivered ?? 0);

    return {
      ts: entry.ts,
      iso: entry.iso || new Date(entry.ts).toISOString(),
      sent: entry.sent ?? 0,
      pending: entry.pending ?? 0,
      serverAck,
      delivered: hasNewStatusFields ? entry.delivered ?? 0 : 0,
      read: entry.read ?? 0,
      played: entry.played ?? 0,
      failed: entry.failed ?? 0,
      rateInWindow: entry.rateInWindow ?? 0,
    };
  });

  res.json({
    service: process.env.SERVICE_NAME || 'baileys-api',
    ...rest,
    startedAt: metricsStartedAt,
    timeline,
    ack: {
      avgMs: inst.metrics.ack?.avgMs || 0,
      lastMs: inst.metrics.ack?.lastMs || null,
      samples: inst.metrics.ack?.count || 0,
    },
    sessionDir: inst.dir,
  });
});

router.post(
  '/:iid/exists',
  asyncHandler(async (req, res) => {
    const inst = getInstance(req.params.iid);
    if (!inst || !inst.sock) {
      res.status(503).json({ error: 'socket indisponível' });
      return;
    }
    const normalized = normalizeToE164BR((req.body as any)?.to);
    if (!normalized) {
      res.status(400).json({ error: 'to inválido. Use E.164: 55DDDNUMERO' });
      return;
    }
    const results = await inst.sock.onWhatsApp(normalized);
    res.json({ results });
  }),
);

router.post(
  '/:iid/send-text',
  asyncHandler(async (req, res) => {
    const inst = getInstance(req.params.iid);
    if (!inst || !inst.sock) {
      res.status(503).json({ error: 'socket indisponível' });
      return;
    }
    if (!allowSend(inst)) {
      res.status(429).json({ error: 'rate limit exceeded' });
      return;
    }

    const { to, message, waitAckMs } = (req.body || {}) as {
      to?: string;
      message?: string;
      waitAckMs?: number;
    };
    if (!to || typeof message !== 'string' || !message.trim()) {
      res.status(400).json({ error: 'parâmetros to e message são obrigatórios' });
      return;
    }

    const normalized = normalizeToE164BR(to);
    if (!normalized) {
      res.status(400).json({ error: 'to inválido. Use E.164: 55DDDNUMERO' });
      return;
    }

    const check = await inst.sock.onWhatsApp(normalized);
    const entry = Array.isArray(check) ? check[0] : null;
    if (!entry || !entry.exists) {
      res.status(404).json({ error: 'whatsapp_not_found' });
      return;
    }

    const content = message.trim();
    const timeoutMs = getSendTimeoutMs();
    const targetJid = entry?.jid ?? `${normalized}@s.whatsapp.net`;

    const sent = (inst.context?.messageService
      ? await inst.context.messageService.sendText(targetJid, content, { timeoutMs })
      : await sendWithTimeout(inst, targetJid, { text: content })) as any;
    inst.metrics.sent += 1;
    inst.metrics.sent_by_type.text += 1;
    inst.metrics.last.sentId = sent.key.id ?? null;
    if (sent.key.id) {
      inst.ackSentAt.set(sent.key.id, Date.now());
    }

    let ackStatus: number | null = null;
    if (waitAckMs) {
      ackStatus = await waitForAck(inst, sent.key.id, waitAckMs);
    }

    res.json({ id: sent.key.id, status: sent.status, ack: ackStatus });
  }),
);

const MEDIA_TYPE_COUNTER: Record<MediaMessageType, keyof Instance['metrics']['sent_by_type']> = {
  image: 'image',
  video: 'video',
  audio: 'audio',
  document: 'document',
};

router.post(
  '/:iid/send-media',
  asyncHandler(async (req, res) => {
    const inst = getInstance(req.params.iid);
    if (!inst || !inst.sock) {
      res.status(503).json({ error: 'socket indisponível' });
      return;
    }
    if (!allowSend(inst)) {
      res.status(429).json({ error: 'rate limit exceeded' });
      return;
    }

    const body = (req.body || {}) as {
      type?: string;
      to?: string;
      media?: Record<string, unknown>;
      caption?: string;
      waitAckMs?: number;
    };

    const typeRaw = typeof body.type === 'string' ? body.type.trim().toLowerCase() : '';
    const allowedTypes: MediaMessageType[] = ['image', 'video', 'audio', 'document'];
    if (!allowedTypes.includes(typeRaw as MediaMessageType)) {
      res.status(400).json({ error: 'type_invalid', allowed: allowedTypes });
      return;
    }

    if (!body.media || typeof body.media !== 'object') {
      res.status(400).json({ error: 'media_invalid' });
      return;
    }

    const toRaw = typeof body.to === 'string' ? body.to : '';
    if (!toRaw.trim()) {
      res.status(400).json({ error: 'to_required' });
      return;
    }

    const normalized = normalizeToE164BR(toRaw);
    if (!normalized) {
      res.status(400).json({ error: 'to inválido. Use E.164: 55DDDNUMERO' });
      return;
    }

    const mediaBody = body.media as Record<string, unknown>;
    const mediaPayload: MediaPayload = {
      url: typeof mediaBody.url === 'string' ? mediaBody.url : undefined,
      base64: typeof mediaBody.base64 === 'string' ? mediaBody.base64 : undefined,
      mimetype: typeof mediaBody.mimetype === 'string' ? mediaBody.mimetype : undefined,
      fileName: typeof mediaBody.fileName === 'string' ? mediaBody.fileName : undefined,
      ptt: typeof mediaBody.ptt === 'boolean' ? mediaBody.ptt : undefined,
      gifPlayback: typeof mediaBody.gifPlayback === 'boolean' ? mediaBody.gifPlayback : undefined,
    };

    let built: BuiltMediaContent;
    try {
      built = buildMediaMessageContent(typeRaw as MediaMessageType, mediaPayload, {
        caption: typeof body.caption === 'string' ? body.caption : undefined,
      });
    } catch (err) {
      const code = (err as Error & { code?: string }).code ?? 'media_invalid';
      const detail = (err as Error).message;
      const response: Record<string, unknown> = { error: code, detail };
      if (code === 'media_too_large') {
        response.maxBytes = MAX_MEDIA_BYTES;
      }
      res.status(400).json(response);
      return;
    }

    const check = await inst.sock.onWhatsApp(normalized);
    const entry = Array.isArray(check) ? check[0] : null;
    if (!entry || !entry.exists) {
      res.status(404).json({ error: 'whatsapp_not_found' });
      return;
    }

    const caption = typeof body.caption === 'string' ? body.caption : undefined;
    const timeoutMs = getSendTimeoutMs();
    const targetJid = entry?.jid ?? `${normalized}@s.whatsapp.net`;
    const mediaType = typeRaw as MediaMessageType;

    let sent: WAMessage;
    try {
      sent = inst.context?.messageService
        ? await inst.context.messageService.sendMedia(targetJid, mediaType, mediaPayload, {
            caption,
            timeoutMs,
          })
        : ((await sendWithTimeout(inst, targetJid, built.content)) as WAMessage);
    } catch (err) {
      res.status(500).json({ error: 'send_failed', detail: (err as Error).message });
      return;
    }

    inst.metrics.sent += 1;
    const counterKey = MEDIA_TYPE_COUNTER[mediaType];
    inst.metrics.sent_by_type[counterKey] += 1;
    inst.metrics.last.sentId = sent.key?.id ?? null;
    if (sent.key?.id) {
      inst.ackSentAt.set(sent.key.id, Date.now());
    }

    let ackStatus: number | null = null;
    const waitAckMs = Number(body.waitAckMs);
    if (Number.isFinite(waitAckMs) && waitAckMs > 0 && sent.key?.id) {
      ackStatus = await waitForAck(inst, sent.key.id, waitAckMs);
    }

    res.status(201).json({
      id: sent.key?.id ?? null,
      status: sent.status ?? null,
      ack: ackStatus,
      type: mediaType,
      mimetype: built.mimetype,
      fileName: built.fileName,
      source: built.source,
      size: built.size,
    });
  }),
);

router.post(
  '/:iid/send-poll',
  asyncHandler(async (req, res) => {
    const inst = getInstance(req.params.iid);
    if (!inst || !inst.sock) {
      res.status(503).json({ error: 'socket indisponível' });
      return;
    }
    if (!allowSend(inst)) {
      res.status(429).json({ error: 'rate limit exceeded' });
      return;
    }

    const { to, question, options, selectableCount, waitAckMs } = (req.body || {}) as {
      to?: string;
      question?: string;
      options?: unknown;
      selectableCount?: number;
      waitAckMs?: number;
    };

    const normalized = normalizeToE164BR(to);
    if (!normalized) {
      res.status(400).json({ error: 'to inválido. Use E.164: 55DDDNUMERO' });
      return;
    }

    if (typeof question !== 'string' || !question.trim()) {
      res.status(400).json({ error: 'question inválida' });
      return;
    }

    const rawOptions = Array.isArray(options) ? options : [];
    const sanitized = rawOptions
      .map((item) => (typeof item === 'string' ? item.trim() : ''))
      .filter(Boolean);
    if (sanitized.length < 2) {
      res.status(400).json({ error: 'options inválidas (mínimo 2 opções)' });
      return;
    }

    const pollService = inst.context?.pollService;
    if (!pollService) {
      res.status(503).json({ error: 'poll_service_unavailable' });
      return;
    }

    const check = await inst.sock.onWhatsApp(normalized);
    const entry = Array.isArray(check) ? check[0] : null;
    if (!entry || !entry.exists) {
      res.status(404).json({ error: 'whatsapp_not_found' });
      return;
    }

    const selectableRaw = Number(selectableCount);
    const selectable = Number.isFinite(selectableRaw)
      ? Math.max(1, Math.min(Math.floor(selectableRaw), sanitized.length))
      : 1;

    const targetJid = entry?.jid ?? `${normalized}@s.whatsapp.net`;

    const sent = (await pollService.sendPoll(targetJid, question.trim(), sanitized, {
      selectableCount: selectable,
    })) as any;
    inst.metrics.sent += 1;
    inst.metrics.sent_by_type.buttons += 1;
    inst.metrics.last.sentId = sent.key?.id ?? null;
    if (sent.key?.id) {
      inst.ackSentAt.set(sent.key.id, Date.now());
    }

    let ackStatus: number | null = null;
    if (waitAckMs && sent.key?.id) {
      ackStatus = await waitForAck(inst, sent.key.id, waitAckMs);
    }

    res.status(201).json({ id: sent.key?.id ?? null, status: sent.status, ack: ackStatus });
  }),
);

function serializeInstance(inst: Instance) {
  const connected = Boolean(inst.sock && inst.sock.user);
  return {
    id: inst.id,
    name: inst.name,
    connected,
    user: connected ? inst.sock?.user ?? null : null,
    note: inst.metadata?.note || '',
    metadata: {
      note: inst.metadata?.note || '',
      createdAt: inst.metadata?.createdAt || null,
      updatedAt: inst.metadata?.updatedAt || null,
    },
    counters: {
      sent: inst.metrics.sent,
      byType: { ...inst.metrics.sent_by_type },
      statusCounts: { ...inst.metrics.status_counts },
    },
    last: { ...inst.metrics.last },
    rate: {
      limit: Number(process.env.RATE_MAX_SENDS || 20),
      windowMs: Number(process.env.RATE_WINDOW_MS || 15_000),
      inWindow: inst.rateWindow.length,
      usage: inst.rateWindow.length / (Number(process.env.RATE_MAX_SENDS || 20) || 1),
    },
    metricsStartedAt: inst.metrics.startedAt,
  };
}

export default router;
