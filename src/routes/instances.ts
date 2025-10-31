import { Router, type NextFunction, type Request, type Response } from 'express';
import type { WASocket } from '@whiskeysockets/baileys';
import type { WAMessage } from '@whiskeysockets/baileys';
import crypto from 'node:crypto';
import QRCode from 'qrcode';
import {
  createInstance,
  deleteInstance,
  getAllInstances,
  getInstance,
  resetInstanceSession,
  saveInstancesIndex,
  type Instance,
  recordNoteRevision,
  summarizeNoteDiff,
  MAX_NOTE_REVISIONS,
} from '../instanceManager.js';
import { brokerEventStore } from '../broker/eventStore.js';
import { allowSend, sendWithTimeout, normalizeToE164BR, getSendTimeoutMs } from '../utils.js';
import {
  buildMediaMessageContent,
  type BuiltMediaContent,
  type MediaMessageType,
  type MediaPayload,
  MAX_MEDIA_BYTES,
} from '../baileys/messageService.js';

const router = Router();

type SocketMessageContent = Parameters<WASocket['sendMessage']>[1];

type AsyncHandler = (req: Request, res: Response, next: NextFunction) => Promise<void>;
const asyncHandler = (fn: AsyncHandler) =>
  (req: Request, res: Response, next: NextFunction) =>
    Promise.resolve(fn(req, res, next)).catch(next);

const API_KEYS = String(process.env.API_KEY || 'change-me')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

interface AuthedRequest extends Request {
  authorizedKeyId?: string;
}

function safeEquals(a: unknown, b: unknown): boolean {
  const A = Buffer.from(String(a ?? ''));
  const B = Buffer.from(String(b ?? ''));
  if (A.length !== B.length) return false;
  return crypto.timingSafeEqual(A, B);
}

function resolveApiKeyMatch(value: string): string | null {
  for (const candidate of API_KEYS) {
    if (safeEquals(candidate, value)) return candidate;
  }
  return null;
}

function deriveAuthorizedKeyId(value: string): string {
  const hash = crypto.createHash('sha256').update(value).digest('hex').slice(0, 12);
  return `key:${hash}`;
}

function attachAuthorizedKey(req: Request, key: string | null): void {
  if (!key) return;
  (req as AuthedRequest).authorizedKeyId = deriveAuthorizedKeyId(key);
}

function getAuthorizedKeyId(req: Request): string | null {
  return (req as AuthedRequest).authorizedKeyId ?? null;
}

function auth(req: Request, res: Response, next: NextFunction): void {
  const provided = req.header('x-api-key') || '';
  const matched = resolveApiKeyMatch(provided);
  if (!matched) {
    res.status(401).json({ error: 'unauthorized' });
    return;
  }
  attachAuthorizedKey(req, matched);
  next();
}

router.use(auth);

