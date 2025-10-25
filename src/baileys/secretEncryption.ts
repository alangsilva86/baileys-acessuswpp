import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'crypto';

const SUPPORTED_SECRET_ENV_VARS = [
  'POLL_METADATA_ENCRYPTION_KEY',
  'APP_ENCRYPTION_SECRET',
  'APP_ENCRYPTION_KEY',
];

const AES_GCM_ALGORITHM = 'aes-256-gcm';
const GCM_IV_LENGTH = 12; // 96-bit nonce recommended for GCM
const AUTH_TAG_LENGTH = 16;
const PAYLOAD_VERSION = 1;

function resolveAppSecret(): string | null {
  for (const name of SUPPORTED_SECRET_ENV_VARS) {
    const value = process.env[name];
    if (value && value.trim()) {
      return value.trim();
    }
  }
  return null;
}

function deriveKey(): Buffer | null {
  const secret = resolveAppSecret();
  if (!secret) return null;

  try {
    const material = Buffer.from(secret, 'utf-8');
    if (!material.length) return null;
    return createHash('sha256').update(material).digest();
  } catch {
    return null;
  }
}

function toBuffer(
  value: string | Buffer | Uint8Array | null | undefined,
): Buffer | null {
  if (!value) return null;
  if (Buffer.isBuffer(value)) {
    return value.length ? value : null;
  }
  if (value instanceof Uint8Array) {
    return value.length ? Buffer.from(value) : null;
  }
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!trimmed) return null;

    if (/^[0-9a-fA-F]+$/.test(trimmed) && trimmed.length % 2 === 0) {
      try {
        const hex = Buffer.from(trimmed, 'hex');
        if (hex.length) return hex;
      } catch {
        // ignore invalid hex
      }
    }

    try {
      const base64 = Buffer.from(trimmed, 'base64');
      if (base64.length) return base64;
    } catch {
      // ignore invalid base64
    }

    return Buffer.from(trimmed, 'utf-8');
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
    const iv = randomBytes(GCM_IV_LENGTH);
    const cipher = createCipheriv(AES_GCM_ALGORITHM, key, iv);
    const ciphertext = Buffer.concat([cipher.update(plain, 'utf-8'), cipher.final()]);
    const authTag = cipher.getAuthTag();

    const payload = Buffer.concat([
      Buffer.from([PAYLOAD_VERSION]),
      iv,
      authTag,
      ciphertext,
    ]);

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

  if (payload.length <= 1 + GCM_IV_LENGTH + AUTH_TAG_LENGTH) {
    return encoded;
  }

  const version = payload[0];
  if (version !== PAYLOAD_VERSION) {
    return encoded;
  }

  try {
    const iv = payload.subarray(1, 1 + GCM_IV_LENGTH);
    const authTag = payload.subarray(1 + GCM_IV_LENGTH, 1 + GCM_IV_LENGTH + AUTH_TAG_LENGTH);
    const ciphertext = payload.subarray(1 + GCM_IV_LENGTH + AUTH_TAG_LENGTH);

    const decipher = createDecipheriv(AES_GCM_ALGORITHM, key, iv);
    decipher.setAuthTag(authTag);
    const plain = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    return plain.toString('utf-8');
  } catch {
    return encoded;
  }
}

export function fingerprintSecret(
  value: string | Buffer | Uint8Array | null | undefined,
): string | null {
  const buffer = toBuffer(value);
  if (!buffer) return null;
  return createHash('sha256').update(buffer).digest('hex');
}
