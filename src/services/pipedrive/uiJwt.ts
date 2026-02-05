import crypto from 'node:crypto';
import {
  PIPEDRIVE_UI_JWT_MAX_AGE_SECONDS,
} from './config.js';
import { resolvePipedriveUiJwtSecret } from './uiConfig.js';

export interface PipedriveUiJwtClaims {
  companyId: number;
  userId: number;
  apiDomain: string | null;
  raw: Record<string, unknown>;
}

function base64UrlToBuffer(input: string): Buffer {
  const normalized = input.replace(/-/g, '+').replace(/_/g, '/');
  const padLen = (4 - (normalized.length % 4)) % 4;
  const padded = normalized + '='.repeat(padLen);
  return Buffer.from(padded, 'base64');
}

function safeJsonParse(value: Buffer): any | null {
  try {
    return JSON.parse(value.toString('utf8'));
  } catch {
    return null;
  }
}

function toNumber(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string' && value.trim()) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function extractCompanyId(payload: Record<string, unknown>): number | null {
  return (
    toNumber(payload.companyId) ??
    toNumber(payload.company_id) ??
    toNumber(payload.company) ??
    null
  );
}

function extractUserId(payload: Record<string, unknown>): number | null {
  return (
    toNumber(payload.userId) ??
    toNumber(payload.user_id) ??
    toNumber(payload.user) ??
    null
  );
}

function extractApiDomain(payload: Record<string, unknown>): string | null {
  const raw =
    (typeof payload.apiDomain === 'string' ? payload.apiDomain : null) ??
    (typeof payload.api_domain === 'string' ? payload.api_domain : null) ??
    null;
  return raw && raw.trim() ? raw.trim() : null;
}

export function verifyPipedriveUiJwt(token: string): PipedriveUiJwtClaims {
  const secret = resolvePipedriveUiJwtSecret();
  if (!secret) {
    throw new Error('pipedrive_ui_jwt_secret_missing');
  }

  const parts = token.split('.');
  if (parts.length !== 3) {
    throw new Error('jwt_malformed');
  }
  const [headerPart, payloadPart, signaturePart] = parts;

  const header = safeJsonParse(base64UrlToBuffer(headerPart));
  if (!header || typeof header !== 'object') {
    throw new Error('jwt_header_invalid');
  }
  const alg = typeof header.alg === 'string' ? header.alg : '';
  if (alg.toUpperCase() !== 'HS256') {
    throw new Error('jwt_alg_not_supported');
  }

  const payloadRaw = safeJsonParse(base64UrlToBuffer(payloadPart));
  if (!payloadRaw || typeof payloadRaw !== 'object') {
    throw new Error('jwt_payload_invalid');
  }
  const payload = payloadRaw as Record<string, unknown>;

  const data = `${headerPart}.${payloadPart}`;
  const expectedSig = crypto.createHmac('sha256', secret).update(data).digest().toString('base64url');
  const sigA = Buffer.from(signaturePart);
  const sigB = Buffer.from(expectedSig);
  if (sigA.length !== sigB.length || !crypto.timingSafeEqual(sigA, sigB)) {
    throw new Error('jwt_signature_invalid');
  }

  const now = Math.floor(Date.now() / 1000);
  const exp = toNumber(payload.exp);
  if (!exp) throw new Error('jwt_exp_required');
  if (now >= exp) throw new Error('jwt_expired');

  const iat = toNumber(payload.iat);
  if (iat) {
    const maxAge = Math.max(1, Math.floor(PIPEDRIVE_UI_JWT_MAX_AGE_SECONDS));
    if (iat > now + 60) throw new Error('jwt_iat_in_future');
    if (now - iat > maxAge) throw new Error('jwt_too_old');
  }

  const companyId = extractCompanyId(payload);
  const userId = extractUserId(payload);
  if (!companyId || companyId <= 0) throw new Error('jwt_company_id_required');
  if (!userId || userId <= 0) throw new Error('jwt_user_id_required');

  return {
    companyId,
    userId,
    apiDomain: extractApiDomain(payload),
    raw: payload,
  };
}

