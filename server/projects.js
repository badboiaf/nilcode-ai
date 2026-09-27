// Per-user workspace and project registry. Every project lives under
// workspaces/<userId>/<projectId>/ so files, memory and credentials stay isolated.
import { join, resolve, sep } from 'node:path';
import { existsSync, readdirSync } from 'node:fs';
import config from './config.js';
import { readJson, writeJson, ensureDir, token } from './store.js';

export function userRoot(userId) {
  return join(config.dataDir, 'workspaces', userId);
}

export function userProjectsIndexFile(userId) {
  return join(userRoot(userId), 'projects.json');
}

export function listProjects(userId) {
  const idx = readJson(userProjectsIndexFile(userId), { projects: [] });
  return idx.projects
    .filter((p) => existsSync(projectPath(userId, p.id)))
    .map((p) => ({ ...p, path: projectPath(userId, p.id) }));
}

export function getProject(userId, projectId) {
  const p = listProjects(userId).find((p) => p.id === projectId);
  return p || null;
}

export function createProject(userId, { name, description = '', repoUrl = null }) {
  const id = token(6);
  const p = {
    id,
    name,
    description,
    repoUrl,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
  const idx = readJson(userProjectsIndexFile(userId), { projects: [] });
  idx.projects.unshift(p);
  writeJson(userProjectsIndexFile(userId), idx);
  ensureDir(projectPath(userId, id));
  return { ...p, path: projectPath(userId, id) };
}

export function updateProject(userId, projectId, patch) {
  const idx = readJson(userProjectsIndexFile(userId), { projects: [] });
  const p = idx.projects.find((p) => p.id === projectId);
  if (!p) return null;
  Object.assign(p, patch, { updatedAt: Date.now() });
  writeJson(userProjectsIndexFile(userId), idx);
  return { ...p, path: projectPath(userId, projectId) };
}

export function deleteProject(userId, projectId) {
  const idx = readJson(userProjectsIndexFile(userId), { projects: [] });
  idx.projects = idx.projects.filter((p) => p.id !== projectId);
  writeJson(userProjectsIndexFile(userId), idx);
}

export function projectPath(userId, projectId) {
  return join(userRoot(userId), projectId);
}

// Safe path resolution inside a project (blocks traversal outside the workspace).
export function safeJoin(projectDir, relPath) {
  const abs = resolve(projectDir, relPath);
  const root = resolve(projectDir);
  if (abs !== root && !abs.startsWith(root + sep)) {
    throw new Error('Path escapes the project directory.');
  }
  return abs;
}
