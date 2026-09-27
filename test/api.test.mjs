// NILCODE AI foundation tests: end-to-end API coverage with per-user isolation.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.NULLCODE_DATA_DIR = mkdtempSync(join(tmpdir(), 'nullcode-test-'));
process.env.NULLCODE_NO_LISTEN = '1';
process.env.NULLCODE_ALLOW_OLLAMA = '0'; // tests must not depend on host AI state
process.env.NULLCODE_DISABLE_AUTO_AI = '1'; // tests must never call real external AI providers

const { default: app } = await import('../server/index.js');
const { stopAll } = await import('../server/runtime/serve.js');

test.after(() => {
  stopAll();
  try {
    server?.closeAllConnections?.();
    server?.closeIdleConnections?.();
    server?.close();
  } catch { /* already closed */ }
  try { rmSync(process.env.NULLCODE_DATA_DIR, { recursive: true, force: true }); } catch { /* windows lock */ }
});

// Use real HTTP via a local listener so streaming and static files are covered.
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

test('health: static index served', async () => {
  const res = await fetch(`${baseUrl}/`);
  assert.equal(res.status, 200);
  const html = await res.text();
  assert.match(html, /NILCODE/);
  assert.match(html, /brand\/logo-light\.svg/);
});

test('logo assets exist', async () => {
  for (const p of ['/brand/logo-light.svg', '/brand/logo-dark.svg', '/brand/favicon.svg']) {
    const res = await fetch(`${baseUrl}${p}`);
    assert.equal(res.status, 200, p);
    const svg = await res.text();
    assert.match(svg, /<svg/);
  }
});

test('signup, login and session flow', async () => {
  const su = await api('POST', '/auth/signup', { body: { email: 'amy@example.com', password: 'secret1', name: 'Amy' } });
  assert.equal(su.status, 200);
  assert.ok(su.data.token);
  const me = await api('GET', '/me', { token: su.data.token });
  assert.equal(me.data.user.email, 'amy@example.com');
  const li = await api('POST', '/auth/login', { body: { email: 'amy@example.com', password: 'secret1' } });
  assert.equal(li.status, 200);
  const bad = await api('POST', '/auth/login', { body: { email: 'amy@example.com', password: 'wrong' } });
  assert.equal(bad.status, 401);
});

test('signup requires strong-enough password', async () => {
  const r = await api('POST', '/auth/signup', { body: { email: 'x@example.com', password: '123' } });
  assert.equal(r.status, 400);
});

test('unauthenticated requests are rejected', async () => {
  const r = await api('GET', '/projects');
  assert.equal(r.status, 401);
});

test('project lifecycle + isolation between users', async () => {
  const a = await api('POST', '/auth/signup', { body: { email: 'a@example.com', password: 'secret1', name: 'A' } });
  const b = await api('POST', '/auth/signup', { body: { email: 'b@example.com', password: 'secret1', name: 'B' } });
  const ta = a.data.token, tb = b.data.token;

  const created = await api('POST', '/projects', { token: ta, body: { name: 'Rental Site' } });
  assert.equal(created.status, 200);
  const pid = created.data.project.id;

  const listA = await api('GET', '/projects', { token: ta });
  assert.equal(listA.data.projects.length, 1);
  const listB = await api('GET', '/projects', { token: tb });
  assert.equal(listB.data.projects.length, 0);

  // User B cannot touch A's project.
  const sneaky = await api('GET', `/projects/${pid}/context`, { token: tb });
  assert.equal(sneaky.status, 404);

  // File write + read within A's project; traversal blocked.
  const w = await api('PUT', `/projects/${pid}/files`, {
    token: ta,
    body: { path: 'hello.txt', content: 'hi from NILCODE' },
  });
  assert.equal(w.status, 200);
  const r = await api('GET', `/projects/${pid}/files?path=hello.txt`, { token: ta });
  assert.equal(r.data.content, 'hi from NILCODE');
  const evil = await api('GET', `/projects/${pid}/files?path=../secret.txt`, { token: ta });
  assert.equal(evil.status, 400);

  // Context + tree include the new file.
  const ctx = await api('GET', `/projects/${pid}/context`, { token: ta });
  assert.ok(ctx.data.tree.includes('hello.txt'));
  assert.ok(ctx.data.context.project);
});