function connectionUpdatedAtIso(inst: Instance | undefined): string | null {
  if (!inst?.connectionUpdatedAt) return null;
  const date = new Date(inst.connectionUpdatedAt);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function ensureInstanceHasSocket(
  inst: Instance | undefined,
  res: Response,
  allowedStates: Instance['connectionState'][] = ['open'],
): inst is Instance & { sock: WASocket } {
  if (!inst) {
    res.status(404).json({ error: 'instance_not_found' });
    return false;
  }
  if (!inst.sock) {
    res
      .status(503)
      .json({ error: 'instance_offline', state: inst.connectionState, updatedAt: connectionUpdatedAtIso(inst) });
    return false;
  }
  if (!allowedStates.includes(inst.connectionState)) {
    res
      .status(503)
      .json({ error: 'instance_offline', state: inst.connectionState, updatedAt: connectionUpdatedAtIso(inst) });
    return false;
  }
  return true;
}

function ensureInstanceOnline(inst: Instance | undefined, res: Response): inst is Instance & { sock: WASocket } {
  return ensureInstanceHasSocket(inst, res, ['open']);
}

function getErrorMessage(err: unknown): string {
  if (err && typeof err === 'object') {
    const anyErr = err as Record<string, unknown>;
    if (typeof anyErr.message === 'string' && anyErr.message.trim()) {
      return anyErr.message;
    }
    if (typeof anyErr.reason === 'string' && anyErr.reason.trim()) {
      return anyErr.reason;
    }
  }
  if (typeof err === 'string') {
    return err;
  }
  return 'unknown error';
}

function isSocketUnavailableError(err: unknown): boolean {
  const message = getErrorMessage(err).toLowerCase();
  if (!message || message === 'unknown error') return false;
  return (
    message.includes('connection closed') ||
    message.includes('socket is unavailable') ||
    message.includes('socket closed')
  );
}

const GROUP_ACTION_STATUS_MESSAGES: Record<string, string> = {
  '200': 'ok',
  '401': 'ação não autorizada para o participante',
  '403': 'instância não é administradora ou não possui permissão para esta ação',
  '404': 'participante não encontrado ou não faz parte do grupo',
  '408': 'ação expirou ou participante não pôde ser atualizado',
  '409': 'participante já está no grupo',
  '410': 'participante já não faz parte do grupo',
  '429': 'limite do WhatsApp atingido; tente novamente mais tarde',
  '500': 'erro interno do WhatsApp ao processar a ação',
};

interface ParsedParticipant {
  jid: string;
  phone: string;
}

interface ParticipantActionItem {
  jid: string;
  phone: string;
  status: number | null;
  rawStatus: string | null;
  success: boolean;
  message: string;
  systemMessageId: string | null;
}

interface ParticipantActionSummary {
  items: ParticipantActionItem[];
  successCount: number;
  total: number;
  systemMessageId: string | null;
}

function ensureGroupJid(raw: string): string | null {
  const value = String(raw ?? '').trim();
  if (!value) return null;
  if (/^[0-9A-Za-z-]+@g\.us$/i.test(value)) return value;
  if (/^[0-9A-Za-z-]+$/i.test(value)) {
    return `${value}@g.us`;
  }
  return null;
}

function describeGroupParticipantStatus(code: string): string {
  return GROUP_ACTION_STATUS_MESSAGES[code] || 'erro desconhecido ao atualizar participante';
}

function mapBaileysError(
  err: any,
  fallbackError = 'baileys_error',
): { status: number; error: string; detail: string } {
  const statusCodeRaw = err?.output?.statusCode ?? err?.statusCode ?? err?.status;
  const statusCode = Number.isFinite(Number(statusCodeRaw)) ? Number(statusCodeRaw) : undefined;
  const detail =
    err?.data?.details || err?.output?.payload?.details || err?.output?.payload?.message || err?.message || 'erro desconhecido';

  if (statusCode === 403) {
    return {
      status: 403,
      error: 'forbidden',
      detail: 'Instância não possui permissão para executar esta ação no grupo.',
    };
  }
  if (statusCode === 404) {
    return {
      status: 404,
      error: 'group_not_found',
      detail: 'Grupo não encontrado ou instância não participa dele.',
    };
  }
  if (statusCode === 429) {
    return {
      status: 429,
      error: 'rate_limited',
      detail: 'Limite de operações imposto pelo WhatsApp atingido. Tente novamente mais tarde.',
    };
  }

  return {
    status: statusCode && statusCode >= 400 && statusCode < 600 ? statusCode : 502,
    error: fallbackError,
    detail,
  };
}

function collectParticipantJids(input: unknown): { participants: ParsedParticipant[]; invalid: string[] } {
  const participants: ParsedParticipant[] = [];
  const invalid: string[] = [];
  const seen = new Set<string>();

  const list = Array.isArray(input) ? input : [];
  for (const raw of list) {
    const normalized = normalizeToE164BR(raw);
    if (!normalized) {
      invalid.push(String(raw ?? ''));
      continue;
    }
    const jid = `${normalized}@s.whatsapp.net`;
    if (seen.has(jid)) continue;
    seen.add(jid);
    participants.push({ jid, phone: normalized });
  }

  return { participants, invalid };
}

function summarizeParticipantResults(rawResults: any[]): ParticipantActionSummary {
  const items: ParticipantActionItem[] = rawResults.map((entry) => {
    const rawStatus = entry?.status ? String(entry.status) : null;
    const statusNumber = rawStatus && Number.isFinite(Number(rawStatus)) ? Number(rawStatus) : null;
    const jid = String(entry?.jid ?? '');
    const phone = jid.endsWith('@s.whatsapp.net') ? jid.replace('@s.whatsapp.net', '') : jid;
    const success = rawStatus === '200';
    const systemMessageId = typeof entry?.content?.attrs?.id === 'string' ? entry.content.attrs.id : null;

    return {
      jid,
      phone,
      status: statusNumber,
      rawStatus,
      success,
      message: rawStatus ? describeGroupParticipantStatus(rawStatus) : 'status não informado',
      systemMessageId,
    };
  });

  const successCount = items.filter((item) => item.success).length;
  const systemMessageId = items.find((item) => item.success && item.systemMessageId)?.systemMessageId ?? null;

  return {
    items,
    successCount,
    total: items.length,
    systemMessageId,
  };
}

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
      connectionState: serialized.connectionState,
      connectionUpdatedAt: serialized.connectionUpdatedAt,
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

    if (!inst.metadata) {
      inst.metadata = { note: '', createdAt: null, updatedAt: null, revisions: [] };
    }
    if (!Array.isArray(inst.metadata.revisions)) {
      inst.metadata.revisions = [];
    }

    const body = (req.body || {}) as Record<string, unknown>;
    let touched = false;
    let noteChanged = false;
    const previousNote = inst.metadata.note || '';

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
      const nextNote = String(patchNote).trim().slice(0, 280);
      if (nextNote !== inst.metadata.note) {
        noteChanged = true;
        inst.metadata.note = nextNote;
      } else {
        inst.metadata.note = nextNote;
      }
      touched = true;
    }

    if (!touched) {
      res.status(400).json({ error: 'no_updates' });
      return;
    }

    const nowIso = new Date().toISOString();
    if (noteChanged) {
      const author = getAuthorizedKeyId(req);
      const diffSummary = summarizeNoteDiff(previousNote, inst.metadata.note || '');
      recordNoteRevision(inst, {
        timestamp: nowIso,
        author,
        diff: {
          before: previousNote,
          after: inst.metadata.note || '',
          summary: diffSummary,
        },
      });
    }

    if (Array.isArray(inst.metadata.revisions) && inst.metadata.revisions.length > MAX_NOTE_REVISIONS) {
      inst.metadata.revisions = inst.metadata.revisions.slice(0, MAX_NOTE_REVISIONS);
    }

    inst.metadata.updatedAt = nowIso;
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
    if (!ensureInstanceHasSocket(inst, res, ['open', 'connecting'])) return;
    const phoneNumberRaw = (req.body as any)?.phoneNumber;
    if (!phoneNumberRaw) {
      res.status(400).json({ error: 'phoneNumber obrigatório (ex: 5544...)' });
      return;
    }
    const phoneNumber = String(phoneNumberRaw).trim();
    if (!phoneNumber) {
      res.status(400).json({ error: 'phoneNumber inválido' });
      return;
    }
    const previousPhone = inst.phoneNumber;
    inst.phoneNumber = phoneNumber;
    await saveInstancesIndex();
    try {
      const code = await inst.sock.requestPairingCode(phoneNumber);
      res.json({ pairingCode: code });
    } catch (err) {
      inst.phoneNumber = previousPhone;
      await saveInstancesIndex();
      throw err;
    }
  }),
);

