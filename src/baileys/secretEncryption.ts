import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'crypto';

const SUPPORTED_SECRET_ENV_VARS = [
  'POLL_METADATA_ENCRYPTION_KEY',
  'APP_ENCRYPTION_SECRET',
  'APP_ENCRYPTION_KEY',
];

const AES_GCM_ALGO = 'aes-256-gcm';
const GCM_IV_LEN = 12;
const AUTH_TAG_LEN = 16;
const PAYLOAD_VERSION = 1;

function resolveAppSecret(): string | null {
  for (const name of SUPPORTED_SECRET_ENV_VARS) {
    const v = process.env[name];
    if (v && v.trim()) return v.trim();
  }
  return null;
}

function deriveKey(): Buffer | null {
  const secret = resolveAppSecret();
  if (!secret) return null;
  try {
    return createHash('sha256').update(Buffer.from(secret, 'utf-8')).digest();
  } catch {
    return null;
  }
}

function toBuffer(value: string | Buffer | Uint8Array | null | undefined): Buffer | null {
  if (!value) return null;
  if (Buffer.isBuffer(value)) return value.length ? value : null;
  if (value instanceof Uint8Array) return value.length ? Buffer.from(value) : null;
  if (typeof value === 'string') {
    const s = value.trim();
    if (!s) return null;
    // hex
    if (/^[0-9a-fA-F]+$/.test(s) && s.length % 2 === 0) {
      try {
        const hex = Buffer.from(s, 'hex');
        if (hex.length) return hex;
      } catch {}
    }
    // base64
    try {
      const b64 = Buffer.from(s, 'base64');
      if (b64.length) return b64;
    } catch {}
    return Buffer.from(s, 'utf-8');
  }
  return null;
}

export function encryptSecret(value: string | null | undefined): string | null {
  if (value == null) return null;
  const plain = value.toString();
  if (!plain) return plain;

  const key = deriveKey();
  if (!key) return plain;

  try {
    const iv = randomBytes(GCM_IV_LEN);
    const cipher = createCipheriv(AES_GCM_ALGO, key, iv);
    const ciphertext = Buffer.concat([cipher.update(plain, 'utf-8'), cipher.final()]);
    const tag = cipher.getAuthTag();

    const payload = Buffer.concat([Buffer.from([PAYLOAD_VERSION]), iv, tag, ciphertext]);
    return payload.toString('base64');
  } catch {
    return plain;
  }
}

export function decryptSecret(value: string | null | undefined): string | null {
  if (value == null) return null;
  const encoded = value.toString();
  if (!encoded) return encoded;

  const key = deriveKey();
  if (!key) return encoded;

  let payload: Buffer;
  try {
    payload = Buffer.from(encoded, 'base64');
  } catch {
    return encoded;
  }

  if (payload.length <= 1 + GCM_IV_LEN + AUTH_TAG_LEN) return encoded;
  const version = payload[0];
  if (version !== PAYLOAD_VERSION) return encoded;

  try {
    const iv = payload.subarray(1, 1 + GCM_IV_LEN);
    const tag = payload.subarray(1 + GCM_IV_LEN, 1 + GCM_IV_LEN + AUTH_TAG_LEN);
    const ciphertext = payload.subarray(1 + GCM_IV_LEN + AUTH_TAG_LEN);

    const decipher = createDecipheriv(AES_GCM_ALGO, key, iv);
    decipher.setAuthTag(tag);
    const plain = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    return plain.toString('utf-8');
  } catch {
    return encoded;
  }
}

export function fingerprintSecret(value: string | Buffer | Uint8Array | null | undefined): string | null {
  const buf = toBuffer(value);
  if (!buf) return null;
  return createHash('sha256').update(buf).digest('hex');
}