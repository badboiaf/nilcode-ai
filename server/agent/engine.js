// The NILCODE AI agent engine.
//
// The model runs as a real tool-using agent: it inspects the project, decides
// what to do, calls tools (read_files, write_file, cmd, git_commit), sees each
// result, corrects course when something fails, and keeps working until the
// task is done or genuinely blocked. Every response comes from a configured
// AI provider; with no provider the agent says so honestly — it never fakes
// success.
import { join } from 'node:path';
import { existsSync } from 'node:fs';
import { ProviderRegistry } from '../providers/registry.js';
import * as tools from './tools.js';
import * as localGit from '../git/local.js';
import { readJson, writeJson } from '../store.js';
import config from '../config.js';
import { logAIError } from '../providers/registry.js';
import { recordUsage } from '../ai-usage.js';
import { connectorContext, dispatchConnectorTool } from '../connectors/connector-bridge.js';

const SYSTEM_PERSONA = `You are NILCODE AI, an autonomous software development agent working inside a real project directory on the user's machine.
The user may not know how to program. Talk to them in clear, plain language.

# Environment
- OS: ${process.platform === 'win32' ? 'Windows. Shell is cmd.exe. Use Windows command syntax (dir, type, where). Never use POSIX-only commands.' : process.platform}
- The project root is your working directory. All tool paths are relative to it.

# Tools — call them by wrapping JSON in <tool></tool> tags
1. read_files  {"paths": ["dir/subdir", "file.css"], "maxChars": 6000}
   Inspect directories or files. ALWAYS inspect before writing anything: know the existing structure, stack and design conventions first.
2. write_file  {"path": "components/Hero.jsx", "notes": "what this file must contain"}
   Step 1 of writing a file: register it. You receive back the relevant project context.
3. write_file  {"path": "components/Hero.jsx", "content": "<complete final file content>"}
   Step 2: one call with the COMPLETE final file content. Never truncated, no placeholders, no markdown fences.
4. cmd  {"command": "npm install"}
   Run a real shell command. The command must start with an actual program name.
5. git_commit  {"message": "short message"}
   Commit the current changes inside the project.

# Hard rules
- NEVER put natural language inside cmd. A command like "List the files" or "Create a homepage" is a serious error — those are tool calls: use read_files or write_file instead.
- Create and edit files ONLY through write_file — never with cmd echo/copy-con.
- write_file content must be complete and final — the file is saved exactly as you provide it.
- Preserve the project's existing design system: reuse its colors, typography, components and conventions.

# How to work
1. Understand the request. If it is a question or explanation, just answer (see reply protocol below).
2. read_files to ground yourself in the project before changing it.
3. Create a mental plan, then execute it file by file. Write complete, working code.
4. After building: verify. For a website, check the entry file exists and is valid. If package.json defines test/build scripts, run them with cmd, inspect failures, and fix your code until they pass. Do not run commands that download large dependencies or start interactive or long-running servers.
5. Keep going until the request is fully implemented and verified. Do not stop after one file if more are needed. If a tool fails, read the error, fix the cause, and try again differently.
6. When everything is done, respond with ONLY a JSON object (no tool call):
   {"summary": "1-3 plain sentences: what you built/changed, what you verified, and anything the user should know. No markdown."}

# Reply protocol (questions and conversation — no project changes)
Respond with ONLY a JSON object: {"reply": "your answer in plain language"}
Never wrap reply JSON in tool tags.`;

function conversationFile(userId, projectId) {
  return join(config.usersDir, userId, 'conversations', `${projectId}.json`);
}

export function loadConversation(userId, projectId) {
  return readJson(conversationFile(userId, projectId), { messages: [] });
}

export function appendMessage(userId, projectId, msg) {
  const f = conversationFile(userId, projectId);
  const conv = readJson(f, { messages: [] });
  conv.messages.push({ ...msg, at: Date.now() });
  writeJson(f, conv);
  return conv;
}

