import { Router, type Request, type Response } from 'express';

import type { RuntimeContext } from '../context';
import { allowSend, normalizeToE164BR, sendWithTimeout, waitForAck } from '../utils';

interface PollRequestBody {
  to?: string;
  question?: string;
  options?: unknown[];
  selectableCount?: number;
  waitAckMs?: number;
}

export function createPollsRouter(ctx: RuntimeContext): Router {
  const router = Router();

  router.post('/', async (
    req: Request<unknown, unknown, PollRequestBody>,
    res: Response,
  ) => {
    const instance = ctx.instance;
    const sock = instance.sock;
    if (!instance || !sock) {
      return res.status(503).json({ error: 'instance_unavailable' });
    }

    if (!allowSend(instance)) {
      return res.status(429).json({ error: 'rate_limit_exceeded' });
    }

    const { to, question, options, selectableCount, waitAckMs } = req.body || {};

    const normalized = normalizeToE164BR(to);
    if (!normalized) {
      return res.status(400).json({ error: 'invalid_recipient' });
    }

    if (typeof question !== 'string' || !question.trim()) {
      return res.status(400).json({ error: 'invalid_question' });
    }

    if (!Array.isArray(options) || options.length < 2) {
      return res.status(400).json({ error: 'invalid_options' });
    }

    const sanitizedOptions = options
      .map((option) => (typeof option === 'string' ? option.trim() : ''))
      .filter(Boolean);
    if (sanitizedOptions.length < 2) {
      return res.status(400).json({ error: 'invalid_options' });
    }

    const selectableRaw = Number(selectableCount);
    const selectable = Number.isFinite(selectableRaw)
      ? Math.max(1, Math.min(Math.floor(selectableRaw), sanitizedOptions.length))
      : 1;

    const check = await sock.onWhatsApp(normalized);
    const entry = Array.isArray(check) ? check[0] : null;
    if (!entry || !entry.exists) {
      return res.status(404).json({ error: 'whatsapp_not_found' });
    }

    const sent = await sendWithTimeout(instance, normalized, {
      poll: {
        name: question.trim(),
        values: sanitizedOptions,
        selectableCount: selectable,
      },
    });

    instance.metrics.sent += 1;
    instance.metrics.sent_by_type.buttons += 1;
    instance.metrics.last.sentId = sent.key.id;
    instance.ackSentAt.set(sent.key.id, Date.now());

    let ackStatus: number | null = null;
    const ackTimeout = Number(waitAckMs);
    if (Number.isFinite(ackTimeout) && ackTimeout > 0) {
      ackStatus = await waitForAck(instance, sent.key.id, ackTimeout);
    }

    res.status(201).json({ id: sent.key.id, status: sent.status, ack: ackStatus });
  });

  return router;
}

export default createPollsRouter;
