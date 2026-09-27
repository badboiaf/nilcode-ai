// Storage abstraction for user attachments. The default adapter stores files
// on local disk under the user's isolated data directory. The interface
// (put/get/remove/stat) is intentionally narrow so an object-storage provider
// (S3-compatible, Drive, etc.) can be added without touching callers.
import { mkdirSync, createWriteStream, createReadStream, statSync, unlinkSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { pipeline } from 'node:stream/promises';
import config from '../config.js';

const adapter = {
  name: 'local-disk',

  // root: per-user directory — isolation is structural, not by convention.
  pathFor(userId, fileKey) {
    return join(config.dataDir, 'attachments', userId, fileKey);
  },

  async put(userId, fileKey, readStream) {
    const target = this.pathFor(userId, fileKey);
    mkdirSync(dirname(target), { recursive: true });
    await pipeline(readStream, createWriteStream(target));
    return { provider: this.name, key: fileKey };
  },

  get(userId, fileKey) {
    const target = this.pathFor(userId, fileKey);
    if (!existsSync(target)) return null;
    return createReadStream(target);
  },

  stat(userId, fileKey) {
    const target = this.pathFor(userId, fileKey);
    if (!existsSync(target)) return null;
    const s = statSync(target);
    return { size: s.size };
  },

  remove(userId, fileKey) {
    const target = this.pathFor(userId, fileKey);
    if (existsSync(target)) unlinkSync(target);
    return true;
  },
};

export function storage() {
  return adapter;
}