router.post(
  '/:iid/logout',
  asyncHandler(async (req, res) => {
    const inst = getInstance(req.params.iid);
    if (!ensureInstanceOnline(inst, res)) return;
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

    void resetInstanceSession(inst).catch((err) => {
      console.error('[instances] resetInstanceSession.failed', err);
    });

    res
      .status(202)
      .json({ ok: true, message: 'Sessão reiniciando. O QR será regenerado em instantes.' });
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
    if (!ensureInstanceOnline(inst, res)) return;
    const all = await inst.sock.groupFetchAllParticipating();
    const list = Object.values(all).map((group) => ({ id: group.id, subject: group.subject }));
    res.json(list);
  }),
);

router.post(
  '/:iid/groups',
  asyncHandler(async (req, res) => {
    const inst = getInstance(req.params.iid);
    if (!ensureInstanceOnline(inst, res)) return;

    const subjectRaw = (req.body as any)?.subject;
    const subject = typeof subjectRaw === 'string' ? subjectRaw.trim() : '';
    if (!subject) {
      res.status(400).json({ error: 'subject_obrigatorio' });
      return;
    }

    const { participants, invalid } = collectParticipantJids((req.body as any)?.participants);
    if (invalid.length) {
      res.status(400).json({ error: 'participants_invalid', detail: invalid });
      return;
    }
    if (!participants.length) {
      res.status(400).json({ error: 'participants_required', detail: 'Informe ao menos um participante válido (55DDDNUMERO).' });
      return;
    }

    try {
      const metadata = await inst.sock.groupCreate(
        subject,
        participants.map((item) => item.jid),
      );

      inst.metrics.sent += 1;
      inst.metrics.sent_by_type.group += 1;

      res.status(201).json({
        id: metadata.id,
        subject: metadata.subject,
        creation: metadata.creation ?? null,
        owner: metadata.owner ?? null,
        announce: metadata.announce ?? null,
        restrict: metadata.restrict ?? null,
        size: metadata.size ?? metadata.participants?.length ?? null,
        participants: (metadata.participants || []).map((participant) => ({
          jid: participant.id,
          phone: participant.id?.endsWith('@s.whatsapp.net')
            ? participant.id.replace('@s.whatsapp.net', '')
            : participant.id,
          isAdmin: Boolean(participant.admin),
          isSuperAdmin: Boolean(participant.isSuperAdmin),
        })),
      });
    } catch (err: any) {
      const mapped = mapBaileysError(err, 'group_create_failed');
      res.status(mapped.status).json({ error: mapped.error, detail: mapped.detail });
    }
  }),
);

router.post(
  '/:iid/groups/:gid/members',
  asyncHandler(async (req, res) => {
    const inst = getInstance(req.params.iid);
    if (!ensureInstanceOnline(inst, res)) return;

    const groupJid = ensureGroupJid(req.params.gid);
    if (!groupJid) {
      res.status(400).json({ error: 'group_id_invalido' });
      return;
    }

    const { participants, invalid } = collectParticipantJids((req.body as any)?.participants);
    if (invalid.length) {
      res.status(400).json({ error: 'participants_invalid', detail: invalid });
      return;
    }
    if (!participants.length) {
      res.status(400).json({ error: 'participants_required', detail: 'Informe ao menos um participante válido (55DDDNUMERO).' });
      return;
    }

    try {
      const results = await inst.sock.groupParticipantsUpdate(
        groupJid,
        participants.map((item) => item.jid),
        'add',
      );
      const summary = summarizeParticipantResults(results);

      if (summary.successCount > 0) {
        inst.metrics.sent += 1;
        inst.metrics.sent_by_type.group += 1;
        if (summary.systemMessageId) {
          inst.metrics.last.sentId = summary.systemMessageId;
        }
      }

      const statusType =
        summary.successCount === summary.total
          ? 'success'
          : summary.successCount === 0
          ? 'error'
          : 'partial';
      const statusCode = statusType === 'success' ? 200 : statusType === 'partial' ? 207 : 400;
      const message =
        statusType === 'success'
          ? 'Todos os participantes foram adicionados ao grupo.'
          : statusType === 'partial'
          ? 'Alguns participantes não puderam ser adicionados.'
          : 'Nenhum participante pôde ser adicionado.';

      res.status(statusCode).json({ status: statusType, message, results: summary.items });
    } catch (err: any) {
      const mapped = mapBaileysError(err, 'group_participants_update_failed');
      res.status(mapped.status).json({ error: mapped.error, detail: mapped.detail });
    }
  }),
);

