const express = require("express");
const crypto = require("crypto");
const fs = require("fs/promises");
const QRCode = require("qrcode");
const {
  createInstance,
  deleteInstance,
  getInstance,
  getAllInstances,
  saveInstancesIndex,
} = require("../instanceManager");
const {
  allowSend,
  waitForAck,
  normalizeToE164BR,
} = require("../utils");

const router = express.Router();

const asyncHandler = (fn) => (req, res, next) =>
  Promise.resolve(fn(req, res, next)).catch(next);

// ---------------------- Auth & Utils --------------------------
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
function isAuthorized(req) {
  const key = req.header("x-api-key") || "";
  return API_KEYS.some((k) => safeEquals(k, key));
}
function auth(req, res, next) {
  if (!isAuthorized(req)) return res.status(401).json({ error: "unauthorized" });
  next();
}

router.use(auth);

router.post(
  "/",
  asyncHandler(async (req, res) => {
    const name = String(req.body?.name || "").trim() || null;
    const noteRaw =
      typeof req.body?.note === "string"
        ? req.body.note.trim()
        : typeof req.body?.notes === "string"
        ? req.body.notes.trim()
        : "";
    const note = noteRaw ? noteRaw.slice(0, 280) : "";

    const iid =
      (name ? name.toLowerCase().replace(/[^\w]+/g, "-") : crypto.randomUUID());
    if (getInstance(iid))
      return res.status(409).json({ error: "instance_exists" });

    const inst = await createInstance(iid, name || iid, { note });
    res.json({ id: inst.id, name: inst.name, dir: inst.dir, metadata: inst.metadata });
  })
);

router.get("/", (req, res) => {
  const list = getAllInstances().map((inst) => {
    const s = serializeInstance(inst);
    return {
      id: s.id,
      name: s.name,
      note: s.note, // compat
      notes: s.note, // compat
      metadata: s.metadata,
      connected: s.connected,
      user: s.user,
      counters: { sent: s.counters.sent, status: s.counters.statusCounts },
      rate: s.rate,
    };
  });
  res.json(list);
});

router.get("/:iid", (req, res) => {
  const inst = getInstance(req.params.iid);
  if (!inst) return res.status(404).json({ error: "instance_not_found" });
  const s = serializeInstance(inst);
  res.json({ ...s, notes: s.note }); // compat
});

router.patch(
  "/:iid",
  asyncHandler(async (req, res) => {
    const inst = getInstance(req.params.iid);
    if (!inst) return res.status(404).json({ error: "instance_not_found" });

    const body = req.body || {};
    let touched = false;

    if (Object.prototype.hasOwnProperty.call(body, "name")) {
      if (typeof body.name !== "string")
        return res.status(400).json({ error: "name_invalid" });
      const nextName = body.name.trim();
      if (!nextName) return res.status(400).json({ error: "name_empty" });
      inst.name = nextName.slice(0, 80);
      touched = true;
    }
    const patchNote =
      Object.prototype.hasOwnProperty.call(body, "note")
        ? body.note
        : Object.prototype.hasOwnProperty.call(body, "notes")
        ? body.notes
        : undefined;
    if (patchNote !== undefined) {
      if (typeof patchNote !== "string")
        return res.status(400).json({ error: "note_invalid" });
      inst.metadata = inst.metadata || {};
      inst.metadata.note = String(patchNote).trim().slice(0, 280);
      touched = true;
    }
    if (!touched) return res.status(400).json({ error: "no_updates" });

    inst.metadata.updatedAt = new Date().toISOString();
    await saveInstancesIndex();
    res.json(serializeInstance(inst));
  })
);

router.delete(
  "/:iid",
  asyncHandler(async (req, res) => {
    const iid = req.params.iid;
    if (iid === "default")
      return res
        .status(400)
        .json({ error: "default_instance_cannot_be_deleted" });
    const inst = getInstance(iid);
    if (!inst) return res.status(404).json({ error: "instance_not_found" });

    await deleteInstance(iid, { removeDir: true, logout: true });
    res.json({ ok: true, message: "Instância removida permanentemente." });
  })
);

router.get(
  "/:iid/qr.png",
  asyncHandler(async (req, res) => {
    const i = getInstance(req.params.iid);
    if (!i) return res.status(404).send("instance_not_found");
    if (!i.lastQR) return res.status(404).send("no-qr");
    const png = await QRCode.toBuffer(i.lastQR, {
      type: "png",
      margin: 1,
      scale: 6,
    });
    res.type("png").send(png);
  })
);

router.post(
  "/:iid/pair",
  asyncHandler(async (req, res) => {
    const i = getInstance(req.params.iid);
    if (!i || !i.sock) return res.status(503).json({ error: "socket indisponível" });
    const phoneNumberRaw = req.body?.phoneNumber;
    if (!phoneNumberRaw)
      return res.status(400).json({ error: "phoneNumber obrigatório (ex: 5544...)" });
    const code = await i.sock.requestPairingCode(String(phoneNumberRaw));
    res.json({ pairingCode: code });
  })
);

router.post(
  "/:iid/logout",
  asyncHandler(async (req, res) => {
    const i = getInstance(req.params.iid);
    if (!i || !i.sock) return res.status(503).json({ error: "socket indisponível" });
    try {
      await i.sock.logout();
      res.json({ ok: true, message: "Sessão desconectada. Um novo QR aparecerá em breve." });
    } catch (e) {
      res.status(500).json({ error: "falha ao desconectar", detail: e.message });
    }
  })
);

