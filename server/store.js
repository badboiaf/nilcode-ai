// Minimal atomic JSON file store. All app metadata lives here so the
// foundation stays dependency-free and easy to back up.
import { readFileSync, writeFileSync, renameSync, mkdirSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { createHash, randomBytes } from 'node:crypto';

export function ensureDir(p) {
  if (!existsSync(p)) mkdirSync(p, { recursive: true });
}

export function readJson(file, fallback) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

export function writeJson(file, data) {
  ensureDir(dirname(file));
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(data, null, 2));
  renameSync(tmp, file);
}

export function sha256(s) {
  return createHash('sha256').update(s).digest('hex');
}

export function token(bytes = 32) {
  return randomBytes(bytes).toString('hex');
}

export class Collection {
  constructor(file) {
    this.file = file;
    this.data = readJson(file, {});
  }
  save() {
    writeJson(this.file, this.data);
  }
}

export function scopedPath(base, userId, ...parts) {
  return join(base, userId, ...parts);
}
