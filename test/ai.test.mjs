// Real-AI-path tests: NILCODE AI must round-trip to an actual AI backend.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startMockAI } from './mock-ai-server.mjs';

process.env.NULLCODE_DATA_DIR = mkdtempSync(join(tmpdir(), 'nullcode-ai-test-'));
process.env.NULLCODE_NO_LISTEN = '1';
process.env.NULLCODE_ALLOW_OLLAMA = '0'; // tests must not depend on host AI state
process.env.NULLCODE_DISABLE_AUTO_AI = '1'; // the built-in provider chain is covered by auto-ai.test.mjs

// Start the mock AI and point the platform config at it BEFORE the server
// modules load — provider configuration is read at module initialization.
const mock = await startMockAI();
process.env.NULLCODE_AI_BASE_URL = mock.url;
process.env.NULLCODE_AI_API_KEY = 'test-key';
process.env.NULLCODE_AI_MODEL = 'test-model';
process.env.NULLCODE_AI_LABEL = 'Test model';

const { default: app } = await import('../server/index.js');
const { stopAll } = await import('../server/runtime/serve.js');

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
  mock.server.close();
  try {
    server?.closeAllConnections?.();
    server?.close();
  } catch { /* already closed */ }
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

test('ai/status reports platform mode when NULLCODE_AI_* env is configured', async () => {
  const u = await api('POST', '/auth/signup', { body: { email: 'ai@example.com', password: 'secret1', name: 'AI' } });
  const s = await api('GET', '/ai/status', { token: u.data.token });
  assert.equal(s.status, 200);
  assert.equal(s.data.ready, true);
  assert.equal(s.data.mode, 'platform');
});

test('agent performs a real AI build: planner + coder round-trips, files actually written', async () => {
  const u = await api('POST', '/auth/signup', { body: { email: 'build@example.com', password: 'secret1', name: 'B' } });
  const t = u.data.token;

  // Create project WITH description — it must become AI context.
  const p = await api('POST', '/projects', {
    token: t,
    body: { name: 'Nova Coffee', description: 'Create a website for a specialty coffee shop in Lisbon.' },
  });
  const pid = p.data.project.id;

  const res2 = await fetch(`${baseUrl}/api/projects/${pid}/chat`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${t}` },
    body: JSON.stringify({ prompt: 'Build the homepage.' }),
  });
  assert.equal(res2.status, 200);
  const events = [];
  const reader = res2.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    for (const line of buf.split('\n')) {
      if (line.trim()) { try { events.push(JSON.parse(line)); } catch { /* partial */ } }
    }
    buf = '';
  }

  const types = events.map((e) => e.type);
  assert.ok(types.includes('plan'), 'AI returned an executable plan');
  assert.ok(types.includes('assistant'), 'agent reported the outcome');
  assert.equal(events[types.indexOf('assistant')].content.includes('Completed all 2 step(s)'), true);

  // Files were ACTUALLY written by the coder round-trip.
  const tree = await api('GET', `/projects/${pid}/files?tree=1`, { token: t });
  assert.ok(tree.data.tree.includes('index.html'));

  // The AI backend received the project description as context.
  const plannerCall = mock.calls.find((c) => /chat\/completions/.test(c.url) && /Build the homepage/.test(JSON.stringify(c.body)));
  assert.ok(plannerCall, 'planner call reached the AI backend');
  assert.ok(
    JSON.stringify(plannerCall.body).includes('specialty coffee shop in Lisbon'),
    'project description (intent) is part of AI context'
  );

  // Git checkpoint exists in the project's own repo.
  const gs = await api('GET', `/projects/${pid}/git`, { token: t });
  assert.ok(gs.data.recentLog.length >= 1);
});

test('agent answers questions conversationally without touching files', async () => {
  const u = await api('POST', '/auth/signup', { body: { email: 'q@example.com', password: 'secret1', name: 'Q' } });
  const t = u.data.token;
  const p = await api('POST', '/projects', { token: t, body: { name: 'Nova Coffee' } });
  const pid = p.data.project.id;

  const res = await fetch(`${baseUrl}/api/projects/${pid}/chat`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${t}` },
    body: JSON.stringify({ prompt: 'What is this project?' }),
  });
  const events = [];
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    for (const line of buf.split('\n')) {
      if (line.trim()) { try { events.push(JSON.parse(line)); } catch { /* partial */ } }
    }
    buf = '';
  }
  const assistant = events.find((e) => e.type === 'assistant');
  assert.ok(assistant, 'got a conversational reply');
  assert.match(assistant.content, /Nova Coffee/);
  assert.equal(events.some((e) => e.type === 'plan'), false, 'no plan emitted for a question');
});