router.delete(
  '/:iid/groups/:gid/members',
  asyncHandler(async (req, res) => {
    const inst = getInstance(req.params.iid);
    if (!ensureInstanceOnline(inst, res)) return;

    const groupJid = ensureGroupJid(req.params.gid);
    if (!groupJid) {
      res.status(400).json({ error: 'group_id_invalido' });
      return;
    }

    const { participants, invalid } = collectParticipantJids((req.body as any)?.participants);
    if (invalid.length) {
      res.status(400).json({ error: 'participants_invalid', detail: invalid });
      return;
    }
    if (!participants.length) {
      res.status(400).json({ error: 'participants_required', detail: 'Informe ao menos um participante válido (55DDDNUMERO).' });
      return;
    }

    try {
      const results = await inst.sock.groupParticipantsUpdate(
        groupJid,
        participants.map((item) => item.jid),
        'remove',
      );
      const summary = summarizeParticipantResults(results);

      if (summary.successCount > 0) {
        inst.metrics.sent += 1;
        inst.metrics.sent_by_type.group += 1;
        if (summary.systemMessageId) {
          inst.metrics.last.sentId = summary.systemMessageId;
        }
      }

      const statusType =
        summary.successCount === summary.total
          ? 'success'
          : summary.successCount === 0
          ? 'error'
          : 'partial';
      const statusCode = statusType === 'success' ? 200 : statusType === 'partial' ? 207 : 400;
      const message =
        statusType === 'success'
          ? 'Participantes removidos do grupo com sucesso.'
          : statusType === 'partial'
          ? 'Alguns participantes não puderam ser removidos.'
          : 'Nenhum participante pôde ser removido.';

      res.status(statusCode).json({ status: statusType, message, results: summary.items });
    } catch (err: any) {
      const mapped = mapBaileysError(err, 'group_participants_update_failed');
      res.status(mapped.status).json({ error: mapped.error, detail: mapped.detail });
    }
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

router.get('/:iid/logs', (req, res) => {
  const inst = getInstance(req.params.iid);
  if (!inst) {
    res.status(404).json({ error: 'instance_not_found' });
    return;
  }

  const limit = Number(req.query.limit);
  const direction =
    req.query.direction === 'inbound' || req.query.direction === 'outbound' || req.query.direction === 'system'
      ? req.query.direction
      : undefined;

  const events = brokerEventStore.recent({
    instanceId: inst.id,
    type: typeof req.query.type === 'string' ? req.query.type : undefined,
    direction,
    limit: Number.isFinite(limit) ? limit : 20,
  });

  res.json({ events });
});

router.get('/:iid/metrics', (req, res) => {
  const inst = getInstance(req.params.iid);
  if (!inst) {
    res.status(404).json({ error: 'instance_not_found' });
    return;
  }

  const summary = serializeInstance(inst);
  const { metricsStartedAt, ...rest } = summary;
  const statusCounts = summary.counters?.statusCounts || {};
  const deliverySummary = {
    pending: Number(statusCounts['1']) || 0,
    serverAck: Number(statusCounts['2']) || 0,
    delivered: Number(statusCounts['3']) || 0,
  };
  const inFlight = deliverySummary.pending + deliverySummary.serverAck;
  const delivery = { ...deliverySummary, inFlight };
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
    delivery,
    sessionDir: inst.dir,
  });
});

router.post(
  '/:iid/exists',
  asyncHandler(async (req, res) => {
    const inst = getInstance(req.params.iid);
    if (!ensureInstanceOnline(inst, res)) return;
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
  '/:iid/send-quick',
  asyncHandler(async (req, res) => {
    const inst = getInstance(req.params.iid);
    if (!ensureInstanceOnline(inst, res)) return;
    if (!allowSend(inst)) {
      res.status(429).json({ error: 'rate limit exceeded' });
      return;
    }

    const body = (req.body || {}) as Record<string, unknown>;
    const typeRaw = typeof body.type === 'string' ? body.type.trim().toLowerCase() : 'text';
    const allowedTypes = ['text', 'buttons', 'list', 'media'] as const;
    const isAllowedType = (allowedTypes as readonly string[]).includes(typeRaw);
    if (!isAllowedType) {
      res.status(400).json({ error: 'type_invalid', allowed: allowedTypes });
      return;
    }
    const type = typeRaw as (typeof allowedTypes)[number];

    const toRaw = typeof body.to === 'string' ? body.to : '';
    if (!toRaw.trim()) {
      res.status(400).json({ error: 'parâmetro to é obrigatório' });
      return;
    }

    const normalized = normalizeToE164BR(toRaw);
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

    const targetJid = entry?.jid ?? `${normalized}@s.whatsapp.net`;
    const timeoutMs = getSendTimeoutMs();
    const digits = normalized.replace(/\D/g, '');
    const quickLinks = [
      digits
        ? {
            rel: 'chat',
            label: 'Abrir conversa',
            href: `https://wa.me/${digits}`,
          }
        : null,
      digits
        ? {
            rel: 'web',
            label: 'Abrir no WhatsApp Web',
            href: `https://web.whatsapp.com/send?phone=${digits}`,
          }
        : null,
      {
        rel: 'logs',
        label: 'Ver eventos recentes',
        href: `/instances/${inst.id}/logs?limit=20&direction=outbound`,
      },
    ].filter((link): link is { rel: string; label: string; href: string } => Boolean(link));

    const requestLog: Record<string, unknown> = { type, to: normalized };
    const meta: Record<string, unknown> = {};

    const respondSocketUnavailable = (err: unknown): boolean => {
      if (!isSocketUnavailableError(err)) return false;
      const message = getErrorMessage(err);
      res.status(503).json({
        error: 'socket_unavailable',
        detail: 'Conexão com o WhatsApp indisponível. Refaça o pareamento e tente novamente.',
        message,
      });
      return true;
    };

    let sent: WAMessage | undefined;
    let messageId: string | null = null;
    let status: number | null = null;
    let summary = '';
    const preview: Record<string, unknown> = {};

    if (type === 'text') {
        const rawMessage =
          typeof body.text === 'string'
            ? body.text
            : typeof body.message === 'string'
            ? body.message
            : '';
        const messageText = rawMessage.trim();
        if (!messageText) {
          res.status(400).json({ error: 'message_required' });
          return;
        }
        if (messageText.length > 4096) {
          res.status(400).json({ error: 'message_too_long', max: 4096 });
          return;
        }

        requestLog.messageLength = messageText.length;

        try {
          sent = inst.context?.messageService
            ? await inst.context.messageService.sendText(targetJid, messageText, { timeoutMs })
            : ((await sendWithTimeout(inst, targetJid, { text: messageText })) as WAMessage);
        } catch (err) {
          if (respondSocketUnavailable(err)) return;
          res.status(500).json({ error: 'send_failed', detail: getErrorMessage(err) });
          return;
        }

        inst.metrics.sent += 1;
        inst.metrics.sent_by_type.text += 1;

        const snippet = messageText.length > 120 ? `${messageText.slice(0, 117)}…` : messageText;
        summary = snippet ? `Texto enviado para ${normalized}: ${snippet}` : `Texto enviado para ${normalized}.`;
        if (snippet) preview.text = snippet;
        meta.length = messageText.length;
    } else if (type === 'buttons') {
        const messageText = typeof body.text === 'string' ? body.text.trim() : '';
        if (!messageText) {
          res.status(400).json({ error: 'text inválido' });
          return;
        }

        const rawOptions = Array.isArray((body as any).buttons)
          ? ((body as any).buttons as unknown[])
          : Array.isArray((body as any).options)
          ? ((body as any).options as unknown[])
          : [];
        const sanitizedButtons: { id: string; title: string }[] = [];
        const seenIds = new Set<string>();
        for (const option of rawOptions) {
          if (!option || typeof option !== 'object') continue;
          const idRaw = (option as any).id ?? (option as any).buttonId;
          const titleRaw =
            (option as any).title ??
            (option as any).text ??
            (option as any).label ??
            (option as any)?.buttonText?.displayText;
          const id = typeof idRaw === 'string' ? idRaw.trim() : '';
          const title = typeof titleRaw === 'string' ? titleRaw.trim() : '';
          if (!id || !title || seenIds.has(id)) continue;
          seenIds.add(id);
          sanitizedButtons.push({ id, title });
          if (sanitizedButtons.length >= 3) break;
        }
        if (!sanitizedButtons.length) {
          res.status(400).json({ error: 'options inválidas (mínimo 1 botão com id e title)' });
          return;
        }

        const footerText = typeof body.footer === 'string' ? body.footer.trim() : '';
        const sanitizedFooter = footerText ? footerText : undefined;

        requestLog.buttonsCount = sanitizedButtons.length;
        requestLog.buttons = sanitizedButtons.map((button) => button.id);
        if (sanitizedFooter) requestLog.footer = sanitizedFooter;
        meta.buttonsCount = sanitizedButtons.length;
        if (sanitizedFooter) meta.footer = sanitizedFooter;

        try {
          if (inst.context?.messageService) {
            sent = await inst.context.messageService.sendButtons(
              targetJid,
              { text: messageText, footer: sanitizedFooter, buttons: sanitizedButtons },
              { timeoutMs },
            );
          } else {
            const templateButtons = sanitizedButtons.map((button, index) => ({
              index: index + 1,
              quickReplyButton: { id: button.id, displayText: button.title },
            }));
            const content = {
              text: messageText,
              footer: sanitizedFooter,
              templateButtons,
            } as unknown as SocketMessageContent;
            sent = (await sendWithTimeout(inst, targetJid, content)) as WAMessage;
          }
        } catch (err) {
          if (respondSocketUnavailable(err)) return;
          res.status(500).json({ error: 'send_failed', detail: getErrorMessage(err) });
          return;
        }

        inst.metrics.sent += 1;
        inst.metrics.sent_by_type.buttons += 1;

        summary = `Botões (${sanitizedButtons.length}) enviados para ${normalized}.`;
        preview.text = messageText;
        preview.buttons = sanitizedButtons;
    } else if (type === 'list') {
        const messageText = typeof body.text === 'string' ? body.text.trim() : '';
        if (!messageText) {
          res.status(400).json({ error: 'text inválido' });
          return;
        }

        const buttonText = typeof body.buttonText === 'string' ? body.buttonText.trim() : '';
        if (!buttonText) {
          res.status(400).json({ error: 'buttonText inválido' });
          return;
        }

        const rawSections = Array.isArray(body.sections) ? (body.sections as unknown[]) : [];
        const sanitizedSections: { title?: string; options: { id: string; title: string; description?: string }[] }[] = [];
        const seenIds = new Set<string>();

        for (const section of rawSections) {
          if (!section || typeof section !== 'object') continue;
          const sectionTitle = typeof (section as any).title === 'string' ? (section as any).title.trim() : '';
          const rawOptions = Array.isArray((section as any).options)
            ? ((section as any).options as unknown[])
            : Array.isArray((section as any).rows)
            ? ((section as any).rows as unknown[])
            : [];
          const sectionOptions: { id: string; title: string; description?: string }[] = [];
          for (const option of rawOptions) {
            if (!option || typeof option !== 'object') continue;
            const idRaw = (option as any).id ?? (option as any).rowId;
            const titleRaw = (option as any).title ?? (option as any).text;
            const descriptionRaw = (option as any).description ?? (option as any).subtitle;
            const id = typeof idRaw === 'string' ? idRaw.trim() : '';
            const title = typeof titleRaw === 'string' ? titleRaw.trim() : '';
            const description = typeof descriptionRaw === 'string' ? descriptionRaw.trim() : '';
            if (!id || !title || seenIds.has(id)) continue;
            seenIds.add(id);
            const optionEntry: { id: string; title: string; description?: string } = { id, title };
            if (description) optionEntry.description = description;
            sectionOptions.push(optionEntry);
          }
          if (sectionOptions.length) {
            const normalizedSection: { title?: string; options: { id: string; title: string; description?: string }[] } = {
              options: sectionOptions,
            };
            if (sectionTitle) normalizedSection.title = sectionTitle;
            sanitizedSections.push(normalizedSection);
          }
        }

        if (!sanitizedSections.length) {
          res.status(400).json({ error: 'sections inválidas (mínimo 1 opção com id e title)' });
          return;
        }

        const footerText = typeof body.footer === 'string' ? body.footer.trim() : '';
        const sanitizedFooter = footerText ? footerText : undefined;
        const titleText = typeof body.title === 'string' ? body.title.trim() : '';
        const sanitizedTitle = titleText ? titleText : undefined;

        requestLog.buttonText = buttonText;
        requestLog.sectionsCount = sanitizedSections.length;
        requestLog.optionsCount = sanitizedSections.reduce((acc, section) => acc + section.options.length, 0);
        meta.sectionsCount = requestLog.sectionsCount;
        meta.optionsCount = requestLog.optionsCount;

        try {
          if (inst.context?.messageService) {
            sent = await inst.context.messageService.sendList(
              targetJid,
              {
                text: messageText,
                buttonText,
                title: sanitizedTitle,
                footer: sanitizedFooter,
                sections: sanitizedSections,
              },
              { timeoutMs },
            );
          } else {
            const sectionsPayload = sanitizedSections.map((section) => ({
              title: section.title,
              rows: section.options.map((option) => ({
                rowId: option.id,
                title: option.title,
                description: option.description,
              })),
            }));
            const content = {
              text: messageText,
              footer: sanitizedFooter,
              list: {
                title: sanitizedTitle,
                buttonText,
                description: messageText,
                footer: sanitizedFooter,
                sections: sectionsPayload,
              },
            } as unknown as SocketMessageContent;
            sent = (await sendWithTimeout(inst, targetJid, content)) as WAMessage;
          }
        } catch (err) {
          if (respondSocketUnavailable(err)) return;
          res.status(500).json({ error: 'send_failed', detail: getErrorMessage(err) });
          return;
        }

        inst.metrics.sent += 1;
        inst.metrics.sent_by_type.lists += 1;

        const totalOptions = sanitizedSections.reduce((acc, section) => acc + section.options.length, 0);
        summary = `Lista enviada para ${normalized} (${totalOptions} opções).`;
        preview.text = messageText;
        preview.buttonText = buttonText;
        preview.sections = sanitizedSections.map((section) => ({
          title: section.title,
          options: section.options.map((option) => option.title),
        }));
        if (sanitizedTitle) meta.title = sanitizedTitle;
        if (sanitizedFooter) meta.footer = sanitizedFooter;
    } else if (type === 'media') {
        const mediaTypeRaw = typeof body.mediaType === 'string' ? body.mediaType.trim().toLowerCase() : '';
        const allowedMediaTypes: MediaMessageType[] = ['image', 'video', 'audio', 'document'];
        if (!allowedMediaTypes.includes(mediaTypeRaw as MediaMessageType)) {
          res.status(400).json({ error: 'type_invalid', allowed: allowedMediaTypes });
          return;
        }

        if (!body.media || typeof body.media !== 'object') {
          res.status(400).json({ error: 'media_invalid' });
          return;
        }

        const captionRaw =
          typeof body.caption === 'string'
            ? body.caption
            : typeof body.text === 'string'
            ? body.text
            : '';

        const mediaPayload: MediaPayload = {
          url: typeof (body.media as any).url === 'string' ? (body.media as any).url : undefined,
          base64: typeof (body.media as any).base64 === 'string' ? (body.media as any).base64 : undefined,
          mimetype: typeof (body.media as any).mimetype === 'string' ? (body.media as any).mimetype : undefined,
          fileName: typeof (body.media as any).fileName === 'string' ? (body.media as any).fileName : undefined,
          ptt: typeof (body.media as any).ptt === 'boolean' ? (body.media as any).ptt : undefined,
          gifPlayback: typeof (body.media as any).gifPlayback === 'boolean' ? (body.media as any).gifPlayback : undefined,
        };

        let built: BuiltMediaContent;
        try {
          built = buildMediaMessageContent(mediaTypeRaw as MediaMessageType, mediaPayload, {
            caption: captionRaw || undefined,
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

        requestLog.mediaType = mediaTypeRaw;
        if (mediaPayload.mimetype) requestLog.mimetype = mediaPayload.mimetype;
        if (captionRaw) requestLog.captionLength = captionRaw.length;

        try {
          if (inst.context?.messageService) {
            sent = await inst.context.messageService.sendMedia(targetJid, mediaTypeRaw as MediaMessageType, mediaPayload, {
              caption: captionRaw || undefined,
              timeoutMs,
            });
          } else {
            sent = (await sendWithTimeout(inst, targetJid, built.content)) as WAMessage;
          }
        } catch (err) {
          if (respondSocketUnavailable(err)) return;
          res.status(500).json({ error: 'send_failed', detail: getErrorMessage(err) });
          return;
        }

        inst.metrics.sent += 1;
        const counterKey = MEDIA_TYPE_COUNTER[mediaTypeRaw as MediaMessageType];
        inst.metrics.sent_by_type[counterKey] += 1;

        const caption = captionRaw.trim();
        summary = `Mídia (${mediaTypeRaw}) enviada para ${normalized}${caption ? `: ${caption}` : ''}`;
        if (caption) preview.text = caption;
        preview.mediaType = mediaTypeRaw;
        if (built.fileName) preview.fileName = built.fileName;
        if (built.mimetype) preview.mimetype = built.mimetype;

        meta.media = {
          type: mediaTypeRaw,
          mimetype: built.mimetype,
          size: built.size,
          fileName: built.fileName,
          source: built.source,
        };
    }

    const timestampIso = new Date().toISOString();
    status = sent?.status ?? null;
    messageId = sent?.key?.id ?? null;

    inst.metrics.last.sentId = messageId;

    const responsePayload: Record<string, unknown> = {
      messageId,
      type,
      to: normalized,
      status,
      summary,
      preview,
      links: quickLinks,
      timestamp: timestampIso,
    };
    if (Object.keys(meta).length) {
      responsePayload.meta = meta;
    }

    res.json(responsePayload);

    brokerEventStore.enqueue({
      instanceId: inst.id,
      direction: 'system',
      type: 'QUICK_SEND_RESULT',
      payload: {
        request: requestLog,
        response: responsePayload,
        meta,
        timestamp: timestampIso,
      },
    });
  }),
);

router.post(
  '/:iid/send-text',
  asyncHandler(async (req, res) => {
    const inst = getInstance(req.params.iid);
    if (!ensureInstanceOnline(inst, res)) return;
    if (!allowSend(inst)) {
      res.status(429).json({ error: 'rate limit exceeded' });
      return;
    }

    const { to, message } = (req.body || {}) as {
      to?: string;
      message?: string;
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

    let sent: any;
    try {
      sent = inst.context?.messageService
        ? await inst.context.messageService.sendText(targetJid, content, { timeoutMs })
        : await sendWithTimeout(inst, targetJid, { text: content });
    } catch (err) {
      if (isSocketUnavailableError(err)) {
        const message = getErrorMessage(err);
        res.status(503).json({
          error: 'socket_unavailable',
          detail: 'Conexão com o WhatsApp indisponível. Refaça o pareamento e tente novamente.',
          message,
        });
        return;
      }
      throw err;
    }
    const messageId = sent?.key?.id ?? null;

    inst.metrics.sent += 1;
    inst.metrics.sent_by_type.text += 1;
    inst.metrics.last.sentId = messageId;
    res.json({ id: messageId, messageId, status: sent.status });
  }),
);

router.post(
  '/:iid/send-buttons',
  asyncHandler(async (req, res) => {
    const inst = getInstance(req.params.iid);
    if (!ensureInstanceOnline(inst, res)) return;
    if (!allowSend(inst)) {
      res.status(429).json({ error: 'rate limit exceeded' });
      return;
    }

    const { to, text, options, footer } = (req.body || {}) as {
      to?: string;
      text?: string;
      options?: unknown;
      footer?: string;
    };

    if (!to) {
      res.status(400).json({ error: 'parâmetro to é obrigatório' });
      return;
    }

    const normalized = normalizeToE164BR(to);
    if (!normalized) {
      res.status(400).json({ error: 'to inválido. Use E.164: 55DDDNUMERO' });
      return;
    }

    const messageText = typeof text === 'string' ? text.trim() : '';
    if (!messageText) {
      res.status(400).json({ error: 'text inválido' });
      return;
    }

    const rawOptions = Array.isArray(options) ? options : [];
    const sanitizedButtons: { id: string; title: string }[] = [];
    const seenIds = new Set<string>();

    for (const option of rawOptions) {
      if (!option || typeof option !== 'object') continue;
      const idRaw = (option as any).id ?? (option as any).buttonId;
      const titleRaw =
        (option as any).title ??
        (option as any).text ??
        (option as any).label ??
        (option as any)?.buttonText?.displayText;
      const id = typeof idRaw === 'string' ? idRaw.trim() : '';
      const title = typeof titleRaw === 'string' ? titleRaw.trim() : '';
      if (!id || !title || seenIds.has(id)) continue;
      seenIds.add(id);
      sanitizedButtons.push({ id, title });
      if (sanitizedButtons.length >= 3) break;
    }

    if (!sanitizedButtons.length) {
      res.status(400).json({ error: 'options inválidas (mínimo 1 botão com id e title)' });
      return;
    }

    const footerText = typeof footer === 'string' ? footer.trim() : '';
    const sanitizedFooter = footerText ? footerText : undefined;

    const check = await inst.sock.onWhatsApp(normalized);
    const entry = Array.isArray(check) ? check[0] : null;
    if (!entry || !entry.exists) {
      res.status(404).json({ error: 'whatsapp_not_found' });
      return;
    }

    const targetJid = entry?.jid ?? `${normalized}@s.whatsapp.net`;
    const timeoutMs = getSendTimeoutMs();

    let sent: any;
    if (inst.context?.messageService) {
      sent = await inst.context.messageService.sendButtons(
        targetJid,
        { text: messageText, footer: sanitizedFooter, buttons: sanitizedButtons },
        { timeoutMs },
      );
    } else {
      const templateButtons = sanitizedButtons.map((button, index) => ({
        index: index + 1,
        quickReplyButton: { id: button.id, displayText: button.title },
      }));
      const content = {
        text: messageText,
        footer: sanitizedFooter,
        templateButtons,
      } as unknown as SocketMessageContent;
      sent = (await sendWithTimeout(inst, targetJid, content)) as any;
    }

    const messageId = sent?.key?.id ?? null;

    inst.metrics.sent += 1;
    inst.metrics.sent_by_type.buttons += 1;
    inst.metrics.last.sentId = messageId;

    res.json({ id: messageId, messageId, status: sent?.status ?? null });
  }),
);

router.post(
  '/:iid/send-list',
  asyncHandler(async (req, res) => {
    const inst = getInstance(req.params.iid);
    if (!ensureInstanceOnline(inst, res)) return;
    if (!allowSend(inst)) {
      res.status(429).json({ error: 'rate limit exceeded' });
      return;
    }

    const { to, text, buttonText, sections, footer, title } = (req.body || {}) as {
      to?: string;
      text?: string;
      buttonText?: string;
      sections?: unknown;
      footer?: string;
      title?: string;
    };

    if (!to) {
      res.status(400).json({ error: 'parâmetro to é obrigatório' });
      return;
    }

    const normalized = normalizeToE164BR(to);
    if (!normalized) {
      res.status(400).json({ error: 'to inválido. Use E.164: 55DDDNUMERO' });
      return;
    }

    const messageText = typeof text === 'string' ? text.trim() : '';
    if (!messageText) {
      res.status(400).json({ error: 'text inválido' });
      return;
    }

    const buttonLabel = typeof buttonText === 'string' ? buttonText.trim() : '';
    if (!buttonLabel) {
      res.status(400).json({ error: 'buttonText inválido' });
      return;
    }

    const rawSections = Array.isArray(sections) ? sections : [];
    const sanitizedSections: { title?: string; options: { id: string; title: string; description?: string }[] }[] = [];
    const seenIds = new Set<string>();

    for (const section of rawSections) {
      if (!section || typeof section !== 'object') continue;

      const sectionTitleRaw =
        (section as any).title ??
        (section as any).header ??
        (section as any)?.titleText ??
        (section as any)?.sectionTitle;
      const sectionTitle = typeof sectionTitleRaw === 'string' ? sectionTitleRaw.trim() : '';

      const rowsRaw = Array.isArray((section as any).options)
        ? (section as any).options
        : Array.isArray((section as any).rows)
        ? (section as any).rows
        : [];

      const sectionOptions: { id: string; title: string; description?: string }[] = [];

      for (const row of rowsRaw) {
        if (!row || typeof row !== 'object') continue;

        const idRaw = (row as any).id ?? (row as any).rowId;
        const titleRaw =
          (row as any).title ?? (row as any).text ?? (row as any).name ?? (row as any)?.displayText;
        const descriptionRaw =
          (row as any).description ?? (row as any).subtitle ?? (row as any)?.body ?? '';

        const id = typeof idRaw === 'string' ? idRaw.trim() : '';
        const titleValue = typeof titleRaw === 'string' ? titleRaw.trim() : '';
        const description = typeof descriptionRaw === 'string' ? descriptionRaw.trim() : '';

        if (!id || !titleValue || seenIds.has(id)) continue;
        seenIds.add(id);

        const option: { id: string; title: string; description?: string } = { id, title: titleValue };
        if (description) {
          option.description = description;
        }

        sectionOptions.push(option);
      }

      if (sectionOptions.length) {
        const normalizedSection: { title?: string; options: { id: string; title: string; description?: string }[] } = {
          options: sectionOptions,
        };
        if (sectionTitle) {
          normalizedSection.title = sectionTitle;
        }
        sanitizedSections.push(normalizedSection);
      }
    }

    if (!sanitizedSections.length) {
      res.status(400).json({ error: 'sections inválidas (mínimo 1 opção com id e title)' });
      return;
    }

    const footerText = typeof footer === 'string' ? footer.trim() : '';
    const sanitizedFooter = footerText ? footerText : undefined;
    const titleText = typeof title === 'string' ? title.trim() : '';
    const sanitizedTitle = titleText ? titleText : undefined;

    const check = await inst.sock.onWhatsApp(normalized);
    const entry = Array.isArray(check) ? check[0] : null;
    if (!entry || !entry.exists) {
      res.status(404).json({ error: 'whatsapp_not_found' });
      return;
    }

    const targetJid = entry?.jid ?? `${normalized}@s.whatsapp.net`;
    const timeoutMs = getSendTimeoutMs();

    let sent: any;
    if (inst.context?.messageService) {
      sent = await inst.context.messageService.sendList(
        targetJid,
        {
          text: messageText,
          buttonText: buttonLabel,
          title: sanitizedTitle,
          footer: sanitizedFooter,
          sections: sanitizedSections,
        },
        { timeoutMs },
      );
    } else {
      const sectionsPayload = sanitizedSections.map((section) => ({
        title: section.title,
        rows: section.options.map((option) => ({
          rowId: option.id,
          title: option.title,
          description: option.description,
        })),
      }));

      const content = {
        text: messageText,
        footer: sanitizedFooter,
        list: {
          title: sanitizedTitle,
          buttonText: buttonLabel,
          description: messageText,
          footer: sanitizedFooter,
          sections: sectionsPayload,
        },
      } as unknown as SocketMessageContent;

      sent = (await sendWithTimeout(inst, targetJid, content)) as any;
    }

    const messageId = sent?.key?.id ?? null;

    inst.metrics.sent += 1;
    inst.metrics.sent_by_type.lists += 1;
    inst.metrics.last.sentId = messageId;

    res.json({ id: messageId, messageId, status: sent?.status ?? null });
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
    if (!ensureInstanceOnline(inst, res)) return;
    if (!allowSend(inst)) {
      res.status(429).json({ error: 'rate limit exceeded' });
      return;
    }

    const body = (req.body || {}) as {
      type?: string;
      to?: string;
      media?: Record<string, unknown>;
      caption?: string;
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

    res.status(201).json({
      id: sent.key?.id ?? null,
      status: sent.status ?? null,
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
    if (!ensureInstanceOnline(inst, res)) return;
    if (!allowSend(inst)) {
      res.status(429).json({ error: 'rate limit exceeded' });
      return;
    }

    const { to, question, options, selectableCount } = (req.body || {}) as {
      to?: string;
      question?: string;
      options?: unknown;
      selectableCount?: number;
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

    res.status(201).json({ id: sent.key?.id ?? null, status: sent.status });
  }),
);

function serializeInstance(inst: Instance) {
  const connected = inst.connectionState === 'open';
  const statusCounts = { ...inst.metrics.status_counts };
  const pending = Number(statusCounts['1']) || 0;
  const serverAck = Number(statusCounts['2']) || 0;
  return {
    id: inst.id,
    name: inst.name,
    connected,
    connectionState: inst.connectionState,
    connectionUpdatedAt: connectionUpdatedAtIso(inst),
    user: connected ? inst.sock?.user ?? null : null,
    qrVersion: inst.qrVersion,
    hasLastQr: Boolean(inst.lastQR),
    hasStoredPhone: Boolean(inst.phoneNumber),
    note: inst.metadata?.note || '',
    metadata: {
      note: inst.metadata?.note || '',
      createdAt: inst.metadata?.createdAt || null,
      updatedAt: inst.metadata?.updatedAt || null,
      revisions: Array.isArray(inst.metadata?.revisions) ? inst.metadata.revisions : [],
    },
    counters: {
      sent: inst.metrics.sent,
      byType: { ...inst.metrics.sent_by_type },
      statusCounts,
      inFlight: pending + serverAck,
    },
    last: { ...inst.metrics.last },
    rate: {
      limit: Number(process.env.RATE_MAX_SENDS || 20),
      windowMs: Number(process.env.RATE_WINDOW_MS || 15_000),
      inWindow: inst.rateWindow.length,
      usage: inst.rateWindow.length / (Number(process.env.RATE_MAX_SENDS || 20) || 1),
    },
    metricsStartedAt: inst.metrics.startedAt,
    revisions: Array.isArray(inst.metadata?.revisions) ? inst.metadata.revisions : [],
  };
}

export default router;
