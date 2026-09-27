// Dev-server manager. Serves a project directory over loopback on a free port
// (zero extra dependencies). Command-based dev servers (npm run dev) can be
// layered on later through the same registry interface.
import http from 'node:http';
import { createServer } from 'node:net';
import { readFileSync, existsSync, statSync } from 'node:fs';
import { join, extname, normalize } from 'node:path';

const MIME = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png',
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp',
  '.ico': 'image/x-icon', '.txt': 'text/plain; charset=utf-8', '.md': 'text/plain; charset=utf-8',
  '.woff': 'font/woff', '.woff2': 'font/woff2',
};

const servers = new Map(); // projectId -> { server, url, port }

function freePort() {
  return new Promise((resolve, reject) => {
    const s = createServer();
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
    s.on('error', reject);
  });
}

export function getServer(projectId) {
  return servers.get(projectId) || null;
}

export async function startServer(projectId, projectDir) {
  const existing = servers.get(projectId);
  if (existing) return existing;
  const port = await freePort();
  const server = http.createServer((req, res) => {
    try {
      const urlPath = decodeURIComponent(new URL(req.url, 'http://x').pathname);
      let file = normalize(join(projectDir, urlPath));
      if (!file.startsWith(normalize(projectDir))) {
        res.writeHead(403).end('Forbidden');
        return;
      }
      if (existsSync(file) && statSync(file).isDirectory()) file = join(file, 'index.html');
      if (!existsSync(file)) {
        // SPA-friendly fallback to index.html when present.
        const fallback = join(projectDir, 'index.html');
        if (existsSync(fallback)) file = fallback;
        else { res.writeHead(404, { 'content-type': 'text/plain' }).end('Not found'); return; }
      }
      const body = readFileSync(file);
      res.writeHead(200, { 'content-type': MIME[extname(file)] || 'application/octet-stream' });
      res.end(body);
    } catch (err) {
      res.writeHead(500, { 'content-type': 'text/plain' }).end(String(err.message || err));
    }
  });
  await new Promise((resolve) => server.listen(port, '127.0.0.1', resolve));
  const entry = { server, port, url: `http://127.0.0.1:${port}`, startedAt: Date.now() };
  servers.set(projectId, entry);
  return entry;
}

export function stopServer(projectId) {
  const entry = servers.get(projectId);
  if (!entry) return false;
  servers.delete(projectId);
  entry.server.close();
  return true;
}

export function stopAll() {
  for (const id of [...servers.keys()]) stopServer(id);
}
