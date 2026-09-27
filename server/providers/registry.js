// Provider/model abstraction. Adapters implement a single `chat()` call so new
// providers can be added without touching the agent. Ordinary users get a
// working default AI path with zero configuration; advanced users can connect
// their own providers in Settings. Per-user credentials stay isolated.
import { join } from 'node:path';
import { existsSync, readFileSync } from 'node:fs';
import config from '../config.js';
import { readJson, writeJson, ensureDir } from '../store.js';

// ---------------------------------------------------------------- adapters --

async function chatOpenAICompatible(cred, messages, opts) {
  if (!cred.baseUrl) throw new Error(`${cred.label || 'Provider'} has no base URL configured.`);
  if (!cred.model) throw new Error(`${cred.label || 'Provider'} has no model configured.`);
  const res = await fetch(`${cred.baseUrl.replace(/\/$/, '')}/chat/completions`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(cred.apiKey ? { authorization: `Bearer ${cred.apiKey}` } : {}),
    },
    body: JSON.stringify({
      model: cred.model,
      messages,
      temperature: opts.temperature ?? 0.2,
      max_tokens: opts.maxTokens ?? 4096,
    }),
    signal: AbortSignal.timeout(opts.timeoutMs ?? 180000),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`${cred.label || cred.baseUrl} error ${res.status}: ${body.slice(0, 300)}`);
  }
  const data = await res.json();
  return {
    text: data.choices?.[0]?.message?.content ?? '',
    usage: data.usage || null,
  };
}

async function chatAnthropic(cred, messages, opts) {
  if (!cred.apiKey) throw new Error(`${cred.label || 'Anthropic'} has no API key configured.`);
  const system = messages.filter((m) => m.role === 'system').map((m) => m.content).join('\n');
  const rest = messages.filter((m) => m.role !== 'system');
  const res = await fetch(`${cred.baseUrl || 'https://api.anthropic.com'}/v1/messages`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': cred.apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: cred.model || 'claude-sonnet-4-20250514',
      max_tokens: opts.maxTokens ?? 4096,
      system: system || undefined,
      messages: rest,
    }),
    signal: AbortSignal.timeout(opts.timeoutMs ?? 180000),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`${cred.label || 'Anthropic'} error ${res.status}: ${body.slice(0, 300)}`);
  }
  const data = await res.json();
  return {
    text: (data.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('\n'),
    usage: data.usage || null,
  };
}

const ADAPTERS = {
  'openai-compatible': chatOpenAICompatible,
  anthropic: chatAnthropic,
  ollama: chatOpenAICompatible, // Ollama speaks the OpenAI chat-completions protocol
};

// ------------------------------------------------------------------ routing --

const ROLES = ['planner', 'coder', 'reviewer', 'debugger', 'tester', 'visual'];
// Routing priority by role. Users can reorder types in a future settings pass.
const ROLE_PRIORITY = {
  planner: ['openai-compatible', 'ollama', 'anthropic'],
  coder: ['openai-compatible', 'ollama', 'anthropic'],
  reviewer: ['anthropic', 'openai-compatible', 'ollama'],
  debugger: ['anthropic', 'openai-compatible', 'ollama'],
  tester: ['openai-compatible', 'ollama', 'anthropic'],
  visual: ['anthropic', 'openai-compatible', 'ollama'],
};

// ------------------------------------------------------------------ registry --

export class ProviderRegistry {
  constructor(userId) {
    this.userId = userId;
    // Credentials are stored per-user, never shared across accounts.
    this.file = join(config.usersDir, userId, 'providers.json');
    this.data = readJson(this.file, { providers: [] });
  }

  save() {
    ensureDir(config.usersDir);
    writeJson(this.file, this.data);
  }

  add(cred) {
    if (!ADAPTERS[cred.type]) throw new Error(`Unknown provider type: ${cred.type}`);
    const entry = {
      id: `p_${Date.now().toString(36)}${Math.floor(Math.random() * 1e4)}`,
      type: cred.type,
      label: cred.label || cred.type,
      baseUrl: cred.baseUrl || null,
      model: cred.model || null,
      apiKey: cred.apiKey || null,
      free: !!cred.free,
      enabled: cred.enabled !== false,
      addedAt: Date.now(),
    };
    this.data.providers.push(entry);
    this.save();
    return entry;
  }

