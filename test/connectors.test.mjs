// Connector platform tests: encryption at rest, catalog honesty (nothing
// connectable that is not implemented), per-user isolation, the token flow,
// the human-approval gate and project env-var writing. Runs against the real
// HTTP API with a temp data dir — no external service is ever contacted.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.NULLCODE_DATA_DIR = mkdtempSync(join(tmpdir(), 'nullcode-conn-test-'));
process.env.NULLCODE_NO_LISTEN = '1';
process.env.NULLCODE_ALLOW_OLLAMA = '0';
process.env.NULLCODE_DISABLE_AUTO_AI = '1';

const { default: app } = await import('../server/index.js');
const { stopAll } = await import('../server/runtime/serve.js');
const { encryptSecret, decryptSecret, isEncrypted } = await import('../server/connectors/crypto.js');
const { CATALOG } = await import('../server/connectors/catalog.js');
const oauth = await import('../server/connectors/oauth.js');
const bridge = await import('../server/connectors/connector-bridge.js');
const store = await import('../server/connectors/store.js');

let baseUrl;
let server;
test.before(async () => {
  await new Promise((resolve) => {
    server = app.listen(0, '127.0.0.1', () => {
      baseUrl = `http://127.0.0.1:${server.address().port}`;
      resolve();
    });
  });
});

