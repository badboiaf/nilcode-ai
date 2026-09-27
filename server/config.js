import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';

// When running as a Node Single Executable Application (the Windows .exe),
// module paths live inside the binary — resolve everything from the exe's
// folder instead (public/ and data live next to the executable).
function detectSea() {
  try {
    const require = createRequire(import.meta.url);
    const sea = require('node:sea');
    return typeof sea.isSea === 'function' ? sea.isSea() : false;
  } catch {
    return false;
  }
}
const IS_SEA = detectSea();

function sourceRoot() {
  try {
    return join(dirname(fileURLToPath(import.meta.url)), '..');
  } catch {
    return null; // bundled/embedded (import.meta.url unavailable)
  }
}

function appRoot() {
  if (IS_SEA) return dirname(process.execPath);
  return sourceRoot() || dirname(process.execPath);
}

const ROOT = appRoot();

// Minimal .env loader (no dependency): fills process.env from a .env file next
// to the app, never overriding variables already set in the environment.
function loadDotEnv(dir) {
  try {
    const content = readFileSync(join(dir, '.env'), 'utf8');
    for (const rawLine of content.split(/\r?\n/)) {
      const line = rawLine.trim();
      if (!line || line.startsWith('#')) continue;
      const eq = line.indexOf('=');
      if (eq === -1) continue;
      const key = line.slice(0, eq).trim();
      let val = line.slice(eq + 1).trim();
      if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
        val = val.slice(1, -1);
      }
      if (key && process.env[key] === undefined) process.env[key] = val;
    }
  } catch {
    // No .env file — everything runs on real environment variables.
  }
}
loadDotEnv(ROOT);

const config = {
  root: ROOT,
  port: Number(process.env.PORT) > 0 ? Number(process.env.PORT) : 4310,
  host: process.env.HOST || '127.0.0.1',
  // Optional mount path so the same server can live under a sub-path of a
  // larger site (e.g. NULLCODE_BASE_PATH=/nilcode-live behind a reverse
  // proxy serving xeer0.online). Empty string = serve at root exactly as
  // before (standalone + desktop unchanged). The frontend is written with
  // relative URLs, so it works identically under any base.
  basePath: (process.env.NILCODE_BASE_PATH || '').replace(/\\+$/, ''),
  // Sensitive app data (users, sessions, credentials) lives here:
  dataDir: process.env.NULLCODE_DATA_DIR || join(ROOT, '.nullcode-data'),
  // Operators/embedders may relocate the static assets (e.g. Electron dev mode).
  publicDir: process.env.NULLCODE_PUBLIC_DIR || join(ROOT, 'public'),
  sessionTtlMs: 1000 * 60 * 60 * 24 * 30, // 30 days
};

config.usersDir = join(config.dataDir, 'users');
config.sessionsFile = join(config.dataDir, 'sessions.json');

// ---------------------------------------------------------------- AI access --
// Default AI path for ordinary users. The server (operator) may configure a
// platform-managed provider; individual users can additionally connect their
// own providers in Settings. Users never see or handle platform credentials.
config.platform = {
  type: process.env.NULLCODE_AI_TYPE === 'anthropic' ? 'anthropic' : 'openai-compatible',
  baseUrl: process.env.NULLCODE_AI_BASE_URL || '',
  apiKey: process.env.NULLCODE_AI_API_KEY || '',
  model: process.env.NULLCODE_AI_MODEL || '',
  label: process.env.NULLCODE_AI_LABEL || 'NILCODE AI default model',
  dailyLimit: Number(process.env.NULLCODE_AI_DAILY_LIMIT) || 0,
};

config.ai = {
  timeoutMs: Number(process.env.NULLCODE_AI_TIMEOUT_MS) || 180000,
};

// Built-in platform fallback chain. When the operator has not configured an
// explicit platform provider (NULLCODE_AI_*), the server can use its own
// provider accounts so ordinary users get working AI with zero setup. Keys are
// read server-side only and never sent to any client. Disable in tests with
// NULLCODE_DISABLE_AUTO_AI=1. Each provider can override its model via env.
config.platformAutoProviders = [
  {
    id: 'openrouter',
    type: 'openai-compatible',
    label: process.env.OPENROUTER_LABEL || 'OpenRouter (free)',
    baseUrl: process.env.OPENROUTER_BASE_URL || 'https://openrouter.ai/api/v1',
    apiKey: process.env.OPENROUTER_API_KEY || '',
    model: process.env.OPENROUTER_MODEL || 'openrouter/free',
    free: true,
    platform: true,
  },
  {
    id: 'gemini',
    type: 'openai-compatible',
    label: process.env.GEMINI_LABEL || 'Google Gemini',
    // Gemini's official OpenAI-compatible endpoint.
    baseUrl: process.env.GEMINI_BASE_URL || 'https://generativelanguage.googleapis.com/v1beta/openai',
    apiKey: process.env.GEMINI_API_KEY || '',
    model: process.env.GEMINI_MODEL || 'gemini-flash-latest',
    free: true,
    platform: true,
  },
  {
    id: 'groq',
    type: 'openai-compatible',
    label: process.env.GROQ_LABEL || 'Groq',
    baseUrl: process.env.GROQ_BASE_URL || 'https://api.groq.com/openai/v1',
    apiKey: process.env.GROQ_API_KEY || '',
    model: process.env.GROQ_MODEL || 'openai/gpt-oss-120b',
    free: true,
    platform: true,
  },
].filter((p) => p.apiKey);
if (process.env.NULLCODE_DISABLE_AUTO_AI === '1') config.platformAutoProviders = [];

// Optional free local path: if a local Ollama server is running, the server can
// use it automatically (no API key, no user setup). Disable with NULLCODE_ALLOW_OLLAMA=0.
config.allowOllama = process.env.NULLCODE_ALLOW_OLLAMA !== '0';
config.ollamaStatusFile = join(config.dataDir, 'ollama-status.json');

// Google Identity Services (sign in with Google). Only identity scopes are
// used; no client secret is involved in the GIS ID-token flow. Configure:
//   NULLCODE_GOOGLE_CLIENT_ID        (required)
//   NULLCODE_GOOGLE_ALLOWED_CLIENT_IDS (optional; defaults to CLIENT_ID)
config.google = {
  clientId: process.env.NULLCODE_GOOGLE_CLIENT_ID || '',
  allowedClientIds: (process.env.NULLCODE_GOOGLE_ALLOWED_CLIENT_IDS || process.env.NULLCODE_GOOGLE_CLIENT_ID || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean),
};

export default config;