// ------------------------------------------------------------------ context --

function recentConversation(userId, projectId, limit = 10) {
  const msgs = loadConversation(userId, projectId).messages || [];
  return msgs
    .slice(-limit)
    .map((m) => `${m.role === 'user' ? 'User' : 'You'}: ${String(m.content).slice(0, 400)}`)
    .join('\n');
}

function renderContext(context) {
  const lines = [];
  if (context.intent?.description) lines.push(`Project intent (why this project exists): ${context.intent.description}`);
  if (context.project) {
    const p = context.project;
    lines.push(
      `Project: ${p.name || 'unnamed'} — files: ${p.fileCount ?? 0}, languages: ${
        Object.keys(p.languages || {}).join(', ') || 'none yet'
      }`
    );
  }
  if (context.architecture?.detected?.length) lines.push(`Detected stack: ${context.architecture.detected.join(', ')}`);
  if (context.conventions?.styling) lines.push(`Styling: ${context.conventions.styling}`);
  if (context.memory?.entries?.length) {
    lines.push(`Project memory (must respect): ${context.memory.entries.slice(-10).map((e) => e.text || e).join('; ')}`);
  }
  return lines.length ? lines.join('\n') : '(empty workspace)';
}

// ---------------------------------------------------------------- tool layer --

// Guards every tool call. Returns {ok, result} — result is a string the model
// sees on the next round. Natural language masquerading as a shell command
// ('List the files…') is caught here and answered with guidance instead of
// reaching the shell, which is what produced "'List' is not recognized" before.
function dispatchTool({ name, args, projectDir, registry, prompt, registrations }) {
  if (typeof name !== 'string' || name.length > 40) return { ok: false, result: 'Invalid tool name.' };

  if (name === 'read_files') {
    let paths = args?.paths;
    if (typeof paths === 'string') paths = [paths];
    if (!Array.isArray(paths) || !paths.length || paths.some((p) => typeof p !== 'string')) {
      const tree = tools.listTree(projectDir, '.', 3).slice(0, 60).join('\n');
      return { ok: true, result: `Provide {"paths": [...]}.\nProject tree:\n${tree}` };
    }
    const found = tools.readFiles(projectDir, paths);
    const body = found
      .map((f) => (f.error ? `${f.path}: ${f.error}` : `--- ${f.path} ---\n${f.content}${f.content.length >= 7900 ? '\n…(truncated)' : ''}`))
      .join('\n\n');
    return { ok: true, result: body || 'Nothing readable at those paths.' };
  }

  if (name === 'write_file') {
    const path = args?.path;
    if (typeof path !== 'string' || !path.trim()) return { ok: false, result: 'write_file needs a "path".' };
    if (typeof args.content === 'string' && args.content.length) {
      tools.writeFileTool(projectDir, path, args.content);
      return { ok: true, result: `Saved ${path} (${args.content.length} bytes).` };
    }
    // Guided authoring: the model declared intent without content — hand it
    // the project tree and any existing file so the next call can be final.
    // A RE-registration means the model missed the instruction the first
    // time: escalate with an unmissable, example-anchored prompt.
    registrations.set(path, (registrations.get(path) || 0) + 1);
    const seen = registrations.get(path);
    const tree = tools.listTree(projectDir, '.', 3).slice(0, 80).join('\n');
    let existing = '';
    if (existsSync(join(projectDir, path))) {
      try { existing = tools.readFile(projectDir, path).content.slice(0, 6000); } catch { /* gone */ }
    }
    if (seen > 1) {
      return {
        ok: true,
        result: `You already registered "${path}" ${seen} times without sending content. Respond NOW with exactly one tool call and nothing else:\n<tool>{"tool":"write_file","path":"${path}","content":"...the complete final file text..."}</tool>\nEvery newline inside content must be written as \\n and every quote as \\".`,
      };
    }
    return {
      ok: true,
      result: [
        `Registered ${path}. Now send write_file again with the COMPLETE final "content" for this file.`,
        args?.notes ? `Your notes: ${String(args.notes).slice(0, 500)}` : '',
        tree ? `Project files:\n${tree}` : '',
        existing ? `Current content of ${path}:\n${existing}` : '',
      ]
        .filter(Boolean)
        .join('\n\n'),
    };
  }

  if (name === 'cmd') {
    const command = typeof args?.command === 'string' ? args.command.trim() : '';
    if (!command) return { ok: false, result: 'cmd needs a "command" string that starts with a program name.' };
    // Natural-language masquerading as a command is the classic failure mode
    // behind "'List' is not recognized". Real shell commands start with a
    // program name; sentence-style commands start with an English verb or are
    // long plain-word strings with no flags, paths or operators. Catch them
    // BEFORE the shell and teach the model the right tool instead.
    const NL_VERB = /^(list|show|display|print|read|open|create|make|write|check|find|tell|give|explain|describe|summarize|inspect|run|execute|build|test|install)\b/i;
    const hasShellMeta = /[-/\\"'=|><$]/.test(command);
    const wordCount = command.split(/\s+/).length;
    if (NL_VERB.test(command) || (wordCount >= 4 && !hasShellMeta)) {
      return {
        ok: false,
        result: `"${command.slice(0, 80)}" is not a shell command — cmd runs programs, not instructions. To inspect files use read_files; to create files use write_file; or send a real command that starts with a program name (dir, type, node, npm…).`,
      };
    }
    if (/^(cd|chdir)\b/i.test(command)) {
      return {
        ok: false,
        result: 'The working directory is fixed to the project root. Use read_files with a subdirectory path instead of cd.',
      };
    }
    const r = tools.runTerminal(projectDir, command);
    return r; // {ok, exitCode, stdout, stderr} — the loop formats it
  }

  if (name === 'git_commit') {
    return { ok: true, git: true, message: String(args?.message || 'NILCODE change').slice(0, 200) };
  }

  return { ok: false, result: `Unknown tool "${name}". Available: read_files, write_file, cmd, git_commit.` };
}

function formatToolResult(out) {
  if (out.git) return 'commit queued';
  if (typeof out.result === 'string' && out.result) return out.result;
  const parts = [];
  if (out.stdout) parts.push(`stdout:\n${out.stdout.slice(0, 3000)}`);
  if (out.stderr) parts.push(`stderr:\n${out.stderr.slice(0, 3000)}`);
  if (out.exitCode !== undefined && out.exitCode !== 0) parts.push(`exit code: ${out.exitCode}`);
  if (out.error) parts.push(`error: ${out.error}`);
  return parts.join('\n') || 'done';
}

// ---------------------------------------------------------------- parsing --

// Tolerant tool-call parser. Models routinely emit INVALID JSON here (raw
// newlines or unescaped quotes inside file content), and strict parsing turned
// those rounds into "unparseable" failures. Try strict JSON first, then
// salvage the known fields individually — content is taken verbatim between
// its opening quote and the tag's final quote, with a best-effort escape fix.
function parseToolCall(raw) {
  const body = raw.trim();
  try {
    const j = JSON.parse(body);
    if (j && typeof j === 'object') return j;
  } catch { /* fall through to tolerant parsing */ }

  const tool = /"tool"\s*:\s*"([a-z_]+)"/.exec(body)?.[1] || /"name"\s*:\s*"([a-z_]+)"/.exec(body)?.[1];
  if (!tool) return null;
  const call = { tool };
  const str = (key) => {
    const m = new RegExp(`"${key}"\\s*:\\s*"((?:[^"\\\\]|\\\\.)*)"`).exec(body)?.[1];
    if (m === undefined) return undefined;
    try { return JSON.parse(`"${m}"`); } catch { return m; }
  };
  for (const key of ['path', 'command', 'message', 'notes']) {
    const v = str(key);
    if (v !== undefined) call[key] = v;
  }
  const pathsArr = /"paths"\s*:\s*\[([^\]]*)\]/.exec(body)?.[1];
  if (pathsArr) call.paths = [...pathsArr.matchAll(/"((?:[^"\\]|\\.)*)"/g)].map((m) => m[1]);
  // Content aliases: models drift between "content", "code", "source" and
  // "body" for the file body — accept all of them.
  for (const key of ['content', 'code', 'source', 'body']) {
    const cStart = body.search(new RegExp(`"${key}"\\s*:\\s*"`));
    if (cStart < 0) continue;
    let content = body
      .slice(cStart)
      .replace(new RegExp(`^"${key}"\\s*:\\s*"`), '')
      .replace(/\s*\}\s*$/, '')
      .replace(/"\s*$/, '');
    // Models often leave raw newlines/tabs (invalid JSON). Escape those and
    // re-parse so legitimate \\n and \\" sequences still decode correctly;
    // if that still fails, use the text verbatim.
    try {
      content = JSON.parse(`"${content.replace(/\r?\n/g, '\\n').replace(/\t/g, '\\t')}"`);
    } catch { /* verbatim */ }
    if (content.trim()) {
      call.content = content;
      break;
    }
  }
  if (call.content !== undefined || call.path || call.command || call.paths || call.message) return call;
  return null;
}

