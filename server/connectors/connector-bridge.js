// The bridge between the connector platform and the AI agent. Exposes:
//  - connectorContext(): compact prompt text describing what is connected
//  - connectorToolSpecs(): the <tool> descriptors injected into the persona
//  - dispatchConnectorTool(): executes a real capability, returns model-facing
//    results, and gates consequential actions behind user approval
// Secrets never flow through here: capability results are built safe by
// construction, and anything flagged `secret: true` is written to the project
// .env server-side instead of being returned.
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { CATALOG, getCatalogEntry } from './catalog.js';
import { listConnections, getConnection, safeMeta } from './store.js';

// ------------------------------------------------------------- approvals --
// In-process pending approvals: the agent loop awaits the user's decision
// (Approve/Cancel buttons in the chat UI). Timed out = declined.
const pending = new Map();

export function createApproval(userId, info) {
  const id = `ap_${Date.now().toString(36)}${Math.floor(Math.random() * 1e4)}`;
  return { id, userId, createdAt: Date.now(), ...info };
}

export function waitApproval(id, { timeoutMs = 120000, userId } = {}) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      resolve('timeout');
    }, timeoutMs);
    // userId is checked at resolution time: only the requesting user may
    // approve or decline their own connector action.
    pending.set(id, {
      userId,
      resolve: (v) => { clearTimeout(timer); pending.delete(id); resolve(v); },
      createdAt: Date.now(),
    });
  });
}

export function resolveApproval(id, decision, userId) {
  const p = pending.get(id);
  if (!p || (userId && p.userId !== userId)) return false;
  p.resolve(decision === 'approve' ? 'approved' : 'declined');
  return true;
}

// ---------------------------------------------------------------- context --

// Which connectors apply here: user-level connections, plus anything attached
// to this specific project (project attachment stored in .nullcode/connectors.json).
export function projectAttachments(projectDir) {
  const f = join(projectDir, '.nullcode', 'connectors.json');
  if (!existsSync(f)) return {};
  try { return JSON.parse(readFileSync(f, 'utf8')); } catch { return {}; }
}

export function attachToProject(projectDir, connectorId, meta) {
  const f = join(projectDir, '.nullcode', 'connectors.json');
  let data = {};
  try { data = JSON.parse(readFileSync(f, 'utf8')); } catch { /* first */ }
  data[connectorId] = { ...(data[connectorId] || {}), ...meta, attachedAt: Date.now() };
  writeFileSync(f, JSON.stringify(data, null, 2), 'utf8');
  return data[connectorId];
}

export function detachFromProject(projectDir, connectorId) {
  const f = join(projectDir, '.nullcode', 'connectors.json');
  if (!existsSync(f)) return;
  const data = JSON.parse(readFileSync(f, 'utf8'));
  delete data[connectorId];
  writeFileSync(f, JSON.stringify(data, null, 2), 'utf8');
}

export function connectorContext(userId, projectDir) {
  const conns = listConnections(userId);
  const attached = projectAttachments(projectDir);
  const lines = [];
  for (const c of conns) {
    const entry = getCatalogEntry(c.connectorId);
    if (!entry?.implemented) continue;
    const attach = attached[c.connectorId];
    lines.push(
      `- ${entry.name} (connector id: ${entry.id}) — tools: ${entry.capabilities.map((x) => `${entry.id}.${x}`).join(', ')}${
        attach ? ` — ATTACHED to this project: ${JSON.stringify(safeMeta(attach))}` : ''
      }${entry.pricing ? ` — pricing: ${entry.pricing}` : ''}`
    );
  }
  if (!lines.length) return '';
  return [
    '## Connectors (real external services this user connected)',
    ...lines,
    'Call connector tools with <tool>{"tool":"<connector>.<capability>","arguments":{…}}</tool>.',
    'Actions with external consequences (deploying, sending messages, creating paid resources) will ask the user for confirmation automatically — do not apologize for the prompt and do not try to bypass it.',
    'Never invent connector capabilities that are not listed, and never claim an external action succeeded unless a tool result says so.',
  ].join('\n');
}

// ----------------------------------------------------------------- dispatch --

function capabilityModule(connectorId) {
  switch (connectorId) {
    case 'supabase': return import('./capabilities/supabase.js');
    case 'netlify': return import('./capabilities/netlify.js');
    case 'discord': return import('./capabilities/discord.js');
    default: return null;
  }
}

function approvalTitle(entry, capability, args) {
  const a = args || {};
  switch (`${entry.id}.${capability}`) {
    case 'netlify.deploy': return `Deploy this project to Netlify site “${a.siteId || '…'}”?`;
    case 'netlify.createSite': return `Create a new Netlify site “${a.name || '…'}”?`;
    case 'supabase.createProject': return `Create a new Supabase project “${a.name || '…'}”? This may incur charges on your Supabase account.`;
    case 'discord.sendMessage': return `Send a message to Discord channel ${a.channelId || '…'}?`;
    case 'discord.createWebhook': return `Create a Discord webhook in channel ${a.channelId || '…'}?`;
    default: return `Run ${entry.name}.${capability}?`;
  }
}

