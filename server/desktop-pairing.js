// Desktop session handoff. A signed-in web user can generate a short-lived,
// single-use pairing code; a NILCODE AI desktop instance redeems it to create
// its local session for the same account. No Google client secrets and no
// long-lived tokens ever live inside the desktop binary.
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { readJson, writeJson } from './store.js';
import config from './config.js';

function store() {
  return join(config.dataDir, 'pairing.json');
}

const CODE_TTL_MS = 10 * 60 * 1000;

export function createPairingCode(userId) {
  const code = randomBytes(4).toString('hex').toUpperCase(); // 8 chars, single-use
  const data = readJson(store(), { codes: {} });
  // housekeeping: drop expired entries
  for (const [c, v] of Object.entries(data.codes)) {
    if (v.expiresAt < Date.now() || v.used) delete data.codes[c];
  }
  data.codes[code] = { userId, createdAt: Date.now(), expiresAt: Date.now() + CODE_TTL_MS, used: false };
  writeJson(store(), data);
  return { code, expiresInMs: CODE_TTL_MS };
}

export function peekPairingCode(code) {
  const entry = readJson(store(), { codes: {} }).codes[String(code || '').toUpperCase()];
  if (!entry || entry.used || entry.expiresAt < Date.now()) return null;
  return entry;
}

export function consumePairingCode(code) {
  const key = String(code || '').toUpperCase();
  const data = readJson(store(), { codes: {} });
  const entry = data.codes[key];
  if (!entry || entry.used || entry.expiresAt < Date.now()) return null;
  entry.used = true;
  writeJson(store(), data);
  return { userId: entry.userId };
}

// Desktop-side: redeem a code against the central NILCODE AI web deployment.
export async function redeemViaCentral(code) {
  const base = (config.centralUrl || '').replace(/\/$/, '');
  if (!base) throw new Error('No central NILCODE AI URL configured (NULLCODE_CENTRAL_URL).');
  const res = await fetch(`${base}/api/desktop/pair-code/redeem`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ code }),
    signal: AbortSignal.timeout(15000),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || 'Pairing code could not be verified.');
  return data; // { user: { id, email, name }, redeemedAt }
}
