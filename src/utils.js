const RATE_MAX_SENDS = Number(process.env.RATE_MAX_SENDS || 20);
const RATE_WINDOW_MS = Number(process.env.RATE_WINDOW_MS || 15_000);
const E164_BRAZIL = /^55\d{10,11}$/;
const METRICS_TIMELINE_MAX = 288; // ~24h (amostra a cada ~5min)
const METRICS_TIMELINE_MIN_INTERVAL_MS = 5 * 60_000; // 5 min

function normalizeToE164BR(val) {
  const digits = String(val || '').replace(/\D+/g, '');
  if (digits.startsWith('55') && E164_BRAZIL.test(digits)) return digits;
  if (/^\d{10,11}$/.test(digits)) return `55${digits}`;
  return null;
}

function allowSend(inst) {
  const now = Date.now();
  while (inst.rateWindow.length && now - inst.rateWindow[0] > RATE_WINDOW_MS) {
    inst.rateWindow.shift();
  }
  if (inst.rateWindow.length >= RATE_MAX_SENDS) return false;
  inst.rateWindow.push(now);
  return true;
}

function waitForAck(inst, messageId, timeoutMs = 10000) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      inst.ackWaiters.delete(messageId);
      resolve(null);
    }, timeoutMs);
    inst.ackWaiters.set(messageId, { resolve, timer });
  });
}

function recordMetricsSnapshot(inst, force = false) {
  if (!inst) return;
  if (!inst.metrics.timeline) inst.metrics.timeline = [];
  const now = Date.now();
  const last = inst.metrics.timeline[inst.metrics.timeline.length - 1];
  const statusCounts = inst.metrics.status_counts || {};
  const pending = statusCounts['1'] || 0;
  const serverAck = statusCounts['2'] || 0;
  const delivered = statusCounts['3'] || 0;
  const read = statusCounts['4'] || 0;
  const played = statusCounts['5'] || 0;
  const failed = Object.entries(statusCounts).reduce((acc, [code, value]) => {
    const numericCode = Number(code);
    if (Number.isFinite(numericCode) && numericCode >= 6) {
      return acc + (Number(value) || 0);
    }
    return acc;
  }, 0);

  if (last && now - last.ts < METRICS_TIMELINE_MIN_INTERVAL_MS) {
    last.sent = inst.metrics.sent;
    last.pending = pending;
    last.serverAck = serverAck;
    last.delivered = delivered;
    last.read = read;
    last.played = played;
    last.failed = failed;
    last.rateInWindow = inst.rateWindow.length;
    if (!last.iso) last.iso = new Date(last.ts).toISOString();
    if (!force) return;
  }

  inst.metrics.timeline.push({
    ts: now,
    iso: new Date(now).toISOString(),
    sent: inst.metrics.sent,
    pending,
    serverAck,
    delivered,
    read,
    played,
    failed,
    rateInWindow: inst.rateWindow.length,
  });

  if (inst.metrics.timeline.length > METRICS_TIMELINE_MAX) {
    inst.metrics.timeline.splice(
      0,
      inst.metrics.timeline.length - METRICS_TIMELINE_MAX
    );
  }
}

module.exports = {
  normalizeToE164BR,
  allowSend,
  waitForAck,
  recordMetricsSnapshot,
};
