import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';

import { decryptSecret, encryptSecret, fingerprintSecret } from '../src/baileys/secretEncryption.js';

function withSecret<T>(value: string | null, fn: () => T): T {
  const originalSecret = process.env.POLL_METADATA_ENCRYPTION_KEY;
  if (value == null) {
    delete process.env.POLL_METADATA_ENCRYPTION_KEY;
  } else {
    process.env.POLL_METADATA_ENCRYPTION_KEY = value;
  }
  try {
    return fn();
  } finally {
    if (originalSecret == null) {
      delete process.env.POLL_METADATA_ENCRYPTION_KEY;
    } else {
      process.env.POLL_METADATA_ENCRYPTION_KEY = originalSecret;
    }
  }
}

test('encryptSecret returns ciphertext that decrypts back to original', () => {
  withSecret('unit-test-secret', () => {
    const plaintext = 'abcdef123456';
    const encrypted = encryptSecret(plaintext);
    assert.ok(encrypted);
    assert.notEqual(encrypted, plaintext);

    const decrypted = decryptSecret(encrypted);
    assert.equal(decrypted, plaintext);
  });
});

test('encryptSecret is a no-op when secret is missing', () => {
  withSecret(null, () => {
    const plaintext = 'deadbeef';
    const encrypted = encryptSecret(plaintext);
    assert.equal(encrypted, plaintext);
  });
});

test('decryptSecret leaves legacy plaintext as-is', () => {
  withSecret('unit-test-secret', () => {
    const legacy = 'cafebabe';
    const decrypted = decryptSecret(legacy);
    assert.equal(decrypted, legacy);
  });
});

test('fingerprintSecret produces stable hash for hex strings', () => {
  const fingerprintA = fingerprintSecret('0011ff');
  const fingerprintB = fingerprintSecret(Buffer.from([0x00, 0x11, 0xff]));
  assert.ok(fingerprintA);
  assert.ok(fingerprintB);
  assert.equal(fingerprintA, fingerprintB);
});
