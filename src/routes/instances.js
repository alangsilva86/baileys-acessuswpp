const express = require("express");
const crypto = require("crypto");
const QRCode = require("qrcode");
const {
  allowSend,
  sendWithTimeout,
  waitForAck,
  normalizeToE164BR,
} = require("../utils");

const asyncHandler = (fn) => (req, res, next) =>
  Promise.resolve(fn(req, res, next)).catch(next);

const API_KEYS = String(process.env.API_KEY || "change-me")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

function safeEquals(a, b) {
  const A = Buffer.from(String(a));
  const B = Buffer.from(String(b));
  if (A.length !== B.length) return false;
  return crypto.timingSafeEqual(A, B);
}

function createRouter(ctx) {
  const router = express.Router();

  function isAuthorized(req) {
    const key = req.header("x-api-key") || "";
    return API_KEYS.some((k) => safeEquals(k, key));
  }

  function auth(req, res, next) {
    if (!isAuthorized(req))
      return res.status(401).json({ error: "unauthorized" });
    next();
  }

  function ensureInstance(req, res) {
    const requested = req.params.iid || req.header("x-instance-id") || ctx.id;
    if (requested && requested !== ctx.id) {
      res.status(404).json({ error: "instance_not_found" });
      return null;
    }
    return ctx;
  }

  router.use(auth);

  const listHandler = (req, res) => {
    res.json([serializeInstance(ctx)]);
  };

  router.get("/", listHandler);

  const singleHandler = (req, res) => {
    if (!ensureInstance(req, res)) return;
    res.json(serializeInstance(ctx));
  };

  router.get("/:iid", singleHandler);

  const qrHandler = asyncHandler(async (req, res) => {
    if (!ensureInstance(req, res)) return;
    if (!ctx.lastQR) return res.status(404).send("no-qr");
    const png = await QRCode.toBuffer(ctx.lastQR, {
      type: "png",
      margin: 1,
      scale: 6,
    });
    res.type("png").send(png);
  });

  router.get("/:iid/qr.png", qrHandler);
  router.get("/qr.png", qrHandler);

  const metricsHandler = (req, res) => {
    if (!ensureInstance(req, res)) return;

      const summary = serializeInstance(ctx);
      const { metricsStartedAt, ...rest } = summary;
      const timeline = (ctx.metrics.timeline || []).map((entry) => {
        const hasNewStatusFields =
          Object.prototype.hasOwnProperty.call(entry, "serverAck") ||
          Object.prototype.hasOwnProperty.call(entry, "pending") ||
          Object.prototype.hasOwnProperty.call(entry, "read") ||
          Object.prototype.hasOwnProperty.call(entry, "played");

        const serverAck =
          entry.serverAck ?? (hasNewStatusFields ? 0 : entry.delivered ?? 0);

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
        service: process.env.SERVICE_NAME || "baileys-api",
        ...rest,
        startedAt: metricsStartedAt,
        timeline,
        ack: {
          avgMs: ctx.metrics.ack?.avgMs || 0,
          lastMs: ctx.metrics.ack?.lastMs || null,
          samples: ctx.metrics.ack?.count || 0,
        },
        sessionDir: ctx.dir,
      });
    }
  };

  router.get("/:iid/metrics", metricsHandler);
  router.get("/metrics", metricsHandler);

  const statusHandler = (req, res) => {
    if (!ensureInstance(req, res)) return;
    const id = String(req.query.id || "");
    if (!id) return res.status(400).json({ error: "id obrigatório" });
    const status = ctx.statusMap.get(id) ?? null;
    res.json({ id, status });
  };

  router.get("/:iid/status", statusHandler);
  router.get("/status", statusHandler);

  const groupsHandler = asyncHandler(async (req, res) => {
    if (!ensureInstance(req, res)) return;
    if (!ctx.sock)
      return res.status(503).json({ error: "socket indisponível" });
    const all = await ctx.sock.groupFetchAllParticipating();
    const list = Object.values(all).map((g) => ({ id: g.id, subject: g.subject }));
    res.json(list);
  });

  router.get("/:iid/groups", groupsHandler);
  router.get("/groups", groupsHandler);

  const existsHandler = asyncHandler(async (req, res) => {
      if (!ensureInstance(req, res)) return;
      if (!ctx.sock)
        return res.status(503).json({ error: "socket indisponível" });
      const normalized = normalizeToE164BR(req.body?.to || req.query?.to);
      if (!normalized)
        return res.status(400).json({ error: "to inválido. Use E.164: 55DDDNUMERO" });
      const results = await ctx.sock.onWhatsApp(normalized);
      res.json({ results });
  });

  router.post("/:iid/exists", existsHandler);
  router.post("/exists", existsHandler);

  const sendTextHandler = asyncHandler(async (req, res) => {
    if (!ensureInstance(req, res)) return;
    if (!ctx.sock)
      return res.status(503).json({ error: "socket indisponível" });
    if (!allowSend(ctx))
      return res.status(429).json({ error: "rate limit exceeded" });

    const { to, message, waitAckMs } = req.body || {};
    if (!to || !message)
      return res
        .status(400)
        .json({ error: "parâmetros to e message são obrigatórios" });

    const normalized = normalizeToE164BR(to);
    if (!normalized)
      return res
        .status(400)
        .json({ error: "to inválido. Use E.164: 55DDDNUMERO" });

    const check = await ctx.sock.onWhatsApp(normalized);
    const entry = Array.isArray(check) ? check[0] : null;
    if (!entry || !entry.exists)
      return res.status(404).json({ error: "whatsapp_not_found" });

    const sent = await sendWithTimeout(ctx, normalized, { text: message });
    ctx.metrics.sent += 1;
    ctx.metrics.sent_by_type.text += 1;
    ctx.metrics.last.sentId = sent.key.id;
    ctx.ackSentAt.set(sent.key.id, Date.now());

    let ackStatus = null;
    if (waitAckMs) {
      ackStatus = await waitForAck(ctx, sent.key.id, waitAckMs);
    }

    res.json({ id: sent.key.id, status: sent.status, ack: ackStatus });
  });

  router.post("/:iid/send-text", sendTextHandler);
  router.post("/send-text", sendTextHandler);

  return router;
}

function serializeInstance(ctx) {
  const connected = !!(ctx.ready && ctx.sock && ctx.sock.user);
  return {
    id: ctx.id,
    name: ctx.name,
    connected,
    user: connected ? ctx.sock.user : null,
    note: ctx.metadata?.note || "",
    metadata: {
      note: ctx.metadata?.note || "",
      createdAt: ctx.metadata?.createdAt || null,
      updatedAt: ctx.metadata?.updatedAt || null,
    },
    counters: {
      sent: ctx.metrics.sent,
      byType: { ...ctx.metrics.sent_by_type },
      statusCounts: { ...ctx.metrics.status_counts },
    },
    last: { ...ctx.metrics.last },
    rate: {
      limit: Number(process.env.RATE_MAX_SENDS || 20),
      windowMs: Number(process.env.RATE_WINDOW_MS || 15_000),
      inWindow: ctx.rateWindow.length,
      usage:
        ctx.rateWindow.length / (Number(process.env.RATE_MAX_SENDS || 20) || 1),
    },
    metricsStartedAt: ctx.metrics.startedAt,
    ready: ctx.ready,
    userId: ctx.userId,
  };
}

module.exports = createRouter;
