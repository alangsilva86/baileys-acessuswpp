const fs = require("fs/promises");
const path = require("path");
const pino = require("pino");
const {
  default: makeWASocket,
  useMultiFileAuthState,
  fetchLatestBaileysVersion,
  DisconnectReason,
} = require("@whiskeysockets/baileys");
const { recordMetricsSnapshot, buildSignature } = require("./utils");

const logger = pino({ level: process.env.LOG_LEVEL || "info" });

const RECONNECT_MIN_DELAY_MS = 1_000;
const RECONNECT_MAX_DELAY_MS = 30_000;
const WEBHOOK_URL = process.env.WEBHOOK_URL || "";
const API_KEYS = String(process.env.API_KEY || "change-me")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);
const SESSION_ROOT = process.env.SESSION_DIR || "./sessions";
const INSTANCE_ID = process.env.INSTANCE_ID || "default";
const INSTANCE_NAME = process.env.INSTANCE_NAME || INSTANCE_ID;

function createMetrics() {
  return {
    startedAt: Date.now(),
    sent: 0,
    sent_by_type: { text: 0, image: 0, group: 0, buttons: 0, lists: 0 },
    status_counts: { "1": 0, "2": 0, "3": 0, "4": 0, "5": 0 },
    last: { sentId: null, lastStatusId: null, lastStatusCode: null },
    ack: { totalMs: 0, count: 0, avgMs: 0, lastMs: null },
    timeline: [],
  };
}

async function bootBaileys() {
  const dir = path.join(SESSION_ROOT, INSTANCE_ID);
  await fs.mkdir(dir, { recursive: true });

  const ctx = {
    id: INSTANCE_ID,
    name: INSTANCE_NAME,
    dir,
    ready: false,
    userId: null,
    user: null,
    sock: null,
    lastQR: null,
    reconnectDelay: RECONNECT_MIN_DELAY_MS,
    reconnectTimer: null,
    stopping: false,
    metadata: {
      note: "",
      createdAt: null,
      updatedAt: null,
    },
    metrics: createMetrics(),
    statusMap: new Map(),
    ackWaiters: new Map(),
    rateWindow: [],
    ackSentAt: new Map(),
  };

  await startSocket(ctx);
  return ctx;
}

async function startSocket(ctx) {
  const { state, saveCreds } = await useMultiFileAuthState(ctx.dir);
  const { version } = await fetchLatestBaileysVersion();
  logger.info({ iid: ctx.id, version }, "baileys.version");

  const sock = makeWASocket({ version, auth: state, logger });
  ctx.sock = sock;
  ctx.ready = false;
  ctx.userId = null;
  ctx.user = null;

  sock.ev.on("creds.update", saveCreds);

  sock.ev.on("connection.update", (update) => {
    const { connection, lastDisconnect, qr, receivedPendingNotifications } = update;
    const iid = ctx.id;

    if (qr) {
      ctx.lastQR = qr;
      logger.info({ iid }, "qr.updated");
    }
    if (connection === "open") {
      ctx.lastQR = null;
      ctx.reconnectDelay = RECONNECT_MIN_DELAY_MS;
      ctx.ready = true;
      ctx.userId = sock.user?.id || null;
      ctx.user = sock.user || null;
      logger.info(
        { iid, receivedPendingNotifications, user: ctx.userId },
        "whatsapp.connected"
      );
    }
    if (connection === "close") {
      const statusCode = lastDisconnect?.error?.output?.statusCode;
      const isLoggedOut = statusCode === DisconnectReason.loggedOut;
      ctx.ready = false;
      ctx.userId = null;
      ctx.user = null;
      logger.warn({ iid, statusCode }, "whatsapp.disconnected");

      if (ctx.reconnectTimer) {
        try {
          clearTimeout(ctx.reconnectTimer);
        } catch {}
        ctx.reconnectTimer = null;
      }

      if (!ctx.stopping && !isLoggedOut) {
        const delay = Math.min(ctx.reconnectDelay, RECONNECT_MAX_DELAY_MS);
        logger.warn({ iid, delay }, "whatsapp.reconnect.scheduled");
        const currentSock = sock;
        ctx.reconnectTimer = setTimeout(() => {
          if (ctx.sock !== currentSock) return;
          ctx.reconnectDelay = Math.min(
            ctx.reconnectDelay * 2,
            RECONNECT_MAX_DELAY_MS
          );
          startSocket(ctx).catch((err) =>
            logger.error({ iid, err }, "whatsapp.reconnect.failed")
          );
        }, delay);
      } else if (isLoggedOut) {
        logger.error({ iid }, "session.loggedOut");
      }
    }
  });

  sock.ev.on("messages.upsert", async (evt) => {
    const count = evt.messages?.length || 0;
    const iid = ctx.id;
    logger.info({ iid, type: evt.type, count }, "messages.upsert");

    if (count) {
      for (const m of evt.messages) {
        const from = m.key?.remoteJid;

        const btn =
          m.message?.templateButtonReplyMessage ||
          m.message?.buttonsResponseMessage;
        if (btn) {
          logger.info(
            {
              iid,
              from,
              selectedId: btn?.selectedId || btn?.selectedButtonId,
              selectedText: btn?.selectedDisplayText,
            },
            "button.reply"
          );
        }

        const list = m.message?.listResponseMessage;
        if (list) {
          logger.info(
            {
              iid,
              from,
              selectedId: list?.singleSelectReply?.selectedRowId,
              selectedTitle: list?.title,
            },
            "list.reply"
          );
        }
      }
    }

    if (WEBHOOK_URL && count) {
      try {
        const body = JSON.stringify({ iid, ...evt });
        const sig = buildSignature(body, API_KEYS[0] || "change-me");
        await fetch(WEBHOOK_URL, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Signature-256": sig,
          },
          body,
        }).catch(() => {});
      } catch (e) {
        logger.warn({ iid, err: e?.message }, "webhook.relay.error");
      }
    }
  });

  sock.ev.on("messages.update", (updates) => {
    const iid = ctx.id;
    for (const u of updates) {
      const mid = u.key?.id;
      const st = u.update?.status;
      if (mid && st != null) {
        ctx.statusMap.set(mid, st);
        ctx.metrics.status_counts[String(st)] =
          (ctx.metrics.status_counts[String(st)] || 0) + 1;
        ctx.metrics.last.lastStatusId = mid;
        ctx.metrics.last.lastStatusCode = st;

        if (st >= 2 && ctx.ackSentAt?.has(mid)) {
          const sentAt = ctx.ackSentAt.get(mid);
          ctx.ackSentAt.delete(mid);
          if (sentAt) {
            const delta = Math.max(0, Date.now() - sentAt);
            ctx.metrics.ack.totalMs += delta;
            ctx.metrics.ack.count += 1;
            ctx.metrics.ack.lastMs = delta;
            ctx.metrics.ack.avgMs = Math.round(
              ctx.metrics.ack.totalMs / ctx.metrics.ack.count
            );
          }
        }

        recordMetricsSnapshot(ctx);

        const waiter = ctx.ackWaiters.get(mid);
        if (waiter) {
          clearTimeout(waiter.timer);
          ctx.ackWaiters.delete(mid);
          waiter.resolve(st);
        }
      }
      logger.info({ iid, mid, status: st }, "messages.status");
    }
  });

  recordMetricsSnapshot(ctx, true);
  return ctx;
}

module.exports = { bootBaileys };
