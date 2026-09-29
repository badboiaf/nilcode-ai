// Tools available to the agent. Every tool takes a project directory and
// returns a plain result object; the loop translates these into UI events.
import { readFileSync, writeFileSync, mkdirSync, readdirSync, statSync, rmSync, existsSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { join, dirname, relative, extname } from 'node:path';
import { safeJoin } from '../projects.js';

const IGNORED = new Set(['node_modules', '.git', 'dist', 'build', '.next', '.nullcode', '.nullcode-data']);

export function runTerminal(projectDir, command, timeoutMs = 120000) {
  const blocked = /(rm\s+-rf\s+\/|mkfs|format\s+[a-z]:|shutdown|del\s+\/[sq])/i;
  if (blocked.test(command)) return Promise.resolve({ ok: false, error: 'Command blocked by safety policy.' });
  return new Promise((resolve) => {
    execFile(
      process.platform === 'win32' ? 'cmd' : 'sh',
      process.platform === 'win32' ? ['/c', command] : ['-c', command],
      { cwd: projectDir, timeout: timeoutMs, maxBuffer: 1024 * 1024 * 4, windowsHide: true },
      (err, stdout, stderr) => {
        resolve({
          ok: !err,
          exitCode: err ? (err.code ?? 1) : 0,
          stdout: String(stdout || '').slice(0, 8000),
          stderr: String(stderr || err?.message || '').slice(0, 8000),
        });
      }
    );
  });
}

export function git(projectDir, args) {
  return new Promise((resolve) => {
    execFile('git', args, { cwd: projectDir, windowsHide: true, maxBuffer: 4 * 1024 * 1024 }, (err, stdout, stderr) => {
      resolve({ ok: !err, stdout: String(stdout || ''), stderr: String(stderr || err?.message || '') });
    });
  });
}

export function listTree(projectDir, rel = '.', depth = 3) {
  const abs = safeJoin(projectDir, rel);
  if (!existsSync(abs)) return [];
  const out = [];
  const walk = (dir, prefix, d) => {
    for (const name of readdirSync(dir)) {
      if (IGNORED.has(name)) continue;
      const p = join(dir, name);
      const s = statSync(p);
      out.push(prefix + name + (s.isDirectory() ? '/' : ''));
      if (s.isDirectory() && d < depth) walk(p, `${prefix}${name}/`, d + 1);
    }
  };
  walk(abs, '', 0);
  return out.slice(0, 500);
}

// Batch inspector: read several files in one call so the agent can ground
// itself in the real project before writing anything. Content is capped so a
// handful of large files cannot blow the model's context.
export function readFiles(projectDir, relPaths, maxBytesEach = 8000, totalBudget = 40000) {
  const out = [];
  let budget = totalBudget;
  for (const rel of relPaths.slice(0, 12)) {
    if (budget <= 0) break;
    try {
      const content = readFileSync(safeJoin(projectDir, rel), 'utf8').slice(0, Math.min(maxBytesEach, budget));
      budget -= content.length;
      out.push({ path: rel, content });
    } catch {
      out.push({ path: rel, error: 'unreadable or missing' });
    }
  }
  return out;
}

export function readFile(projectDir, rel) {
  const abs = safeJoin(projectDir, rel);
  const content = readFileSync(abs, 'utf8');
  return { path: rel, lines: content.split('\n').length, content: content.slice(0, 40000) };
}

export function writeFileTool(projectDir, rel, content) {
  const abs = safeJoin(projectDir, rel);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, content, 'utf8');
  return { path: rel, bytes: Buffer.byteLength(content) };
}

export function deletePath(projectDir, rel) {
  const abs = safeJoin(projectDir, rel);
  if (abs === projectDir) throw new Error('Refusing to delete the project root.');
  rmSync(abs, { recursive: true, force: true });
  return { path: rel, deleted: true };
}

// ------------------------------------------------------------- .nullcode index --

const LANG_BY_EXT = {
  '.js': 'javascript', '.mjs': 'javascript', '.cjs': 'javascript', '.ts': 'typescript',
  '.tsx': 'typescript', '.jsx': 'javascript', '.py': 'python', '.html': 'html',
  '.css': 'css', '.json': 'json', '.md': 'markdown', '.go': 'go', '.rs': 'rust', '.java': 'java',
};

