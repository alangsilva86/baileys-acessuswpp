import crypto from 'node:crypto';
import type { WASocket } from '@whiskeysockets/baileys';
import type { Instance } from './instanceManager.js';

const RATE_MAX_SENDS = Number(process.env.RATE_MAX_SENDS || 20);
const RATE_WINDOW_MS = Number(process.env.RATE_WINDOW_MS || 15_000);
const E164_BRAZIL = /^55\d{10,11}$/;
const DEFAULT_SEND_TIMEOUT_MS = 25_000;
const METRICS_TIMELINE_MAX = 288;
const METRICS_TIMELINE_MIN_INTERVAL_MS = 5 * 60_000;

export function normalizeToE164BR(val: unknown): string | null {
  const digits = String(val ?? '').replace(/\D+/g, '');
  if (digits.startsWith('55') && E164_BRAZIL.test(digits)) return digits;
  if (/^\d{10,11}$/.test(digits)) return `55${digits}`;
  return null;
}

export function buildSignature(payload: string, secret: string): string {
  const hmac = crypto.createHmac('sha256', String(secret));
  hmac.update(payload);
  return `sha256=${hmac.digest('hex')}`;
}

export function allowSend(inst: Instance): boolean {
  const now = Date.now();
  while (inst.rateWindow.length && now - inst.rateWindow[0] > RATE_WINDOW_MS) {
    inst.rateWindow.shift();
  }
  if (inst.rateWindow.length >= RATE_MAX_SENDS) return false;
  inst.rateWindow.push(now);
  return true;
}

export function getSendTimeoutMs(): number {
  const parsed = Number(process.env.SEND_TIMEOUT_MS);
  if (Number.isFinite(parsed) && parsed > 0) {
    return parsed;
  }
  return DEFAULT_SEND_TIMEOUT_MS;
}

type MessageContent = Parameters<WASocket['sendMessage']>[1];

export async function sendWithTimeout(
  inst: Instance,
  jid: string,
  content: MessageContent,
): Promise<unknown> {
  if (!inst.sock) {
    throw new Error('socket unavailable');
  }

  const timeoutMs = getSendTimeoutMs();

  return Promise.race([
    inst.sock.sendMessage(jid, content),
    new Promise((_, reject) => {
      setTimeout(() => reject(new Error('send timeout')), timeoutMs);
    }),
  ]);
}

export function waitForAck(inst: Instance, messageId: string, timeoutMs = 10_000): Promise<number | null> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      inst.ackWaiters.delete(messageId);
      resolve(null);
    }, timeoutMs);
    inst.ackWaiters.set(messageId, { resolve, timer });
  });
}

export function recordMetricsSnapshot(inst: Instance, force = false): void {
  if (!inst.metrics.timeline) inst.metrics.timeline = [];
  const now = Date.now();
  const last = inst.metrics.timeline[inst.metrics.timeline.length - 1];

  let pending = 0;
  let serverAck = 0;
  let delivered = 0;
  let read = 0;
  let played = 0;
  let failed = 0;

  for (const status of inst.statusMap.values()) {
    switch (status) {
      case 1:
        pending += 1;
        break;
      case 2:
        serverAck += 1;
        break;
      case 3:
        delivered += 1;
        break;
      case 4:
        read += 1;
        break;
      case 5:
        played += 1;
        break;
      default:
        if (status >= 6) failed += 1;
        break;
    }
  }

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
    inst.metrics.timeline.splice(0, inst.metrics.timeline.length - METRICS_TIMELINE_MAX);
  }
}
