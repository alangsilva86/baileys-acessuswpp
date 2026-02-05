import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';

process.env.NODE_ENV = process.env.NODE_ENV || 'development';
process.env.PIPEDRIVE_CLIENT_SECRET = process.env.PIPEDRIVE_CLIENT_SECRET || 'client-secret';

const { verifyPipedriveUiJwt } = await import('../src/services/pipedrive/uiJwt.js');

function b64url(input: unknown): string {
  return Buffer.from(JSON.stringify(input)).toString('base64url');
}

function signJwt(payload: Record<string, unknown>, secret: string): string {
  const header = { alg: 'HS256', typ: 'JWT' };
  const head = b64url(header);
  const body = b64url(payload);
  const data = `${head}.${body}`;
  const sig = crypto.createHmac('sha256', secret).update(data).digest().toString('base64url');
  return `${data}.${sig}`;
}

test('verifyPipedriveUiJwt aceita token válido (HS256, exp, companyId/userId)', () => {
  const now = Math.floor(Date.now() / 1000);
  const token = signJwt(
    { exp: now + 60, iat: now, companyId: 123, userId: 456, apiDomain: 'https://example.pipedrive.com' },
    process.env.PIPEDRIVE_CLIENT_SECRET!,
  );
  const claims = verifyPipedriveUiJwt(token);
  assert.equal(claims.companyId, 123);
  assert.equal(claims.userId, 456);
  assert.equal(claims.apiDomain, 'https://example.pipedrive.com');
});

test('verifyPipedriveUiJwt rejeita assinatura inválida', () => {
  const now = Math.floor(Date.now() / 1000);
  const token = signJwt(
    { exp: now + 60, iat: now, companyId: 123, userId: 456 },
    'wrong-secret',
  );
  assert.throws(() => verifyPipedriveUiJwt(token), /jwt_signature_invalid/);
});

test('verifyPipedriveUiJwt rejeita token expirado', () => {
  const now = Math.floor(Date.now() / 1000);
  const token = signJwt(
    { exp: now - 1, iat: now - 10, companyId: 123, userId: 456 },
    process.env.PIPEDRIVE_CLIENT_SECRET!,
  );
  assert.throws(() => verifyPipedriveUiJwt(token), /jwt_expired/);
});

test('verifyPipedriveUiJwt exige companyId e userId', () => {
  const now = Math.floor(Date.now() / 1000);
  const tokenMissingCompany = signJwt(
    { exp: now + 60, iat: now, userId: 456 },
    process.env.PIPEDRIVE_CLIENT_SECRET!,
  );
  assert.throws(() => verifyPipedriveUiJwt(tokenMissingCompany), /jwt_company_id_required/);

  const tokenMissingUser = signJwt(
    { exp: now + 60, iat: now, companyId: 123 },
    process.env.PIPEDRIVE_CLIENT_SECRET!,
  );
  assert.throws(() => verifyPipedriveUiJwt(tokenMissingUser), /jwt_user_id_required/);
});

