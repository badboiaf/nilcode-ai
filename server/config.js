import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

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

const config = {
  root: ROOT,
  port: Number(process.env.PORT) > 0 ? Number(process.env.PORT) : 4310,
  host: process.env.HOST || '127.0.0.1',
  // Sensitive app data (users, sessions, credentials) lives here:
  dataDir: process.env.NULLCODE_DATA_DIR || join(ROOT, '.nullcode-data'),
  publicDir: join(ROOT, 'public'),
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
  label: process.env.NULLCODE_AI_LABEL || 'NULLCODE default model',
  dailyLimit: Number(process.env.NULLCODE_AI_DAILY_LIMIT) || 0,
};

config.ai = {
  timeoutMs: Number(process.env.NULLCODE_AI_TIMEOUT_MS) || 180000,
};

// Optional free local path: if a local Ollama server is running, NULLCODE can
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
