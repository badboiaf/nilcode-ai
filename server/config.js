import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

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
};

// Optional free local path: if a local Ollama server is running, NULLCODE can
// use it automatically (no API key, no user setup). Disable with NULLCODE_ALLOW_OLLAMA=0.
config.allowOllama = process.env.NULLCODE_ALLOW_OLLAMA !== '0';
config.ollamaStatusFile = join(config.dataDir, 'ollama-status.json');

export default config;
