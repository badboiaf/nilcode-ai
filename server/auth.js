// Multi-user foundation: signup/login, bearer-token sessions, credential isolation.
import { join } from 'node:path';
import { scryptSync, randomBytes, timingSafeEqual } from 'node:crypto';
import config from './config.js';
import { Collection, ensureDir, token } from './store.js';

const users = new Collection(join(config.dataDir, 'users.json'));
const sessions = new Collection(config.sessionsFile);

function hashPassword(password, salt) {
  return scryptSync(password, salt, 32).toString('hex');
}

export function createUser({ email, password, name }) {
  const id = email.trim().toLowerCase();
  if (users.data[id]) throw new Error('An account with this email already exists.');
  const salt = randomBytes(16).toString('hex');
  users.data[id] = {
    id,
    email: id,
    name: name || id.split('@')[0],
    salt,
    passwordHash: hashPassword(password, salt),
    createdAt: Date.now(),
  };
  users.save();
  ensureDir(join(config.usersDir, id));
  return publicUser(users.data[id]);
}

export function verifyUser(email, password) {
  const id = String(email || '').trim().toLowerCase();
  const u = users.data[id];
  if (!u) return null;
  const a = Buffer.from(u.passwordHash, 'hex');
  const b = Buffer.from(hashPassword(password, u.salt), 'hex');
  return a.length === b.length && timingSafeEqual(a, b) ? publicUser(u) : null;
}

export function getUser(id) {
  const u = users.data[id];
  return u ? publicUser(u) : null;
}

export function publicUser(u) {
  return { id: u.id, email: u.email, name: u.name, createdAt: u.createdAt };
}

export function createSession(userId) {
  const t = token(32);
  sessions.data[t] = { userId, createdAt: Date.now() };
  sessions.save();
  return t;
}

export function resolveSession(t) {
  const s = t && sessions.data[t];
  if (!s) return null;
  return getUser(s.userId);
}

export function destroySession(t) {
  if (sessions.data[t]) {
    delete sessions.data[t];
    sessions.save();
  }
}

export function sessionCount() {
  return Object.keys(sessions.data).length;
}

export { users, sessions };
