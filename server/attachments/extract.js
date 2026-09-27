// Per-kind attachment processing. Keeps excerpts small so the context engine
// can select relevant material without shipping whole files to AI models.
import { createReadStream, readSync, openSync, closeSync, statSync } from 'node:fs';
import { createInflateRaw } from 'node:zlib';

export const TEXTUAL = /\.(txt|md|markdown|log|json|js|mjs|cjs|ts|tsx|jsx|css|scss|html|htm|xml|yml|yaml|csv|env|ini|cfg|conf|sh|bat|ps1|py|rb|go|rs|java|kt|swift|php|sql|toml)$/i;

// Extract a bounded text excerpt from a stored file.
export async function extractText(absPath, maxChars = 12000) {
  const chunks = [];
  let size = 0;
  for await (const chunk of createReadStream(absPath, { encoding: 'utf8' })) {
    chunks.push(chunk);
    size += chunk.length;
    if (size >= maxChars) break;
  }
  let text = chunks.join('');
  if (text.length > maxChars) text = text.slice(0, maxChars) + '\n…[truncated]';
  return text;
}

// PDF best-effort: pull readable text runs out of the raw bytes. Works for
// text-based PDFs; scanned PDFs degrade to a notice (no OCR in foundation).
export function extractPdfText(absPath, maxChars = 8000) {
  const size = statSync(absPath).size;
  const fd = openSync(absPath, 'r');
  try {
    const buf = Buffer.alloc(Math.min(size, 2 * 1024 * 1024));
    readSync(fd, buf, 0, buf.length, 0);
    const raw = buf.toString('latin1');
    const pieces = [];
    const re = /\(((?:\\.|[^()\\])*)\)\s*T[jJ]/g;
    let m;
    while ((m = re.exec(raw)) && pieces.join(' ').length < maxChars) {
      pieces.push(m[1].replace(/\\([()\\])/g, '$1').replace(/\\[nr]/g, ' '));
    }
    const text = pieces.join(' ').replace(/\s+/g, ' ').trim();
    if (!text) return '(No extractable text found — the PDF may be scanned images.)';
    return text.slice(0, maxChars);
  } finally {
    closeSync(fd);
  }
}

// ZIP: walk local file headers to list the structure, and optionally inflate
// a single small entry. Avoids extracting whole archives to inspect them.
export function inspectZip(absPath, { maxEntries = 400 } = {}) {
  const size = statSync(absPath).size;
  const fd = openSync(absPath, 'r');
  const entries = [];
  try {
    const buf = Buffer.alloc(Math.min(size, 64 * 1024 * 1024));
    readSync(fd, buf, 0, buf.length, 0);
    let offset = 0;
    while (offset + 30 <= buf.length && entries.length < maxEntries) {
      if (buf.readUInt32LE(offset) !== 0x04034b50) break; // local file header signature
      const method = buf.readUInt16LE(offset + 8);
      const compressedSize = buf.readUInt32LE(offset + 18);
      const nameLen = buf.readUInt16LE(offset + 26);
      const extraLen = buf.readUInt16LE(offset + 28);
      const nameStart = offset + 30;
      const name = buf.slice(nameStart, nameStart + nameLen).toString('utf8');
      const dataStart = nameStart + nameLen + extraLen;
      if (dataStart + compressedSize > buf.length) break;
      entries.push({ name, method, compressedSize, dataStart });
      offset = dataStart + compressedSize;
    }
    return {
      entries: entries.length,
      truncated: entries.length >= maxEntries,
      listing: entries.map((e) => e.name),
      raw: entries,
      buf,
    };
  } finally {
    closeSync(fd);
  }
}

// Inflate one small stored/deflated entry from a scanned ZIP buffer,
// bounded so a malicious archive can't exhaust memory.
export function extractZipEntry(buf, entry, maxOut = 64 * 1024) {
  const slice = buf.subarray(entry.dataStart, entry.dataStart + entry.compressedSize);
  if (entry.method === 0) return slice.subarray(0, maxOut).toString('utf8');
  const inflator = createInflateRaw();
  inflator.write(slice);
  inflator.end();
  let out = Buffer.alloc(0);
  let chunk;
  while ((chunk = inflator.read(maxOut)) !== null) {
    out = Buffer.concat([out, chunk]);
    if (out.length >= maxOut) break;
  }
  return out.toString('utf8').slice(0, maxOut);
}
