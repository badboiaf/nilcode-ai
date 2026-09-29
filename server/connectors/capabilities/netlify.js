// Netlify capabilities via the public API (https://api.netlify.com).
// Deploys use the real file-digest flow: hash every project file, open a
// deploy with the digest map, then upload only the files Netlify is missing.
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { getValidAccessToken } from '../oauth.js';

const API = 'https://api.netlify.com/api/v1';

export const DESTRUCTIVE = new Set(['createSite']);

async function call(token, path, opts = {}) {
  const res = await fetch(`${API}${path}`, {
    ...opts,
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
      ...(opts.headers || {}),
    },
    signal: AbortSignal.timeout(60000),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Netlify API ${res.status}: ${body.slice(0, 200)}`);
  }
  return res.json();
}

// Files the agent may deploy: static assets and sources, ignoring heavy dirs.
function collectFiles(dir) {
  const out = [];
  const IGNORED = new Set(['node_modules', '.git', '.nullcode', 'dist', 'build', '.next']);
  const walk = (d) => {
    for (const name of readdirSync(d)) {
      if (IGNORED.has(name)) continue;
      const p = join(d, name);
      const s = statSync(p);
      if (s.isDirectory()) walk(p);
      else if (s.size < 5 * 1024 * 1024) out.push(p);
    }
  };
  walk(dir);
  return out;
}

export async function listSites(userId) {
  const token = await getValidAccessToken(userId, { id: 'netlify', auth: { tokenUrl: 'https://api.netlify.com/oauth/token' } });
  const sites = await call(token, '/sites?per_page=50');
  return sites.map((s) => ({ id: s.id, name: s.name, ssl_url: s.ssl_url || s.url, updated_at: s.updated_at }));
}

export async function getSite(userId, { siteId }) {
  const token = await getValidAccessToken(userId, { id: 'netlify', auth: { tokenUrl: 'https://api.netlify.com/oauth/token' } });
  const s = await call(token, `/sites/${encodeURIComponent(siteId)}`);
  return { id: s.id, name: s.name, ssl_url: s.ssl_url || s.url, published_deploy: s.published_deploy?.state };
}

export async function createSite(userId, { name }) {
  const token = await getValidAccessToken(userId, { id: 'netlify', auth: { tokenUrl: 'https://api.netlify.com/oauth/token' } });
  const s = await call(token, '/sites', { method: 'POST', body: JSON.stringify({ name }) });
  return { id: s.id, name: s.name, ssl_url: s.ssl_url || s.url };
}

// Real deploy: digest map → required uploads → PUT each file.
export async function deploy(userId, { siteId }, projectDir) {
  const token = await getValidAccessToken(userId, { id: 'netlify', auth: { tokenUrl: 'https://api.netlify.com/oauth/token' } });
  const publishDir = ['public', 'dist', 'build', '.'].map((d) => join(projectDir, d)).find((d) => existsSync(d) && readdirSync(d).length) || projectDir;
  const files = collectFiles(publishDir);
  if (!files.length) throw new Error('No files to deploy.');
  const digests = {};
  for (const abs of files) {
    const rel = relative(publishDir, abs).split(sep).join('/');
    digests[rel] = createHash('sha1').update(readFileSync(abs)).digest('hex');
  }
  const dep = await call(token, `/sites/${encodeURIComponent(siteId)}/deploys`, {
    method: 'POST',
    body: JSON.stringify({ files: digests, async: false }),
  });
  const required = dep.required || [];
  let uploaded = 0;
  for (const sha of required) {
    const rel = Object.entries(digests).find(([, v]) => v === sha)?.[0];
    if (!rel) continue;
    await fetch(`${API}/deploys/${dep.id}/files/${rel}`, {
      method: 'PUT',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/octet-stream' },
      body: readFileSync(join(publishDir, rel)),
      signal: AbortSignal.timeout(120000),
    });
    uploaded++;
  }
  return {
    deployId: dep.id,
    deployUrl: `${dep.ssl_url || `https://${dep.id}--${siteId}.netlify.app`}`,
    adminUrl: `https://app.netlify.com/sites/${siteId}/deploys/${dep.id}`,
    filesTotal: files.length,
    filesUploaded: uploaded,
    state: dep.state,
  };
}

export async function deploymentStatus(userId, { deployId }) {
  const token = await getValidAccessToken(userId, { id: 'netlify', auth: { tokenUrl: 'https://api.netlify.com/oauth/token' } });
  const d = await call(token, `/deploys/${encodeURIComponent(deployId)}`);
  return {
    id: d.id,
    state: d.state,
    url: d.ssl_url,
    error: d.error_message || (d.state === 'error' ? 'Deployment failed — see the Netlify admin log.' : null),
  };
}

export const capabilities = { listSites, getSite, createSite, deploy, deploymentStatus };
