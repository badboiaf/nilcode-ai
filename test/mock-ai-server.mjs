// Minimal OpenAI-compatible mock server for tests. Verifies that NILCODE AI
// actually round-trips to an AI backend (planner + coder roles) instead of
// simulating results locally.
import http from 'node:http';

const CODER_HTML =
  '<!doctype html><html><head><title>Nova Coffee</title></head><body><h1>Nova Coffee</h1><p>Specialty coffee in Lisbon.</p></body></html>';

export function startMockAI() {
  const calls = [];
  const statusQueue = []; // one-shot failures: queueStatus(429), queueStatus(500)…
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
      const forced = statusQueue.shift();
      if (forced) {
        res.writeHead(forced, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: { message: 'mock failure' } }));
        return;
      }
      if (parsed.stream) {
        // SSE mode (streaming round-trip): emit the same content as deltas.
        const content = mockContent(parsed);
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        const parts = content.match(/[\s\S]{1,24}/g) || [];
        for (const part of parts) {
          res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: part } }] })}\n\n`);
        }
        res.write('data: [DONE]\n\n');
        res.end();
        return;
      }

      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ choices: [{ message: { content: mockContent(parsed) } }], usage: { total_tokens: 42 } }));
    });
  });

  // Role/state detection from the prompt shape used by the engine. Stateless
  // across rounds: the conversation history itself carries the markers
  // (assistant plan JSON, tool_result blocks). Only the final request line
  // decides conversation vs build (history may quote earlier phrases).
  function mockContent(parsed) {
    const flat = JSON.stringify(parsed);
    const currentRequest = /Current request: ([^"\\]*(?:\\.[^"\\]*)*)/.exec(flat)?.[1] || '';
    const isQuestion = /What is this project/i.test(currentRequest);
    const isTitle = /Reply with the project name only/i.test(flat);

    if (isTitle) return 'Nova Coffee Site';
    if (/TRIGGER-LIST-BUG/i.test(currentRequest)) {
      // Regression: the exact misbehavior behind "'List' is not recognized" —
      // a natural-language action sent through the shell tool.
      if (/not a shell command/.test(flat)) {
        return JSON.stringify({ summary: 'I listed the project contents for you — the file browser is empty, so nothing is here yet.' });
      }
      return '<tool>{"tool":"cmd","command":"List the files in the project"}</tool>';
    }
    if (isQuestion) {
      return JSON.stringify({
        reply:
          'This is Nova Coffee, a specialty coffee shop site. So far it has a single homepage; ask me to add a menu or reservations next.',
      });
    }
    // Agentic state machine: plan → tool calls → summary. Markers are the
    // engine's own prompt lines (JSON-escaping makes quote-based patterns
    // unreliable against the serialized body).
    if (/tool_result/.test(flat)) {
      return JSON.stringify({ summary: 'Created the homepage and saved a checkpoint. index.html is verified and ready to preview.' });
    }
    if (/Plan noted\. Execute it now/.test(flat)) {
      const content = CODER_HTML.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n');
      return `<tool>{"tool":"write_file","path":"index.html","content":"${content}"}</tool>\n<tool>{"tool":"git_commit","message":"Initial build"}</tool>`;
    }
    return JSON.stringify({
      plan: [{ title: 'Create the homepage' }, { title: 'Save a checkpoint' }],
    });
  }

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve({
        server,
        url: `http://127.0.0.1:${server.address().port}/v1`,
        calls,
        queueStatus: (s) => statusQueue.push(s),
      });
    });
  });
}