test.after(() => {
  stopAll();
  try {
    server?.closeAllConnections?.();
    server?.closeIdleConnections?.();
    server?.close();
  } catch { /* already closed */ }
  try { rmSync(process.env.NULLCODE_DATA_DIR, { recursive: true, force: true }); } catch { /* windows lock */ }
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

async function signup(email) {
  const r = await api('POST', '/auth/signup', { body: { email, password: 'secret1', name: email.split('@')[0] } });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  const me = await api('GET', '/me', { token: r.data.token });
  return { token: r.data.token, id: me.data.user.id };
}

// ------------------------------------------------------------------- crypto --
test('secrets encrypt and decrypt round-trip; ciphertext is not plaintext', () => {
  const enc = encryptSecret('sup3r-secret-token');
  assert.notEqual(enc, 'sup3r-secret-token');
  assert.ok(isEncrypted(enc));
  assert.equal(decryptSecret(enc), 'sup3r-secret-token');
});

test('tampered ciphertext refuses to decrypt', () => {
  const enc = encryptSecret('value');
  const parts = enc.split('.');
  // Flip one character inside the GCM auth tag (valid base64, wrong bits):
  // Buffer.from ignores junk appended after padding, so corrupt in-place.
  parts[2] = (parts[2][0] === 'A' ? 'B' : 'A') + parts[2].slice(1);
  assert.throws(() => decryptSecret(parts.join('.')));
});

// ------------------------------------------------------------------ catalog --
test('catalog is honest: implemented entries have capabilities, coming-soon do not', () => {
  for (const c of CATALOG) {
    if (c.implemented) {
      assert.ok(c.capabilities.length >= 1, `${c.id} must expose capabilities`);
      assert.ok(c.auth, `${c.id} must declare an auth strategy`);
    } else {
      assert.equal(c.capabilities.length, 0, `${c.id} is not implemented and must not fake capabilities`);
    }
  }
  for (const id of ['supabase', 'netlify', 'discord', 'github']) {
    assert.ok(CATALOG.find((c) => c.id === id)?.implemented, `${id} must be implemented`);
  }
});

test('catalog API never leaks secrets and shows per-user connection state', async () => {
  const a = await signup('conn-a@example.com');
  await api('POST', '/connectors/github/token', { token: a.token, body: { token: 'gh_pat_AAA' } });
  const cat = await api('GET', '/connectors/catalog', { token: a.token });
  assert.equal(cat.status, 200);
  const raw = JSON.stringify(cat.data);
  assert.ok(!raw.includes('gh_pat_AAA'), 'token value must never appear in catalog payload');
  assert.ok(!raw.includes('"secrets"'), 'no secrets key may appear in catalog payload');
  const gh = cat.data.connectors.find((c) => c.id === 'github');
  assert.equal(gh.connection.connectorId, 'github');
  const soon = cat.data.connectors.find((c) => c.id === 'stripe');
  assert.equal(soon.implemented, false);
});

// --------------------------------------------------------------- isolation --
test('connections are per-user: user B never sees or uses user A connection', async () => {
  const a = await signup('iso-a@example.com');
  const b = await signup('iso-b@example.com');
  await api('POST', '/connectors/github/token', { token: a.token, body: { token: 'gh_pat_of_A' } });

  const catB = await api('GET', '/connectors/catalog', { token: b.token });
  assert.equal(catB.data.connectors.find((c) => c.id === 'github').connection, null);

  // Files are separate per user on disk.
  assert.ok(store.getConnection(a.id, 'github'));
  assert.equal(store.getConnection(b.id, 'github'), null);

  // B cannot disconnect A's connection (removeConnection is user-scoped).
  const res = await api('POST', '/connectors/github/disconnect', { token: b.token });
  assert.equal(res.status, 200);
  assert.ok(store.getConnection(a.id, 'github'), 'A connection survives B disconnect');
});

// ---------------------------------------------------------------- token flow --
test('token endpoint stores credentials without echoing them back', async () => {
  const a = await signup('tok@example.com');
  const r = await api('POST', '/connectors/github/token', { token: a.token, body: { token: 'gh_pat_XYZ' } });
  assert.equal(r.status, 200);
  assert.equal(r.data.connection.connectorId, 'github');
  assert.ok(!JSON.stringify(r.data).includes('gh_pat_XYZ'));
  // Stored encrypted at rest.
  const conn = store.getConnection(a.id, 'github');
  assert.ok(isEncrypted(conn.secrets.token));
});

test('unimplemented connectors cannot be connected (honesty enforced server-side)', async () => {
  const a = await signup('soon@example.com');
  const tokenTry = await api('POST', '/connectors/stripe/token', { token: a.token, body: { token: 'sk_x' } });
  assert.equal(tokenTry.status, 404);
  const oauthTry = await api('POST', '/connectors/vercel/oauth/start', { token: a.token });
  assert.equal(oauthTry.status, 404);
});

test('oauth start without configured client id returns a clear 400', async () => {
  const a = await signup('oa@example.com');
  const r = await api('POST', '/connectors/supabase/oauth/start', { token: a.token });
  assert.equal(r.status, 400);
  assert.match(r.data.error, /not configured/i);
});

test('oauth state is signed and tamper-proof', () => {
  const st = oauth.createState('supabase', 'user-1');
  assert.ok(oauth.verifyState(st));
  const forged = st.slice(0, -2) + (st.endsWith('aa') ? 'bb' : 'aa');
  assert.equal(oauth.verifyState(forged), null);
  assert.equal(oauth.verifyState('garbage'), null);
  // A state for another user/connector must not verify after re-signing attempts.
  assert.equal(oauth.verifyState(oauth.createState('netlify', 'user-2').split('.')[0] || ''), null);
});

// ---------------------------------------------------------------- approvals --
test('approval gate: only the requesting user can approve, wrong user gets 404', async () => {
  const a = await signup('appr@example.com');
  const b = await signup('appr-b@example.com');
  const approval = bridge.createApproval(a.id, { connectorId: 'netlify', capability: 'deploy', args: {}, title: 'Deploy?' });
  const waiter = bridge.waitApproval(approval.id, { userId: a.id });

  const wrong = await api('POST', `/connectors/approvals/${approval.id}`, { token: b.token, body: { decision: 'approve' } });
  assert.equal(wrong.status, 404);

  const right = await api('POST', `/connectors/approvals/${approval.id}`, { token: a.token, body: { decision: 'approve' } });
  assert.equal(right.status, 200);
  assert.equal(await waiter, 'approved');
});

test('approval declines and times out safely', async () => {
  const a = await signup('appr2@example.com');
  const d = bridge.createApproval(a.id, { connectorId: 'discord', capability: 'sendMessage', args: {}, title: 'Send?' });
  const waiterD = bridge.waitApproval(d.id, { userId: a.id });
  assert.ok(await (async () => { bridge.resolveApproval(d.id, 'decline', a.id); return waiterD; })() === 'declined');

  const t = bridge.createApproval(a.id, { connectorId: 'discord', capability: 'sendMessage', args: {}, title: 'Send?' });
  assert.equal(await bridge.waitApproval(t.id, { timeoutMs: 30, userId: a.id }), 'timeout');
});

test('dispatchConnectorTool blocks consequential actions until approved (decline path)', async () => {
  const a = await signup('disp@example.com');
  store.setSecrets(a.id, 'discord', { botToken: 'fake-bot-token' });
  const events = [];
  const out = await bridge.dispatchConnectorTool({
    userId: a.id,
    projectDir: process.env.NULLCODE_DATA_DIR,
    name: 'discord.sendMessage',
    args: { channelId: '1', content: 'hi' },
    // Simulate the UI pressing Cancel when the approval card appears.
    emitSafe: (e) => {
      events.push(e);
      if (e.type === 'approval_request') setTimeout(() => bridge.resolveApproval(e.id, 'decline', a.id), 30);
    },
    setStatus: () => {},
  });
  assert.equal(out.ok, false);
  assert.match(out.result, /declined/);
  assert.equal(events[0]?.type, 'approval_request');
  assert.equal(events[0]?.connector, 'Discord');
});

test('dispatchConnectorTool rejects unknown connectors and unconnected services', async () => {
  const a = await signup('disp2@example.com');
  const unknown = await bridge.dispatchConnectorTool({ userId: a.id, projectDir: '.', name: 'vercel.listSites', args: {} });
  assert.equal(unknown.ok, false);
  const unconnected = await bridge.dispatchConnectorTool({ userId: a.id, projectDir: '.', name: 'netlify.listSites', args: {} });
  assert.equal(unconnected.ok, false);
  assert.match(unconnected.result, /not connected/i);
  const badCap = await bridge.dispatchConnectorTool({ userId: a.id, projectDir: '.', name: 'netlify.deleteEverything', args: {} });
  assert.equal(badCap.ok, false);
});

// ------------------------------------------------------- env vars + project --
test('upsertEnvVars merges without duplicating keys and keeps user lines', () => {
  const dir = mkdtempSync(join(tmpdir(), 'nullcode-env-'));
  const w1 = bridge.upsertEnvVars(dir, { SUPABASE_URL: 'https://x.supabase.co', EXTRA_NOTE: 'keep me' });
  assert.deepEqual(w1.sort(), ['EXTRA_NOTE', 'SUPABASE_URL']);
  const w2 = bridge.upsertEnvVars(dir, { SUPABASE_URL: 'https://y.supabase.co' });
  assert.deepEqual(w2, ['SUPABASE_URL']);
  const content = readFileSync(join(dir, '.env'), 'utf8');
  assert.equal((content.match(/^SUPABASE_URL=/gm) || []).length, 1, 'no duplicate keys');
  assert.ok(content.includes('https://y.supabase.co'), 'value updated');
  assert.ok(content.includes('EXTRA_NOTE=keep me'), 'unrelated lines survive');
  rmSync(dir, { recursive: true, force: true });
});

test('project attach route writes env vars and stores metadata only', async () => {
  const a = await signup('attach@example.com');
  const proj = await api('POST', '/projects', { token: a.token, body: { name: 'Attach Demo' } });
  assert.equal(proj.status, 200, JSON.stringify(proj.data));
  const pid = proj.data.project?.id || proj.data.id;
  assert.ok(pid, 'project id returned');

  const noConn = await api('POST', `/projects/${pid}/connectors/netlify`, { token: a.token, body: { siteId: 's1' } });
  assert.equal(noConn.status, 400, 'cannot attach an unconnected service');

  const conn = await api('POST', '/connectors/github/token', { token: a.token, body: { token: 'gh_pat_ATT' } });
  assert.equal(conn.status, 200, JSON.stringify(conn.data));
  // GitHub attaches (implemented + connected) with metadata only.
  const gh = await api('POST', `/projects/${pid}/connectors/github`, { token: a.token, body: {} });
  assert.equal(gh.status, 200, JSON.stringify(gh.data));
  assert.ok(!JSON.stringify(gh.data).includes('gh_pat_ATT'));

  const detach = await api('DELETE', `/projects/${pid}/connectors/github`, { token: a.token });
  assert.equal(detach.status, 200);
});
