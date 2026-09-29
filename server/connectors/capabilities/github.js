// GitHub connector capability. Uses the token stored by the connector
// framework (encrypted at rest), falling back to the pre-existing Settings →
// GitHub token so both paths work identically for the agent.
import { getSecret } from '../store.js';

export const DESTRUCTIVE = new Set();

async function tokenFor(userId) {
  const fromConnector = getSecret(userId, 'github', 'token');
  if (fromConnector) return fromConnector;
  // Fall back to the existing Settings → GitHub token if present.
  const gh = await import('../../git/github.js');
  return typeof gh.getGithubToken === 'function' ? gh.getGithubToken(userId) : null;
}

export async function listRepos(userId) {
  const token = await tokenFor(userId);
  if (!token) throw new Error('No GitHub token stored.');
  const res = await fetch('https://api.github.com/user/repos?per_page=50&sort=updated', {
    headers: {
      authorization: `Bearer ${token}`,
      accept: 'application/vnd.github+json',
      'user-agent': 'NILCODE-AI',
    },
    signal: AbortSignal.timeout(30000),
  });
  if (!res.ok) throw new Error(`GitHub API ${res.status}`);
  const repos = await res.json();
  return repos.map((r) => ({ id: r.id, name: r.full_name, private: r.private, url: r.html_url }));
}

export const capabilities = { listRepos };
