// Provider/model abstraction. Adapters implement a single `chat()` call so new
// providers can be added without touching the agent. Ordinary users get a
// working default AI path with zero configuration; advanced users can connect
// their own providers in Settings. Per-user credentials stay isolated.
import { join } from 'node:path';
import { existsSync, readFileSync } from 'node:fs';
import config from '../config.js';
import { readJson, writeJson, ensureDir } from '../store.js';

// Maps provider HTTP failures onto the user-facing taxonomy; full detail is
// logged server-side and attached to AIError.detail (never serialized to UI).
function providerErrorMessage(cred, status, body) {
  return `${cred.label || cred.baseUrl || cred.type} responded ${status}: ${String(body).slice(0, 300)}`;
}

// ------------------------------------------------------- user-facing errors --
// Errors carry a stable code the UI maps to friendly copy. Raw provider
// details stay in server logs only — they never reach a browser.
export class AIError extends Error {
  constructor(code, userMessage, detail) {
    super(userMessage);
    this.code = code;
    this.detail = detail;
  }
}

export const AI_ERRORS = {
  NOT_CONFIGURED: 'NILCODE AI is not configured yet.',
  UNAVAILABLE: 'NILCODE AI is temporarily unavailable. Please try again in a moment.',
  RATE_LIMITED: "You've reached your current usage limit. Your allowance resets tomorrow.",
  INVALID_REQUEST: "NILCODE AI couldn't process that request. Try rephrasing or shortening it.",
  AUTH_REQUIRED: 'Sign in to use NILCODE AI.',
};

export function logAIError(scope, detail) {
  // Operator diagnostics live in server logs only.
  console.error(`[ai] ${scope}:`, detail);
}

// ---------------------------------------------------------------- adapters --

// OpenAI-style multimodal content: text + image_url data URLs.
function openAiContentWithImages(text, images) {
  return [
    { type: 'text', text },
    ...images.map((i) => ({ type: 'image_url', image_url: { url: `data:${i.mime};base64,${i.base64}` } })),
  ];
}

// Shared HTTP-error mapping for OpenAI-compatible providers; throws AIError.
function handleProviderHttpError(cred, status, body) {
  const message = providerErrorMessage(cred, status, body);
  if (status === 401 || status === 403) {
    logAIError('auth failure', message);
    throw new AIError('UNAVAILABLE', AI_ERRORS.UNAVAILABLE, message);
  }
  if (status === 429) throw new AIError('RATE_LIMITED', AI_ERRORS.RATE_LIMITED, message);
  if (status >= 500) throw new AIError('UNAVAILABLE', AI_ERRORS.UNAVAILABLE, message);
  logAIError('request rejected', message);
  throw new AIError('INVALID_REQUEST', AI_ERRORS.INVALID_REQUEST, message);
}

