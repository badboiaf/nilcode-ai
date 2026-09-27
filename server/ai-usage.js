// Platform AI usage accounting. Usage is associated with the authenticated
// user and enforced before any provider call. This is honest capacity control
// — the product never claims unlimited free AI. Local/user-provider calls are
// not metered (they cost the user nothing).
import { join } from 'node:path';
import { readJson, writeJson } from './store.js';
import config from './config.js';

// Platform AI requests per user per UTC day. Read dynamically so operators
// can tune it via env and tests can exercise enforcement.
function limit() {
  const env = Number(process.env.NULLCODE_AI_DAILY_LIMIT);
  if (env > 0) return env;
  const cfg = Number(config.platform.dailyLimit);
  return cfg > 0 ? cfg : 50;
}

function file(userId) {
  return join(config.usersDir, userId, 'ai-usage.json');
}

function utcDay() {
  return new Date().toISOString().slice(0, 10);
}

function load(userId) {
  const data = readJson(file(userId), { days: {} });
  const today = data.days[utcDay()] || { requests: 0, tokens: 0 };
  return { today, data };
}

export function usageState(userId) {
  const { today } = load(userId);
  const max = limit();
  return {
    used: today.requests,
    tokens: today.tokens,
    limit: max,
    remaining: Math.max(0, max - today.requests),
    resetsAt: `${utcDay()}T23:59:59Z`,
  };
}

export function checkUsage(userId) {
  const state = usageState(userId);
  return { allowed: state.remaining > 0, ...state };
}

export function recordUsage(userId, { requests = 1, tokens = 0 } = {}) {
  const { today, data } = load(userId);
  today.requests += requests;
  today.tokens += tokens;
  data.days[utcDay()] = today;
  // keep only the last 30 days of counters
  const keys = Object.keys(data.days).sort();
  while (keys.length > 30) delete data.days[keys.shift()];
  writeJson(file(userId), data);
  return usageState(userId);
}

export function dailyLimit() {
  return limit();
}