// ------------------------------------------------------------------- the loop --

export async function runAgent({ user, project, prompt, emit, attachments, preferredModel }) {
  const emitSafe = (e) => { try { emit(e); } catch { /* client gone */ } };
  const registry = new ProviderRegistry(user.id);
  const projectDir = project.path;
  const maxRounds = config.agentMaxRounds || 24;

  appendMessage(user.id, project.id, { role: 'user', content: prompt });
  emitSafe({ type: 'user', content: prompt });

  emitSafe({ type: 'status', text: 'Understanding request…' });
  let context = {};
  try { context = tools.readContext(projectDir); } catch { /* empty workspace */ }

  const messages = [
    { role: 'system', content: SYSTEM_PERSONA },
    {
      role: 'user',
      content: [
        `Project context:\n${renderContext(context)}`,
        connectorContext(user.id, projectDir),
        attachments?.text,
        'Recent conversation:',
        recentConversation(user.id, project.id, 8),
        `Current request: ${prompt}`,
      ]
        .filter(Boolean)
        .join('\n\n'),
    },
  ];

  // Files created/updated this run, emitted live for the UI's change list.
  const touched = { created: [], updated: [] };
  // existedBefore must be captured BEFORE the file is written to disk.
  const noteFileWrite = (path, existedBefore) => {
    if (touched.created.includes(path) || touched.updated.includes(path)) return;
    (existedBefore ? touched.updated : touched.created).push(path);
    emitSafe({ type: 'files', created: [...touched.created], updated: [...touched.updated] });
  };

  let usedProvider = null;
  let lastError = null;
  let lastProse = null; // last plain-prose round (protocol drift fallback)
  let finalText = null;
  let rounds = 0;
  let toolActions = 0; // writes + real commands — "did the agent actually work?"
  let repeatedFails = 0;
  let gitMessage = null;
  let statusText = 'Working…';
  // write_file registrations per path — repeated registrations without content
  // trigger an escalating instruction instead of an infinite inspect/register
  // loop.
  const registrations = new Map();

  const setStatus = (t) => { statusText = t; emitSafe({ type: 'status', text: t }); };

  // Live token relay: the provider's streamed deltas become real 'token'
  // events so the UI can show the answer as it forms. The frontend unwraps
  // the final JSON envelope; raw deltas are never persisted.
  let streamStarted = false;
  const streamRelay = (delta) => {
    if (!streamStarted) {
      streamStarted = true;
      emitSafe({ type: 'stream_start' });
    }
    emitSafe({ type: 'token', text: delta });
  };

  while (rounds < maxRounds && finalText === null) {
    rounds++;
    streamStarted = false;
    // Each round is a fresh model response: the client clears its streaming
    // buffer so fragments of earlier rounds never bleed into the answer.
    emitSafe({ type: 'stream_reset' });
    if (rounds > 1) emitSafe({ type: 'activity', text: statusText });
    if (rounds === maxRounds - 1) {
      // Reserve the closing round: force a summary instead of burning the last
      // round on another tool call.
      messages.push({
        role: 'user',
        content: 'You are almost out of steps. Wrap up NOW: reply ONLY {"summary": "…"} describing what was completed and what remains.',
      });
    }

    let res;
    try {
      // History compaction: long builds accumulate tool results and blow past
      // provider token ceilings (Groq's TPM, OpenRouter free-tier limits).
      // Keep the system prompt, the original request, and the most recent
      // exchanges — older tool output has already been consumed by the model.
      if (messages.length > 12) {
        const compacted = [messages[0], messages[1], ...messages.slice(-8)];
        messages.length = 0;
        messages.push(...compacted);
      }
      res = await registry.chat('planner', messages, {
        maxTokens: 6000,
        temperature: 0.2,
        images: rounds === 1 ? attachments?.images || [] : [],
        preferredModel,
        onToken: streamRelay,
      });
    } catch (err) {
      const code = err.code || 'UNAVAILABLE';
      const message = err.message || 'NILCODE AI is temporarily unavailable.';
      logAIError('chat failed', err.detail || err.message);
      if (toolActions > 0 || touched.created.length || touched.updated.length) {
        // Real work happened before the connection dropped — report it instead
        // of throwing the run away. Honest: the work IS saved on disk.
        const parts = [];
        if (touched.created.length) parts.push(`created ${touched.created.join(', ')}`);
        if (touched.updated.length) parts.push(`updated ${touched.updated.join(', ')}`);
        const summary = `I ${parts.join(' and ')} before the AI connection dropped. Everything is saved in your project — ask me to continue and I will pick up where I left off.`;
        appendMessage(user.id, project.id, { role: 'assistant', content: summary, aiError: code });
        emitSafe({ type: 'files', created: [...touched.created], updated: [...touched.updated] });
        emitSafe({ type: 'assistant', content: summary, provider: usedProvider?.label });
        emitSafe({ type: 'error', message: 'AI connection lost mid-task.', code });
      } else {
        appendMessage(user.id, project.id, { role: 'assistant', content: `⚠️ ${message}`, aiError: code });
        emitSafe({ type: 'error', message, code });
      }
      emitSafe({ type: 'done' });
      return { ok: false, error: code };
    }
    usedProvider = res.provider;
    // Metering: one chat request counts once (round 1); follow-up tool rounds
    // add their tokens so cost tracking stays honest without inflating the
    // per-day request counter.
    if (res.provider.platform) {
      recordUsage(user.id, { requests: rounds === 1 ? 1 : 0, tokens: res.usage?.total_tokens || 0 });
    }
    if (rounds === 1) emitSafe({ type: 'model', id: res.provider.id, label: res.provider.label, model: res.provider.model });

    // ---- parse the round: tool calls, a plan, a reply, or a summary ----
    const rawTags = [...res.text.matchAll(/<tool>([\s\S]*?)<\/tool>/g)].map((m) => m[1]);
    const toolCalls = rawTags.map((t) => parseToolCall(t)).filter(Boolean);

    if (toolCalls.length) {
      repeatedFails = 0;
      for (const call of toolCalls) {
        const name = call.tool || call.name || call.action;
        // Capture BEFORE dispatch: after the tool runs, the file obviously
        // exists, and created-vs-updated would always read "updated".
        const preExisted =
          name === 'write_file' && typeof call.path === 'string' ? existsSync(join(projectDir, call.path)) : false;
        let out;
        if (String(name).includes('.')) {
          // Connector capability (<connector>.<capability>): executed against
          // the user's real connected service, with human approval for
          // consequential actions. Results are model-facing and secret-free.
          toolActions++;
          out = await dispatchConnectorTool({
            userId: user.id,
            projectDir,
            name,
            args: call,
            emitSafe,
            setStatus,
          });
        } else {
          try {
            out = dispatchTool({ name, args: call, projectDir, registry, prompt, registrations });
          } catch (e) {
            // A crashing tool (bad path, disk error…) becomes feedback for the
            // model, not a crashed run.
            out = { ok: false, result: `Tool error: ${e.message}` };
          }
        }

        if (out.git) {
          // Deferred so a failing commit never blocks the build itself.
          try {
            await localGit.ensureRepo(projectDir);
            await localGit.commit(projectDir, out.message || 'NILCODE change');
            setStatus('Saving a checkpoint…');
          } catch (e) {
            messages.push({ role: 'assistant', content: res.text.slice(0, 4000) });
            messages.push({ role: 'user', content: `git_commit failed: ${e.message}. Continue with the task.` });
            continue;
          }
          messages.push({ role: 'assistant', content: res.text.slice(0, 4000) });
          messages.push({ role: 'user', content: 'Checkpoint committed. Continue.' });
          continue;
        }

        if (name === 'write_file' && typeof call.path === 'string' && typeof call.content === 'string' && call.content.length) {
          noteFileWrite(call.path, preExisted);
          toolActions++;
          setStatus('Creating files…');
        } else if (name === 'cmd' && typeof out.ok === 'boolean') {
          toolActions++;
          setStatus('Running checks…');
        } else if (name === 'read_files') {
          setStatus('Inspecting project…');
        }

        messages.push({ role: 'assistant', content: res.text.slice(0, 4000) });
        messages.push({
          role: 'user',
          content: `<tool_result tool="${name}" ok=${out.ok === false ? 'false' : 'true'}>\n${formatToolResult(out).slice(0, 6000)}\n</tool_result>`,
        });
      }
      continue;
    }

    // ---- structured decisions: {plan:[...]} or {reply:"..."} ----
    const objMatch = res.text.match(/\{[\s\S]*\}/);
    let decision = null;
    if (objMatch) {
      try { decision = JSON.parse(objMatch[0]); } catch { decision = null; }
    }

    if (decision && typeof decision.reply === 'string' && decision.reply.trim()) {
      // Conversational answer — no project changes.
      appendMessage(user.id, project.id, { role: 'assistant', content: decision.reply });
      emitSafe({ type: 'assistant', content: decision.reply, provider: usedProvider.label });
      emitSafe({ type: 'done' });
      return { ok: true, reply: decision.reply };
    }

    if (decision && Array.isArray(decision.plan) && decision.plan.length) {
      // A declared plan: show it, then let the loop execute it with tools.
      // Plan titles are informational; the activity stream carries the real
      // operations — no per-step states are invented.
      emitSafe({ type: 'plan', provider: usedProvider.label, steps: decision.plan.map((s) => String(s?.title || s).slice(0, 120)) });
      messages.push({ role: 'assistant', content: res.text.slice(0, 4000) });
      messages.push({
        role: 'user',
        content: 'Plan noted. Execute it now with tool calls. Start by inspecting anything you have not seen yet.',
      });
      continue;
    }

    if (decision && typeof decision.summary === 'string' && decision.summary.trim()) {
      if (toolActions === 0) {
        // Claimed completion without doing anything — one correction, then stop.
        if (repeatedFails++ === 0) {
          messages.push({ role: 'assistant', content: res.text.slice(0, 2000) });
          messages.push({
            role: 'user',
            content: 'You reported completion but made no changes. If the request needs work, start now with tool calls. Only reply JSON {"reply": …} if it truly needs none.',
          });
          continue;
        }
        finalText = decision.summary;
        break;
      }
      finalText = decision.summary;
      break;
    }

    // ---- unparseable output: guide the model back on track ----
    lastError = 'model produced an unparseable response';
    lastProse = res.text; // free models often answer in plain prose; keep it
    const hadTags = /<tool>/.test(res.text);
    const limit = hadTags ? 4 : 2; // salvageable tool calls get more chances
    if (repeatedFails++ < limit) {
      messages.push({ role: 'assistant', content: res.text.slice(0, 2000) });
      messages.push({
        role: 'user',
        content: hadTags
          ? 'The tool call could not be parsed (invalid JSON). Resend the SAME action as ONE JSON object inside <tool></tool> tags. In "content", write every newline as \\n and every quote as \\" — or keep content on a single line.'
          : 'Format error. To use a tool, wrap one JSON object per action in <tool></tool> tags, e.g. <tool>{"tool":"read_files","paths":["."]}</tool>. To finish, reply ONLY {"summary": "…"}. To just answer, reply ONLY {"reply": "…"}.',
      });
      continue;
    }
    break;
  }

  if (finalText === null) {
    const work = touched.created.length || touched.updated.length
      ? `So far I ${[
          touched.created.length ? `created ${touched.created.join(', ')}` : '',
          touched.updated.length ? `updated ${touched.updated.join(', ')}` : '',
        ]
          .filter(Boolean)
          .join(' and ')}. `
      : '';
    // No work done and the model spoke in plain prose? Its words ARE the
    // answer (protocol drift on free models) — deliver them rather than a
    // canned failure.
    if (!work && lastProse && lastProse.trim().length > 40 && !/<tool>/.test(lastProse)) {
      finalText = lastProse.trim().slice(0, 2000);
    } else {
      finalText = lastError
        ? `${work}I had trouble completing the rest of this request — a model response could not be processed. Please try again and I will pick up where I left off.`
        : `${work}I hit the step limit before finishing. Ask me to continue and I will pick up where I left off.`;
    }
  }

  appendMessage(user.id, project.id, { role: 'assistant', content: finalText });
  if (touched.created.length || touched.updated.length) {
    emitSafe({ type: 'files', created: [...touched.created], updated: [...touched.updated] });
  }
  emitSafe({ type: 'assistant', content: finalText, provider: usedProvider?.label });
  emitSafe({ type: 'done' });
  return { ok: true, summary: finalText, files: touched, rounds };
}

