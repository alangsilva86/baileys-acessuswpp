import type { Instance, InstanceEventReason } from '../instanceManager.js';

export const QR_INITIAL_TTL_MS = 60_000;
export const QR_SUBSEQUENT_TTL_MS = 20_000;

export interface ConnectionLifecycleHooks {
  onEvent?: (reason: InstanceEventReason, detail?: Record<string, unknown>) => void;
}

export function updateConnectionState(inst: Instance, state: Instance['connectionState']): void {
  inst.connectionState = state;
  inst.connectionUpdatedAt = Date.now();
}

export function updateLastQr(
  inst: Instance,
  qr: string | null,
  hooks?: ConnectionLifecycleHooks,
): void {
  if (inst.lastQR === qr) return;
  inst.lastQR = qr;
  inst.qrVersion += 1;
  if (qr) {
    const now = Date.now();
    const ttl = inst.qrVersion > 1 ? QR_SUBSEQUENT_TTL_MS : QR_INITIAL_TTL_MS;
    inst.qrReceivedAt = now;
    inst.qrExpiresAt = now + ttl;
    const attempt = incrementPairingAttempts(inst);
    hooks?.onEvent?.('qr', {
      qrVersion: inst.qrVersion,
      expiresAt: inst.qrExpiresAt,
      attempt,
    });
  } else {
    inst.qrReceivedAt = null;
    inst.qrExpiresAt = null;
  }
}

export function clearPairingState(inst: Instance): void {
  inst.pairingAttempts = 0;
}

export function clearLastError(inst: Instance): void {
  inst.lastError = null;
}

export function setLastError(inst: Instance, message: string | null | undefined): void {
  inst.lastError = message && message.trim() ? message.trim() : null;
}

export function setConnectionDetail(inst: Instance, detail: Instance['connectionStateDetail']): void {
  inst.connectionStateDetail = detail;
}

export function incrementPairingAttempts(inst: Instance): number {
  inst.pairingAttempts = Math.max(inst.pairingAttempts + 1, 1);
  return inst.pairingAttempts;
}