export function indexProject(projectDir) {
  const metaDir = join(projectDir, '.nullcode');
  mkdirSync(metaDir, { recursive: true });

  const files = [];
  const walk = (dir, prefix, depth) => {
    if (depth > 4) return;
    for (const name of readdirSync(dir)) {
      if (IGNORED.has(name)) continue;
      const p = join(dir, name);
      const s = statSync(p);
      if (s.isDirectory()) walk(p, `${prefix}${name}/`, depth + 1);
      else files.push({ path: `${prefix}${name}`, size: s.size, lang: LANG_BY_EXT[extname(name)] || null });
    }
  };
  if (existsSync(projectDir)) walk(projectDir, '', 0);

  const langs = {};
  for (const f of files) if (f.lang) langs[f.lang] = (langs[f.lang] || 0) + 1;

  let pkg = null;
  const pkgPath = join(projectDir, 'package.json');
  if (existsSync(pkgPath)) {
    try { pkg = JSON.parse(readFileSync(pkgPath, 'utf8')); } catch { /* ignore */ }
  }

  const project = {
    generatedAt: new Date().toISOString(),
    name: pkg?.name || projectDir.split(/[\\/]/).pop(),
    languages: langs,
    fileCount: files.length,
    dependencies: pkg?.dependencies || {},
    devDependencies: pkg?.devDependencies || {},
    scripts: pkg?.scripts || {},
  };

  // Detect common frameworks/conventions (cheap heuristics, extendable).
  const has = (...names) => files.some((f) => names.some((n) => f.path.toLowerCase().includes(n)));
  const architecture = {
    detected: [],
    entrypoints: [],
    routes: [],
    directories: {},
  };
  if (pkg?.dependencies?.next || has('next.config')) architecture.detected.push('next');
  if (pkg?.dependencies?.react) architecture.detected.push('react');
  if (pkg?.dependencies?.vue) architecture.detected.push('vue');
  if (pkg?.dependencies?.express) architecture.detected.push('express');
  if (has('index.html')) architecture.entrypoints.push('index.html');
  if (pkg?.scripts?.start) architecture.entrypoints.push(`npm start (${pkg.scripts.start})`);
  if (pkg?.scripts?.dev) architecture.entrypoints.push(`npm run dev (${pkg.scripts.dev})`);
  for (const f of files) {
    if (/^(routes|app|pages|api)\//.test(f.path)) architecture.routes.push(f.path);
    if (/components?\//.test(f.path)) (architecture.directories.components ??= []).push(f.path);
  }
  architecture.routes = architecture.routes.slice(0, 50);

  const conventions = {
    styling: has('tailwind.config', '.css') ? 'css detected — inspect before restyling' : 'unknown',
    notes: 'Preserve the existing design system. Reuse components before creating new ones.',
  };

  const memoryFile = join(metaDir, 'memory.json');
  const memory = existsSync(memoryFile)
    ? JSON.parse(readFileSync(memoryFile, 'utf8'))
    : { entries: [] };

  writeJsonSafe(join(metaDir, 'project.json'), project);
  writeJsonSafe(join(metaDir, 'architecture.json'), architecture);
  writeJsonSafe(join(metaDir, 'conventions.json'), conventions);
  writeJsonSafe(join(metaDir, 'capabilities.json'), { tested: [], planned: [] });
  writeJsonSafe(join(metaDir, 'known-issues.json'), { issues: [] });

  return { project, fileCount: files.length };
}

function writeJsonSafe(file, data) {
  writeFileSync(file, JSON.stringify(data, null, 2), 'utf8');
}

export function readContext(projectDir) {
  const metaDir = join(projectDir, '.nullcode');
  const out = {};
  for (const name of ['project.json', 'architecture.json', 'conventions.json', 'memory.json', 'intent.json']) {
    const p = join(metaDir, name);
    if (existsSync(p)) {
      try { out[name.replace('.json', '')] = JSON.parse(readFileSync(p, 'utf8')); } catch { /* ignore */ }
    }
  }
  return out;
}

// The project description is the initial intent/context NILCODE AI builds from.
export function setProjectIntent(projectDir, description) {
  const metaDir = join(projectDir, '.nullcode');
  mkdirSync(metaDir, { recursive: true });
  writeJsonSafe(join(metaDir, 'intent.json'), {
    description,
    createdAt: new Date().toISOString(),
  });
  return { intent: description };
}

export { relative };
