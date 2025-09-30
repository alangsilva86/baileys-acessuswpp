import { Router } from 'express';

import type { RuntimeContext } from '../context';
import { env } from '../env';
import { allowSend, normalizeToE164BR, sendWithTimeout, waitForAck } from '../utils';

function serializeInstance(instance: RuntimeContext['instance']) {
  const connected = Boolean(instance.sock && instance.sock.user);
  return {
    id: instance.id,
    name: instance.name,
    connected,
    user: connected ? instance.sock.user : null,
    metadata: instance.metadata,
    counters: {
      sent: instance.metrics.sent,
      byType: { ...instance.metrics.sent_by_type },
      statusCounts: { ...instance.metrics.status_counts },
    },
    last: { ...instance.metrics.last },
    rate: {
      limit: env.rateLimit.max,
      windowMs: env.rateLimit.windowMs,
      inWindow: instance.rateWindow.length,
    },
  };
}

function ensureInstance(ctx: RuntimeContext, id: string) {
  if (id !== ctx.instance.id) {
    return null;
  }
  return ctx.instance;
}

export function createInstancesRouter(ctx: RuntimeContext): Router {
  const router = Router();

  router.get('/', (_req, res) => {
    const summary = serializeInstance(ctx.instance);
    res.json([
      {
        id: summary.id,
        name: summary.name,
        connected: summary.connected,
        user: summary.user,
      },
    ]);
  });

  router.get('/:id', (req, res) => {
    const instance = ensureInstance(ctx, req.params.id);
    if (!instance) {
      return res.status(404).json({ error: 'instance_not_found' });
    }
    res.json(serializeInstance(instance));
  });

  router.get('/:id/qr', (req, res) => {
    const instance = ensureInstance(ctx, req.params.id);
    if (!instance) {
      return res.status(404).json({ error: 'instance_not_found' });
    }
    if (!instance.lastQR) {
      return res.status(404).json({ error: 'qr_not_available' });
    }
    res.json({ id: instance.id, qr: instance.lastQR });
  });

  router.get('/:id/status', (req, res) => {
    const instance = ensureInstance(ctx, req.params.id);
    if (!instance) {
      return res.status(404).json({ error: 'instance_not_found' });
    }
    const messageId = String(req.query.id || '').trim();
    if (!messageId) {
      return res.status(400).json({ error: 'id_required' });
    }
    const status = instance.statusMap.get(messageId) ?? null;
    res.json({ id: messageId, status });
  });

  router.post('/:id/exists', async (req, res) => {
    const instance = ensureInstance(ctx, req.params.id);
    if (!instance || !instance.sock) {
      return res.status(503).json({ error: 'instance_unavailable' });
    }
    const normalized = normalizeToE164BR(req.body?.to);
    if (!normalized) {
      return res.status(400).json({ error: 'invalid_recipient' });
    }
    const results = await instance.sock.onWhatsApp(normalized);
    res.json({ results });
  });

  router.post('/:id/send-text', async (req, res) => {
    const instance = ensureInstance(ctx, req.params.id);
    if (!instance || !instance.sock) {
      return res.status(503).json({ error: 'instance_unavailable' });
    }
    if (!allowSend(instance)) {
      return res.status(429).json({ error: 'rate_limit_exceeded' });
    }

    const { to, message, waitAckMs } = req.body || {};
    if (!to || !message) {
      return res.status(400).json({ error: 'missing_to_or_message' });
    }

    const normalized = normalizeToE164BR(to);
    if (!normalized) {
      return res.status(400).json({ error: 'invalid_recipient' });
    }

    const check = await instance.sock.onWhatsApp(normalized);
    const entry = Array.isArray(check) ? check[0] : null;
    if (!entry || !entry.exists) {
      return res.status(404).json({ error: 'whatsapp_not_found' });
    }

    const sent = await sendWithTimeout(instance, normalized, { text: message });
    instance.metrics.sent += 1;
    instance.metrics.sent_by_type.text += 1;
    instance.metrics.last.sentId = sent.key.id;
    instance.ackSentAt.set(sent.key.id, Date.now());

    let ackStatus: number | null = null;
    if (waitAckMs) {
      ackStatus = await waitForAck(instance, sent.key.id, waitAckMs);
    }

    res.json({ id: sent.key.id, status: sent.status, ack: ackStatus });
  });

  return router;
}

export default createInstancesRouter;
