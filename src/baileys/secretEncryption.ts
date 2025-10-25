import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'crypto';

/**
 * Variáveis de ambiente aceitas para derivar a chave.
 * A primeira encontrada com valor não-vazio é utilizada.
 */
const SUPPORTED_SECRET_ENV_VARS = [
  'POLL_METADATA_ENCRYPTION_KEY',
  'APP_ENCRYPTION_SECRET',
  'APP_ENCRYPTION_KEY',
] as const;

/** Parâmetros de criptografia (AES-256-GCM) */
const AES_GCM_ALGORITHM = 'aes-256-gcm';
const GCM_IV_LENGTH = 12;              // 96 bits, recomendado para GCM
const AUTH_TAG_LENGTH = 16;            // 128 bits
const PAYLOAD_VERSION = 1;             // byte de versão no payload

/** Cache da chave derivada para evitar hash a cada chamada */
let cachedKey: Buffer | null = null;
let cachedSecretSource: string | null = null;

/* ========================================================================== */
/* Helpers                                                                    */
/* ========================================================================== */

/** Resolve o segredo da aplicação a partir das variáveis suportadas. */
function resolveAppSecret(): string | null {
  for (const name of SUPPORTED_SECRET_ENV_VARS) {
    const value = process.env[name];
    if (value && value.trim()) return value.trim();
  }
  return null;
}

/**
 * Deriva (e cacheia) a chave de 32 bytes via SHA-256 do segredo resolvido.
 * Caso não haja segredo, retorna null e a função chamadora deve operar em modo “transparente”.
 */
function getOrDeriveKey(): Buffer | null {
  const secret = resolveAppSecret();
  if (!secret) {
    cachedKey = null;
    cachedSecretSource = null;
    return null;
  }
  if (cachedKey && cachedSecretSource === secret) return cachedKey;

  try {
    const material = Buffer.from(secret, 'utf-8');
    if (!material.length) {
      cachedKey = null;
      cachedSecretSource = null;
      return null;
    }
    cachedKey = createHash('sha256').update(material).digest(); // 32 bytes
    cachedSecretSource = secret;
    return cachedKey;
  } catch {
    cachedKey = null;
    cachedSecretSource = null;
    return null;
  }
}

/** Converte base64url em base64 canônico. */
function base64urlToBase64(input: string): string {
  let s = input.replace(/-/g, '+').replace(/_/g, '/');
  const pad = s.length % 4;
  if (pad) s += '='.repeat(4 - pad);
  return s;
}

/** Tenta decodificar uma string como base64 ou base64url. Se falhar, lança. */
function bufferFromBase64Any(input: string): Buffer {
  try {
    return Buffer.from(input, 'base64');
  } catch {
    // tenta base64url
    const normalized = base64urlToBase64(input);
    return Buffer.from(normalized, 'base64');
  }
}

/** Converte valor heterogêneo em Buffer. */
function toBuffer(value: string | Buffer | Uint8Array | null | undefined): Buffer | null {
  if (!value) return null;
  if (Buffer.isBuffer(value)) return value.length ? value : null;
  if (value instanceof Uint8Array) return value.length ? Buffer.from(value) : null;

  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!trimmed) return null;

    // hex puro
    if (/^[0-9a-fA-F]+$/.test(trimmed) && trimmed.length % 2 === 0) {
      try {
        const hex = Buffer.from(trimmed, 'hex');
        if (hex.length) return hex;
      } catch {
        // ignora
      }
    }

    // base64 ou base64url
    try {
      const b64 = bufferFromBase64Any(trimmed);
      if (b64.length) return b64;
    } catch {
      // ignora
    }

    // utf-8 por fim
    return Buffer.from(trimmed, 'utf-8');
  }

  return null;
}

/* ========================================================================== */
/* API pública                                                                */
/* ========================================================================== */

/**
 * Criptografa um segredo textual.
 * - Se a chave de app não estiver configurada, retorna o valor original (modo pass-through).
 * - Formato do payload: base64( [version:1][iv:12][tag:16][ciphertext:n] )
 */
export function encryptSecret(value: string | null | undefined): string | null {
  if (value == null) return null;

  const plain = value.toString();
  if (!plain) return plain;

  const key = getOrDeriveKey();
  if (!key) return plain; // sem segredo de app: não criptografa

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
    // falha inesperada: conserva o valor original para não quebrar fluxo
    return plain;
  }
}

/**
 * Descriptografa um segredo previamente criptografado por `encryptSecret`.
 * - Tenta decodificar base64/base64url; se não parecer nosso formato, retorna o valor original.
 * - Se a chave de app não estiver configurada, retorna o valor original.
 */
export function decryptSecret(value: string | null | undefined): string | null {
  if (value == null) return null;

  const encoded = value.toString();
  if (!encoded) return encoded;

  const key = getOrDeriveKey();
  if (!key) return encoded;

  let payload: Buffer;
  try {
    // aceita base64 e base64url
    payload = bufferFromBase64Any(encoded);
  } catch {
    return encoded; // não é base64 válido
  }

  // tamanho mínimo: 1 (version) + IV + TAG
  if (payload.length <= 1 + GCM_IV_LENGTH + AUTH_TAG_LENGTH) return encoded;

  const version = payload[0];
  if (version !== PAYLOAD_VERSION) return encoded;

  try {
    const iv = payload.subarray(1, 1 + GCM_IV_LENGTH);
    const tagStart = 1 + GCM_IV_LENGTH;
    const authTag = payload.subarray(tagStart, tagStart + AUTH_TAG_LENGTH);
    const ciphertext = payload.subarray(tagStart + AUTH_TAG_LENGTH);

    const decipher = createDecipheriv(AES_GCM_ALGORITHM, key, iv);
    decipher.setAuthTag(authTag);

    const plain = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    return plain.toString('utf-8');
  } catch {
    // tag inválida, chave errada ou payload corrompido: retorna original
    return encoded;
  }
}

/**
 * Gera um fingerprint estável (sha256 hex) para qualquer entrada.
 * Útil para logs sem vazar o valor real do segredo.
 */
export function fingerprintSecret(
  value: string | Buffer | Uint8Array | null | undefined,
): string | null {
  const buffer = toBuffer(value);
  if (!buffer) return null;
  return createHash('sha256').update(buffer).digest('hex');
}

/* ========================================================================== */
/* Utilidades opcionais (não exportadas por default)                          */
/* ========================================================================== */

/**
 * Força a limpeza do cache da chave. Útil em testes se as envs mudarem.
 * (Exporte se necessário.)
 */
function _resetKeyCache(): void {
  cachedKey = null;
  cachedSecretSource = null;
}

// Descomente para exportar em cenários de teste
// export { _resetKeyCache as resetEncryptionKeyCache };