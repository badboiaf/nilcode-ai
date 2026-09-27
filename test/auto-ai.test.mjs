// Built-in platform provider chain tests. Uses REAL provider APIs when keys
// are configured (repo .env); skips entirely when they are not (CI), so the
// suite never fails on a machine without credentials.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.NULLCODE_DATA_DIR = mkdtempSync(join(tmpdir(), 'nullcode-autoai-test-'));
process.env.NULLCODE_NO_LISTEN = '1';
process.env.NULLCODE_ALLOW_OLLAMA = '0';
// NOTE: NULLCODE_DISABLE_AUTO_AI is deliberately NOT set here — this suite
// exercises the built-in chain. NULLCODE_AI_* is deliberately NOT set either —
// the chain must only engage when no explicit platform provider exists.

const { default: config } = await import('../server/config.js');
const { ProviderRegistry, AI_ERRORS } = await import('../server/providers/registry.js');

const auto = config.platformAutoProviders || [];
const hasKeys = auto.length > 0;

test.after(() => {
  try { rmSync(process.env.NULLCODE_DATA_DIR, { recursive: true, force: true }); } catch { /* windows */ }
});

test('auto-chain is empty when an explicit platform provider is configured', () => {
  const reg = new ProviderRegistry('autoai-user-1');
  const saved = { ...config.platform };
  try {
    config.platform.baseUrl = 'http://127.0.0.1:1';
    config.platform.apiKey = 'explicit';
    config.platform.model = 'explicit-model';
    assert.deepEqual(reg.platformAutoProviders(), [], 'explicit NULLCODE_AI_* must suppress the chain');
  } finally {
    Object.assign(config.platform, saved);
  }
});

test('no credential material is ever exposed by status or provider listings', async () => {
  const reg = new ProviderRegistry('autoai-user-1');
  const statuses = await Promise.all(
    (reg.platformAutoProviders() || []).map(async () => {
      const { aiStatus } = await import('../server/providers/registry.js');
      return aiStatus('autoai-user-1');
    })
  );
  const blobs = statuses.map((s) => JSON.stringify(s));
  const listings = JSON.stringify(reg.list());
  for (const blob of [...blobs, listings]) {
    for (const p of auto) {
      if (!p.apiKey) continue;
      const probe = p.apiKey.slice(0, 12);
      assert.ok(!blob.includes(probe), 'no key prefix may appear in client-facing payloads');
    }
  }
});

test('built-in chain answers a real chat round-trip', { skip: !hasKeys && 'no OPENROUTER/GEMINI/GROQ keys configured' }, async () => {
  assert.ok(auto.length >= 1, 'at least one built-in provider is configured');
  for (const p of auto) {
    assert.ok(p.baseUrl && p.model && p.apiKey, `${p.id} is fully configured`);
  }

  const reg = new ProviderRegistry('autoai-user-2');
  const res = await reg.chat(
    'planner',
    [
      { role: 'system', content: 'You are a JSON API. Respond with JSON only.' },
      { role: 'user', content: 'Reply with exactly this object: {"ok":true}' },
    ],
    { timeoutMs: 60000 }
  );
  assert.ok(res.text && res.text.length > 0, 'a real provider answered');
  assert.equal(res.provider.platform, true, 'the answer came from the platform chain');
  assert.ok(
    auto.some((p) => p.label === res.provider.label),
    `provider label "${res.provider.label}" is one of the built-ins`
  );
});

test('unconfigured chain reports honest NOT_CONFIGURED', { skip: hasKeys && 'keys are configured; honest-error case covered by ai.test.mjs' }, async () => {
  const reg = new ProviderRegistry('autoai-user-3');
  await assert.rejects(
    () => reg.chat('planner', [{ role: 'user', content: 'hi' }], { timeoutMs: 5000 }),
    (err) => err.code === 'NOT_CONFIGURED' && err.message === AI_ERRORS.NOT_CONFIGURED
  );
});