// ---------------------------------------------------------------- planning (compat) --

// One-shot planner kept for API compatibility and simple integrations: it
// asks the model for either a step array or a conversational reply.
export async function planWithModel(registry, { prompt, context, conversation, attachments }) {
  const messages = [
    { role: 'system', content: SYSTEM_PERSONA },
    {
      role: 'user',
      content: [
        `Project context:\n${renderContext(context)}`,
        conversation ? `Recent conversation:\n${conversation}` : '',
        attachments?.text,
        `Current request: ${prompt}`,
        'Produce the JSON response now (array of steps, or {"reply": "..."}).',
      ]
        .filter(Boolean)
        .join('\n\n'),
    },
  ];
  const res = await registry.chat('planner', messages, {
    maxTokens: 3000,
    temperature: 0.2,
    images: attachments?.images || [],
  });
  const text = res.text.trim();
  const arrMatch = text.match(/\[[\s\S]*\]/);
  if (arrMatch) {
    const steps = JSON.parse(arrMatch[0]);
    if (Array.isArray(steps) && steps.length) return { kind: 'plan', steps, provider: res.provider };
  }
  const objMatch = text.match(/\{[\s\S]*\}/);
  if (objMatch) {
    const obj = JSON.parse(objMatch[0]);
    if (typeof obj.reply === 'string') return { kind: 'reply', reply: obj.reply, provider: res.provider };
  }
  return { kind: 'reply', reply: text, provider: res.provider };
}
