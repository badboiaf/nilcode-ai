// Minimal OpenAI-compatible mock server for tests. Verifies that NULLCODE
// actually round-trips to an AI backend (planner + coder roles) instead of
// simulating results locally.
import http from 'node:http';

export function startMockAI() {
  const calls = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      let parsed = {};
      try { parsed = body ? JSON.parse(body) : {}; } catch { parsed = { raw: body.slice(0, 200) }; }
      calls.push({ url: req.url, body: parsed });
      if (req.method === 'GET' || !body) {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ object: 'list', data: [{ id: 'nova-test' }] }));
        return;
      }

      // Role detection from the prompt shape used by the engine.
      const isCoder = /Write the complete content/i.test(body);
      const isQuestion = /What is this project/i.test(body);

      let content;
      if (isCoder) {
        content =
          '<!doctype html><html><head><title>Nova Coffee</title></head><body><h1>Nova Coffee</h1><p>Specialty coffee in Lisbon.</p></body></html>';
      } else if (isQuestion) {
        content = JSON.stringify({
          reply:
            'This is Nova Coffee, a specialty coffee shop site. So far it has a single homepage; ask me to add a menu or reservations next.',
        });
      } else {
        content = JSON.stringify([
          { title: 'Create the homepage', action: 'write_file', path: 'index.html', details: 'Build the Nova Coffee homepage' },
          { title: 'Save a checkpoint', action: 'git_commit', details: 'Initial build' },
        ]);
      }

      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ choices: [{ message: { content } }], usage: { total_tokens: 42 } }));
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve({ server, url: `http://127.0.0.1:${server.address().port}/v1`, calls });
    });
  });
}
