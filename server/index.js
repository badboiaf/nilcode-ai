// NILCODE AI server entry point.
import express from 'express';
import { createReadStream } from 'node:fs';
import { join } from 'node:path';
import { existsSync } from 'node:fs';
import config from './config.js';
import * as auth from './auth.js';
import * as projects from './projects.js';
import { ProviderRegistry } from './providers/registry.js';
import { runAgent, loadConversation } from './agent/engine.js';
import { heuristicProjectTitle, cleanProjectTitle } from './titles.js';
import { aiStatus } from './providers/registry.js';
import { authenticateWithGoogle, googleStatus } from './auth/google.js';
import { checkUsage, usageState } from './ai-usage.js';
import { AI_ERRORS } from './providers/registry.js';
import { createPairingCode, peekPairingCode, consumePairingCode } from './desktop-pairing.js';
import * as tools from './agent/tools.js';
import * as localGit from './git/local.js';
import * as github from './git/github.js';
import * as serve from './runtime/serve.js';
import { testSite } from './runtime/browsertest.js';
import { startOllamaWatcher } from './providers/ollama-detect.js';
import Busboy from 'busboy';
import { MAX_FILE_BYTES, ingestUpload, listAttachments, getAttachment, pinAttachment, deleteAttachment, publicMeta } from './attachments/attachments.js';
import { selectAttachments, buildAttachmentContext, imageToDataUrl } from './attachments/context.js';
import { CATALOG, getCatalogEntry } from './connectors/catalog.js';
import { listConnections, getConnection, setSecrets, removeConnection, safeMeta, getSecret } from './connectors/store.js';
import * as oauth from './connectors/oauth.js';
import { resolveApproval, attachToProject, detachFromProject, envVarsFor, upsertEnvVars } from './connectors/connector-bridge.js';

