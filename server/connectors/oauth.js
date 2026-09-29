// OAuth 2.0 engine shared by all OAuth connectors. Handles authorization-URL
// construction (with PKCE where the provider requires it), signed anti-CSRF
// state, code exchange and refresh. Client secrets and tokens never leave the
// server: the browser only ever sees the authorize URL it is redirected to.
// Tokens are stored through the same encrypted `secrets` map as every other
// credential, so metadata responses can never leak them.
import { createHash, randomBytes, createHmac } from 'node:crypto';
import { encryptSecret, decryptSecret, isEncrypted } from './crypto.js';
import { getConnection, upsertConnection } from './store.js';

const STATE_SECRET = () => process.env.NULLCODE_SECRET_KEY || 'nilcode-oauth-state-dev';

export function clientIdFor(entry) {
  return process.env[`NULLCODE_CONNECTOR_${entry.id.toUpperCase().replace(/-/g, '_')}_CLIENT_ID`] || '';
}

export function clientSecretFor(entry) {
  return process.env[`NULLCODE_CONNECTOR_${entry.id.toUpperCase().replace(/-/g, '_')}_CLIENT_SECRET`] || '';
}

// Signed, timestamped state: prevents CSRF and carries the connector id.
export function createState(connectorId, userId) {
  const payload = `${connectorId}.${userId}.${Date.now()}.${randomBytes(8).toString('hex')}`;
  const pB64 = Buffer.from(payload).toString('base64url');
  const sig = createHmac('sha256', STATE_SECRET()).update(payload).digest('base64url');
  return `${pB64}.${sig}`;
}

export function verifyState(state) {
  try {
    const [pB64, sig] = String(state).split('.');
    if (!pB64 || !sig) return null;
    const payload = Buffer.from(pB64, 'base64url').toString('utf8');
    const expected = createHmac('sha256', STATE_SECRET()).update(payload).digest('base64url');
    // Constant-time-ish comparison; lengths match by construction.
    if (sig.length !== expected.length || !cryptoTimingSafe(sig, expected)) return null;
    const [connectorId, userId, ts] = payload.split('.');
    // 15-minute window for the user to complete authorization.
    if (!connectorId || !userId || Date.now() - Number(ts) > 15 * 60 * 1000) return null;
    return { connectorId, userId };
  } catch {
    return null;
  }
}

function cryptoTimingSafe(a, b) {
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

// PKCE pair for providers that require it (Supabase).
export function createPkce() {
  const verifier = randomBytes(32).toString('base64url');
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  return { verifier, challenge };
}

// Where the provider should send the user back. Local dev and the desktop app
// both run on 127.0.0.1; hosted deployments set NULLCODE_CONNECTOR_REDIRECT_BASE.
export function redirectUri(req) {
  const base = process.env.NULLCODE_CONNECTOR_REDIRECT_BASE || `http://127.0.0.1:${config_port()}`;
  return `${base.replace(/\/$/, '')}/api/connectors/oauth/callback`;
}

function config_port() {
  // Read lazily to avoid a config import cycle in tests.
  return process.env.PORT || 4310;
}

export function authorizeUrl(entry, { state, codeChallenge, redirect }) {
  const auth = entry.auth;
  const params = new URLSearchParams({
    client_id: clientIdFor(entry),
    redirect_uri: redirect,
    response_type: 'code',
    state,
    scope: (auth.scopes || []).join(' '),
  });
  if (auth.pkce && codeChallenge) params.set('code_challenge', codeChallenge);
  // Discord: explicit bot permissions (never administrator) + per-guild install.
  if (entry.id === 'discord' && auth.botPermissions) {
    params.set('permissions', auth.botPermissions);
  }
  return `${auth.authorizeUrl}?${params}`;
}

export async function exchangeCode(entry, { code, codeVerifier, redirect }) {
  const body = new URLSearchParams({
    client_id: clientIdFor(entry),
    grant_type: 'authorization_code',
    code,
    redirect_uri: redirect,
  });
  const clientSecret = clientSecretFor(entry);
  if (clientSecret) body.set('client_secret', clientSecret);
  if (entry.auth.pkce && codeVerifier) body.set('code_verifier', codeVerifier);

  const res = await fetch(entry.auth.tokenUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body,
    signal: AbortSignal.timeout(30000),
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(`Token exchange failed (${res.status}).`);
  }
  return res.json();
}

async function refreshAccessToken(entry, refreshToken) {
  const body = new URLSearchParams({
    client_id: clientIdFor(entry),
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
  });
  const clientSecret = clientSecretFor(entry);
  if (clientSecret) body.set('client_secret', clientSecret);
  const res = await fetch(entry.auth.tokenUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body,
    signal: AbortSignal.timeout(30000),
  });
  if (!res.ok) throw new Error('Token refresh failed.');
  return res.json();
}

function readSecret(conn, key) {
  const v = conn?.secrets?.[key];
  if (!v) return null;
  return isEncrypted(v) ? decryptSecret(v) : String(v);
}

// Access token with transparent refresh. Refreshed tokens are written back
// encrypted, so secrets on disk stay current.
export async function getValidAccessToken(userId, entry) {
  const conn = getConnection(userId, entry.id);
  if (!conn) return null;
  const access = readSecret(conn, 'accessToken');
  const expiresAt = conn.expiresAt || 0;
  if (access && expiresAt > Date.now() + 60000) return access;
  const refresh = readSecret(conn, 'refreshToken');
  if (!refresh) return access; // providers without refresh (Netlify tokens don't expire)
  const refreshed = await refreshAccessToken(entry, refresh);
  const secrets = { ...(conn.secrets || {}) };
  if (refreshed.access_token) secrets.accessToken = encryptSecret(refreshed.access_token);
  if (refreshed.refresh_token) secrets.refreshToken = encryptSecret(refreshed.refresh_token);
  upsertConnection(userId, entry.id, {
    secrets,
    expiresAt: refreshed.expires_in ? Date.now() + refreshed.expires_in * 1000 : null,
  });
  return refreshed.access_token;
}

export { decryptSecret };
