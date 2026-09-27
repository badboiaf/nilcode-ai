// Attachment system tests: uploads land in per-user storage, are processed by
// kind, are visible only to their owner, and feed project context.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.NULLCODE_DATA_DIR = mkdtempSync(join(tmpdir(), 'nullcode-att-test-'));
process.env.NULLCODE_NO_LISTEN = '1';
process.env.NULLCODE_ALLOW_OLLAMA = '0';
process.env.NULLCODE_DISABLE_AUTO_AI = '1'; // tests must never call real external AI providers

const { default: app } = await import('../server/index.js');
const { stopAll } = await import('../server/runtime/serve.js');

let server;
let baseUrl;
test.before(async () => {
  await new Promise((resolve) => {
    server = app.listen(0, '127.0.0.1', () => {
      baseUrl = `http://127.0.0.1:${server.address().port}`;
      resolve();
    });
  });
});

test.after(() => {
  stopAll();
  try { server?.closeAllConnections?.(); server?.close(); } catch { /* closed */ }
  try { rmSync(process.env.NULLCODE_DATA_DIR, { recursive: true, force: true }); } catch { /* windows */ }
});

async function api(method, path, { token, body, raw } = {}) {
  const res = await fetch(`${baseUrl}/api${path}`, {
    method,
    headers: {
      ...(raw ? raw.headers : { 'content-type': 'application/json' }),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: raw ? raw.body : body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  return { status: res.status, data };
}

function signup(email) {
  return api('POST', '/auth/signup', { body: { email, password: 'secret1', name: email.split('@')[0] } });
}

function uploadPart(token, path, filename, contentType, content) {
  const boundary = '----nilcodetest' + Math.random().toString(36).slice(2);
  const pre = Buffer.from(
    `--${boundary}\r\ncontent-disposition: form-data; name="files"; filename="${filename}"\r\ncontent-type: ${contentType}\r\n\r\n`
  );
  const post = Buffer.from(`\r\n--${boundary}--\r\n`);
  const body = Buffer.isBuffer(content) ? content : Buffer.from(content);
  const full = Buffer.concat([pre, body, post]);
  return api('POST', path, {
    token,
    raw: { headers: { 'content-type': `multipart/form-data; boundary=${boundary}` }, body: full },
  });
}

test('text upload is stored, processed, and listed for the owner', async () => {
  const u = await signup('att1@example.com');
  const t = u.data.token;
  const p = await api('POST', '/projects', { token: t, body: { name: 'Att Project' } });

  const up = await uploadPart(
    t, `/projects/${p.data.project.id}/attachments`, 'error.log', 'text/plain',
    'TypeError: Cannot read properties of undefined (reading "map")\n    at render (app.js:42)\n'
  );
  assert.equal(up.status, 200);
  assert.equal(up.data.attachments.length, 1);
  const a = up.data.attachments[0];
  assert.equal(a.kind, 'text');
  assert.match(a.summary, /TypeError/);
  assert.match(a.summary, /app\.js:42/);

  const list = await api('GET', `/attachments?projectId=${p.data.project.id}`, { token: t });
  assert.equal(list.data.attachments.length, 1);
  assert.equal(list.data.attachments[0].name, 'error.log');
});

test('another user cannot read or even list another user’s attachments', async () => {
  const owner = await signup('att-owner@example.com');
  const stranger = await signup('att-stranger@example.com');
  const p = await api('POST', '/projects', { token: owner.data.token, body: { name: 'Secret' } });
  await uploadPart(owner.data.token, `/projects/${p.data.project.id}/attachments`, 'secret.txt', 'text/plain', 'top secret');

  const strangerList = await api('GET', `/attachments?projectId=${p.data.project.id}`, { token: stranger.data.token });
  assert.equal(strangerList.data.attachments.length, 0);

  const ownerList = await api('GET', `/attachments?projectId=${p.data.project.id}`, { token: owner.data.token });
  const id = ownerList.data.attachments[0].id;
  const steal = await api('GET', `/attachments/${id}/content`, { token: stranger.data.token });
  assert.equal(steal.status, 404);
  const pin = await api('POST', `/attachments/${id}/pin`, { token: stranger.data.token, body: { pinned: true } });
  assert.equal(pin.status, 404);
  const del = await api('DELETE', `/attachments/${id}`, { token: stranger.data.token });
  assert.equal(del.status, 200, 'delete of non-existent id is a no-op for the stranger');
  const stillThere = await api('GET', `/attachments?projectId=${p.data.project.id}`, { token: owner.data.token });
  assert.equal(stillThere.data.attachments.length, 1);
});

test('pinning keeps an attachment as persistent project context', async () => {
  const u = await signup('att2@example.com');
  const t = u.data.token;
  const p = await api('POST', '/projects', { token: t, body: { name: 'Pinned' } });
  const up = await uploadPart(t, `/projects/${p.data.project.id}/attachments`, 'design-reference.png', 'image/png', Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  const id = up.data.attachments[0].id;
  assert.equal(up.data.attachments[0].kind, 'image');

  const pin = await api('POST', `/attachments/${id}/pin`, { token: t, body: { pinned: true } });
  assert.equal(pin.data.attachment.pinned, true);

  const list = await api('GET', '/attachments', { token: t });
  assert.equal(list.data.attachments.find((a) => a.id === id).pinned, true);

  const content = await fetch(`${baseUrl}/api/attachments/${id}/content`, { headers: { authorization: `Bearer ${t}` } });
  assert.equal(content.status, 200);
  const buf = Buffer.from(await content.arrayBuffer());
  assert.equal(buf[0], 0x89, 'binary image content served intact');
});

test('zip upload is inspected for structure without blind extraction', async () => {
  const u = await signup('att3@example.com');
  const t = u.data.token;
  const p = await api('POST', '/projects', { token: t, body: { name: 'Zip' } });
  // A minimal stored (uncompressed) zip built by hand: local header + data.
  const name = Buffer.from('readme.txt');
  const data = Buffer.from('hello from inside the archive');
  const crc = 0; // CRC is not verified in the scanner; integrity is checked by consumers
  const header = Buffer.alloc(30);
  header.writeUInt32LE(0x04034b50, 0);
  header.writeUInt16LE(20, 4);
  header.writeUInt16LE(0, 6);
  header.writeUInt16LE(0, 8); // stored
  header.writeUInt16LE(0, 10);
  header.writeUInt16LE(0, 12);
  header.writeUInt32LE(crc, 14);
  header.writeUInt32LE(data.length, 18);
  header.writeUInt32LE(data.length, 22);
  header.writeUInt16LE(name.length, 26);
  header.writeUInt16LE(0, 28);
  const zip = Buffer.concat([header, name, data]);

  const up = await uploadPart(t, `/projects/${p.data.project.id}/attachments`, 'project.zip', 'application/zip', zip);
  assert.equal(up.status, 200);
  const a = up.data.attachments[0];
  assert.equal(a.kind, 'zip');
  assert.match(a.summary, /1 entr/);
  assert.match(a.summary, /readme\.txt/);
});

test('pdf upload extracts readable text best-effort', async () => {
  const u = await signup('att4@example.com');
  const t = u.data.token;
  const p = await api('POST', '/projects', { token: t, body: { name: 'Pdf' } });
  const pdf = Buffer.from(
    'BT /F1 12 Tf (Payment flow: user taps checkout, pays, receives confirmation.) Tj ET',
    'latin1'
  );
  const up = await uploadPart(t, `/projects/${p.data.project.id}/attachments`, 'payment-flow.pdf', 'application/pdf', pdf);
  assert.equal(up.status, 200);
  const a = up.data.attachments[0];
  assert.equal(a.kind, 'pdf');
  assert.match(a.summary, /Payment flow/);
});

test('deleting an attachment removes it from the index', async () => {
  const u = await signup('att5@example.com');
  const t = u.data.token;
  const p = await api('POST', '/projects', { token: t, body: { name: 'Del' } });
  const up = await uploadPart(t, `/projects/${p.data.project.id}/attachments`, 'temp.txt', 'text/plain', 'temporary');
  const id = up.data.attachments[0].id;
  const del = await api('DELETE', `/attachments/${id}`, { token: t });
  assert.equal(del.data.deleted, true);
  const list = await api('GET', `/attachments?projectId=${p.data.project.id}`, { token: t });
  assert.equal(list.data.attachments.length, 0);
});
