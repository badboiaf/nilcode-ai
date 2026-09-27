// NULLCODE application. This bundle loads only for signed-in users.
const $ = (id) => document.getElementById(id);

let token = localStorage.getItem('nc_token') || '';
let user = null;
let project = null;
let sending = false;
let wired = false;

const api = async (path, opts = {}) => {
  const res = await fetch(`/api${path}`, {
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
  $('authTitle').textContent = signin ? 'Sign in to NULLCODE' : 'Create your NULLCODE account';
  $('authSub').textContent = signin
    ? 'Use your account to access your NULLCODE workspace.'
    : 'A few details and your workspace is ready.';
  $('authSubmit').textContent = signin ? 'Sign in' : 'Create account';
  $('authName').classList.toggle('hidden', !signin ? false : true);
  $('authSwitchLabel').classList.toggle('hidden', !signin);  // "New to NULLCODE?"
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
  $('projTitle').textContent = 'NULLCODE';
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
      bubble('assistant', `Project context saved. When you describe what to build, NULLCODE will work from: “${description}”`);
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

  // First message with no project: create one from the request itself so the
  // user can simply describe what they want and go.
  if (!project) {
    const name = (text || 'Untitled project').replace(/\s+/g, ' ').slice(0, 40);
    try {
      const data = await api('/projects', { method: 'POST', body: { name } });
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

  const stepsBox = $('steps');
  stepsBox.innerHTML = '';
  stepsBox.classList.remove('hidden');

  try {
    const res = await fetch(`/api/projects/${project.id}/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify({ prompt }),
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

function handleEvent(ev) {
  const stepsBox = $('steps');
  switch (ev.type) {
    case 'status':
      setStatus(ev.text);
      break;
    case 'plan':
      stepsBox.innerHTML = '';
      ev.steps.forEach((title, i) => {
        const el = document.createElement('div');
        el.className = 'step pending';
        el.dataset.i = i;
        el.innerHTML = '<span class="ico">○</span><span class="title"></span><span class="result"></span>';
        el.querySelector('.title').textContent = `${i + 1}. ${title}`;
        stepsBox.appendChild(el);
      });
      break;
    case 'step': {
      const el = stepsBox.querySelector(`.step[data-i="${ev.index - 1}"]`);
      if (el) {
        el.className = `step ${ev.state}`;
        el.querySelector('.ico').textContent = ev.state === 'done' ? '✓' : ev.state === 'error' ? '✕' : '◐';
        if (ev.result) el.querySelector('.result').textContent = ev.result;
        if (ev.error) el.querySelector('.result').textContent = ev.error;
      }
      break;
    }
    case 'assistant':
      bubble('assistant', ev.content, ev.provider);
      break;
    case 'error':
      bubble('assistant', ev.message);
      break;
    case 'done':
      stepsBox.classList.add('hidden');
      break;
  }
}

function setStatus(text, cls = '') {
  const el = $('statusPill');
  el.textContent = text;
  el.className = `status ${cls}`;
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
  const res = await fetch(`/api/projects/${project.id}/attachments`, {
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

// ================================================================ SETTINGS ==
async function refreshAiStatus() {
  try {
    const s = await api('/ai/status');
    $('aiStatus').textContent = s.message;
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
  const msg = prompt('Commit message:', 'Update from NULLCODE');
  if (!msg) return;
  try {
    const r = await api(`/projects/${project.id}/git/commit`, { method: 'POST', body: { message: msg } });
    bubble('assistant', r.ok ? `Committed: ${msg}` : `Commit: ${r.output}`);
  } catch (err) {
    bubble('assistant', `Commit failed: ${err.message}`);
  }
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