test('without any AI, the agent answers honestly instead of faking success', async () => {
  // Simulate an operator misconfiguration: disable the platform provider
  // (config is a live singleton; provider resolution reads it per request).
  const { default: config } = await import('../server/config.js');
  const saved = config.platform.baseUrl;
  config.platform.baseUrl = '';
  const u = await api('POST', '/auth/signup', { body: { email: 'none@example.com', password: 'secret1', name: 'N' } });
  const t = u.data.token;
  const p = await api('POST', '/projects', { token: t, body: { name: 'No AI' } });
  const pid = p.data.project.id;

  const res = await fetch(`${baseUrl}/api/projects/${pid}/chat`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${t}` },
    body: JSON.stringify({ prompt: 'Build something.' }),
  });
  const events = [];
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    for (const line of buf.split('\n')) {
      if (line.trim()) { try { events.push(JSON.parse(line)); } catch { /* partial */ } }
    }
    buf = '';
  }
  const types = events.map((e) => e.type);
  const errEvent = events.find((e) => e.type === 'error');
  assert.ok(errEvent, 'an honest error event is emitted');
  assert.equal(errEvent.code, 'NOT_CONFIGURED', 'stable error code for UI mapping');
  assert.doesNotMatch(errEvent.message, /NULLCODE_AI_|environment|Ollama/i, 'no operator internals leaked to users');
  assert.equal(types.includes('plan'), false, 'no plan is faked');
  assert.equal(types.includes('assistant'), false, 'no fake success message');
  // Restore for any later tests.
  config.platform.baseUrl = saved;
});

test('provider 429 maps to the rate-limit code, 500 to unavailable', async () => {
  const u = await api('POST', '/auth/signup', { body: { email: 'rl@example.com', password: 'secret1', name: 'RL' } });
  const t = u.data.token;
  const p = await api('POST', '/projects', { token: t, body: { name: 'Rate Limit' } });

  mock.queueStatus(429);
  const events1 = [];
  await collectChat(t, p.data.project.id, 'do something', events1);
  assert.equal(events1.find((e) => e.type === 'error')?.code, 'RATE_LIMITED');

  mock.queueStatus(500);
  const events2 = [];
  await collectChat(t, p.data.project.id, 'do something else', events2);
  assert.equal(events2.find((e) => e.type === 'error')?.code, 'UNAVAILABLE');
});

test('platform AI usage is metered and enforced per user per day', async () => {
  process.env.NULLCODE_AI_DAILY_LIMIT = '2';
  const u = await api('POST', '/auth/signup', { body: { email: 'usage@example.com', password: 'secret1', name: 'U' } });
  const t = u.data.token;
  const p = await api('POST', '/projects', { token: t, body: { name: 'Metered' } });

  const events1 = [];
  await collectChat(t, p.data.project.id, 'first request', events1);
  assert.ok(events1.find((e) => e.type === 'assistant') || events1.find((e) => e.type === 'plan'), 'first request succeeds');

  const events2 = [];
  await collectChat(t, p.data.project.id, 'second request', events2);
  assert.ok(events2.find((e) => e.type === 'assistant') || events2.find((e) => e.type === 'plan'), 'second request succeeds');

  const events3 = [];
  await collectChat(t, p.data.project.id, 'third request', events3);
  const err = events3.find((e) => e.type === 'error');
  assert.equal(err?.code, 'RATE_LIMITED');
  assert.match(err?.message || '', /usage limit/);

  const status = await api('GET', '/ai/status', { token: t });
  assert.equal(status.data.usage.limit, 2);
  assert.equal(status.data.usage.used, 2);
  delete process.env.NULLCODE_AI_DAILY_LIMIT;
});

async function collectChat(token, projectId, prompt, into) {
  const res = await fetch(`${baseUrl}/api/projects/${projectId}/chat`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify({ prompt }),
  });
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    for (const line of buf.split('\n')) {
      if (line.trim()) { try { into.push(JSON.parse(line)); } catch { /* partial */ } }
    }
    buf = '';
  }
}
