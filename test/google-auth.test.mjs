// Google authentication tests. Generates a real RSA keypair, serves a fake
// discovery/JWKS, signs real ID tokens, and verifies NILCODE AI's full
// verification + account-linking flow without touching google.com.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generateKeyPairSync, createSign } from 'node:crypto';
import http from 'node:http';

const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const jwk = publicKey.export({ format: 'jwk' });
const KID = 'test-key-1';
const CLIENT_ID = 'test-client-id.apps.googleusercontent.com';

function b64url(obj) {
  return Buffer.from(JSON.stringify(obj)).toString('base64url');
}

function signToken(payload) {
  const header = { alg: 'RS256', kid: KID, typ: 'JWT' };
  const signingInput = `${b64url(header)}.${b64url(payload)}`;
  const signer = createSign('RSA-SHA256');
  signer.update(signingInput);
  return `${signingInput}.${signer.sign(privateKey).toString('base64url')}`;
}

// ------------------------------------------------------------ fake Google ---
const jwksServer = http.createServer((req, res) => {
  const host = req.headers.host;
  if (req.url === '/.well-known/openid-configuration') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ issuer: 'https://accounts.google.com', jwks_uri: `http://${host}/jwks` }));
    return;
  }
  if (req.url === '/jwks') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ keys: [{ ...jwk, kid: KID, alg: 'RS256' }] }));
    return;
  }
  res.writeHead(404).end();
});
await new Promise((r) => jwksServer.listen(0, '127.0.0.1', r));
const discoveryUrl = `http://127.0.0.1:${jwksServer.address().port}/.well-known/openid-configuration`;

// --------------------------------------------------------------- app boot ---
process.env.NULLCODE_DATA_DIR = mkdtempSync(join(tmpdir(), 'nullcode-google-test-'));
process.env.NULLCODE_NO_LISTEN = '1';
process.env.NULLCODE_ALLOW_OLLAMA = '0';
process.env.NULLCODE_DISABLE_AUTO_AI = '1'; // tests must never call real external AI providers
process.env.NULLCODE_GOOGLE_CLIENT_ID = CLIENT_ID;

const configModule = await import('../server/config.js');
configModule.default.google.discoveryUrl = discoveryUrl;

const { default: app } = await import('../server/index.js');

let server;
let baseUrl;
test.before(async () => {
  await new Promise((resolve) => {
    server = app.listen(0, '127.0.0.1', () => {
      baseUrl = `http://127.0.0.1:${server.address().port}`;
      resolve();
    });
  });
});

test.after(() => {
  try { server?.closeAllConnections?.(); server?.close(); } catch { /* closed */ }
  jwksServer.close();
  try { rmSync(process.env.NULLCODE_DATA_DIR, { recursive: true, force: true }); } catch { /* windows */ }
});

async function api(method, path, { token, body } = {}) {
  const res = await fetch(`${baseUrl}/api${path}`, {
    method,
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  return { status: res.status, data };
}

// ------------------------------------------------------------------ tests ---

test('google status endpoint reports configured state', async () => {
  const r = await api('GET', '/auth/google/status');
  assert.equal(r.status, 200);
  assert.equal(r.data.enabled, true);
  assert.equal(r.data.clientId, CLIENT_ID);
});

test('valid Google ID token creates an account and a working session', async () => {
  const now = Math.floor(Date.now() / 1000);
  const credential = signToken({
    iss: 'accounts.google.com',
    aud: CLIENT_ID,
    sub: 'g-user-123',
    email: 'g.user@example.com',
    email_verified: true,
    name: 'Google User',
    exp: now + 600,
    iat: now,
  });
  const r = await api('POST', '/auth/google', { body: { credential } });
  assert.equal(r.status, 200);
  assert.ok(r.data.token, 'session token issued');
  assert.equal(r.data.created, true);
  assert.equal(r.data.user.email, 'g.user@example.com');

  const me = await api('GET', '/me', { token: r.data.token });
  assert.equal(me.status, 200);
  assert.equal(me.data.user.email, 'g.user@example.com');
});

test('returning Google user signs back in without a duplicate account', async () => {
  const now = Math.floor(Date.now() / 1000);
  const credential = signToken({
    iss: 'accounts.google.com', aud: CLIENT_ID, sub: 'g-user-123',
    email: 'g.user@example.com', email_verified: true, exp: now + 600,
  });
  const r = await api('POST', '/auth/google', { body: { credential } });
  assert.equal(r.status, 200);
  assert.equal(r.data.created, false, 'linked to the existing account');
});

test('wrong audience is rejected', async () => {
  const now = Math.floor(Date.now() / 1000);
  const credential = signToken({
    iss: 'accounts.google.com', aud: 'other-app-id', sub: 'evil-1',
    email: 'evil@example.com', email_verified: true, exp: now + 600,
  });
  const r = await api('POST', '/auth/google', { body: { credential } });
  assert.equal(r.status, 401);
});

test('wrong issuer is rejected', async () => {
  const now = Math.floor(Date.now() / 1000);
  const credential = signToken({
    iss: 'https://evil.example.com', aud: CLIENT_ID, sub: 'evil-2',
    email: 'evil2@example.com', email_verified: true, exp: now + 600,
  });
  const r = await api('POST', '/auth/google', { body: { credential } });
  assert.equal(r.status, 401);
});

test('expired token is rejected', async () => {
  const now = Math.floor(Date.now() / 1000);
  const credential = signToken({
    iss: 'accounts.google.com', aud: CLIENT_ID, sub: 'late',
    email: 'late@example.com', email_verified: true, exp: now - 100,
  });
  const r = await api('POST', '/auth/google', { body: { credential } });
  assert.equal(r.status, 401);
});

test('tampered signature is rejected', async () => {
  const now = Math.floor(Date.now() / 1000);
  const credential = signToken({
    iss: 'accounts.google.com', aud: CLIENT_ID, sub: 'hacker',
    email: 'hacker@example.com', email_verified: true, exp: now + 600,
  });
  const parts = credential.split('.');
  const forged = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
  forged.email = 'victim@example.com';
  const tampered = `${parts[0]}.${b64url(forged)}.${parts[2]}`;
  const r = await api('POST', '/auth/google', { body: { credential: tampered } });
  assert.equal(r.status, 401);
});

test('unverified email is rejected', async () => {
  const now = Math.floor(Date.now() / 1000);
  const credential = signToken({
    iss: 'accounts.google.com', aud: CLIENT_ID, sub: 'nv',
    email: 'nv@example.com', email_verified: false, exp: now + 600,
  });
  const r = await api('POST', '/auth/google', { body: { credential } });
  assert.equal(r.status, 401);
});

test('garbage credential is rejected gracefully', async () => {
  const r = await api('POST', '/auth/google', { body: { credential: 'not-a-token' } });
  assert.equal(r.status, 401);
  const r2 = await api('POST', '/auth/google', { body: {} });
  assert.equal(r2.status, 401);
});

test('unconfigured instance reports google disabled', async () => {
  const configModule2 = await import('../server/config.js');
  const saved = configModule2.default.google.clientId;
  configModule2.default.google.clientId = '';
  configModule2.default.google.allowedClientIds = [];
  const r = await api('POST', '/auth/google', { body: { credential: 'x'.repeat(80) } });
  assert.equal(r.status, 401);
  assert.match(r.data.error, /not configured/);
  const s = await api('GET', '/auth/google/status');
  assert.equal(s.data.enabled, false);
  configModule2.default.google.clientId = saved;
  configModule2.default.google.allowedClientIds = [saved];
});