// Executes `<connector>.<capability>` for real. Returns {ok, result, approval?}.
export async function dispatchConnectorTool({ userId, projectDir, name, args, emitSafe, setStatus }) {
  const [connectorId, capability] = String(name).split('.');
  const entry = getCatalogEntry(connectorId);
  if (!entry || !entry.implemented) {
    return { ok: false, result: `Unknown or unimplemented connector "${connectorId}". Available: ${CATALOG.filter((c) => c.implemented).map((c) => c.id).join(', ')}.` };
  }
  if (!entry.capabilities.includes(capability)) {
    return { ok: false, result: `${entry.name} does not support "${capability}". Supported: ${entry.capabilities.join(', ')}.` };
  }
  const conn = getConnection(userId, connectorId);
  if (!conn) {
    return { ok: false, result: `${entry.name} is not connected. Tell the user to connect it in Settings → Connectors first.` };
  }
  const mod = await capabilityModule(connectorId);
  const fn = mod?.capabilities?.[capability];
  if (typeof fn !== 'function') {
    return { ok: false, result: `Capability ${name} is not implemented yet.` };
  }

  const callArgs = args && typeof args === 'object' ? args : {};
  // Consequential actions require explicit human approval — the model cannot
  // bypass this gate; the engine blocks on the user's decision.
  if (mod.DESTRUCTIVE?.has(capability) || /sendMessage|createWebhook|deploy|createProject|createSite/.test(capability)) {
    const approval = createApproval(userId, {
      connectorId,
      capability,
      args: callArgs,
      title: approvalTitle(entry, capability, callArgs),
      detail: entry.pricing ? `Pricing note: ${entry.pricing}` : null,
    });
    emitSafe?.({ type: 'approval_request', id: approval.id, title: approval.title, detail: approval.detail, connector: entry.name });
    setStatus?.('Waiting for your approval…');
    const decision = await waitApproval(approval.id, { timeoutMs: 120000, userId });
    if (decision !== 'approved') {
      return { ok: false, result: `User ${decision === 'timeout' ? 'did not respond — the action was cancelled' : 'declined'} the ${entry.name} action "${capability}". Do not retry it; continue with the rest of the task.` };
    }
  }

  setStatus?.(`Using ${entry.name}…`);
  try {
    const out = await fn(userId, callArgs, projectDir, upsertEnvVars);
    // Secret-bearing results: write to project .env, report only metadata.
    if (out && typeof out === 'object' && out.secret === true && typeof out.webhookUrl === 'string') {
      upsertEnvVars(projectDir, { DISCORD_WEBHOOK_URL: out.webhookUrl });
      const { id, channelId, name: hookName } = out;
      return { ok: true, result: `Discord webhook "${hookName}" created and saved to the project .env as DISCORD_WEBHOOK_URL (channel ${channelId}).` };
    }
    const text = typeof out === 'string' ? out : JSON.stringify(out, null, 1);
    return { ok: true, result: text.slice(0, 4000) };
  } catch (err) {
    return { ok: false, result: `${entry.name}.${capability} failed: ${err.message}. Read the error and adjust before retrying.` };
  }
}

// ------------------------------------------------------------ env variables --

// Safe per-user env-var filename inside the project dir.
const ENV_FILE = '.env';

// Merge key/values into the project .env without duplicating keys, and never
// delete anything the user added. Returns the list of keys written.
export function upsertEnvVars(projectDir, kv) {
  const f = join(projectDir, ENV_FILE);
  let existing = '';
  try { existing = readFileSync(f, 'utf8'); } catch { /* new file */ }
  const lines = existing.split(/\r?\n/);
  const written = [];
  for (const [key, value] of Object.entries(kv)) {
    if (!/^[A-Z_][A-Z0-9_]*$/i.test(key)) continue;
    const line = `${key}=${value}`;
    let replaced = false;
    for (let i = 0; i < lines.length; i++) {
      if (new RegExp(`^\\s*${key}\\s*=`).test(lines[i])) {
        lines[i] = line;
        replaced = true;
        break;
      }
    }
    if (!replaced) {
      if (lines.length && lines[lines.length - 1] !== '') lines.push('');
      lines.push(line);
    }
    written.push(key);
  }
  writeFileSync(f, lines.join('\n'), 'utf8');
  return written;
}

// Catalog-driven env vars for the Attach flow (server route also uses this).
export function envVarsFor(connectorId, meta) {
  switch (connectorId) {
    case 'supabase':
      return {
        SUPABASE_URL: meta?.apiUrl || `https://${meta?.ref || 'YOUR-PROJECT-REF'}.supabase.co`,
        SUPABASE_ANON_KEY: meta?.anonKey || '',
      };
    case 'netlify':
      return { NETLIFY_SITE_ID: meta?.siteId || '' };
    case 'discord':
      return {};
    default:
      return {};
  }
}