// Streams OpenAI-style SSE chunks (delta.content) to onToken; without onToken
// it returns the full response in one JSON call.
async function chatOpenAICompatible(cred, messages, opts) {
  if (!cred.baseUrl) throw new Error(`${cred.label || 'Provider'} has no base URL configured.`);
  if (!cred.model) throw new Error(`${cred.label || 'Provider'} has no model configured.`);
  const outMessages = opts.images?.length
    ? [
        ...messages.slice(0, -1),
        {
          ...messages[messages.length - 1],
          content: openAiContentWithImages(messages[messages.length - 1].content, opts.images),
        },
      ]
    : messages;
  const stream = typeof opts.onToken === 'function';
  // Most hosted models are now reasoning models; without anti-reasoning
  // params they can spend the ENTIRE token budget thinking before any visible
  // content. Providers disagree on the parameter shape (OpenRouter wants
  // reasoning:{effort}, Gemini/Groq take reasoning_effort and REJECT the
  // object form), so we send both and strip them on a 400 rejection.
  const reasoningParams = { reasoning: { effort: 'low' }, reasoning_effort: 'low' };
  const baseBody = {
    model: cred.model,
    messages: outMessages,
    temperature: opts.temperature ?? 0.2,
    max_tokens: opts.maxTokens ?? 4096,
    ...(stream ? { stream: true } : {}),
  };
  const doFetch = (body) =>
    fetch(`${cred.baseUrl.replace(/\/$/, '')}/chat/completions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(cred.apiKey ? { authorization: `Bearer ${cred.apiKey}` } : {}),
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(opts.timeoutMs ?? (Number(config.ai?.timeoutMs) || 180000)),
    });
  let res = await doFetch({ ...baseBody, ...reasoningParams });
  if (!res.ok) {
    const errBody = await res.text().catch(() => '');
    if (res.status === 400 && /reasoning/i.test(errBody)) {
      // Provider rejected the anti-reasoning params — retry without them.
      res = await doFetch(baseBody);
    } else {
      handleProviderHttpError(cred, res.status, errBody);
    }
  }
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    const message = providerErrorMessage(cred, res.status, body);
    if (res.status === 401 || res.status === 403) {
      logAIError('auth failure', message);
      throw new AIError('UNAVAILABLE', AI_ERRORS.UNAVAILABLE, message);
    }
    if (res.status === 429) throw new AIError('RATE_LIMITED', AI_ERRORS.RATE_LIMITED, message);
    if (res.status >= 500) throw new AIError('UNAVAILABLE', AI_ERRORS.UNAVAILABLE, message);
    logAIError('request rejected', message);
    throw new AIError('INVALID_REQUEST', AI_ERRORS.INVALID_REQUEST, message);
  }
  if (!stream) {
    const data = await res.json();
    const msg = data.choices?.[0]?.message || {};
    const reasoning = extractReasoningText(msg);
    const text = msg.content || reasoning;
    if (!text) throw new Error('empty response');
    return {
      text,
      usage: data.usage || null,
      reasoningOnly: !msg.content && !!reasoning,
    };
  }
  // SSE decoding: split on blank lines, read `data:` payloads, accumulate deltas.
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  let text = '';
  let reasoning = '';
  let usage = null;
  outer: while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let idx;
    while ((idx = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, idx).trim();
      buf = buf.slice(idx + 1);
      if (!line.startsWith('data:')) continue;
      const payload = line.slice(5).trim();
      if (payload === '[DONE]') break outer;
      try {
        const chunk = JSON.parse(payload);
        const delta = chunk.choices?.[0]?.delta || {};
        if (delta.content) {
          text += delta.content;
          try { opts.onToken(delta.content); } catch { /* client gone */ }
        }
        // Reasoning models stream their thinking first; keep it as a fallback
        // answer if the budget runs out before any visible content.
        if (delta.reasoning) reasoning += delta.reasoning;
        for (const d of delta.reasoning_details || []) {
          if (typeof d?.text === 'string') reasoning += d.text;
        }
        if (chunk.usage) usage = chunk.usage;
      } catch { /* keep-alive or partial line */ }
    }
  }
  let reasoningOnly = false;
  if (!text && reasoning) {
    // Budget exhausted mid-thought: deliver the thinking trace rather than
    // nothing — but do NOT relay it as tokens (it is not an answer; the chat()
    // chain first tries the next provider for real content).
    reasoningOnly = true;
    text = reasoning;
  }
  if (!text) throw new Error('empty response');
  return { text, usage, reasoningOnly };
}

// Reasoning-model fallback: some backends return the thinking trace in a
// separate field with empty content when the token budget runs out.
function extractReasoningText(msg) {
  if (typeof msg.reasoning === 'string' && msg.reasoning.trim()) return msg.reasoning;
  const details = msg.reasoning_details || [];
  const joined = details
    .map((d) => (typeof d?.text === 'string' ? d.text : ''))
    .join('')
    .trim();
  return joined;
}

// Anthropic multimodal blocks: text + base64 image sources.
function anthropicContentWithImages(text, images) {
  return [
    { type: 'text', text },
    ...images.map((i) => ({
      type: 'image',
      source: { type: 'base64', media_type: i.mime, data: i.base64 },
    })),
  ];
}

async function chatAnthropic(cred, messages, opts) {
  if (!cred.apiKey) throw new Error(`${cred.label || 'Anthropic'} has no API key configured.`);
  const system = messages.filter((m) => m.role === 'system').map((m) => m.content).join('\n');
  const rest = messages.filter((m) => m.role !== 'system').map((m, i, arr) =>
    i === arr.length - 1 && opts.images?.length
      ? { ...m, content: anthropicContentWithImages(m.content, opts.images) }
      : m
  );
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
    signal: AbortSignal.timeout(opts.timeoutMs ?? (Number(config.ai?.timeoutMs) || 180000)),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    const message = providerErrorMessage(cred, res.status, body);
    if (res.status === 401 || res.status === 403) {
      logAIError('auth failure', message);
      throw new AIError('UNAVAILABLE', AI_ERRORS.UNAVAILABLE, message);
    }
    if (res.status === 429) throw new AIError('RATE_LIMITED', AI_ERRORS.RATE_LIMITED, message);
    if (res.status >= 500) throw new AIError('UNAVAILABLE', AI_ERRORS.UNAVAILABLE, message);
    logAIError('request rejected', message);
    throw new AIError('INVALID_REQUEST', AI_ERRORS.INVALID_REQUEST, message);
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

  // Built-in server-managed providers (OpenRouter / Gemini / Groq). Used only
  // when the operator has NOT configured an explicit platform provider via
  // NULLCODE_AI_* — explicit operator configuration always wins.
  platformAutoProviders() {
    if (this.platformProvider()) return [];
    return (config.platformAutoProviders || []).map((p) => ({ ...p, platform: true }));
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

  // Models the chat selector may offer. Only providers this server can route
  // to right now appear here; the UI never invents entries.
  listModels() {
    const models = [];
    const platform = this.platformProvider();
    if (platform) models.push({ id: 'platform', label: platform.label, model: platform.model, free: true, platform: true });
    models.push(
      ...this.platformAutoProviders().map((p) => ({
        id: p.id,
        label: p.label,
        model: p.model,
        free: true,
        platform: true,
      }))
    );
    return models;
  }

  available() {
    return this.data.providers.filter(
      (p) => p.enabled !== false && p.baseUrl && (p.apiKey || p.type === 'ollama')
    );
  }

  // Resolve candidates for a role, user providers first (their keys, their
  // quotas), then the platform-managed default, then the built-in provider
  // chain (OpenRouter/Gemini/Groq), then local Ollama if present.
  async resolve(role) {
    const priority = ROLE_PRIORITY[role] ?? ROLE_PRIORITY.coder;
    const candidates = [...this.available()].sort(
      (a, b) => priority.indexOf(a.type) - priority.indexOf(b.type)
    );
    const platform = this.platformProvider();
    if (platform) candidates.push(platform);
    candidates.push(...this.platformAutoProviders());
    const ollama = await this.ollamaProvider();
    if (ollama) candidates.push(ollama);
    return candidates;
  }

  // preferredModel: model id/name chosen in the UI. Reorders the resolved
  // candidates so the matching provider is tried FIRST — the chain and every
  // fallback stay intact if it fails.
  async chat(role, messages, opts = {}) {
    let candidates = await this.resolve(role);
    if (!candidates.length) {
      throw new AIError('NOT_CONFIGURED', AI_ERRORS.NOT_CONFIGURED, 'no providers configured');
    }
    if (opts.preferredModel) {
      const want = String(opts.preferredModel);
      const match = (c) => c.model === want || c.id === want;
      if (candidates.some(match)) {
        const head = candidates.filter(match);
        const tail = candidates.filter((c) => !match(c));
        candidates = [...head, ...tail];
      }
    }
    const details = [];
    const codes = [];
    let lastResort = null;
    for (const cred of candidates) {
      try {
        const adapter = ADAPTERS[cred.type];
        const out = await adapter(cred, messages, opts);
        if (!out.text) throw new Error('empty response');
        if (out.reasoningOnly) {
          // A reasoning model that burned its budget: no real answer. Try the
          // next provider; keep this as a last resort if everything else fails.
          lastResort = { provider: { id: cred.id || null, label: cred.label, type: cred.type, model: cred.model, platform: !!cred.platform }, ...out };
          details.push(`${cred.label}: reasoning-only response`);
          continue;
        }
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
        // A failed candidate must not break the chain: move on to the next
        // provider (5xx outages and per-provider rejects are exactly why the
        // fallback exists). The error code is decided AFTER every candidate
        // has had its chance.
        codes.push(err.code || null);
        details.push(`${cred.label}: ${err.message}`);
      }
    }
    if (lastResort) {
      logAIError(`only reasoning-only responses for role "${role}"`, details.join(' | '));
      return lastResort;
    }
    logAIError(`all providers failed for role "${role}"`, details.join(' | '));
    const code = codes.length && codes.every((c) => c === 'RATE_LIMITED') ? 'RATE_LIMITED' : 'UNAVAILABLE';
    throw new AIError(code, AI_ERRORS[code], details.join(' | '));
  }
}

export function validateCredential(cred) {
  return ADAPTERS[cred.type] ? null : `Unknown provider type: ${cred.type}`;
}

// Answers "is NILCODE AI usable right now, and through which path?"
export async function aiStatus(userId) {
  const reg = new ProviderRegistry(userId);
  const platform = reg.platformProvider();
  const auto = reg.platformAutoProviders();
  const ollama = await reg.ollamaProvider();
  const userProviders = reg.list();
  const mode = userProviders.length
    ? 'own-keys'
    : platform || auto.length
      ? 'platform'
      : ollama
        ? 'local'
        : 'none';
  const ready = mode !== 'none';
  return {
    ready,
    mode,
    defaultModel: platform ? platform.model : auto.length ? auto[0].model : ollama ? ollama.model : null,
    userProviders: userProviders.length,
    message: ready
      ? mode === 'own-keys'
        ? 'Using your connected AI providers.'
        : mode === 'local'
          ? 'Using the local AI model on this machine.'
          : 'Platform AI is ready — no setup needed.'
      : AI_ERRORS.NOT_CONFIGURED,
  };
}
