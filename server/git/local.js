// Git helpers for local projects: init, commits, checkpoints (branch-per-task
// safety), branch listing and rollback.
import { join } from 'node:path';
import { existsSync } from 'node:fs';
import { git } from '../agent/tools.js';

export async function ensureRepo(projectDir) {
  // A parent repo (e.g. NILCODE AI's own checkout) must NOT be reused:
  // every project gets its own nested repository.
  if (!existsSync(join(projectDir, '.git'))) {
    await git(projectDir, ['init', '-b', 'main']);
  }
  return true;
}

export async function status(projectDir) {
  await ensureRepo(projectDir);
  const s = await git(projectDir, ['status', '--porcelain']);
  const b = await git(projectDir, ['rev-parse', '--abbrev-ref', 'HEAD']);
  const log = await git(projectDir, ['log', '--oneline', '-5']);
  return {
    branch: b.ok ? b.stdout.trim() : null,
    changes: s.stdout.trim() ? s.stdout.trim().split('\n').length : 0,
    recentLog: log.ok ? log.stdout.trim().split('\n').slice(0, 5) : [],
  };
}

export async function commit(projectDir, message) {
  await ensureRepo(projectDir);
  await git(projectDir, ['add', '-A']);
  const r = await git(projectDir, ['commit', '-m', message]);
  // "nothing to commit" is fine.
  return { ok: r.ok || /nothing to commit/.test(r.stdout + r.stderr), output: r.stdout || r.stderr };
}

export async function checkpoint(projectDir, label) {
  await ensureRepo(projectDir);
  await commit(projectDir, `Checkpoint: ${label}`);
  const name = `checkpoint/${Date.now().toString(36)}`;
  await git(projectDir, ['branch', name]);
  return { branch: name, label };
}

export async function listBranches(projectDir) {
  const r = await git(projectDir, ['branch', '--list']);
  return r.stdout.trim().split('\n').map((s) => s.replace(/^\*?\s*/, '')).filter(Boolean);
}

export async function rollbackToBranch(projectDir, branch) {
  // Rollback = reset working tree to a checkpoint branch (kept non-destructive
  // to reflog: creates a safety branch of current state first).
  await checkpoint(projectDir, 'pre-rollback safety');
  const r = await git(projectDir, ['checkout', branch]);
  if (!r.ok) throw new Error(r.stderr || `Checkout of ${branch} failed.`);
  return { branch };
}
