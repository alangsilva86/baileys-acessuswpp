import { recordMetricsSnapshot, resolveAckWaiters } from '../utils.js';
import type { Instance } from '../instanceManager.js';

const DEFAULT_STATUS_TTL_MS = 10 * 60_000;
const DEFAULT_STATUS_SWEEP_INTERVAL_MS = 60_000;
const FINAL_STATUS_THRESHOLD = 3;
const FINAL_STATUS_CODES = new Set([0]);

const STATUS_TEXT_MAP: Record<string, number> = {
  ERROR: 0,
  FAILED: 0,
  PENDING: 1,
  QUEUED: 1,
  SENT: 1,
  SERVER_ACK: 2,
  ACK: 2,
  DELIVERY_ACK: 3,
  DELIVERED: 3,
  READ: 4,
  PLAYED: 5,
};

function parsePositiveInt(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

const STATUS_TTL_MS = parsePositiveInt(process.env.STATUS_TTL_MS, DEFAULT_STATUS_TTL_MS);
const STATUS_SWEEP_INTERVAL_MS = parsePositiveInt(
  process.env.STATUS_SWEEP_INTERVAL_MS,
  DEFAULT_STATUS_SWEEP_INTERVAL_MS,
);

export const statusTrackerConfig = {
  TTL_MS: STATUS_TTL_MS,
  SWEEP_INTERVAL_MS: STATUS_SWEEP_INTERVAL_MS,
};

export type MessageReceipt = Partial<{
  receiptTimestamp: unknown;
  readTimestamp: unknown;
  playedTimestamp: unknown;
  pendingDeviceJid: unknown;
  deliveredDeviceJid: unknown;
}>;

function decrement(inst: Instance, status: number): void {
  const key = String(status);
  const current = inst.metrics.status_counts[key] || 0;
  inst.metrics.status_counts[key] = current > 0 ? current - 1 : 0;
}

function increment(inst: Instance, status: number): void {
  const key = String(status);
  inst.metrics.status_counts[key] = (inst.metrics.status_counts[key] || 0) + 1;
}

function isFinal(status: number): boolean {
  return status >= FINAL_STATUS_THRESHOLD || FINAL_STATUS_CODES.has(status);
}

function removeStatus(inst: Instance, messageId: string, { record = true }: { record?: boolean } = {}): void {
  if (!inst.statusMap.has(messageId)) return;
  const previous = inst.statusMap.get(messageId);
  if (record) {
    recordMetricsSnapshot(inst);
  }
  if (previous != null) decrement(inst, previous);
  inst.statusMap.delete(messageId);
  inst.statusTimestamps.delete(messageId);
}

function ensureCleanup(inst: Instance): void {
  if (inst.statusCleanupTimer) return;
  inst.statusCleanupTimer = setInterval(() => {
    if (!inst.statusMap.size) return;
    const now = Date.now();
    for (const [messageId, status] of inst.statusMap.entries()) {
      const updatedAt = inst.statusTimestamps.get(messageId) ?? 0;
      if (isFinal(status) || now - updatedAt >= STATUS_TTL_MS) {
        removeStatus(inst, messageId);
      }
    }
  }, STATUS_SWEEP_INTERVAL_MS);
}

function toNumber(value: unknown): number | null {
  if (value == null) return null;
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : null;
  }
  if (typeof value === 'string' && value.trim()) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  if (typeof value === 'object' && typeof (value as { toNumber?: () => number }).toNumber === 'function') {
    try {
      const parsed = (value as { toNumber: () => number }).toNumber();
      return Number.isFinite(parsed) ? parsed : null;
    } catch {
      return null;
    }
  }
  return null;
}

export function normalizeStatusCode(raw: unknown): number | null {
  if (raw == null) return null;
  if (typeof raw === 'number') {
    const normalized = Math.trunc(raw);
    return Number.isFinite(normalized) ? normalized : null;
  }
  if (typeof raw === 'string') {
    const trimmed = raw.trim();
    if (!trimmed) return null;
    const numeric = Number(trimmed);
    if (Number.isFinite(numeric)) return Math.trunc(numeric);
    const mapped = STATUS_TEXT_MAP[trimmed.toUpperCase()];
    return typeof mapped === 'number' ? mapped : null;
  }
  if (typeof raw === 'object') {
    const candidateKeys = ['status', 'code', 'value'];
    for (const key of candidateKeys) {
      if (Object.prototype.hasOwnProperty.call(raw, key)) {
        const result = normalizeStatusCode((raw as Record<string, unknown>)[key]);
        if (result != null) return result;
      }
    }
  }
  return null;
}

export function deriveStatusFromReceipt(receipt: MessageReceipt): number | null {
  if (!receipt) return null;
  const played = toNumber(receipt.playedTimestamp);
  if (played && played > 0) return 5;
  const read = toNumber(receipt.readTimestamp);
  if (read && read > 0) return 4;
  const deliveredList = Array.isArray(receipt.deliveredDeviceJid)
    ? receipt.deliveredDeviceJid.filter(Boolean)
    : [];
  if (deliveredList.length > 0) return 3;
  const receiptTimestamp = toNumber(receipt.receiptTimestamp);
  if (receiptTimestamp && receiptTimestamp > 0) return 2;
  const pendingList = Array.isArray(receipt.pendingDeviceJid)
    ? receipt.pendingDeviceJid.filter(Boolean)
    : [];
  if (pendingList.length > 0) return 1;
  return null;
}

export function applyStatus(inst: Instance, messageId: string, status: number): boolean {
  if (status == null) return false;
  const now = Date.now();
  const previous = inst.statusMap.get(messageId);
  if (previous != null && status <= previous) {
    inst.statusTimestamps.set(messageId, now);
    return false;
  }

  if (previous != null) {
    decrement(inst, previous);
  }

  inst.statusMap.set(messageId, status);
  inst.statusTimestamps.set(messageId, now);
  ensureCleanup(inst);
  increment(inst, status);

  inst.metrics.last.lastStatusId = messageId;
  inst.metrics.last.lastStatusCode = status;

  recordMetricsSnapshot(inst, true);
  resolveAckWaiters(inst, messageId, status);

  if (isFinal(status)) {
    removeStatus(inst, messageId, { record: false });
    recordMetricsSnapshot(inst, true);
  }

  return true;
}

export function clearStatusTimers(inst: Instance): void {
  if (!inst.statusCleanupTimer) return;
  try {
    clearInterval(inst.statusCleanupTimer);
  } catch {
    // ignore cleanup errors
  }
  inst.statusCleanupTimer = null;
}
