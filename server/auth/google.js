// Google Identity Services (GIS) — server-side ID token verification.
// Identity-only scopes. No client secret exists in this flow: the GIS
// JavaScript button returns an ID token that this module verifies against
// Google's public JWKS. Additional Google services can be connected later
// through separate OAuth authorization flows.
import { createPublicKey, verify } from 'node:crypto';
import config from '../config.js';
import { upsertExternalUser } from '../auth.js';

const DISCOVERY = 'https://accounts.google.com/.well-known/openid-configuration';
const CACHE_MS = 12 * 60 * 60 * 1000;
let jwksCache = { keys: null, fetchedAt: 0 };

function discoveryUrl() {
  return config.google?.discoveryUrl || DISCOVERY;
}

async function getJwks() {
  if (jwksCache.keys && Date.now() - jwksCache.fetchedAt < CACHE_MS) return jwksCache.keys;
  const res = await fetch(discoveryUrl(), { signal: AbortSignal.timeout(10000) });
  if (!res.ok) throw new Error(`Google discovery request failed (${res.status}).`);
  const discovery = await res.json();
  const jwksRes = await fetch(discovery.jwks_uri, { signal: AbortSignal.timeout(10000) });
  if (!jwksRes.ok) throw new Error('Google JWKS request failed.');
  jwksCache = { keys: await jwksRes.json(), fetchedAt: Date.now() };
  return jwksCache.keys;
}

export function googleConfigured() {
  return !!(config.google?.clientId && config.google?.allowedClientIds?.length);
}

export function googleStatus() {
  return { enabled: googleConfigured(), clientId: config.google?.clientId || null };
}

// Verify a Google ID token produced by the GIS JavaScript client and
// link-or-create the NULLCODE account. Returns { user, created }.
export async function authenticateWithGoogle(credential) {
  if (!googleConfigured()) {
    throw new Error('Google sign-in is not configured on this NULLCODE instance.');
  }
  if (!credential || typeof credential !== 'string' || credential.length < 50) {
    throw new Error('Invalid Google credential.');
  }
  const parts = credential.split('.');
  if (parts.length !== 3) throw new Error('Malformed Google credential.');

  let header, payload;
  try {
    header = JSON.parse(Buffer.from(parts[0], 'base64url').toString('utf8'));
    payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
  } catch {
    throw new Error('Malformed Google credential.');
  }

  // 1. Signature (RS256 via Google's JWKS).
  if (header.alg !== 'RS256') throw new Error('Unsupported Google token algorithm.');
  const jwks = await getJwks();
  const key = jwks.keys.find((k) => k.kid === header.kid);
  if (!key) throw new Error('Unknown Google signing key — please retry.');
  const keyObject = createPublicKey({ key, format: 'jwk' });
  const signatureOk = verify(
    'RSA-SHA256',
    Buffer.from(`${parts[0]}.${parts[1]}`),
    keyObject,
    Buffer.from(parts[2], 'base64url')
  );
  if (!signatureOk) throw new Error('Google credential signature verification failed.');

  // 2. Standard claims: issuer, audience, expiry, verified email, subject.
  if (payload.iss !== 'accounts.google.com' && payload.iss !== 'https://accounts.google.com') {
    throw new Error('Wrong token issuer.');
  }
  if (!config.google.allowedClientIds.map(String).includes(String(payload.aud))) {
    throw new Error('Google credential is for a different application.');
  }
  if (!payload.sub) throw new Error('Google credential is missing a subject.');
  if (payload.exp && payload.exp * 1000 < Date.now()) throw new Error('Google credential has expired.');
  if (!payload.email || payload.email_verified === false) {
    throw new Error('Google account email is not verified.');
  }

  const account = upsertExternalUser({
    email: payload.email,
    name: payload.name,
    provider: 'google',
    providerId: payload.sub,
    picture: payload.picture || null,
  });
  return account;
}
