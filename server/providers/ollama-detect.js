// Free local AI fallback: detect a running Ollama instance and remember the
// best available model. Runs in the background; NULLCODE never requires it.
import { writeFile, mkdir } from 'node:fs/promises';
import config from '../config.js';

async function writeStatus(data) {
  await mkdir(config.dataDir, { recursive: true });
  await writeFile(config.ollamaStatusFile, JSON.stringify(data, null, 2));
}

const OLLAMA_BASE = process.env.NULLCODE_OLLAMA_URL || 'http://127.0.0.1:11434';

// Preference for small, generally-useful coding-capable models that may be
// installed locally. Whatever exists is fine — nothing is required.
const MODEL_PREFERENCE = /qwen|coder|llama|mistral|gemma|phi|deepseek/i;

export async function probeOllama() {
  try {
    const res = await fetch(`${OLLAMA_BASE}/v1/models`, { signal: AbortSignal.timeout(2500) });
    if (!res.ok) throw new Error(String(res.status));
    const data = await res.json();
    const ids = (data.data || []).map((m) => m.id).filter(Boolean);
    if (!ids.length) throw new Error('no models');
    ids.sort((a, b) => {
      const pa = MODEL_PREFERENCE.test(a) ? 0 : 1;
      const pb = MODEL_PREFERENCE.test(b) ? 0 : 1;
      return pa - pb || a.localeCompare(b);
    });
    await writeStatus({ available: true, model: ids[0], models: ids, baseUrl: `${OLLAMA_BASE}/v1`, checkedAt: new Date().toISOString() });
    return { available: true, model: ids[0] };
  } catch {
    try { await writeStatus({ available: false, checkedAt: new Date().toISOString() }); } catch { /* read-only fs */ }
    return { available: false };
  }
}

// Probe now, then refresh periodically so a later-started Ollama is picked up.
export function startOllamaWatcher() {
  if (!config.allowOllama) return;
  probeOllama();
  setInterval(probeOllama, 60000).unref?.();
}
