import { Router, type NextFunction, type Request, type Response } from 'express';
import crypto from 'node:crypto';
import {
  BROKER_INSTANCE_ID,
  ensureInstance,
  ensureInstanceStarted,
  getInstance,
  removeInstance,
} from '../instanceManager.js';
import { brokerEventStore } from '../broker/eventStore.js';
import {
  allowSend,
  getSendTimeoutMs,
  normalizeToE164BR,
  sendWithTimeout,
  waitForAck,
} from '../utils.js';

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

function resolveInstanceId(req: Request): string {
  const bodyId = typeof (req.body as any)?.instanceId === 'string' ? (req.body as any).instanceId : null;
  const queryId = typeof req.query.instanceId === 'string' ? req.query.instanceId : null;
  return bodyId || queryId || BROKER_INSTANCE_ID;
}

router.get(
  '/events',
  asyncHandler(async (req, res) => {
    const events = brokerEventStore.list({
      limit: req.query.limit ? Number(req.query.limit) : undefined,
      after: typeof req.query.after === 'string' ? req.query.after : undefined,
      instanceId: typeof req.query.instanceId === 'string' ? req.query.instanceId : undefined,
      type: typeof req.query.type === 'string' ? req.query.type : undefined,
      direction:
        req.query.direction === 'inbound' || req.query.direction === 'outbound' || req.query.direction === 'system'
          ? req.query.direction
          : undefined,
    });

    res.json({ events, nextCursor: events.length ? events[events.length - 1].id : null });
  }),
);

router.post(
  '/events/ack',
  asyncHandler(async (req, res) => {
    const ids = Array.isArray((req.body as any)?.ids)
      ? ((req.body as any).ids as unknown[]).map((id) => String(id)).filter(Boolean)
      : [];
    if (!ids.length) {
      res.status(400).json({ error: 'ids_required' });
      return;
    }
    const result = brokerEventStore.ack(ids);
    res.json(result);
  }),
);

router.post(
  '/messages',
  asyncHandler(async (req, res) => {
    const body = (req.body || {}) as {
      instanceId?: string;
      to?: string;
      text?: string;
      waitAckMs?: number;
      timeoutMs?: number;
      skipNormalize?: boolean;
    };

    const instanceId = body.instanceId || resolveInstanceId(req);
    const inst = await ensureInstanceStarted(instanceId, { name: instanceId });
    if (!inst.sock) {
      res.status(503).json({ error: 'socket_unavailable' });
      return;
    }

    if (!allowSend(inst)) {
      res.status(429).json({ error: 'rate_limit_exceeded' });
      return;
    }

    const rawTo = body.to || '';
    const normalized = body.skipNormalize ? rawTo : normalizeToE164BR(rawTo);
    if (!normalized) {
      res.status(400).json({ error: 'invalid_destination' });
      return;
    }

    const text = typeof body.text === 'string' ? body.text.trim() : '';
    if (!text) {
      res.status(400).json({ error: 'text_required' });
      return;
    }

    if (!inst.sock.onWhatsApp) {
      res.status(503).json({ error: 'socket_capability_unavailable' });
      return;
    }

    const check = await inst.sock.onWhatsApp(normalized);
    const entry = Array.isArray(check) ? check[0] : null;
    if (!entry || !entry.exists) {
      res.status(404).json({ error: 'whatsapp_not_found' });
      return;
    }

    const timeoutMs = Number.isFinite(body.timeoutMs) && Number(body.timeoutMs) > 0 ? Number(body.timeoutMs) : getSendTimeoutMs();

    const message = inst.context?.messageService
      ? await inst.context.messageService.sendText(normalized, text, { timeoutMs })
      : ((await sendWithTimeout(inst, normalized, { text })) as any);

    inst.metrics.sent += 1;
    inst.metrics.sent_by_type.text += 1;
    inst.metrics.last.sentId = message.key?.id ?? null;
    if (message.key?.id) {
      inst.ackSentAt.set(message.key.id, Date.now());
    }

    let ackStatus: number | null = null;
    if (body.waitAckMs && message.key?.id) {
      ackStatus = await waitForAck(inst, message.key.id, body.waitAckMs);
    }

    res.status(201).json({
      id: message.key?.id ?? null,
      ack: ackStatus,
      timestamp: message.messageTimestamp ?? null,
    });
  }),
);

router.post(
  '/session/connect',
  asyncHandler(async (req, res) => {
    const body = (req.body || {}) as { instanceId?: string; name?: string };
    const instanceId = body.instanceId || resolveInstanceId(req);
    const name = typeof body.name === 'string' && body.name.trim() ? body.name.trim() : instanceId;

    const inst = await ensureInstanceStarted(instanceId, { name });

    res.json({
      id: inst.id,
      name: inst.name,
      connected: Boolean(inst.sock?.user),
      user: inst.sock?.user ?? null,
      qr: inst.lastQR ?? null,
    });
  }),
);

router.post(
  '/session/logout',
  asyncHandler(async (req, res) => {
    const body = (req.body || {}) as { instanceId?: string; wipe?: boolean };
    const instanceId = body.instanceId || resolveInstanceId(req);
    const inst = getInstance(instanceId);
    if (!inst) {
      res.status(404).json({ error: 'instance_not_found' });
      return;
    }

    await removeInstance(instanceId, { logout: true, removeDir: Boolean(body.wipe) });

    if (body.wipe) {
      res.json({ id: instanceId, removed: true });
    } else {
      await ensureInstance(instanceId, { name: inst.name });
      res.json({ id: instanceId, removed: false });
    }
  }),
);

router.get(
  '/session/status',
  asyncHandler(async (req, res) => {
    const instanceId = resolveInstanceId(req);
    const inst = getInstance(instanceId);
    if (!inst) {
      res.status(404).json({ error: 'instance_not_found' });
      return;
    }

    res.json({
      id: inst.id,
      name: inst.name,
      connected: Boolean(inst.sock?.user),
      user: inst.sock?.user ?? null,
      qr: inst.lastQR ?? null,
      metrics: {
        sent: inst.metrics.sent,
        rateWindow: inst.rateWindow.length,
      },
    });
  }),
);

export default router;