router.post(
  "/:iid/session/wipe",
  asyncHandler(async (req, res) => {
    const i = getInstance(req.params.iid);
    if (!i) return res.status(404).json({ error: "instance_not_found" });

    try {
      i.stopping = true;
      if (i.sock) {
        try {
          await i.sock.logout().catch(() => {});
        } catch {}
        try {
          i.sock.end?.();
        } catch {}
      }
    } catch {}

    try {
      const stamp = new Date().toISOString().replace(/[:.]/g, "-");
      const bak = `${i.dir}.bak-${stamp}`;
      await fs.rename(i.dir, bak).catch(() => {});
      await fs.mkdir(i.dir, { recursive: true }).catch(() => {});

      res.json({ ok: true, message: "Sessão isolada. Reiniciando para gerar novo QR." });

      setTimeout(() => process.exit(0), 200);
      setTimeout(async () => {
        try {
          await fs.rm(bak, { recursive: true, force: true });
        } catch {}
      }, 1000);
    } catch (e) {
      try {
        await fs.rm(i.dir, { recursive: true, force: true });
        await fs.mkdir(i.dir, { recursive: true });
        res.json({ ok: true, message: "Sessão limpa. Reiniciando para gerar novo QR." });
        setTimeout(() => process.exit(0), 200);
      } catch (err) {
        res.status(500).json({ error: "falha ao limpar sessão", detail: err?.message || String(err) });
      }
    }
  })
);

router.get("/:iid/status", (req, res) => {
  const i = getInstance(req.params.iid);
  if (!i) return res.status(404).json({ error: "instance_not_found" });
  const id = String(req.query.id || "");
  if (!id) return res.status(400).json({ error: "id obrigatório" });
  const status = i.statusMap.get(id) ?? null;
  res.json({ id, status });
});

router.get(
  "/:iid/groups",
  asyncHandler(async (req, res) => {
    const i = getInstance(req.params.iid);
    if (!i || !i.sock) return res.status(503).json({ error: "socket indisponível" });
    const all = await i.sock.groupFetchAllParticipating();
    const list = Object.values(all).map((g) => ({ id: g.id, subject: g.subject }));
    res.json(list);
  })
);

router.get("/:iid/metrics", (req, res) => {
  const inst = getInstance(req.params.iid);
  if (!inst) return res.status(404).json({ error: "instance_not_found" });

  const summary = serializeInstance(inst);
  const { metricsStartedAt, ...rest } = summary;
  const timeline = (inst.metrics.timeline || []).map((entry) => {
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
      avgMs: inst.metrics.ack?.avgMs || 0,
      lastMs: inst.metrics.ack?.lastMs || null,
      samples: inst.metrics.ack?.count || 0,
    },
    sessionDir: inst.dir,
  });
});

router.post(
  "/:iid/exists",
  asyncHandler(async (req, res) => {
    const i = getInstance(req.params.iid);
    if (!i || !i.sock) return res.status(503).json({ error: "socket indisponível" });
    const normalized = normalizeToE164BR(req.body?.to);
    if (!normalized)
      return res.status(400).json({ error: "to inválido. Use E.164: 55DDDNUMERO" });
    const results = await i.sock.onWhatsApp(normalized);
    res.json({ results });
  })
);

// --- Envio por instância
router.post(
  "/:iid/send-text",
  asyncHandler(async (req, res) => {
    const i = getInstance(req.params.iid);
    if (!i || !i.sock) return res.status(503).json({ error: "socket indisponível" });
    if (!allowSend(i)) return res.status(429).json({ error: "rate limit exceeded" });

    const { to, message, waitAckMs } = req.body || {};
    if (!to || !message)
      return res.status(400).json({ error: "parâmetros to e message são obrigatórios" });

    const normalized = normalizeToE164BR(to);
    if (!normalized)
      return res.status(400).json({ error: "to inválido. Use E.164: 55DDDNUMERO" });

    const check = await i.sock.onWhatsApp(normalized);
    const entry = Array.isArray(check) ? check[0] : null;
    if (!entry || !entry.exists)
      return res.status(404).json({ error: "whatsapp_not_found" });

    const messageService = i.context?.messageService;
    if (!messageService)
      return res.status(503).json({ error: "message_service_unavailable" });

    const sent = await messageService.sendText(normalized, message, {
      timeoutMs: Number(process.env.SEND_TIMEOUT_MS || 25_000),
    });
    i.metrics.sent += 1;
    i.metrics.sent_by_type.text += 1;
    i.metrics.last.sentId = sent.key.id;
    i.ackSentAt.set(sent.key.id, Date.now());

    let ackStatus = null;
    if (waitAckMs) {
      ackStatus = await waitForAck(i, sent.key.id, waitAckMs);
    }

    res.json({ id: sent.key.id, status: sent.status, ack: ackStatus });
  })
);

function serializeInstance(inst) {
  if (!inst) return null;
  const connected = !!(inst.sock && inst.sock.user);
  return {
    id: inst.id,
    name: inst.name,
    connected,
    user: connected ? inst.sock.user : null,
    note: inst.metadata?.note || "",
    metadata: {
      note: inst.metadata?.note || "",
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

module.exports = router;

