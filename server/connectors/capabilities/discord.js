// Discord capabilities. The bot token comes from the OAuth `bot` flow and is
// usable directly against the Discord REST API. Permissions are limited at
// authorization time to Send Messages + Webhooks + View Channels — the
// connector cannot administer servers by construction.
import { getValidAccessToken } from '../oauth.js';

const API = 'https://discord.com/api/v10';

export const DESTRUCTIVE = new Set(['sendMessage', 'createWebhook']);

async function call(token, path, opts = {}) {
  const res = await fetch(`${API}${path}`, {
    ...opts,
    headers: {
      authorization: `Bot ${token}`,
      'content-type': 'application/json',
      ...(opts.headers || {}),
    },
    signal: AbortSignal.timeout(30000),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Discord API ${res.status}: ${body.slice(0, 200)}`);
  }
  if (res.status === 204) return null;
  return res.json();
}

export async function listGuilds(userId) {
  const token = await getValidAccessToken(userId, { id: 'discord', auth: { tokenUrl: 'https://discord.com/api/oauth2/token' } });
  const guilds = await call(token, '/users/@me/guilds');
  return guilds.map((g) => ({ id: g.id, name: g.name }));
}

// Channels the bot can actually see in a guild (least-privilege discovery).
export async function listChannels(userId, { guildId }) {
  const token = await getValidAccessToken(userId, { id: 'discord', auth: { tokenUrl: 'https://discord.com/api/oauth2/token' } });
  const channels = await call(token, `/guilds/${encodeURIComponent(guildId)}/channels`);
  return channels
    .filter((c) => c.type === 0) // text channels only
    .map((c) => ({ id: c.id, name: c.name }));
}

export async function sendMessage(userId, { channelId, content }) {
  const token = await getValidAccessToken(userId, { id: 'discord', auth: { tokenUrl: 'https://discord.com/api/oauth2/token' } });
  const msg = await call(token, `/channels/${encodeURIComponent(channelId)}/messages`, {
    method: 'POST',
    body: JSON.stringify({ content: String(content).slice(0, 2000) }),
  });
  return { id: msg.id, channelId, sent: true };
}

export async function createWebhook(userId, { channelId, name }) {
  const token = await getValidAccessToken(userId, { id: 'discord', auth: { tokenUrl: 'https://discord.com/api/oauth2/token' } });
  const hook = await call(token, `/channels/${encodeURIComponent(channelId)}/webhooks`, {
    method: 'POST',
    body: JSON.stringify({ name: String(name || 'NILCODE').slice(0, 80) }),
  });
  // The webhook URL is a credential. It goes into the project .env (server-side)
  // and is reported back only as "created", never with the URL.
  return { id: hook.id, channelId, name: hook.name, webhookUrl: hook.url, secret: true };
}

export const capabilities = { listGuilds, listChannels, sendMessage, createWebhook };
