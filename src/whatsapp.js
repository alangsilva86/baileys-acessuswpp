const pino = require("pino");
const { DisconnectReason } = require("@whiskeysockets/baileys");
const { recordMetricsSnapshot } = require("./utils");
const { bootBaileys } = require('./baileys/index.ts');

const logger = pino({ level: process.env.LOG_LEVEL || "info" });

const RECONNECT_MIN_DELAY_MS = 1_000;
const RECONNECT_MAX_DELAY_MS = 30_000;
async function startWhatsAppInstance(inst) {
  const instanceLogger = logger.child({ iid: inst.id });
  const previousAuthDir = process.env.AUTH_DIR;
  process.env.AUTH_DIR = inst.dir;

  const context = await bootBaileys({
    authDir: inst.dir,
    instanceId: inst.id,
    logger: instanceLogger,
  });

  if (previousAuthDir === undefined) {
    delete process.env.AUTH_DIR;
  } else {
    process.env.AUTH_DIR = previousAuthDir;
  }

  const sock = context.sock;
  inst.sock = sock;
  inst.context = context;

  sock.ev.on("connection.update", (update) => {
    const { connection, lastDisconnect, qr, receivedPendingNotifications } = update;
    const iid = inst.id;

    if (qr) {
      inst.lastQR = qr;
      instanceLogger.info({ iid }, "qr.updated");
    }
    if (connection === "open") {
      inst.lastQR = null;
      inst.reconnectDelay = RECONNECT_MIN_DELAY_MS;
      instanceLogger.info({ iid, receivedPendingNotifications }, "whatsapp.connected");
    }
    if (connection === "close") {
      const statusCode = lastDisconnect?.error?.output?.statusCode;
      const isLoggedOut = statusCode === DisconnectReason.loggedOut;
      instanceLogger.warn({ iid, statusCode }, "whatsapp.disconnected");

      if (!inst.stopping && !isLoggedOut) {
        const delay = Math.min(inst.reconnectDelay, RECONNECT_MAX_DELAY_MS);
        instanceLogger.warn({ iid, delay }, "whatsapp.reconnect.scheduled");
        if (inst.reconnectTimer) clearTimeout(inst.reconnectTimer);
        const currentSock = sock;
        inst.reconnectTimer = setTimeout(() => {
          if (inst.sock !== currentSock) return; // evita reconectar duas vezes
          inst.reconnectDelay = Math.min(
            inst.reconnectDelay * 2,
            RECONNECT_MAX_DELAY_MS
          );
          startWhatsAppInstance(inst).catch((err) =>
            instanceLogger.error({ iid, err }, "whatsapp.reconnect.failed")
          );
        }, delay);
      } else if (isLoggedOut) {
        instanceLogger.error({ iid }, "session.loggedOut");
      }
    }
  });

  sock.ev.on("messages.upsert", async (evt) => {
    const count = evt.messages?.length || 0;
    const iid = inst.id;
    instanceLogger.info({ iid, type: evt.type, count }, "messages.upsert");

    // log rudimentar de interações (botões/listas)
    if (count) {
      for (const m of evt.messages) {
        const from = m.key?.remoteJid;

        const btn =
          m.message?.templateButtonReplyMessage ||
          m.message?.buttonsResponseMessage;
        if (btn) {
          instanceLogger.info(
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
          instanceLogger.info(
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

  });

  sock.ev.on("messages.update", (updates) => {
    const iid = inst.id;
    for (const u of updates) {
      const mid = u.key?.id;
      const st = u.update?.status;
      if (mid && st != null) {
        inst.statusMap.set(mid, st);
        inst.metrics.status_counts[String(st)] =
          (inst.metrics.status_counts[String(st)] || 0) + 1;
        inst.metrics.last.lastStatusId = mid;
        inst.metrics.last.lastStatusCode = st;

        // registra ACK
        if (st >= 2 && inst.ackSentAt?.has(mid)) {
          const sentAt = inst.ackSentAt.get(mid);
          inst.ackSentAt.delete(mid);
          if (sentAt) {
            const delta = Math.max(0, Date.now() - sentAt);
            inst.metrics.ack.totalMs += delta;
            inst.metrics.ack.count += 1;
            inst.metrics.ack.lastMs = delta;
            inst.metrics.ack.avgMs = Math.round(
              inst.metrics.ack.totalMs / inst.metrics.ack.count
            );
          }
        }

        recordMetricsSnapshot(inst);

        const waiter = inst.ackWaiters.get(mid);
        if (waiter) {
          clearTimeout(waiter.timer);
          inst.ackWaiters.delete(mid);
          waiter.resolve(st);
        }
      }
      instanceLogger.info({ iid, mid, status: st }, "messages.status");
    }
  });

  recordMetricsSnapshot(inst, true);
  return inst;
}

async function stopWhatsAppInstance(inst, { logout = false } = {}) {
  if (!inst) return;

  inst.stopping = true;
  inst.context = null;

  if (inst.reconnectTimer) {
    try {
      clearTimeout(inst.reconnectTimer);
    } catch {}
    inst.reconnectTimer = null;
  }
  if (logout && inst.sock) {
    try {
      await inst.sock.logout().catch(() => {});
    } catch {}
  }
  try {
    inst.sock?.end?.();
  } catch {}
}

module.exports = { startWhatsAppInstance, stopWhatsAppInstance };