function escapeHtml(s) {
  return String(s).replace(/[<>&"']/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&#39;' }[c]));
}

const app = express();
app.use(express.json({ limit: '2mb' }));
app.use(express.static(config.publicDir, { index: 'index.html' }));

// Free local AI fallback detection (background, optional, never required).
startOllamaWatcher();

const api = express.Router();

// ------------------------------------------------------------------- auth --
api.post('/auth/signup', (req, res) => {
  const { email, password, name } = req.body || {};
  if (!email || !password || String(password).length < 6) {
    return res.status(400).json({ error: 'Email and a password of at least 6 characters are required.' });
  }
  try {
    const user = auth.createUser({ email, password, name });
    const t = auth.createSession(user.id);
    res.json({ token: t, user });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

api.post('/auth/login', (req, res) => {
  const { email, password } = req.body || {};
  const user = auth.verifyUser(email, password);
  if (!user) return res.status(401).json({ error: 'Wrong email or password.' });
  const t = auth.createSession(user.id);
  res.json({ token: t, user });
});

api.get('/auth/google/status', (req, res) => {
  res.json(googleStatus());
});

api.post('/auth/google', async (req, res) => {
  try {
    const { credential } = req.body || {};
    const { user, created } = await authenticateWithGoogle(credential);
    const t = auth.createSession(user.id);
    res.json({ token: t, user, created });
  } catch (err) {
    res.status(401).json({ error: err.message });
  }
});

api.post('/auth/logout', requireAuth, (req, res) => {
  auth.destroySession(req.authToken);
  res.json({ ok: true });
});

api.get('/me', requireAuth, (req, res) => res.json({ user: req.user }));

function requireAuth(req, res, next) {
  const h = req.headers.authorization || '';
  const t = h.startsWith('Bearer ') ? h.slice(7) : null;
  const user = auth.resolveSession(t);
  if (!user) return res.status(401).json({ error: 'Not signed in.' });
  req.user = user;
  req.authToken = t;
  next();
}

// --------------------------------------------------------------- projects --
api.get('/projects', requireAuth, (req, res) => {
  res.json({ projects: projects.listProjects(req.user.id) });
});

api.post('/projects', requireAuth, (req, res) => {
  const { name, description } = req.body || {};
  if (!name || !String(name).trim()) return res.status(400).json({ error: 'Project name is required.' });
  const desc = String(description || '').trim();
  const p = projects.createProject(req.user.id, { name: String(name).trim().slice(0, 80), description: desc });
  // The description is the project's initial intent — it becomes the context
  // NILCODE AI builds from, not just stored metadata.
  if (desc) tools.setProjectIntent(p.path, desc);
  tools.indexProject(p.path);
  res.json({ project: p });
});

api.delete('/projects/:id', requireAuth, (req, res) => {
  const p = projects.getProject(req.user.id, req.params.id);
  if (!p) return res.status(404).json({ error: 'Project not found.' });
  serve.stopServer(p.id);
  projects.deleteProject(req.user.id, p.id);
  res.json({ ok: true });
});

api.get('/projects/:id/context', requireAuth, (req, res) => {
  const p = projects.getProject(req.user.id, req.params.id);
  if (!p) return res.status(404).json({ error: 'Project not found.' });
  res.json({
    project: p,
    context: tools.readContext(p.path),
    conversation: loadConversation(req.user.id, p.id),
    tree: tools.listTree(p.path),
  });
});

// ------------------------------------------------------------------ files --
api.get('/projects/:id/files', requireAuth, (req, res) => {
  const p = projects.getProject(req.user.id, req.params.id);
  if (!p) return res.status(404).json({ error: 'Project not found.' });
  try {
    if (req.query.tree) return res.json({ tree: tools.listTree(p.path) });
    const f = tools.readFile(p.path, String(req.query.path || ''));
    res.json(f);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

api.put('/projects/:id/files', requireAuth, (req, res) => {
  const p = projects.getProject(req.user.id, req.params.id);
  if (!p) return res.status(404).json({ error: 'Project not found.' });
  const { path, content } = req.body || {};
  try {
    res.json(tools.writeFileTool(p.path, String(path), String(content ?? '')));
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// --------------------------------------------------------------- terminal --
api.post('/projects/:id/terminal', requireAuth, async (req, res) => {
  const p = projects.getProject(req.user.id, req.params.id);
  if (!p) return res.status(404).json({ error: 'Project not found.' });
  const { command } = req.body || {};
  if (!command) return res.status(400).json({ error: 'Command is required.' });
  res.json(await tools.runTerminal(p.path, command));
});

// -------------------------------------------------------------------- git --
api.get('/projects/:id/git', requireAuth, async (req, res) => {
  const p = projects.getProject(req.user.id, req.params.id);
  if (!p) return res.status(404).json({ error: 'Project not found.' });
  res.json(await localGit.status(p.path));
});

api.post('/projects/:id/git/commit', requireAuth, async (req, res) => {
  const p = projects.getProject(req.user.id, req.params.id);
  if (!p) return res.status(404).json({ error: 'Project not found.' });
  res.json(await localGit.commit(p.path, String(req.body?.message || 'NILCODE change')));
});

api.post('/projects/:id/git/checkpoint', requireAuth, async (req, res) => {
  const p = projects.getProject(req.user.id, req.params.id);
  if (!p) return res.status(404).json({ error: 'Project not found.' });
  res.json(await localGit.checkpoint(p.path, String(req.body?.label || 'manual checkpoint')));
});

api.get('/projects/:id/git/branches', requireAuth, async (req, res) => {
  const p = projects.getProject(req.user.id, req.params.id);
  if (!p) return res.status(404).json({ error: 'Project not found.' });
  res.json({ branches: await localGit.listBranches(p.path) });
});

// ---------------------------------------------------------------- github --
api.get('/github/status', requireAuth, (req, res) => res.json(github.githubStatus(req.user.id)));

api.post('/github/token', requireAuth, (req, res) => {
  const { token } = req.body || {};
  if (!token || String(token).length < 20) return res.status(400).json({ error: 'A valid GitHub token is required.' });
  github.setGithubToken(req.user.id, String(token).trim());
  res.json({ ok: true, connected: true });
});

api.post('/github/disconnect', requireAuth, (req, res) => {
  github.clearGithubToken(req.user.id);
  res.json({ ok: true, connected: false });
});

api.get('/github/repos', requireAuth, async (req, res) => {
  try {
    const repos = await github.listRepos(req.user.id);
    res.json({ repos: repos.map((r) => ({ full_name: r.full_name, private: r.private, url: r.html_url })) });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

api.post('/projects/:id/publish', requireAuth, async (req, res) => {
  const p = projects.getProject(req.user.id, req.params.id);
  if (!p) return res.status(404).json({ error: 'Project not found.' });
  const { name, isPrivate, description } = req.body || {};
  if (!name) return res.status(400).json({ error: 'Repository name is required.' });
  try {
    await localGit.ensureRepo(p.path);
    await localGit.commit(p.path, 'Publish to GitHub');
    const out = await github.pushToGithub(p.path, req.user.id, {
      owner: req.body.owner || (await github.getAuthenticatedUser(req.user.id)).login,
      name,
      isPrivate,
      description,
    });
    projects.updateProject(req.user.id, p.id, { repoUrl: out.url });
    res.json(out);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// ------------------------------------------------------------ attachments --
api.post('/projects/:id/attachments', requireAuth, (req, res) => {
  const p = projects.getProject(req.user.id, req.params.id);
  if (!p) return res.status(404).json({ error: 'Project not found.' });
  let busboy;
  try {
    busboy = Busboy({ headers: req.headers, limits: { fileSize: MAX_FILE_BYTES, files: 20 } });
  } catch {
    return res.status(400).json({ error: 'Expected a multipart upload.' });
  }
  const saved = [];
  const failures = [];
  const pending = [];
  let done = false;
  const finish = () => {
    if (done) return;
    // Respond only after every ingest has settled (close can beat async I/O).
    Promise.allSettled(pending).then(() => {
      if (done) return;
      done = true;
      res.json({ attachments: saved, failures });
    });
  };
  busboy.on('file', (name, stream, info) => {
    const filename = info.filename || 'unnamed';
    stream.on('limit', () => failures.push({ file: filename, error: `File exceeds the ${Math.round(MAX_FILE_BYTES / 1024 / 1024)} MB infrastructure limit.` }));
    const run = ingestUpload({
      userId: req.user.id,
      projectId: p.id,
      conversationId: null,
      messageRef: null,
      file: { filename, mime: info.mimeType, stream },
    });
    pending.push(run);
    run
      .then((meta) => saved.push(meta))
      .catch((err) => failures.push({ file: filename, error: err.message }));
  });
  busboy.on('error', (err) => { failures.push({ error: err.message }); finish(); });
  busboy.on('close', finish);
  req.pipe(busboy);
});

api.get('/attachments', requireAuth, (req, res) => {
  res.json({
    attachments: listAttachments(req.user.id, {
      projectId: req.query.projectId || undefined,
      conversationId: req.query.conversationId || undefined,
    }),
  });
});

api.get('/attachments/:attId/content', requireAuth, (req, res) => {
  const a = getAttachment(req.user.id, req.params.attId);
  if (!a) return res.status(404).json({ error: 'Attachment not found.' });
  res.setHeader('content-type', a.mime || 'application/octet-stream');
  res.setHeader('content-disposition', `inline; filename="${encodeURIComponent(a.name)}"`);
  const stream = createReadStream(a.absPath);
  stream.on('error', () => res.destroy());
  stream.pipe(res);
});

api.post('/attachments/:attId/pin', requireAuth, (req, res) => {
  const a = pinAttachment(req.user.id, req.params.attId, !!(req.body?.pinned ?? true));
  if (!a) return res.status(404).json({ error: 'Attachment not found.' });
  res.json({ attachment: a });
});

api.delete('/attachments/:attId', requireAuth, (req, res) => {
  res.json({ deleted: deleteAttachment(req.user.id, req.params.attId) });
});

// ---------------------------------------------------- desktop session handoff --
// Signed-in web user generates a short-lived, single-use code for a desktop
// instance. The code itself is the only credential the desktop needs to send.
api.post('/desktop/pair-code', requireAuth, (req, res) => {
  res.json(createPairingCode(req.user.id));
});

api.get('/desktop/pair-code/:code', (req, res) => {
  const e = peekPairingCode(req.params.code);
  if (!e) return res.status(404).json({ error: 'Code is invalid or expired.' });
  res.json({ valid: true });
});

api.post('/desktop/pair-code/redeem', (req, res) => {
  try {
    const { code } = req.body || {};
    const consumed = consumePairingCode(code);
    if (!consumed) return res.status(400).json({ error: 'Code is invalid, already used, or expired.' });
    const user = auth.getUser(consumed.userId);
    if (!user) return res.status(400).json({ error: 'Account no longer exists.' });
    const t = auth.createSession(user.id);
    res.json({ token: t, user, redeemedAt: new Date().toISOString() });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// ------------------------------------------------------------- connectors --
// Catalog + per-user connections. Secrets stay server-side and encrypted;
// every payload here is metadata-only by construction (safeMeta).
api.get('/connectors/catalog', requireAuth, (req, res) => {
  const conns = new Map(listConnections(req.user.id).map((c) => [c.connectorId, c]));
  res.json({
    connectors: CATALOG.map((c) => ({
      id: c.id,
      name: c.name,
      category: c.category,
      description: c.description,
      implemented: !!c.implemented,
      authType: c.auth?.type || null,
      capabilities: c.capabilities || [],
      pricing: c.pricing || null,
      note: c.note || null,
      scopes: c.auth?.scopeDescriptions
        ? Object.entries(c.auth.scopeDescriptions).map(([scope, description]) => ({ scope, description }))
        : [],
      connection: conns.has(c.id) ? safeMeta(conns.get(c.id)) : null,
    })),
  });
});

// Start an OAuth flow: returns the provider's authorize URL for a popup.
api.post('/connectors/:id/oauth/start', requireAuth, (req, res) => {
  const entry = getCatalogEntry(req.params.id);
  if (!entry || !entry.implemented || entry.auth?.type !== 'oauth') {
    return res.status(404).json({ error: 'Unknown connector.' });
  }
  if (!oauth.clientIdFor(entry)) {
    return res.status(400).json({
      error: `${entry.name} sign-in is not configured on this server yet.`,
    });
  }
  const state = oauth.createState(entry.id, req.user.id);
  const pkce = entry.auth.pkce ? oauth.createPkce() : null;
  if (pkce) setSecrets(req.user.id, entry.id, { pkceVerifier: pkce.verifier });
  const redirect = oauth.redirectUri(req);
  res.json({ url: oauth.authorizeUrl(entry, { state, codeChallenge: pkce?.challenge, redirect }) });
});

// Provider callback: exchange the code, encrypt and store tokens. The page
// shown to the user contains nothing but success/failure copy.
api.get('/connectors/oauth/callback', async (req, res) => {
  try {
    const { code, state } = req.query;
    if (req.query.error) {
      return res.status(400).send(`<!doctype html><title>NILCODE AI</title><p>Authorization failed: ${escapeHtml(req.query.error)}</p>`);
    }
    const st = oauth.verifyState(state);
    if (!st) return res.status(400).send('<!doctype html><title>NILCODE AI</title><p>This authorization link is invalid or expired. Start again from NILCODE.</p>');
    const entry = getCatalogEntry(st.connectorId);
    if (!entry) return res.status(400).send('<!doctype html><title>NILCODE AI</title><p>Unknown connector.</p>');
    const redirect = oauth.redirectUri(req);
    const codeVerifier = entry.auth.pkce ? getSecret(st.userId, entry.id, 'pkceVerifier') : null;
    const tokens = await oauth.exchangeCode(entry, { code, codeVerifier, redirect });
    const secrets = {};
    if (tokens.access_token) secrets.accessToken = tokens.access_token;
    if (tokens.refresh_token) secrets.refreshToken = tokens.refresh_token;
    if (tokens.webhook?.url) secrets.webhookUrl = tokens.webhook.url; // discord webhook.incoming
    setSecrets(st.userId, entry.id, secrets);
    res.send(
      `<!doctype html><html><head><title>NILCODE AI</title><style>body{font-family:-apple-system,'Segoe UI',sans-serif;background:#fff;color:#1d1d1f;display:grid;place-items:center;height:100vh;margin:0}main{text-align:center}h1{font-size:20px}</style></head><body><main><h1>✓ ${escapeHtml(entry.name)} connected</h1><p>You can close this window and return to NILCODE AI.</p></main><script>setTimeout(function(){window.close()},1200)</script></body></html>`
    );
  } catch (err) {
    res.status(400).send(`<!doctype html><title>NILCODE AI</title><p>Connection failed: ${escapeHtml(err.message)}</p>`);
  }
});

// API-key / PAT connectors.
api.post('/connectors/:id/token', requireAuth, (req, res) => {
  const entry = getCatalogEntry(req.params.id);
  if (!entry || !entry.implemented || entry.auth?.type !== 'api_key') {
    return res.status(404).json({ error: 'Unknown connector.' });
  }
  const fields = entry.auth.fields || [];
  const secrets = {};
  for (const f of fields) {
    const v = req.body?.[f.name];
    if (typeof v === 'string' && v.trim()) secrets[f.name] = v.trim();
  }
  if (!Object.keys(secrets).length) return res.status(400).json({ error: 'No credentials provided.' });
  setSecrets(req.user.id, entry.id, secrets);
  res.json({ ok: true, connection: safeMeta(getConnection(req.user.id, entry.id)) });
});

api.post('/connectors/:id/disconnect', requireAuth, (req, res) => {
  if (!getCatalogEntry(req.params.id)) return res.status(404).json({ error: 'Unknown connector.' });
  removeConnection(req.user.id, req.params.id);
  res.json({ ok: true });
});

// Manage: list the user's real resources on a connected service (projects,
// sites, servers…). Used by the Connect-to-project flow and the Manage UI.
api.get('/connectors/:id/manage', requireAuth, async (req, res) => {
  const entry = getCatalogEntry(req.params.id);
  if (!entry || !entry.implemented) return res.status(404).json({ error: 'Unknown connector.' });
  if (!getConnection(req.user.id, entry.id)) return res.status(400).json({ error: 'Not connected.' });
  try {
    switch (entry.id) {
      case 'supabase': {
        const sb = await import('./connectors/capabilities/supabase.js');
        const [projects, organizations] = await Promise.all([sb.listProjects(req.user.id), sb.listOrganizations(req.user.id)]);
        return res.json({ resources: { projects, organizations } });
      }
      case 'netlify': {
        const n = await import('./connectors/capabilities/netlify.js');
        return res.json({ resources: { sites: await n.listSites(req.user.id) } });
      }
      case 'discord': {
        const d = await import('./connectors/capabilities/discord.js');
        return res.json({ resources: { guilds: await d.listGuilds(req.user.id) } });
      }
      case 'github': {
        const g = await import('./connectors/capabilities/github.js');
        return res.json({ resources: { repos: await g.listRepos(req.user.id) } });
      }
      default:
        return res.json({ resources: {} });
    }
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// Human approval of a consequential connector action requested by the agent.
api.post('/connectors/approvals/:id', requireAuth, (req, res) => {
  const ok = resolveApproval(req.params.id, req.body?.decision === 'approve' ? 'approve' : 'decline', req.user.id);
  if (!ok) return res.status(404).json({ error: 'This approval request is no longer active.' });
  res.json({ ok: true });
});

// Attach a connected service to a specific NILCODE project (project-level
// connections) and write its safe env vars into the project .env.
api.post('/projects/:id/connectors/:connectorId', requireAuth, (req, res) => {
  const p = projects.getProject(req.user.id, req.params.id);
  if (!p) return res.status(404).json({ error: 'Project not found.' });
  const entry = getCatalogEntry(req.params.connectorId);
  if (!entry || !entry.implemented) return res.status(404).json({ error: 'Unknown connector.' });
  if (!getConnection(req.user.id, entry.id)) return res.status(400).json({ error: `Connect ${entry.name} first.` });
  const b = req.body || {};
  const meta = {};
  for (const k of ['ref', 'name', 'apiUrl', 'siteId', 'siteName', 'guildId', 'guildName', 'channelId']) {
    if (typeof b[k] === 'string' && b[k].trim()) meta[k] = b[k].trim().slice(0, 200);
  }
  attachToProject(p.path, entry.id, meta);
  const vars = envVarsFor(entry.id, meta);
  const written = Object.keys(vars).length ? upsertEnvVars(p.path, vars) : [];
  res.json({ ok: true, attachment: meta, envWritten: written });
});

api.delete('/projects/:id/connectors/:connectorId', requireAuth, (req, res) => {
  const p = projects.getProject(req.user.id, req.params.id);
  if (!p) return res.status(404).json({ error: 'Project not found.' });
  detachFromProject(p.path, req.params.connectorId);
  res.json({ ok: true });
});

// ------------------------------------------------------------- AI status --
api.get('/ai/status', requireAuth, async (req, res) => {
  res.json({ ...(await aiStatus(req.user.id)), usage: usageState(req.user.id) });
});

// Models for the chat selector. Only entries this server can actually route
// to — never invented in the UI.
api.get('/ai/models', requireAuth, (req, res) => {
  res.json({ models: new ProviderRegistry(req.user.id).listModels() });
});

// Semantic auto-title: when a user sends a coding request without creating a
// project first, derive a short, human-readable project name from the
// assignment (AI cleanup pass when a provider is reachable, deterministic
// heuristic otherwise — never a truncated prompt).
api.post('/projects/auto', requireAuth, async (req, res) => {
  const prompt = String(req.body?.prompt || '').trim();
  if (!prompt) return res.status(400).json({ error: 'Prompt is required.' });
  const fallback = heuristicProjectTitle(prompt);
  let name = fallback;
  try {
    const reg = new ProviderRegistry(req.user.id);
    const out = await reg.chat(
      'planner',
      [
        { role: 'system', content: 'You name software projects. Reply with the project name only — 2 to 4 words, Title Case, no quotes, no punctuation.' },
        { role: 'user', content: prompt.slice(0, 500) },
      ],
      { maxTokens: 24, temperature: 0.2, timeoutMs: 12000 }
    );
    name = cleanProjectTitle(out.text) || fallback;
  } catch {
    // No provider reachable — the heuristic fallback IS the feature.
  }
  res.json({ name, source: name === fallback ? 'heuristic' : 'ai' });
});

// -------------------------------------------------------------- providers --
api.get('/providers', requireAuth, (req, res) => {
  res.json({ providers: new ProviderRegistry(req.user.id).list() });
});

api.post('/providers', requireAuth, (req, res) => {
  try {
    const reg = new ProviderRegistry(req.user.id);
    const entry = reg.add(req.body || {});
    res.json({ provider: { ...entry, apiKey: undefined, hasKey: true } });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

api.delete('/providers/:id', requireAuth, (req, res) => {
  const reg = new ProviderRegistry(req.user.id);
  reg.remove(req.params.id);
  res.json({ ok: true });
});

// ----------------------------------------------------------- run + preview --
api.post('/projects/:id/run', requireAuth, async (req, res) => {
  const p = projects.getProject(req.user.id, req.params.id);
  if (!p) return res.status(404).json({ error: 'Project not found.' });
  const entry = await serve.startServer(p.id, p.path);
  res.json({ url: entry.url, port: entry.port });
});

api.post('/projects/:id/stop', requireAuth, (req, res) => {
  res.json({ stopped: serve.stopServer(req.params.id) });
});

api.get('/projects/:id/preview', requireAuth, (req, res) => {
  const entry = serve.getServer(req.params.id);
  res.json({ running: !!entry, url: entry?.url || null });
});

// ---------------------------------------------------------------- testing --
api.post('/projects/:id/test', requireAuth, async (req, res) => {
  const p = projects.getProject(req.user.id, req.params.id);
  if (!p) return res.status(404).json({ error: 'Project not found.' });
  let entry = serve.getServer(p.id);
  if (!entry) entry = await serve.startServer(p.id, p.path);
  const report = await testSite(entry.url);
  res.json(report);
});

// ------------------------------------------------------ chat (NDJSON stream) --
app.post('/api/projects/:id/chat', requireAuth, async (req, res) => {
  const p = projects.getProject(req.user.id, req.params.id);
  if (!p) return res.status(404).json({ error: 'Project not found.' });
  const prompt = String(req.body?.prompt || '').trim();
  if (!prompt) return res.status(400).json({ error: 'Message is required.' });

  res.writeHead(200, {
    'content-type': 'application/x-ndjson',
    'cache-control': 'no-cache',
    connection: 'keep-alive',
  });
  const emit = (event) => res.write(`${JSON.stringify(event)}\n`);
  // Usage gate for platform AI capacity — authenticated users only reach here.
  const usage = checkUsage(req.user.id);
  if (!usage.allowed) {
    emit({ type: 'error', code: 'RATE_LIMITED', message: AI_ERRORS.RATE_LIMITED, usage });
    emit({ type: 'done' });
    return res.end();
  }
  try {
    // Context engine: choose which of the user's attachments are relevant
    // (pinned project files, this conversation's uploads, explicit mentions).
    const index = listAttachments(req.user.id, { projectId: p.id });
    const selected = selectAttachments({ userId: req.user.id, projectId: p.id, prompt, index });
    const attachments = selected.length ? await buildAttachmentContext({ userId: req.user.id, selected }) : { text: '', images: [] };
    const preferredModel = typeof req.body?.model === 'string' && req.body.model.trim() ? req.body.model.trim() : undefined;
    await runAgent({ user: req.user, project: p, prompt, emit, attachments, preferredModel });
  } catch (err) {
    emit({ type: 'error', message: err.message });
  }
  res.end();
});

app.use('/api', api);
app.use('/api', (req, res) => res.status(404).json({ error: 'Unknown API route.' }));

// SPA fallback for the frontend.
app.get('*', (req, res, next) => {
  if (req.path.startsWith('/api/')) return next();
  const index = join(config.publicDir, 'index.html');
  if (existsSync(index)) return res.sendFile(index);
  res.status(404).end('Not found');
});

// Optional base-path mounting (NILCODE_BASE_PATH=/nilcode-live): lets this
// exact server live under a sub-path of a larger site behind a proxy, with
// zero frontend changes — all frontend URLs are relative. Unset (default)
// behaves exactly as before (standalone + desktop).
function mountAtBase(inner, base) {
  const trimmed = base.replace(/\/+$/, '');
  const prefix = `${trimmed}/`;
  const outer = express();
  outer.use((req, res, next) => {
    if (req.url === trimmed || req.url === prefix || req.url.startsWith(prefix)) {
      // Serve the app directly at both the bare base path and base+/ so any
      // reverse proxy works: some (e.g. Next.js rewrites behind a default
      // trailingSlash:false config) redirect the trailing-slash form back to
      // the bare path, which would loop forever if we 308'd bare → slash.
      // originalUrl is rewritten too: serve-static compares the two and, if
      // originalUrl lacks a trailing slash while the path is '/', it 301s
      // back to the mount prefix — which would loop against such proxies.
      req.originalUrl = req.url = req.url.slice(trimmed.length) || '/';
      // The frontend uses relative URLs everywhere (styles.css, app.js,
      // api/…). Those resolve against the DOCUMENT URL, which under a proxy
      // may be the bare base path WITHOUT a trailing slash — making them
      // resolve at the site root instead of under the base. Injecting
      // <base href="{prefix}"> into HTML responses pins every relative URL
      // to the mount prefix regardless of how the document was reached.
      // Conditional revalidation would let stale cached HTML (served before
      // this injection existed, or by an upstream cache) survive forever as a
      // validator-matched 304 has no body to rewrite — so drop the validators
      // on both sides: requests revalidate to a full 200, and injected
      // responses carry no etag/last-modified to revalidate against.
      if (req.method === 'GET' && (req.headers.accept || '').includes('text/html')) {
        delete req.headers['if-none-match'];
        delete req.headers['if-modified-since'];
        const chunks = [];
        const origWrite = res.write.bind(res);
        const origEnd = res.end.bind(res);
        res.write = (chunk, enc, cb) => {
          chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, typeof enc === 'string' ? enc : 'utf8'));
          return true;
        };
        res.end = (chunk, enc, cb) => {
          if (chunk) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, typeof enc === 'string' ? enc : 'utf8'));
          const body = Buffer.concat(chunks);
          if (String(res.getHeader('content-type') || '').includes('text/html')) {
            const injected = Buffer.from(
              body.toString('utf8').replace(/<head(\s[^>]*)?>/i, (m) => `${m}\n  <base href="${prefix}">`)
            );
            res.removeHeader('etag');
            res.removeHeader('last-modified');
            res.setHeader('content-length', String(injected.length));
            return origEnd(injected);
          }
          return origEnd(body);
        };
      }
      return inner(req, res, next);
    }
    return res.redirect(302, prefix);
  });
  return outer;
}

const publicApp = config.basePath ? mountAtBase(app, config.basePath) : app;
export default publicApp;

// Allow both `npm start` and test imports.
if (process.env.NULLCODE_NO_LISTEN !== '1') {
  publicApp.listen(config.port, config.host, () => {
    console.log(`NILCODE AI running at http://${config.host}:${config.port}${config.basePath}`);
  });
}