test('agent chat without configured AI answers honestly (no fake success)', async () => {
  const u = await api('POST', '/auth/signup', { body: { email: 'c@example.com', password: 'secret1', name: 'C' } });
  const t = u.data.token;
  const p = await api('POST', '/projects', { token: t, body: { name: 'Honest Site', description: 'A car rental company website.' } });
  const pid = p.data.project.id;

  const res = await fetch(`${baseUrl}/api/projects/${pid}/chat`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${t}` },
    body: JSON.stringify({ prompt: 'Create a simple website for a car rental company.' }),
  });
  assert.equal(res.status, 200);
  const events = [];
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    for (const line of buf.split('\n')) {
      if (line.trim()) {
        try { events.push(JSON.parse(line)); } catch { /* partial */ }
      }
    }
    buf = '';
  }
  const types = events.map((e) => e.type);
  assert.ok(types.includes('error'), 'honest error when no AI is available');
  assert.equal(types.includes('plan'), false, 'never fakes a plan');
  assert.equal(types.includes('assistant'), false, 'never fakes success');
  assert.ok(events[types.indexOf('error')].message.length > 20);

  // No project files were fabricated.
  const tree = await api('GET', `/projects/${pid}/files?tree=1`, { token: t });
  assert.equal(tree.data.tree.includes('index.html'), false);

  // .nullcode project index exists with the stored intent (internal dir name).
  const idx = await api('GET', `/projects/${pid}/files?path=.nullcode/intent.json`, { token: t });
  assert.equal(idx.status, 200);
  assert.match(JSON.parse(idx.data.content).description, /car rental/);

  // Run works; preview of an intentionally empty project serves 404
  // (documented behavior: nothing to preview until NILCODE AI builds it).
  const run = await api('POST', `/projects/${pid}/run`, { token: t });
  assert.equal(run.status, 200);
  const preview = await fetch(run.data.url);
  assert.equal(preview.status, 404);

  // Browser test endpoint responds (skips gracefully without Chromium).
  const tr = await api('POST', `/projects/${pid}/test`, { token: t });
  assert.equal(tr.status, 200);
  assert.ok(Array.isArray(tr.data.results) || tr.data.skipped);

  // Conversation persisted, including the honest error.
  const conv = await api('GET', `/projects/${pid}/context`, { token: t });
  assert.ok(conv.data.conversation.messages.length >= 2);
});

test('providers CRUD is isolated per user', async () => {
  const u = await api('POST', '/auth/signup', { body: { email: 'd@example.com', password: 'secret1', name: 'D' } });
  const t = u.data.token;
  const add = await api('POST', '/providers', {
    token: t,
    body: { type: 'openai-compatible', label: 'Groq free', baseUrl: 'https://api.groq.com/openai/v1', model: 'llama-3.3-70b-versatile', apiKey: 'gsk_test', free: true },
  });
  assert.equal(add.status, 200);
  const list = await api('GET', '/providers', { token: t });
  assert.equal(list.data.providers.length, 1);
  assert.ok(list.data.providers[0].hasKey);
  assert.equal(list.data.providers[0].apiKey, undefined, 'raw key must never be returned');
  const rm = await api('DELETE', `/providers/${list.data.providers[0].id}`, { token: t });
  assert.equal(rm.status, 200);
});

test('github endpoints gate on connection', async () => {
  const u = await api('POST', '/auth/signup', { body: { email: 'e@example.com', password: 'secret1', name: 'E' } });
  const t = u.data.token;
  const s = await api('GET', '/github/status', { token: t });
  assert.equal(s.data.connected, false);
  const repos = await api('GET', '/github/repos', { token: t });
  assert.equal(repos.status, 400);
});
