// The NILCODE AI agent engine.
// Pipeline: understand → plan (real AI) → implement with tools → report.
// Every response comes from a configured AI provider. If no provider is
// available, the agent says so honestly — it never fakes success.
import { join } from 'node:path';
import { existsSync } from 'node:fs';
import { ProviderRegistry } from '../providers/registry.js';
import * as tools from './tools.js';
import * as localGit from '../git/local.js';
import { readJson, writeJson } from '../store.js';
import config from '../config.js';
import { logAIError } from '../providers/registry.js';
import { recordUsage } from '../ai-usage.js';

const SYSTEM_PERSONA = `You are NILCODE AI, an autonomous software development agent.
The user may not know how to program. Explain in clear, plain language when you talk to them.
You operate inside a project directory with these tools:
- write_file(path, content) — create or update a file
- read_file(path) — read a file
- list() — list project files
- command(command) — run a shell command in the project
- git_commit(message) — commit current changes
Preserve any existing design system: reuse the project's colors, typography, components and conventions.
If the request is a question, explanation, or anything that needs no project changes, answer conversationally.
When you decide to modify the project, respond ONLY with a JSON array of steps:
[{"title": "...", "action": "write_file|command|test|git_commit", "path": "...", "details": "..."}]
When you only need to talk, respond ONLY with a JSON object: {"reply": "your answer"}`;

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

// ------------------------------------------------------------------ planning --

function recentConversation(userId, projectId, limit = 10) {
  const msgs = loadConversation(userId, projectId).messages || [];
  return msgs
    .slice(-limit)
    .map((m) => `${m.role === 'user' ? 'User' : 'You'}: ${String(m.content).slice(0, 400)}`)
    .join('\n');
}

function projectContextText(context) {
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
  if (context.architecture?.detected?.length) {
    lines.push(`Detected stack: ${context.architecture.detected.join(', ')}`);
  }
  if (context.conventions?.styling) lines.push(`Styling: ${context.conventions.styling}`);
  if (context.memory?.entries?.length) {
    lines.push(
      `Project memory (must respect): ${context.memory.entries.slice(-10).map((e) => e.text || e).join('; ')}`
    );
  }
  return lines.length ? lines.join('\n') : '(empty workspace)';
}

