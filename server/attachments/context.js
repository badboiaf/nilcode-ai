// Context engine for attachments. Decides which uploads are relevant to a
// request instead of shipping every file to the model. Pinned project files
// are persistent context; explicit references in the prompt always win.
import { readFileSync, statSync } from 'node:fs';
import { getAttachment } from './attachments.js';
import { extractText } from './extract.js';

const MAX_CONTEXT_CHARS = 60000;
const MAX_IMAGE_BYTES = 4 * 1024 * 1024; // larger images are referenced, not inlined

export function selectAttachments({ userId, projectId, prompt, index }) {
  const lower = (prompt || '').toLowerCase();
  const chosen = new Map();

  for (const a of index) {
    const belongs = !projectId || a.projectId === projectId || a.pinned;
    if (belongs) chosen.set(a.id, a);
  }
  // Explicit references from any project ("use the screenshot I uploaded").
  for (const a of index) {
    if (!chosen.has(a.id) && a.name && lower.includes(a.name.toLowerCase())) chosen.set(a.id, a);
  }
  return [...chosen.values()];
}

// Build the attachment context payload for the agent: bounded text plus
// image parts for vision-capable models.
export async function buildAttachmentContext({ userId, selected }) {
  const textParts = [];
  const images = [];
  let budget = MAX_CONTEXT_CHARS;

  for (const meta of selected) {
    const att = getAttachment(userId, meta.id);
    if (!att || !statSync(att.absPath).size) continue;
    if (meta.kind === 'image') {
      if (meta.size <= MAX_IMAGE_BYTES) {
        images.push({ name: meta.name, mime: meta.mime || 'image/png', absPath: att.absPath });
      } else {
        textParts.push(`Attachment — ${meta.name}: image too large to inline (${Math.round(meta.size / 1024 / 1024)} MB); describe it or re-upload a smaller crop.`);
      }
      continue;
    }
    if (budget <= 0) { textParts.push(`Attachment — ${meta.name}: omitted (context budget).`); continue; }
    let content = meta.excerpt || '';
    if (!content) {
      try { content = await extractText(att.absPath, 8000); } catch { content = '(unreadable)'; }
    }
    if (content.length > budget) content = content.slice(0, budget) + '\n…[truncated]';
    budget -= content.length;
    textParts.push(`Attachment — ${meta.name} (${meta.kind}):\n${content}`);
  }

  return { text: textParts.join('\n\n'), images };
}

export function imageToDataUrl(absPath, mime) {
  const b64 = readFileSync(absPath).toString('base64');
  return `data:${mime};base64,${b64}`;
}
