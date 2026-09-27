// NULLCODE server entry point.
import express from 'express';
import { createReadStream } from 'node:fs';
import { join } from 'node:path';
import { existsSync } from 'node:fs';
import config from './config.js';
import * as auth from './auth.js';
import * as projects from './projects.js';
import { ProviderRegistry } from './providers/registry.js';
import { runAgent, loadConversation } from './agent/engine.js';
import { aiStatus } from './providers/registry.js';
import { authenticateWithGoogle, googleStatus } from './auth/google.js';
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
  // NULLCODE builds from, not just stored metadata.
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
  res.json(await localGit.commit(p.path, String(req.body?.message || 'NULLCODE change')));
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

// ----------------------------------------------------------------- AI status --
api.get('/ai/status', requireAuth, async (req, res) => {
  res.json(await aiStatus(req.user.id));
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
  try {
    // Context engine: choose which of the user's attachments are relevant
    // (pinned project files, this conversation's uploads, explicit mentions).
    const index = listAttachments(req.user.id, { projectId: p.id });
    const selected = selectAttachments({ userId: req.user.id, projectId: p.id, prompt, index });
    const attachments = selected.length ? await buildAttachmentContext({ userId: req.user.id, selected }) : { text: '', images: [] };
    await runAgent({ user: req.user, project: p, prompt, emit, attachments });
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

export default app;

// Allow both `npm start` and test imports.
if (process.env.NULLCODE_NO_LISTEN !== '1') {
  app.listen(config.port, config.host, () => {
    console.log(`NULLCODE running at http://${config.host}:${config.port}`);
  });
}
