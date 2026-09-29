// Credential encryption at rest. Connector secrets (API keys, OAuth refresh
// tokens) are AES-256-GCM encrypted with a machine-local key before they touch
// disk. The key lives outside any repository: NULLCODE_SECRET_KEY env var if
// the operator sets one, otherwise a generated file in the data directory with
// owner-only permissions. Plaintext never appears in logs or API responses.
import { createCipheriv, createDecipheriv, randomBytes, createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import config from '../config.js';

let cachedKey = null;

function loadKey() {
  if (cachedKey) return cachedKey;
  if (process.env.NULLCODE_SECRET_KEY) {
    // Derive a stable 32-byte key from whatever the operator provided.
    cachedKey = createHash('sha256').update(`nilcode-connector:${process.env.NULLCODE_SECRET_KEY}`).digest();
    return cachedKey;
  }
  const keyFile = join(config.dataDir, 'secret.key');
  try {
    const raw = readFileSync(keyFile, 'utf8').trim();
    if (raw) {
      cachedKey = Buffer.from(raw, 'base64');
      if (cachedKey.length === 32) return cachedKey;
    }
  } catch { /* first run */ }
  cachedKey = randomBytes(32);
  mkdirSync(dirname(keyFile), { recursive: true });
  writeFileSync(keyFile, `${cachedKey.toString('base64')}\n`, { mode: 0o600 });
  return cachedKey;
}

export function encryptSecret(plaintext) {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', loadKey(), iv);
  const enc = Buffer.concat([cipher.update(String(plaintext), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `enc1.${iv.toString('base64')}.${tag.toString('base64')}.${enc.toString('base64')}`;
}

export function decryptSecret(stored) {
  if (typeof stored !== 'string' || !stored.startsWith('enc1.')) {
    throw new Error('Not an encrypted secret.');
  }
  const [, ivB64, tagB64, dataB64] = stored.split('.');
  const decipher = createDecipheriv('aes-256-gcm', loadKey(), Buffer.from(ivB64, 'base64'));
  decipher.setAuthTag(Buffer.from(tagB64, 'base64'));
  return Buffer.concat([decipher.update(Buffer.from(dataB64, 'base64')), decipher.final()]).toString('utf8');
}

export function isEncrypted(value) {
  return typeof value === 'string' && value.startsWith('enc1.');
}