export async function planWithModel(registry, { prompt, context, conversation, attachments }) {
  const messages = [
    { role: 'system', content: SYSTEM_PERSONA },
    {
      role: 'user',
      content: [
        `Project context:\n${projectContextText(context)}`,
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
  // Parse either a steps array or a conversational reply object.
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
  // Model answered in plain text: treat it as a conversational answer.
  return { kind: 'reply', reply: text, provider: res.provider };
}

// ------------------------------------------------------------------ execution --

export async function runAgent({ user, project, prompt, emit, attachments }) {
  const emitSafe = (e) => { try { emit(e); } catch { /* client gone */ } };
  const registry = new ProviderRegistry(user.id);
  const projectDir = project.path;

  appendMessage(user.id, project.id, { role: 'user', content: prompt });
  emitSafe({ type: 'user', content: prompt });

  // 1. Understand: compact project context (never the whole repo).
  emitSafe({ type: 'status', text: 'Reading the project…' });
  let context = {};
  try { context = tools.readContext(projectDir); } catch { /* empty */ }
  if (attachments?.text) {
    emitSafe({ type: 'status', text: `Using ${attachments.images.length ? `${attachments.images.length} image(s) and ` : ''}${attachments.text.split('Attachment — ').length - 1} attachment(s) as context…` });
  }

  // 2. Plan / converse via the real AI path. No fallback, no simulation.
  emitSafe({ type: 'status', text: 'Thinking…' });
  let decision;
  try {
    decision = await planWithModel(registry, {
      prompt,
      context,
      conversation: recentConversation(user.id, project.id, 8),
      attachments,
    });
    // Meter platform-AI usage (BYO providers and Ollama are not metered).
    if (decision.provider.platform) {
      recordUsage(user.id, { tokens: decision.usage?.total_tokens || 0 });
    }
  } catch (err) {
    // Friendly user copy; full provider detail goes to server logs only.
    const code = err.code || 'UNAVAILABLE';
    const message = err.message || 'NILCODE AI is temporarily unavailable.';
    logAIError('chat failed', err.detail || err.message);
    appendMessage(user.id, project.id, { role: 'assistant', content: `⚠️ ${message}`, aiError: code });
    emitSafe({ type: 'error', message, code });
    emitSafe({ type: 'done' });
    return { ok: false, error: code };
  }

  // Conversational answer (questions, explanations, "why did you do that?").
  if (decision.kind === 'reply') {
    appendMessage(user.id, project.id, { role: 'assistant', content: decision.reply });
    emitSafe({ type: 'assistant', content: decision.reply, provider: decision.provider.label });
    emitSafe({ type: 'done' });
    return { ok: true, reply: decision.reply };
  }

  // 3. Execute the plan with real tools.
  const plan = decision.steps;
  emitSafe({
    type: 'plan',
    provider: decision.provider.label,
    steps: plan.map((s) => s.title),
  });

  const outputs = [];
  let stepIndex = 0;
  for (const step of plan) {
    stepIndex++;
    emitSafe({ type: 'step', index: stepIndex, total: plan.length, title: step.title, state: 'running' });
    try {
      const result = await executeStep({ step, projectDir, registry, prompt, context, emit: emitSafe });
      outputs.push({ title: step.title, ok: true, result });
      emitSafe({
        type: 'step',
        index: stepIndex,
        total: plan.length,
        title: step.title,
        state: 'done',
        result: summarize(result),
      });
    } catch (err) {
      outputs.push({ title: step.title, ok: false, error: err.message });
      emitSafe({
        type: 'step',
        index: stepIndex,
        total: plan.length,
        title: step.title,
        state: 'error',
        error: err.message,
      });
    }
  }

  // 4. Refresh the compact project index.
  try { tools.indexProject(projectDir); } catch { /* non-fatal */ }

  // 5. Report honestly, including partial failures.
  const failed = outputs.filter((o) => !o.ok);
  const summary = failed.length
    ? `Finished with ${failed.length} issue(s): ${failed.map((f) => `${f.title} — ${f.error}`).join('; ')}.`
    : `Completed all ${outputs.length} step(s). You can preview the project or describe the next change.`;
  appendMessage(user.id, project.id, { role: 'assistant', content: summary, plan: plan.map((s) => s.title) });
  emitSafe({ type: 'assistant', content: summary, provider: decision.provider.label });
  emitSafe({ type: 'done' });
  return { ok: failed.length === 0, outputs, summary };
}

function summarize(result) {
  if (result == null) return '';
  if (typeof result === 'string') return result;
  if (result.files) return `Wrote: ${result.files.join(', ')}`;
  if (result.exitCode !== undefined) return `exit ${result.exitCode}`;
  return JSON.stringify(result).slice(0, 200);
}

async function executeStep({ step, projectDir, registry, prompt, context }) {
  switch (step.action) {
    case 'index':
      return tools.indexProject(projectDir);
    case 'git_commit': {
      await localGit.ensureRepo(projectDir);
      return localGit.commit(projectDir, step.details || prompt.slice(0, 60) || 'NILCODE change');
    }
    case 'test': {
      const file = step.path || step.details || 'index.html';
      if (!existsSync(join(projectDir, file))) throw new Error(`${file} not found after build.`);
      return `Verified ${file} exists.`;
    }
    case 'write_file': {
      if (!step.path) throw new Error('Plan step is missing a file path.');
      const tree = tools.listTree(projectDir, '.', 3).slice(0, 80).join('\n');
      let existing = '';
      if (existsSync(join(projectDir, step.path))) {
        try { existing = tools.readFile(projectDir, step.path).content; } catch { /* gone */ }
      }
      const res = await registry.chat(
        'coder',
        [
          { role: 'system', content: SYSTEM_PERSONA },
          {
            role: 'user',
            content: [
              `Write the complete content for the file "${step.path}".`,
              `Overall task: ${step.details || prompt}`,
              tree ? `Existing project files:\n${tree}` : '',
              existing ? `Current content of ${step.path}:\n${existing.slice(0, 8000)}` : '',
              'Respond with the complete file content only — no explanations, no markdown fences.',
            ]
              .filter(Boolean)
              .join('\n\n'),
          },
        ],
        { maxTokens: 8000, temperature: 0.2 }
      );
      const content = res.text.replace(/^```[a-zA-Z0-9]*\n/, '').replace(/```\s*$/, '');
      tools.writeFileTool(projectDir, step.path, content);
      return { files: [step.path] };
    }
    case 'command': {
      const r = await tools.runTerminal(projectDir, step.details || step.title);
      if (!r.ok) throw new Error(r.stderr || `Command failed with exit code ${r.exitCode}`);
      return r.stdout.slice(0, 400) || 'OK';
    }
    default:
      throw new Error(`Unsupported plan action: ${step.action}`);
  }
}
