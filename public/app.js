// NILCODE AI application. This bundle loads only for signed-in users.
const $ = (id) => document.getElementById(id);

let token = localStorage.getItem('nc_token') || '';
let user = null;
let project = null;
let sending = false;
let wired = false;

const api = async (path, opts = {}) => {
  // Relative /api reference: works at root AND under a base path
  // (e.g. xeer0.online/nilcode-live) without any frontend changes.
  const res = await fetch(`api${path}`, {
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    ...opts,
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
};

// ===================================================================== AUTH ==
let mode = 'signin';

function renderAuthMode() {
  const signin = mode === 'signin';
  $('authTitle').textContent = signin ? 'Sign in to NILCODE AI' : 'Create your NILCODE AI account';
  $('authSub').textContent = signin
    ? 'Use your account to access your NILCODE AI workspace.'
    : 'A few details and your workspace is ready.';
  $('authSubmit').textContent = signin ? 'Sign in' : 'Create account';
  $('authName').classList.toggle('hidden', !signin ? false : true);
  $('authSwitchLabel').classList.toggle('hidden', !signin);  // "New to NILCODE AI?"
  $('authSwitch').classList.toggle('hidden', !signin);       // → Create an account
  $('authSwitchLabel2').classList.toggle('hidden', signin);  // "Already have an account?"
  $('authSwitch2').classList.toggle('hidden', signin);       // → Sign in
  ($('authEmail') || {}).focus?.();
}

function setAuthMode(m) {
  mode = m;
  $('authError').textContent = '';
  renderAuthMode();
}

$('authSwitch').addEventListener('click', (e) => { e.preventDefault(); setAuthMode('signup'); });
$('authSwitch2').addEventListener('click', (e) => { e.preventDefault(); setAuthMode('signin'); });

$('authForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const err = $('authError');
  err.textContent = '';
  const email = $('authEmail').value.trim();
  const password = $('authPass').value;
  if (!email || !password) { err.textContent = 'Enter your email and password.'; return; }
  try {
    const path = mode === 'signin' ? '/auth/login' : '/auth/signup';
    const body = { email, password };
    if (mode === 'signup') body.name = $('authName').value.trim();
    const data = await api(path, { method: 'POST', body });
    token = data.token;
    user = data.user;
    localStorage.setItem('nc_token', token);
    enterApp();
  } catch (ex) {
    err.textContent = ex.message;
  }
});

async function loadMe() {
  if (!token) return false;
  try {
    const data = await api('/me');
    user = data.user;
    return true;
  } catch {
    token = '';
    localStorage.removeItem('nc_token');
    return false;
  }
}

function showAuth() {
  $('appView').classList.add('hidden');
  $('authView').classList.remove('hidden');
  setAuthMode('signin');
  $('authEmail').focus();
}

async function signOut() {
  try { await api('/auth/logout', { method: 'POST' }); } catch { /* session already gone */ }
  localStorage.removeItem('nc_token');
  location.reload();
}

// ================================================================== BOOT ==
(async () => {
  if (await loadMe()) enterApp();
  else showAuth();
})();

function enterApp() {
  $('authView').classList.add('hidden');
  $('appView').classList.remove('hidden');
  if (!wired) { wire(); wired = true; }
  $('userBadge').textContent = user?.name || user?.email || '';
  $('userAvatar').textContent = (user?.name || user?.email || '·').slice(0, 1).toUpperCase();
  loadProjects().then((ps) => { if (ps.length && !project) selectProject(ps[0]); });
  refreshGithub();
  refreshProviders();
  refreshAiStatus();
  loadModels();
}

// =============================================================== PROJECTS ==
async function loadProjects() {
  const data = await api('/projects');
  const list = $('projectList');
  list.innerHTML = '';
  for (const p of data.projects) {
    const el = document.createElement('div');
    el.className = 'project-item' + (project?.id === p.id ? ' active' : '');
    const label = document.createElement('span');
    label.textContent = p.name;
    el.appendChild(label);
    const x = document.createElement('button');
    x.className = 'x';
    x.textContent = '✕';
    x.title = 'Delete project';
    x.addEventListener('click', async (e) => {
      e.stopPropagation();
      if (!confirm(`Delete "${p.name}"? This cannot be undone.`)) return;
      await api(`/projects/${p.id}`, { method: 'DELETE' });
      if (project?.id === p.id) { project = null; renderProject(); }
      loadProjects();
    });
    el.appendChild(x);
    el.addEventListener('click', () => selectProject(p));
    list.appendChild(el);
  }
  return data.projects;
}

async function selectProject(p) {
  project = p;
  document.querySelectorAll('.project-item').forEach((el) => {
    el.classList.toggle('active', el.querySelector('span')?.textContent === project.name);
  });
  $('projTitle').textContent = project.name;
  $('runPill').classList.add('hidden');
  $('previewBox').textContent = 'Run the project to see a live preview.';
  $('treeBox').textContent = 'No files yet.';
  $('testBox').textContent = 'No report yet.';
  $('chat').innerHTML = '';
  await Promise.all([loadConversation(), refreshContext()]);
}

function renderProjectEmpty() {
  $('projTitle').textContent = 'NILCODE';
  $('chat').innerHTML = '';
  $('chatEmpty').classList.remove('hidden');
}

async function newProject() {
  const name = $('npName').value.trim();
  if (!name) { $('npName').focus(); return; }
  const description = $('npDesc').value.trim(); // optional
  $('npCreate').disabled = true;
  try {
    const data = await api('/projects', { method: 'POST', body: { name, description } });
    $('newProjectModal').close();
    $('npName').value = '';
    $('npDesc').value = '';
    await loadProjects();
    await selectProject(data.project);
    if (description) {
      bubble('assistant', `Project context saved. When you describe what to build, NILCODE AI will work from: “${description}”`);
    }
  } catch (ex) {
    alert(ex.message);
  } finally {
    $('npCreate').disabled = false;
  }
}

// ============================================================= CONVERSATION ==
function bubble(role, text, meta) {
  $('chatEmpty').classList.add('hidden');
  const wrap = document.createElement('div');
  wrap.className = `msg ${role}`;
  const b = document.createElement('div');
  b.className = 'bubble';
  b.textContent = text;
  wrap.appendChild(b);
  if (meta) {
    const m = document.createElement('div');
    m.className = 'msg-meta';
    m.textContent = meta;
    wrap.appendChild(m);
  }
  $('chat').appendChild(wrap);
  $('chatScroll').scrollTop = $('chatScroll').scrollHeight;
  return b;
}

async function loadConversation() {
  if (!project) return;
  const data = await api(`/projects/${project.id}/context`).catch(() => null);
  if (!data) return;
  $('chat').innerHTML = '';
  const messages = data.conversation?.messages || [];
  if (messages.length) $('chatEmpty').classList.add('hidden');
  else $('chatEmpty').classList.remove('hidden');
  for (const m of messages) bubble(m.role, m.content);
}

// ================================================================= CHAT ==
async function send() {
  if (sending) return;
  const input = $('prompt');
  const text = input.value.trim();
  if (!text && !attachments.length) return;

  // Persist attachments to isolated per-user storage; they become project
  // context the AI can reference in this and later requests.
  let uploaded = [];
  if (attachments.length) {
    setStatus('Uploading attachments…');
    try {
      uploaded = await uploadAttachments();
    } catch (err) {
      bubble('assistant', `Attachment upload failed: ${err.message}`);
      return;
    }
  }
  const attachmentNote = uploaded.length
    ? '\n\n' + uploaded.map((a) => `[Attached: ${a.name} (${a.kind})]`).join('\n')
    : '';

  // First message with no project: ask the server for a short semantic title
  // derived from the assignment (never a truncated prompt), create the
  // project, and send the full request as its intent.
  if (!project) {
    let name = '';
    try {
      const t = await api('/projects/auto', { method: 'POST', body: { prompt: text } });
      name = t.name;
    } catch { /* heuristic fallback happens server-side anyway */ }
    try {
      const data = await api('/projects', {
        method: 'POST',
        body: { name: name || 'New Project', description: text.slice(0, 500) },
      });
      await loadProjects();
      await selectProject(data.project);
    } catch (err) {
      bubble('assistant', `Could not create a project: ${err.message}`);
      return;
    }
  }

  attachments = [];
  renderAttachments();

  const prompt = text + attachmentNote;
  input.value = '';
  input.style.height = 'auto';
  sending = true;
  $('sendBtn').disabled = true;
  bubble('user', text || '(files only)');
  setStatus('Working…');

  resetActivity();

  try {
    const res = await fetch(`api/projects/${project.id}/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify({ prompt, model: currentModel || undefined }),
    });
    if (!res.ok || !res.body) {
      const data = await res.json().catch(() => ({}));
      throw new Error(data.error || `Chat failed (${res.status})`);
    }
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = '';
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let idx;
      while ((idx = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, idx).trim();
        buf = buf.slice(idx + 1);
        if (!line) continue;
        let ev;
        try { ev = JSON.parse(line); } catch { continue; }
        handleEvent(ev);
      }
    }
  } catch (err) {
    bubble('assistant', `Something went wrong: ${err.message}`);
  } finally {
    sending = false;
    $('sendBtn').disabled = false;
    setStatus('Ready');
    refreshContext();
  }
}

// =========================================== ACTIVITY (real agent events) ==
let activitySteps = [];
let runningIdx = -1;
let streamBubble = null;
let streamBuf = '';
let streamWinner = false; // deltas only count from the provider that won
let filesCardEl = null;

function resetActivity() {
  activitySteps = [];
  runningIdx = -1;
  streamBubble = null;
  streamBuf = '';
  streamWinner = false;
  filesCardEl = null;
  const panel = $('activity');
  panel.classList.remove('hidden', 'completed');
  $('activityTitle').textContent = 'Working…';
  $('activitySummary').classList.add('hidden');
  renderActivity();
}

function activityStart(title) {
  // Identical consecutive stages (round-to-round "Working…") stay one entry.
  const last = activitySteps[activitySteps.length - 1];
  if (last && last.title === title && last.state === 'running') return;
  if (runningIdx >= 0 && activitySteps[runningIdx]) activitySteps[runningIdx].state = 'done';
  activitySteps.push({ title, state: 'running' });
  runningIdx = activitySteps.length - 1;
  renderActivity();
}

function activityFinishCurrent() {
  if (runningIdx >= 0 && activitySteps[runningIdx]) activitySteps[runningIdx].state = 'done';
  runningIdx = -1;
  renderActivity();
}

function renderActivity() {
  const list = $('activityList');
  list.innerHTML = '';
  for (const s of activitySteps) {
    const el = document.createElement('div');
    el.className = `act ${s.state}`;
    const ico = document.createElement('span');
    ico.className = 'ico';
    ico.textContent = s.state === 'done' ? '✓' : s.state === 'error' ? '✕' : '●';
    const t = document.createElement('span');
    t.textContent = s.title;
    el.appendChild(ico);
    el.appendChild(t);
    if (s.note) {
      const n = document.createElement('span');
      n.className = 'note';
      n.textContent = ` — ${s.note}`;
      el.appendChild(n);
    }
    list.appendChild(el);
  }
}

// One expandable card per run, updated live: “3 files created · 1 file updated”.
function upsertFilesCard(ev) {
  const created = ev.created || [];
  const updated = ev.updated || [];
  if (!created.length && !updated.length) return;
  $('chatEmpty').classList.add('hidden');
  if (!filesCardEl) {
    filesCardEl = document.createElement('details');
    filesCardEl.className = 'files-card';
    const summary = document.createElement('summary');
    const list = document.createElement('ul');
    list.className = 'files-list';
    filesCardEl.appendChild(summary);
    filesCardEl.appendChild(list);
    $('chat').appendChild(filesCardEl);
    $('chatScroll').scrollTop = $('chatScroll').scrollHeight;
  }
  const parts = [];
  if (created.length) parts.push(`${created.length} file${created.length === 1 ? '' : 's'} created`);
  if (updated.length) parts.push(`${updated.length} file${updated.length === 1 ? '' : 's'} updated`);
  filesCardEl.querySelector('summary').textContent = parts.join(' · ');
  const list = filesCardEl.querySelector('.files-list');
  list.innerHTML = '';
  for (const p of [...created.map((p) => `＋ ${p}`), ...updated.map((p) => `↻ ${p}`)]) {
    const li = document.createElement('li');
    li.textContent = p;
    list.appendChild(li);
  }
}

// Streams arrive as the agent's final JSON envelope. Unwrap "summary"/"reply"
// incrementally so the user watches the real answer form; tool-call rounds are
// never shown as raw JSON.
function streamUnwrap() {
  const m = streamBuf.match(/"(?:summary|reply)"\s*:\s*"((?:[^"\\]|\\.)*)/);
  if (!m) return null;
  let text = m[1];
  try { text = JSON.parse(`"${text}"`); } catch { /* still escaping — show as-is */ }
  return text;
}

function handleEvent(ev) {
  switch (ev.type) {
    case 'status':
      setStatus(ev.text);
      break;
    case 'plan':
      $('activityTitle').textContent = 'Building…';
      break;
    case 'activity':
      activityStart(ev.text);
      break;
    case 'files':
      upsertFilesCard(ev);
      break;
    case 'stream_start':
      streamWinner = true;
      if (!streamBubble) {
        streamBubble = bubble('assistant', '');
        streamBubble.classList.add('streaming');
      }
      break;
    case 'stream_reset':
      // A new round started: discard any partial/unreliable stream text.
      streamBuf = '';
      streamWinner = false;
      if (streamBubble) {
        streamBubble.textContent = '';
        streamBubble.classList.remove('streaming');
        streamBubble.parentElement?.remove();
        streamBubble = null;
      }
      break;
    case 'token': {
      if (!streamWinner) break; // ignore deltas from non-winning attempts
      streamBuf += ev.text || '';
      const unwrapped = streamUnwrap();
      if (streamBubble && unwrapped !== null) {
        streamBubble.textContent = unwrapped;
        $('chatScroll').scrollTop = $('chatScroll').scrollHeight;
      }
      break;
    }
    case 'assistant':
      if (streamBubble) {
        streamBubble.textContent = ev.content;
        streamBubble.classList.remove('streaming');
        const meta = streamBubble.parentElement.querySelector('.msg-meta');
        if (!meta && ev.provider) {
          const m = document.createElement('div');
          m.className = 'msg-meta';
          m.textContent = ev.provider;
          streamBubble.parentElement.appendChild(m);
        }
        streamBubble = null;
      } else {
        bubble('assistant', ev.content, ev.provider);
      }
      break;
    case 'error': {
      const b = bubble('assistant', ev.message);
      if (ev.code === 'RATE_LIMITED' || ev.code === 'NOT_CONFIGURED' || ev.code === 'UNAVAILABLE') {
        const row = document.createElement('div');
        row.className = 'retry-row';
        const btn = document.createElement('button');
        btn.className = 'btn btn-quiet retry-btn';
        btn.textContent = 'Try again';
        btn.addEventListener('click', () => retryLast(b));
        row.appendChild(btn);
        b.parentElement.appendChild(row);
      }
      break;
    }
    case 'approval_request': {
      // The agent is blocked on a consequential connector action until the
      // user decides. Only this user can resolve it (server-side check).
      const cardEl = document.createElement('div');
      cardEl.className = 'msg assistant approval-card';
      const rowEl = document.createElement('div');
      rowEl.className = 'bubble';
      const t = document.createElement('div');
      t.className = 'approval-title';
      t.textContent = ev.title || 'Allow this action?';
      rowEl.appendChild(t);
      if (ev.detail) {
        const d = document.createElement('div');
        d.className = 'approval-detail';
        d.textContent = ev.detail;
        rowEl.appendChild(d);
      }
      const btns = document.createElement('div');
      btns.className = 'approval-buttons';
      const ok = document.createElement('button');
      ok.className = 'btn btn-primary';
      ok.textContent = 'Continue';
      const no = document.createElement('button');
      no.className = 'btn btn-quiet';
      no.textContent = 'Cancel';
      const decide = async (decision) => {
        ok.disabled = no.disabled = true;
        try { await api(`/connectors/approvals/${encodeURIComponent(ev.id)}`, { method: 'POST', body: { decision } }); } catch { /* timed out server-side */ }
        cardEl.remove();
        setStatus(decision === 'approve' ? 'Approved — continuing…' : 'Cancelled.');
      };
      ok.addEventListener('click', () => decide('approve'));
      no.addEventListener('click', () => decide('decline'));
      btns.append(ok, no);
      rowEl.appendChild(btns);
      cardEl.appendChild(rowEl);
      $('chat').appendChild(cardEl);
      $('chatScroll').scrollTop = $('chatScroll').scrollHeight;
      setStatus('Waiting for your approval…');
      break;
    }
    case 'done':
      activityFinishCurrent();
      $('activity').classList.add('completed');
      $('activityTitle').textContent = activitySteps.some((s) => s.state === 'error') ? 'Completed with issues' : 'Completed';
      setLoader(false);
      break;
  }
}

// The `< >` mark spins whenever NILCODE is genuinely processing.
function setLoader(on) {
  const l = $('ncLoader');
  if (l) l.classList.toggle('hidden', !on);
}

function setStatus(text, cls = '') {
  $('statusText').textContent = text;
  $('statusPill').className = `status ${cls}`;
  setLoader(text !== 'Ready' && text !== '');
}

// Re-sends the last user message when an AI failure was transient.
function retryLast(bubbleEl) {
  const row = bubbleEl.parentElement;
  let node = row?.previousElementSibling;
  while (node && !node.classList.contains('msg')) node = node.previousElementSibling;
  if (node?.classList.contains('msg') && node.classList.contains('user')) {
    const text = node.querySelector('.bubble')?.textContent || '';
    if (text) { $('prompt').value = text; send(); }
  } else {
    setStatus('Nothing to retry', 'status-err');
  }
}

// ============================================================ ATTACHMENTS ==
const MAX_INLINE_BYTES = 500 * 1024; // inline text preview limit per file
let attachments = [];

function renderAttachments() {
  const box = $('attachments');
  box.innerHTML = '';
  box.classList.toggle('hidden', !attachments.length);
  for (const a of attachments) {
    const chip = document.createElement('span');
    chip.className = 'chip chip-attach';
    if (a.kind === 'image' && a.dataUrl) {
      const img = document.createElement('img');
      img.src = a.dataUrl;
      img.className = 'chip-thumb';
      chip.appendChild(img);
      const label = document.createElement('span');
      label.textContent = a.name;
      chip.appendChild(label);
    } else {
      const label = document.createElement('span');
      label.textContent = `${a.name} (${Math.max(1, Math.round(a.size / 1024))} KB)`;
      chip.appendChild(label);
    }
    const x = document.createElement('button');
    x.textContent = '✕';
    x.className = 'x';
    x.addEventListener('click', () => { attachments = attachments.filter((v) => v !== a); renderAttachments(); });
    chip.appendChild(x);
    box.appendChild(chip);
  }
}

function acceptFiles(files) {
  for (const file of files) {
    const att = { name: file.name, size: file.size, type: file.type || 'file', kind: null, text: null, dataUrl: null, file };
    if (file.type.startsWith('image/')) {
      att.kind = 'image';
      const reader = new FileReader();
      reader.onload = () => { att.dataUrl = reader.result; renderAttachments(); };
      reader.readAsDataURL(file);
    } else if (file.type.startsWith('text/') || /\.(txt|md|log|json|js|ts|css|html|py|csv|ya?ml|xml)$/i.test(file.name)) {
      att.kind = 'text';
      if (file.size <= MAX_INLINE_BYTES) file.text().then((t) => { att.text = t; renderAttachments(); });
    } else {
      att.kind = 'file';
    }
    attachments.push(att);
  }
  renderAttachments();
}

async function uploadAttachments() {
  if (!attachments.length || !project) return [];
  const fd = new FormData();
  for (const a of attachments) fd.append('files', a.file, a.name);
  const res = await fetch(`api/projects/${project.id}/attachments`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}` },
    body: fd,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || 'Upload failed.');
  return data.attachments || [];
}

$('fileInput').addEventListener('change', () => { acceptFiles(Array.from($('fileInput').files)); $('fileInput').value = ''; });

['dragenter', 'dragover'].forEach((evt) =>
  document.addEventListener(evt, (e) => { e.preventDefault(); document.body.classList.add('dragging'); })
);
['dragleave', 'drop'].forEach((evt) =>
  document.addEventListener(evt, (e) => { e.preventDefault(); if (evt === 'drop' || e.relatedTarget === null) document.body.classList.remove('dragging'); })
);
document.addEventListener('drop', (e) => {
  if (e.dataTransfer?.files?.length) acceptFiles(Array.from(e.dataTransfer.files));
});
document.addEventListener('paste', (e) => {
  const files = Array.from(e.clipboardData?.files || []);
  if (files.length) { e.preventDefault(); acceptFiles(files); }
});

// ================================================================ CONTEXT ==
async function refreshContext() {
  if (!project) return;
  const data = await api(`/projects/${project.id}/context`).catch(() => null);
  if (!data) return;
  $('treeBox').innerHTML = '';
  const tree = data.tree || [];
  if (!tree.length) { $('treeBox').textContent = 'No files yet.'; return; }
  for (const f of tree) {
    const el = document.createElement('div');
    el.className = 'file' + (f.endsWith('/') ? ' dir' : '');
    el.textContent = f;
    if (!f.endsWith('/')) el.addEventListener('click', () => openFile(f));
    $('treeBox').appendChild(el);
  }
}

async function openFile(path) {
  try {
    const f = await api(`/projects/${project.id}/files?path=${encodeURIComponent(path)}`);
    const w = window.open('', '_blank', 'width=760,height=640');
    w.document.write(`<pre style="font:12px/1.5 ui-monospace,monospace; padding:16px; white-space:pre-wrap;">${f.content.replace(/[<>&]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' }[c]))}</pre>`);
    w.document.title = path;
  } catch (err) {
    alert(err.message);
  }
}

// ============================================================== RUN / TEST ==
async function runProject() {
  if (!project) return;
  setStatus('Starting…');
  try {
    const data = await api(`/projects/${project.id}/run`, { method: 'POST' });
    $('runPill').textContent = `Running :${data.port}`;
    $('runPill').classList.remove('hidden');
    $('previewBox').innerHTML = `<iframe src="${data.url}" sandbox="allow-scripts allow-same-origin allow-forms"></iframe>`;
  } catch (err) {
    setStatus(err.message, 'status-err');
  }
}

async function stopProject() {
  if (!project) return;
  await api(`/projects/${project.id}/stop`, { method: 'POST' });
  $('runPill').classList.add('hidden');
  $('previewBox').textContent = 'Run the project to see a live preview.';
}

async function testProject() {
  if (!project) return;
  setStatus('Testing…');
  $('testBox').textContent = 'Running browser tests…';
  try {
    await api(`/projects/${project.id}/run`, { method: 'POST' });
    const r = await api(`/projects/${project.id}/test`, { method: 'POST' });
    renderTest(r);
    setStatus(r.ok ? 'Tests passed' : 'Tests found issues', r.ok ? 'status-ok' : 'status-err');
  } catch (err) {
    $('testBox').textContent = err.message;
    setStatus('Test failed', 'status-err');
  }
}

function renderTest(r) {
  const box = $('testBox');
  box.innerHTML = '';
  if (r.skipped) { box.innerHTML = `<div class="hint">${r.message}</div>`; return; }
  if (r.error) {
    const el = document.createElement('div');
    el.className = 'test-item bad';
    el.textContent = `Testing error: ${r.error}`;
    box.appendChild(el);
  }
  for (const item of r.results || []) {
    const el = document.createElement('div');
    el.className = 'test-item';
    el.innerHTML = `<span class="${item.ok ? 'ok' : 'bad'}">${item.ok ? '✓' : '✕'}</span><span></span>`;
    el.lastElementChild.textContent = `${item.check} — ${item.detail || ''}`;
    box.appendChild(el);
  }
  if (r.consoleErrors?.length) {
    const el = document.createElement('div');
    el.className = 'test-item bad';
    el.textContent = `${r.consoleErrors.length} console error(s)`;
    box.appendChild(el);
  }
}

// ================================================================= GITHUB ==
async function refreshGithub() {
  try {
    const s = await api('/github/status');
    $('ghBadge') && ($('ghBadge').textContent = s.connected ? 'GitHub: connected' : 'GitHub: not connected');
  } catch { /* ignore */ }
}

async function publish() {
  if (!project) return;
  const s = await api('/github/status');
  if (!s.connected) { openSettings(); $('ghState').textContent = 'Connect a GitHub token first, then publish.'; return; }
  $('pubName').value = project.name.toLowerCase().replace(/[^a-z0-9-_]+/g, '-');
  $('publishModal').showModal();
}

async function doPublish() {
  try {
    $('pubOk').disabled = true;
    const out = await api(`/projects/${project.id}/publish`, {
      method: 'POST',
      body: { name: $('pubName').value.trim(), isPrivate: $('pubPrivate').checked },
    });
    $('publishModal').close();
    bubble('assistant', `Published to GitHub: ${out.url} (branch ${out.branch}).`);
  } catch (err) {
    bubble('assistant', `Publish failed: ${err.message}`);
  } finally {
    $('pubOk').disabled = false;
  }
}

// ================================================================== MODELS ==
let models = [];
let currentModel = localStorage.getItem('nc_model') || '';

async function loadModels() {
  try {
    const data = await api('/ai/models');
    models = data.models || [];
    renderModelSelect();
  } catch { /* status endpoint still works; selector stays hidden */ }
}

function renderModelSelect() {
  const sel = $('modelSelect');
  if (!models.length) { sel.classList.add('hidden'); return; }
  sel.classList.remove('hidden');
  sel.innerHTML = '';
  for (const m of models) {
    const opt = document.createElement('option');
    opt.value = m.id;
    opt.textContent = m.label;
    sel.appendChild(opt);
  }
  if (models.some((m) => m.id === currentModel)) sel.value = currentModel;
  else { sel.value = models[0].id; currentModel = models[0].id; }
}

$('modelSelect').addEventListener('change', (e) => {
  currentModel = e.target.value;
  if (currentModel) localStorage.setItem('nc_model', currentModel);
  else localStorage.removeItem('nc_model');
});

// ================================================================ SETTINGS ==
async function refreshAiStatus() {
  try {
    const s = await api('/ai/status');
    const lines = [s.message];
    if (s.mode === 'platform' && s.usage) {
      lines.push(`Platform usage today: ${s.usage.used}/${s.usage.limit} requests.`);
    }
    $('aiStatus').textContent = lines.join(' ');
  } catch (err) {
    $('aiStatus').textContent = 'AI status unavailable.';
  }
}

async function refreshProviders() {
  try {
    const data = await api('/providers');
    const list = $('provList');
    list.innerHTML = '';
    if (!data.providers.length) return;
    for (const p of data.providers) {
      const el = document.createElement('div');
      el.className = 'prov-item';
      el.innerHTML = '<span><b></b> <span class="hint"></span></span><button class="btn btn-quiet">Remove</button>';
      el.querySelector('b').textContent = p.label;
      el.querySelector('.hint').textContent = `${p.type}${p.model ? ' · ' + p.model : ''}${p.free ? ' · free' : ''}`;
      el.querySelector('button').addEventListener('click', async () => {
        await api(`/providers/${p.id}`, { method: 'DELETE' });
        refreshProviders();
        refreshAiStatus();
      });
      list.appendChild(el);
    }
  } catch { /* not signed in */ }
}

async function addProvider() {
  try {
    await api('/providers', {
      method: 'POST',
      body: {
        type: $('provType').value,
        label: $('provLabel').value.trim() || undefined,
        baseUrl: $('provBase').value.trim() || undefined,
        model: $('provModel').value.trim() || undefined,
        apiKey: $('provKey').value.trim() || undefined,
        free: $('provFree').checked,
      },
    });
    $('provKey').value = '';
    refreshProviders();
    refreshAiStatus();
  } catch (err) {
    alert(err.message);
  }
}

async function saveGithubToken() {
  try {
    await api('/github/token', { method: 'POST', body: { token: $('ghToken').value.trim() } });
    $('ghState').textContent = 'GitHub connected.';
    $('ghToken').value = '';
    refreshGithub();
  } catch (err) {
    $('ghState').textContent = err.message;
  }
}

function openSettings() {
  $('accountInfo').textContent = `${user?.name || ''} · ${user?.email || ''}`;
  $('settingsModal').showModal();
  refreshProviders();
  refreshAiStatus();
  refreshGithub();
}

async function commitNow() {
  if (!project) return;
  const msg = prompt('Commit message:', 'Update from NILCODE');
  if (!msg) return;
  try {
    const r = await api(`/projects/${project.id}/git/commit`, { method: 'POST', body: { message: msg } });
    bubble('assistant', r.ok ? `Committed: ${msg}` : `Commit: ${r.output}`);
  } catch (err) {
    bubble('assistant', `Commit failed: ${err.message}`);
  }
}

// ============================================================= CONNECTORS ==
// Catalog + per-user connections. The server never returns secrets: the
// catalog endpoint is metadata-only (safeMeta), so the UI can show status but
// never credentials. OAuth flows open in a popup; the callback page closes
// itself and we refresh the catalog when it disappears.
let connCatalog = [];
let connFilter = '';
const connMeta = {}; // id -> catalog entry (statuses, scopes, pricing)

const CATEGORY_LABELS = {
  database: 'Database', hosting: 'Hosting', auth: 'Authentication', messaging: 'Messaging',
  payments: 'Payments', api: 'API & Backend', vcs: 'Version control', monitoring: 'Monitoring',
  email: 'Email', ai: 'AI', cms: 'CMS', media: 'Media', productivity: 'Productivity',
};

function monogram(name) {
  return name.split(/\s+/).map((w) => w[0]).join('').slice(0, 2).toUpperCase();
}

async function openConnectors() {
  $('connectorsModal').showModal();
  connSearchRender();
  await loadConnectors();
}

async function loadConnectors() {
  const grid = $('connGrid');
  grid.innerHTML = '<div class="conn-hint muted">Loading connectors…</div>';
  try {
    const data = await api('/connectors/catalog');
    connCatalog = data.connectors || [];
    for (const c of connCatalog) connMeta[c.id] = c;
  } catch (err) {
    grid.innerHTML = `<div class="conn-hint muted">Could not load connectors: ${escapeHtmlErr(err.message)}</div>`;
    return;
  }
  renderConnectorCards();
}

function escapeHtmlErr(s) {
  return String(s).replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
}

function renderConnectorCards() {
  const grid = $('connGrid');
  grid.innerHTML = '';
  const q = connFilter.trim().toLowerCase();
  const items = connCatalog.filter((c) =>
    !q || c.name.toLowerCase().includes(q) || c.description.toLowerCase().includes(q) ||
    (CATEGORY_LABELS[c.category] || c.category).toLowerCase().includes(q));
  if (!items.length) {
    grid.innerHTML = '<div class="conn-hint muted">No connectors match your search.</div>';
    return;
  }
  for (const c of items) grid.appendChild(connectorCard(c));
}

function connectorCard(c) {
  const card = document.createElement('div');
  card.className = 'conn-card';

  const head = document.createElement('div');
  head.className = 'conn-head';
  const logo = document.createElement('div');
  logo.className = 'conn-logo';
  logo.textContent = monogram(c.name);
  const nameWrap = document.createElement('div');
  nameWrap.className = 'conn-name-wrap';
  const nm = document.createElement('div');
  nm.className = 'conn-name';
  nm.textContent = c.name;
  const cat = document.createElement('div');
  cat.className = 'conn-cat';
  cat.textContent = CATEGORY_LABELS[c.category] || c.category;
  nameWrap.append(nm, cat);
  const status = document.createElement('span');
  status.className = c.connection ? 'conn-status conn-status-on' : 'conn-status';
  status.textContent = c.connection ? 'Connected' : (c.implemented ? 'Not connected' : 'Coming soon');
  head.append(logo, nameWrap, status);

  const desc = document.createElement('p');
  desc.className = 'conn-desc';
  desc.textContent = c.description;

  const actions = document.createElement('div');
  actions.className = 'conn-actions';

  if (c.connection) {
    const manage = document.createElement('button');
    manage.className = 'btn btn-quiet';
    manage.textContent = 'Manage';
    manage.addEventListener('click', () => manageConnector(c));
    const disconnect = document.createElement('button');
    disconnect.className = 'btn btn-quiet conn-disconnect';
    disconnect.textContent = 'Disconnect';
    disconnect.addEventListener('click', async () => {
      if (!confirm(`Disconnect ${c.name}? NILCODE will lose access until you connect it again.`)) return;
      await api(`/connectors/${c.id}/disconnect`, { method: 'POST' });
      await loadConnectors();
    });
    actions.append(manage, disconnect);
  } else if (c.implemented) {
    const connect = document.createElement('button');
    connect.className = 'btn btn-primary';
    connect.textContent = 'Connect';
    connect.addEventListener('click', () => connectConnector(c));
    actions.appendChild(connect);
  } else {
    const soon = document.createElement('span');
    soon.className = 'conn-soon';
    soon.textContent = 'In development';
    actions.appendChild(soon);
  }

  card.append(head, desc, actions);
  if (c.pricing) {
    const price = document.createElement('p');
    price.className = 'conn-pricing';
    price.textContent = c.pricing;
    card.appendChild(price);
  }
  return card;
}

// Connect: OAuth connectors open the provider's authorize page in a popup;
// API-key/PAT connectors show a small credential form.
async function connectConnector(c) {
  if (c.authType === 'oauth') {
    setStatus(`Connecting to ${c.name}…`);
    try {
      const { url } = await api(`/connectors/${c.id}/oauth/start`, { method: 'POST' });
      const w = window.open(url, 'nilcode-oauth', 'width=520,height=680');
      if (!w) { setStatus(`${c.name}: popup blocked — allow popups and retry.`, 'status-err'); return; }
      // The callback page closes itself; poll until the popup is gone, then
      // refresh the catalog to pick up the new connection.
      const timer = setInterval(() => {
        if (w.closed) { clearInterval(timer); loadConnectors().then(() => setStatus('Ready')); }
      }, 500);
    } catch (err) {
      setStatus(err.message, 'status-err');
    }
    return;
  }
  if (c.authType === 'api_key') {
    showTokenForm(c);
  }
}

function showTokenForm(c) {
  const grid = $('connGrid');
  const form = document.createElement('div');
  form.className = 'conn-token-form';
  const title = document.createElement('h3');
  title.className = 'conn-token-title';
  title.textContent = `Connect ${c.name}`;
  const note = document.createElement('p');
  note.className = 'conn-token-note';
  note.textContent = c.note || 'The token is stored encrypted on the server and never shown again.';
  form.append(title, note);
  const inputs = [];
  for (const f of (c.fields || [{ name: 'token', label: 'Personal access token', secret: true }])) {
    const label = document.createElement('label');
    label.className = 'field';
    const span = document.createElement('span');
    span.className = 'field-label';
    span.textContent = f.label;
    const input = document.createElement('input');
    input.type = f.secret ? 'password' : 'text';
    input.className = 'input';
    input.autocomplete = 'off';
    label.append(span, input);
    form.appendChild(label);
    inputs.push([f.name, input]);
  }
  const row = document.createElement('div');
  row.className = 'modal-actions';
  const cancel = document.createElement('button');
  cancel.className = 'btn btn-quiet';
  cancel.textContent = 'Cancel';
  cancel.addEventListener('click', () => renderConnectorCards());
  const save = document.createElement('button');
  save.className = 'btn btn-primary';
  save.textContent = 'Save and connect';
  save.addEventListener('click', async () => {
    const body = {};
    for (const [name, input] of inputs) body[name] = input.value.trim();
    if (!Object.values(body).some(Boolean)) return;
    try {
      await api(`/connectors/${c.id}/token`, { method: 'POST', body });
      await loadConnectors();
      setStatus(`${c.name} connected.`);
    } catch (err) {
      setStatus(err.message, 'status-err');
    }
  });
  row.append(cancel, save);
  form.appendChild(row);
  grid.innerHTML = '';
  grid.appendChild(form);
}

// Manage: show real resources on the connected service and, when a project
// is open, offer to attach one to THIS project.
async function manageConnector(c) {
  const grid = $('connGrid');
  grid.innerHTML = `<div class="conn-hint muted">Loading your ${escapeHtmlErr(c.name)} resources…</div>`;
  let resources = {};
  try {
    const data = await api(`/connectors/${c.id}/manage`);
    resources = data.resources || {};
  } catch (err) {
    grid.innerHTML = `<div class="conn-hint muted">${escapeHtmlErr(err.message)}</div>`;
    const back = document.createElement('button');
    back.className = 'btn btn-quiet';
    back.textContent = 'Back';
    back.addEventListener('click', () => renderConnectorCards());
    grid.appendChild(back);
    return;
  }
  renderConnectorCards();
  const panel = document.createElement('div');
  panel.className = 'conn-manage';
  const title = document.createElement('h3');
  title.className = 'conn-token-title';
  title.textContent = `Manage ${c.name}`;
  panel.appendChild(title);
  const groups = ['projects', 'sites', 'guilds', 'repos'];
  let any = false;
  for (const g of groups) {
    const list = resources[g];
    if (!Array.isArray(list) || !list.length) continue;
    any = true;
    const label = document.createElement('div');
    label.className = 'conn-group-label';
    label.textContent = g[0].toUpperCase() + g.slice(1);
    panel.appendChild(label);
    for (const r of list) {
      const rowEl = document.createElement('div');
      rowEl.className = 'conn-resource';
      const nm = document.createElement('span');
      nm.className = 'conn-resource-name';
      nm.textContent = r.name || r.full_name || r.id;
      rowEl.appendChild(nm);
      if (r.region || r.status) {
        const meta = document.createElement('span');
        meta.className = 'conn-resource-meta';
        meta.textContent = [r.region, r.status].filter(Boolean).join(' · ');
        rowEl.appendChild(meta);
      }
      if (project && g !== 'repos') {
        const attach = document.createElement('button');
        attach.className = 'btn btn-quiet';
        attach.textContent = 'Connect to this project';
        attach.addEventListener('click', async () => {
          const metaBody = g === 'projects' ? { ref: r.id, name: r.name, apiUrl: r.apiUrl }
            : g === 'sites' ? { siteId: r.id, siteName: r.name }
            : { guildId: r.id, guildName: r.name };
          try {
            const out = await api(`/projects/${project.id}/connectors/${c.id}`, { method: 'POST', body: metaBody });
            attach.textContent = 'Attached ✓';
            attach.disabled = true;
            setStatus(`${c.name} attached to project.${out.envWritten?.length ? ' Environment variables written.' : ''}`);
          } catch (err) {
            setStatus(err.message, 'status-err');
          }
        });
        rowEl.appendChild(attach);
      }
      panel.appendChild(rowEl);
    }
  }
  if (!any) {
    const empty = document.createElement('p');
    empty.className = 'hint';
    empty.textContent = 'No resources found on this account.';
    panel.appendChild(empty);
  }
  const back = document.createElement('button');
  back.className = 'btn btn-quiet';
  back.textContent = 'Back';
  back.addEventListener('click', () => renderConnectorCards());
  panel.appendChild(back);
  grid.innerHTML = '';
  grid.appendChild(panel);
}

// ================================================================== WIRING ==
function wire() {
  $('newProjectBtn').addEventListener('click', () => $('newProjectModal').showModal());
  $('npCreate').addEventListener('click', newProject);
  $('npCancel').addEventListener('click', () => $('newProjectModal').close());

  $('sendBtn').addEventListener('click', send);
  const ta = $('prompt');
  ta.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); }
  });
  // Auto-grow composer; typing never re-renders the app.
  ta.addEventListener('input', () => {
    ta.style.height = 'auto';
    ta.style.height = Math.min(ta.scrollHeight, 200) + 'px';
  });

  $('attachBtn').addEventListener('click', () => $('fileInput').click());
  $('runBtn').addEventListener('click', runProject);
  $('stopBtn').addEventListener('click', stopProject);
  $('openPreviewBtn').addEventListener('click', () => {
    const iframe = $('previewBox').querySelector('iframe');
    if (iframe) window.open(iframe.src, '_blank');
  });
  $('testBtn').addEventListener('click', testProject);
  $('commitBtn').addEventListener('click', commitNow);
  $('publishBtn').addEventListener('click', publish);
  $('pubOk').addEventListener('click', doPublish);
  $('pubCancel').addEventListener('click', () => $('publishModal').close());

  $('settingsBtn').addEventListener('click', openSettings);
  $('connectorsBtn').addEventListener('click', openConnectors);
  $('connClose').addEventListener('click', () => $('connectorsModal').close());
  $('connSearch').addEventListener('input', (e) => {
    connFilter = e.target.value;
    // Only re-render the card list; never touch an open token/manage panel.
    if (!$('.conn-token-form') && !$('.conn-manage')) renderConnectorCards();
  });
  $('pairGen').addEventListener('click', async () => {
    try {
      const d = await api('/desktop/pair-code', { method: 'POST' });
      $('pairCode').textContent = d.code;
    } catch (err) {
      $('pairCode').textContent = err.message;
    }
  });
  $('ghSave').addEventListener('click', saveGithubToken);
  $('provAdd').addEventListener('click', addProvider);
  $('settingsClose').addEventListener('click', () => $('settingsModal').close());
  $('signOutBtn').addEventListener('click', signOut);
  $('signOutBtn2').addEventListener('click', signOut);

  $('emptyChips').addEventListener('click', (e) => {
    const chip = e.target.closest('.chip');
    if (!chip) return;
    $('prompt').value = chip.dataset.fill || '';
    $('prompt').focus();
  });
}
