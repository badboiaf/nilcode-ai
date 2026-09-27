// Attachment manager. Uploads stream to per-user storage; metadata lives in a
// per-user index. Every access authorizes against the authenticated user, so
// file IDs, URLs, or project IDs can never leak another user's files.
import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { statSync } from 'node:fs';
import { join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { storage } from './store.js';
import { readJson, writeJson } from '../store.js';
import config from '../config.js';
import { TEXTUAL, extractText, extractPdfText, inspectZip, extractZipEntry } from './extract.js';

export const MAX_FILE_BYTES = 100 * 1024 * 1024; // infrastructure limit, not a product quota

function indexFile(userId) {
  return join(config.dataDir, 'attachments', userId, 'index.json');
}

function loadIndex(userId) {
  return readJson(indexFile(userId), { attachments: [] });
}

function saveIndex(userId, data) {
  writeJson(indexFile(userId), data);
}

// ------------------------------------------------------------ classification --

function detectKind(name, mime) {
  if (mime?.startsWith('image/') || /\.(png|jpe?g|gif|webp|svg|bmp|ico)$/i.test(name)) return 'image';
  if (mime === 'application/pdf' || /\.pdf$/i.test(name)) return 'pdf';
  if (mime?.includes('zip') || /\.zip$/i.test(name)) return 'zip';
  if (TEXTUAL.test(name) || mime?.startsWith('text/')) return 'text';
  return 'binary';
}

// ------------------------------------------------------------- upload/ingest --

export async function ingestUpload({ userId, projectId, conversationId, messageRef, file }) {
  const id = randomUUID();
  const fileKey = `${id}-${file.filename}`;
  const kind = detectKind(file.filename, file.mime);

  await storage().put(userId, fileKey, file.stream);
  const abs = storage().pathFor(userId, fileKey);

  let size = 0;
  try { size = statSync(abs).size; } catch { /* stat unavailable */ }

  const meta = {
    id,
    fileKey,
    name: file.filename,
    mime: file.mime || null,
    kind,
    size,
    projectId: projectId || null,
    conversationId: conversationId || null,
    messageRef: messageRef || null,
    pinned: false,
    sha256: null,
    excerpt: null,
    summary: null,
    uploadedAt: new Date().toISOString(),
  };

  try {
    if (size > 0 && size < 16 * 1024 * 1024) {
      const hash = createHash('sha256');
      for await (const chunk of createReadStream(abs)) hash.update(chunk);
      meta.sha256 = hash.digest('hex');
    }
  } catch { /* hashing is best-effort */ }

  try {
    if (kind === 'text') {
      meta.excerpt = await extractText(abs);
      meta.summary = `File: ${meta.name} — content preview:\n${meta.excerpt}`;
    } else if (kind === 'pdf') {
      meta.excerpt = extractPdfText(abs);
      meta.summary = `PDF: ${meta.name} — extracted text:\n${meta.excerpt}`;
    } else if (kind === 'zip') {
      const scan = inspectZip(abs, { maxEntries: 400 });
      meta.excerpt = JSON.stringify(scan.listing.slice(0, 120));
      meta.summary = `Archive: ${meta.name} — ${scan.entries} entries${scan.truncated ? ' (listing truncated)' : ''}.`;
      meta.zipPreview = {};
      for (const e of scan.raw) {
        if (/\.(txt|md|json|log|ya?ml)$/i.test(e.name) && e.compressedSize > 0 && e.compressedSize < 64 * 1024) {
          meta.zipPreview[e.name] = extractZipEntry(scan.buf, e, 8000);
          if (Object.keys(meta.zipPreview).length >= 6) break;
        }
      }
      if (Object.keys(meta.zipPreview).length) {
        meta.summary += '\nSmall text/config files inside:\n' + JSON.stringify(meta.zipPreview, null, 1).slice(0, 4000);
      }
    } else if (kind === 'image') {
      meta.summary = `Image: ${meta.name} — available to vision-capable models as design/reference material.`;
    } else {
      meta.summary = `File: ${meta.name} (${meta.kind}, ${meta.size} bytes).`;
    }
  } catch (err) {
    meta.summary = meta.summary || `Attachment stored (${meta.kind}); automatic analysis unavailable: ${err.message}`;
  }

  const idx = loadIndex(userId);
  idx.attachments.push(meta);
  saveIndex(userId, idx);
  return publicMeta(meta);
}

export function publicMeta(a) {
  return {
    id: a.id,
    name: a.name,
    mime: a.mime,
    kind: a.kind,
    size: a.size,
    projectId: a.projectId,
    conversationId: a.conversationId,
    messageRef: a.messageRef,
    pinned: !!a.pinned,
    summary: a.summary,
    uploadedAt: a.uploadedAt,
  };
}

// ------------------------------------------------------------------- queries --

export function listAttachments(userId, { projectId, conversationId } = {}) {
  let items = loadIndex(userId).attachments;
  if (projectId) items = items.filter((a) => a.projectId === projectId || a.pinned);
  if (conversationId) items = items.filter((a) => a.conversationId === conversationId);
  return items.map(publicMeta);
}

export function getAttachment(userId, id) {
  const found = loadIndex(userId).attachments.find((a) => a.id === id);
  if (!found) return null;
  return { ...found, absPath: storage().pathFor(userId, found.fileKey) };
}

// ---------------------------------------------------------------- management --

export function pinAttachment(userId, id, pinned) {
  const idx = loadIndex(userId);
  const a = idx.attachments.find((x) => x.id === id);
  if (!a) return null;
  a.pinned = !!pinned;
  saveIndex(userId, idx);
  return publicMeta(a);
}

export function deleteAttachment(userId, id) {
  const idx = loadIndex(userId);
  const a = idx.attachments.find((x) => x.id === id);
  if (!a) return false;
  idx.attachments = idx.attachments.filter((x) => x.id !== id);
  saveIndex(userId, idx);
  try { storage().remove(userId, a.fileKey); } catch { /* already gone */ }
  return true;
}
