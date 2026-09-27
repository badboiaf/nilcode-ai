// NULLCODE GitHub module. Uses a per-user personal access token (PAT) stored in
// the user's isolated credentials file. OAuth app flow can be layered on top of
// these same helpers later without changing the API surface.
import { join } from 'node:path';
import config from '../config.js';
import { readJson, writeJson, ensureDir } from '../store.js';

function credsFile(userId) {
  return join(config.usersDir, userId, 'github.json');
}

export function getGithubToken(userId) {
  return readJson(credsFile(userId), {}).token || null;
}

export function setGithubToken(userId, token) {
  ensureDir(join(config.usersDir, userId));
  writeJson(credsFile(userId), {
    token,
    updatedAt: new Date().toISOString(),
  });
}

export function clearGithubToken(userId) {
  writeJson(credsFile(userId), {});
}

export function githubStatus(userId) {
  return { connected: !!getGithubToken(userId) };
}

async function api(userId, path, { method = 'GET', body } = {}) {
  const token = getGithubToken(userId);
  if (!token) throw new Error('GitHub is not connected. Add a token in Settings → GitHub.');
  const res = await fetch(`https://api.github.com${path}`, {
    method,
    headers: {
      accept: 'application/vnd.github+json',
      authorization: `Bearer ${token}`,
      'user-agent': 'NULLCODE',
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`GitHub API ${res.status}: ${text.slice(0, 300)}`);
  }
  return res.status === 204 ? null : res.json();
}

export function getAuthenticatedUser(userId) {
  return api(userId, '/user');
}

export function listRepos(userId) {
  return api(userId, '/user/repos?per_page=100&sort=updated');
}

export function createRepository(userId, { name, isPrivate, description }) {
  return api(userId, '/user/repos', {
    method: 'POST',
    body: { name, private: !!isPrivate, description: description || '', auto_init: false },
  });
}

// Push an existing local project to a (new) GitHub repository.
export async function pushToGithub(projectDir, userId, { owner, name, isPrivate, description }) {
  const { git } = await import('../agent/tools.js');
  let repo = null;
  const repos = await listRepos(userId).catch(() => []);
  const existing = repos.find((r) => r.name === name && r.owner?.login === owner);
  if (existing) {
    repo = existing;
  } else {
    repo = await createRepository(userId, { name, isPrivate, description });
  }
  await git(projectDir, ['remote', 'remove', 'origin']).catch(() => {});
  const tokenUrl = `https://x-access-token:${getGithubToken(userId)}@github.com/${repo.full_name}.git`;
  await git(projectDir, ['remote', 'add', 'origin', tokenUrl]);
  const branch = await git(projectDir, ['rev-parse', '--abbrev-ref', 'HEAD']);
  const head = branch.stdout.trim() || 'main';
  const push = await git(projectDir, ['push', '-u', 'origin', head]);
  if (!push.ok) throw new Error(push.stderr || 'Push failed.');
  // Store the clean URL, never the tokenized one.
  await git(projectDir, ['remote', 'set-url', 'origin', `https://github.com/${repo.full_name}.git`]);
  return { repo: repo.full_name, url: `https://github.com/${repo.full_name}`, branch: head };
}
