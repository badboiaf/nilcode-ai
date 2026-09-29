// Supabase capabilities via the Management API (https://api.supabase.com).
// Every call uses the user's OAuth access token, refreshed transparently by
// the oauth engine. Keys fetched for project configuration are written into
// the project's .env server-side and NEVER returned to the browser or model.
import { getValidAccessToken } from '../oauth.js';

const API = 'https://api.supabase.com/v1';

// Actions with real-world consequences must be confirmed by the user before
// the agent executes them (see connector-bridge.js).
export const DESTRUCTIVE = new Set(['createProject']);

async function call(token, path, opts = {}) {
  const res = await fetch(`${API}${path}`, {
    ...opts,
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
      ...(opts.headers || {}),
    },
    signal: AbortSignal.timeout(30000),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Supabase API ${res.status}: ${body.slice(0, 200)}`);
  }
  if (res.status === 204) return null;
  return res.json();
}

export async function listOrganizations(userId) {
  const token = await getValidAccessToken(userId, { id: 'supabase', auth: { tokenUrl: 'https://api.supabase.com/v1/oauth/token' } });
  return call(token, '/organizations');
}

export async function listProjects(userId) {
  const token = await getValidAccessToken(userId, { id: 'supabase', auth: { tokenUrl: 'https://api.supabase.com/v1/oauth/token' } });
  const projects = await call(token, '/projects');
  // Safe shapes only: never expose keys here — the agent sees names/ids/regions.
  return projects.map((p) => ({
    id: p.id,
    name: p.name,
    organization_id: p.organization_id,
    region: p.region,
    status: p.status,
    apiUrl: `https://${p.id}.supabase.co`,
  }));
}

export async function getProject(userId, { ref }) {
  const token = await getValidAccessToken(userId, { id: 'supabase', auth: { tokenUrl: 'https://api.supabase.com/v1/oauth/token' } });
  const p = await call(token, `/projects/${encodeURIComponent(ref)}`);
  return {
    id: p.id, name: p.name, region: p.region, status: p.status,
    apiUrl: `https://${p.id}.supabase.co`,
  };
}

export async function createProject(userId, { organization_id, name, region, db_pass }) {
  const token = await getValidAccessToken(userId, { id: 'supabase', auth: { tokenUrl: 'https://api.supabase.com/v1/oauth/token' } });
  return call(token, '/projects', {
    method: 'POST',
    body: JSON.stringify({ organization_id, name, region, db_pass, plan: 'free' }),
  });
}

// Writes the project's public configuration into the NILCODE project .env.
// The anon key is designed to be public in browser apps; the service-role key
// is stored ENCRYPTED in connector storage and written to the project .env
// (which is server-side and never served), but never returned through any API.
export async function environmentConfiguration(userId, { ref }, projectDir, writeEnv) {
  const token = await getValidAccessToken(userId, { id: 'supabase', auth: { tokenUrl: 'https://api.supabase.com/v1/oauth/token' } });
  const keys = await call(token, `/projects/${encodeURIComponent(ref)}/api-keys`);
  const anon = keys.find((k) => k.name === 'anon' || k.type === 'anon')?.api_key;
  const service = keys.find((k) => k.name === 'service_role' || k.type === 'service_role')?.api_key;
  const lines = [
    '# Supabase (added by NILCODE connector)',
    `SUPABASE_URL=https://${ref}.supabase.co`,
    anon ? `SUPABASE_ANON_KEY=${anon}` : null,
    service ? `SUPABASE_SERVICE_ROLE_KEY=${service}` : null,
  ].filter(Boolean);
  writeEnv(projectDir, lines);
  if (service) {
    const { setSecrets } = await import('../store.js');
    setSecrets(userId, 'supabase', { [`serviceRole.${ref}`]: service });
  }
  return { url: `https://${ref}.supabase.co`, envWritten: lines.length - 1, serviceKeySecured: !!service };
}

export const capabilities = {
  listOrganizations,
  listProjects,
  getProject,
  createProject,
  environmentConfiguration,
};
