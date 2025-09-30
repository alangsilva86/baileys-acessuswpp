import crypto from 'node:crypto';

import type { AnyMessageContent } from '@whiskeysockets/baileys';

import type { ManagedInstance } from './context';

const RATE_MAX_SENDS = Number(process.env.RATE_MAX_SENDS ?? '20');
const RATE_WINDOW_MS = Number(process.env.RATE_WINDOW_MS ?? '15000');
const E164_BRAZIL = /^55\d{10,11}$/;
const SEND_TIMEOUT_MS = 25_000;
const METRICS_TIMELINE_MAX = 288; // ~24h (amostra a cada ~5min)
const METRICS_TIMELINE_MIN_INTERVAL_MS = 5 * 60_000; // 5 min

type MetricsSnapshot = {
  ts: number;
  iso: string;
  sent: number;
  pending: number;
  serverAck: number;
  delivered: number;
  read: number;
  played: number;
  failed: number;
  rateInWindow: number;
};

export function normalizeToE164BR(val: unknown): string | null {
  const digits = String(val ?? '').replace(/\D+/g, '');
  if (digits.startsWith('55') && E164_BRAZIL.test(digits)) return digits;
  if (/^\d{10,11}$/.test(digits)) return `55${digits}`;
  return null;
}

export function buildSignature(payload: string, secret: string): string {
  const h = crypto.createHmac('sha256', String(secret));
  h.update(payload);
  return `sha256=${h.digest('hex')}`;
}

export function allowSend(inst: ManagedInstance): boolean {
  const now = Date.now();
  while (inst.rateWindow.length && now - inst.rateWindow[0] > RATE_WINDOW_MS) {
    inst.rateWindow.shift();
  }
  if (inst.rateWindow.length >= RATE_MAX_SENDS) return false;
  inst.rateWindow.push(now);
  return true;
}

export async function sendWithTimeout(
  inst: ManagedInstance,
  jid: string,
  content: AnyMessageContent,
): Promise<any> {
  const sock = inst.sock;
  if (!sock) {
    throw new Error('instance socket unavailable');
  }
  return await Promise.race([
    sock.sendMessage(jid, content),
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error('send timeout')), SEND_TIMEOUT_MS),
    ),
  ]);
}

export function waitForAck(
  inst: ManagedInstance,
  messageId: string,
  timeoutMs = 10_000,
): Promise<number | null> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      inst.ackWaiters.delete(messageId);
      resolve(null);
    }, timeoutMs);
    inst.ackWaiters.set(messageId, { resolve, timer });
  });
}

export function recordMetricsSnapshot(inst: ManagedInstance, force = false): void {
  if (!inst) return;
  if (!inst.metrics.timeline) inst.metrics.timeline = [];
  const now = Date.now();
  const timeline = inst.metrics.timeline as MetricsSnapshot[];
  const last = timeline[timeline.length - 1];
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

  timeline.push({
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

  if (timeline.length > METRICS_TIMELINE_MAX) {
    timeline.splice(0, timeline.length - METRICS_TIMELINE_MAX);
  }
}
