// Per-user connector storage. Secrets are AES-256-GCM encrypted at rest
// (crypto.js) and NEVER included in any client-facing payload — list()
// returns only connection metadata. Connections belong to the authenticated
// user and live under their isolated data directory.
import { join } from 'node:path';
import config from '../config.js';
import { readJson, writeJson } from '../store.js';
import { encryptSecret, decryptSecret, isEncrypted } from './crypto.js';

function fileFor(userId) {
  return join(config.usersDir, userId, 'connectors.json');
}

export function listConnections(userId) {
  return readJson(fileFor(userId), { connections: [] }).connections;
}

export function getConnection(userId, connectorId) {
  return listConnections(userId).find((c) => c.connectorId === connectorId) || null;
}

export function upsertConnection(userId, connectorId, patch) {
  const data = readJson(fileFor(userId), { connections: [] });
  let conn = data.connections.find((c) => c.connectorId === connectorId);
  if (!conn) {
    conn = { connectorId, connectedAt: Date.now() };
    data.connections.push(conn);
  }
  Object.assign(conn, patch, { updatedAt: Date.now() });
  writeJson(fileFor(userId), data);
  return conn;
}

export function removeConnection(userId, connectorId) {
  const data = readJson(fileFor(userId), { connections: [] });
  const before = data.connections.length;
  data.connections = data.connections.filter((c) => c.connectorId !== connectorId);
  writeJson(fileFor(userId), data);
  return data.connections.length < before;
}

// ------------------------------------------------------------- secrets ----

// Store one or more secret values, encrypting each at rest.
export function setSecrets(userId, connectorId, secrets) {
  const enc = {};
  for (const [k, v] of Object.entries(secrets)) {
    if (v === undefined || v === null || v === '') continue;
    enc[k] = encryptSecret(String(v));
  }
  upsertConnection(userId, connectorId, { secrets: enc });
}

export function getSecret(userId, connectorId, key) {
  const conn = getConnection(userId, connectorId);
  const enc = conn?.secrets?.[key];
  if (!enc) return null;
  return isEncrypted(enc) ? decryptSecret(enc) : String(enc);
}

// ------------------------------------------------------------- metadata ---

// Client-safe view: connector id, status and NON-secret metadata only.
// Anything under `secrets` is stripped, always.
export function safeMeta(conn) {
  if (!conn) return null;
  const { secrets, ...rest } = conn;
  return rest;
}