  // Never return raw API keys to any client.
  list() {
    return this.data.providers.map(({ apiKey, ...rest }) => ({ ...rest, hasKey: !!apiKey }));
  }

  remove(id) {
    this.data.providers = this.data.providers.filter((p) => p.id !== id);
    this.save();
  }

  // The server-managed default path (operator-configured via environment).
  platformProvider() {
    const p = config.platform;
    if (p.baseUrl && p.apiKey && p.model) {
      return {
        type: p.type,
        label: p.label,
        baseUrl: p.baseUrl,
        model: p.model,
        apiKey: p.apiKey,
        free: true,
        platform: true,
      };
    }
    return null;
  }

  // Free local fallback: a running Ollama instance, if allowed and present.
  async ollamaProvider() {
    if (!config.allowOllama || !existsSync(config.ollamaStatusFile)) return null;
    try {
      const status = JSON.parse(readFileSync(config.ollamaStatusFile, 'utf8'));
      if (!status.available || !status.model) return null;
      return {
        type: 'ollama',
        label: `Ollama (${status.model})`,
        baseUrl: status.baseUrl || 'http://127.0.0.1:11434/v1',
        model: status.model,
        apiKey: 'ollama',
        free: true,
        platform: true,
      };
    } catch {
      return null;
    }
  }

  available() {
    return this.data.providers.filter(
      (p) => p.enabled !== false && p.baseUrl && (p.apiKey || p.type === 'ollama')
    );
  }

  // Resolve candidates for a role, user providers first (their keys, their
  // quotas), then the platform-managed default, then local Ollama if present.
  async resolve(role) {
    const priority = ROLE_PRIORITY[role] ?? ROLE_PRIORITY.coder;
    const candidates = [...this.available()].sort(
      (a, b) => priority.indexOf(a.type) - priority.indexOf(b.type)
    );
    const platform = this.platformProvider();
    if (platform) candidates.push(platform);
    const ollama = await this.ollamaProvider();
    if (ollama) candidates.push(ollama);
    return candidates;
  }

  async chat(role, messages, opts = {}) {
    const candidates = await this.resolve(role);
    if (!candidates.length) {
      throw new Error(
        'NULLCODE has no AI model available right now. The operator needs to configure the platform AI (NULLCODE_AI_* environment variables) or start Ollama locally. You can also connect your own provider in Settings → AI.'
      );
    }
    const errors = [];
    for (const cred of candidates) {
      try {
        const adapter = ADAPTERS[cred.type];
        const out = await adapter(cred, messages, opts);
        if (!out.text) throw new Error('empty response');
        return {
          provider: {
            id: cred.id || null,
            label: cred.label,
            type: cred.type,
            model: cred.model,
            platform: !!cred.platform,
          },
          ...out,
        };
      } catch (err) {
        errors.push(`${cred.label}: ${err.message}`);
      }
    }
    throw new Error(`No AI provider could serve role "${role}". ${errors.join(' | ')}`);
  }
}

export function validateCredential(cred) {
  return ADAPTERS[cred.type] ? null : `Unknown provider type: ${cred.type}`;
}

// Answers "is NULLCODE AI usable right now, and through which path?"
export async function aiStatus(userId) {
  const reg = new ProviderRegistry(userId);
  const platform = reg.platformProvider();
  const ollama = await reg.ollamaProvider();
  const userProviders = reg.list();
  const mode = userProviders.length ? 'own-keys' : platform ? 'platform' : ollama ? 'local' : 'none';
  const ready = mode !== 'none';
  return {
    ready,
    mode,
    defaultModel: platform ? platform.model : ollama ? ollama.model : null,
    userProviders: userProviders.length,
    message: ready
      ? mode === 'platform'
        ? 'NULLCODE AI is ready — no setup needed.'
        : mode === 'local'
          ? `Using your local model (${ollama.model}).`
          : 'Using your connected AI providers.'
      : 'No AI model is configured yet. The operator must set the NULLCODE_AI_* environment variables or start Ollama locally; you can also connect your own provider in Settings → AI.',
  };
}
