# Deploying the NILCODE AI application server

The public site (xeer0.online) is a static/SSR Next.js app on Vercel. The
NILCODE application server is **stateful** — disk-backed accounts, projects
and git checkpoints, per-project preview servers, real terminals and an
optional headless browser — so it runs as its own always-on Node service and
the website proxies to it.

```
browser
  │
  ▼
xeer0.online (Vercel, Next.js)
  │  rewrite /nilcode-live/*  →  NILCODE_LIVE_ORIGIN   (baked at build time)
  ▼
NILCODE app server (always-on Node container, this repo)
  ├─ /data volume  — accounts, projects, files, git checkpoints
  ├─ per-project preview servers (internal ports)
  └─ AI provider keys, server-side only
```

## Why not Vercel?

Vercel runs serverless functions: ephemeral filesystem, no listening
sockets, request-scoped lifetimes. NILCODE needs long-lived processes,
persistent disk and per-project HTTP servers, so it requires an always-on
host. The website on Vercel + the app server on a container host is the
intended architecture.

## The one rule that matters

> `NILCODE_LIVE_ORIGIN` must be set in Vercel **before `next build`** —
> Next.js rewrites are baked into the build output. After adding/changing
> it, trigger **Redeploy** (with "Use existing build cache" **unchecked**).

## Environment variables

### On the app server host

| Variable | Required | Purpose |
|---|---|---|
| `NILCODE_BASE_PATH` | yes | `/nilcode-live` — mounts the app under the site path |
| `NULLCODE_DATA_DIR` | yes (Docker preset) | Where accounts/projects/files live — mount a persistent volume here |
| `OPENROUTER_API_KEY` / `GEMINI_API_KEY` / `GROQ_API_KEY` | one recommended | Built-in AI provider fallback chain (server-side only) |
| `NULLCODE_AI_TYPE` / `NULLCODE_AI_BASE_URL` / `NULLCODE_AI_API_KEY` / `NULLCODE_AI_MODEL` | optional | Platform AI mode: one upstream provider for all users |
| `NULLCODE_GOOGLE_CLIENT_ID` | optional | Enables Google sign-in |
| `NULLCODE_CHROMIUM_PATH` | optional | System Chromium for browser testing (preset in the Dockerfile) |
| `PORT` / `HOST` | preset | `4310` / `0.0.0.0` in the container |

Never put provider keys in the frontend or the Vercel project — the browser
only ever talks to `xeer0.online/nilcode-live/*`, which proxies to the app
server.

## Option A — Docker host you control (VPS, Oracle Always Free VM, home server)

```bash
git clone https://github.com/badboiaf/nilcode-ai.git && cd nilcode-ai
docker build -t nilcode-ai .
docker run -d --name nilcode \
  -p 127.0.0.1:4310:4310 \
  -v nilcode-data:/data \
  -e NILCODE_BASE_PATH=/nilcode-live \
  -e OPENROUTER_API_KEY=sk-or-... \
  --restart unless-stopped \
  nilcode-ai
```

Then front it with Caddy (automatic HTTPS, ~10-line Caddyfile):

```
nilcode.yourdomain.com {
  reverse_proxy 127.0.0.1:4310
}
```

Set in Vercel: `NILCODE_LIVE_ORIGIN=https://nilcode.yourdomain.com` and
redeploy. (Or skip the extra subdomain: proxy `/nilcode-live/*` from any
reverse proxy on the same box straight to port 4310.)

## Option B — Render

New → Blueprint, or a Web Service from the repo:
- Runtime **Docker** (repo root Dockerfile), Instance **Starter** ($7/mo; the
  free tier sleeps and has ephemeral disk — unacceptable for real use)
- Disk: mount 5 GB+ at `/data` (this is what makes accounts/projects persist)
- Env: `NILCODE_BASE_PATH=/nilcode-live` (+ provider key)
- Render gives `https://nilcode-xxxx.onrender.com` — that is your
  `NILCODE_LIVE_ORIGIN` (Render terminates TLS; no custom domain needed)

## Option C — Railway

New service → Deploy from `badboiaf/nilcode-ai`:
- Add a Volume mounted at `/data`
- Variables: `NILCODE_BASE_PATH=/nilcode-live`, provider key
- Railway generates the public domain — use it as `NILCODE_LIVE_ORIGIN`

## Option D — Fly.io

```bash
fly launch --dockerfile Dockerfile --name nilcode-ai --no-deploy
fly volumes create nilcode-data --size 3 --region iad
fly deploy
fly secrets set NILCODE_BASE_PATH=/nilcode-live OPENROUTER_API_KEY=sk-or-...
fly ips allocate-v4 --dedicated   # or use fly.dev domain
```

## After the server is up

1. `curl https://<server-origin>/nilcode-live/api/auth/google/status` → `{"enabled":...}` JSON (not a redirect)
2. In Vercel, set `NILCODE_LIVE_ORIGIN=https://<server-origin>` and redeploy **without build cache**
3. Open `https://xeer0.online/nilcode-live` → sign up, create a project, chat
4. The site's fallback screen is replaced by the real workspace

## Health & maintenance

- Health check: `GET /nilcode-live/api/auth/google/status` returns JSON
- Backups: snapshot the `/data` volume — it is the entire product state
- Updates: `git pull && docker build -t nilcode-ai . && docker restart nilcode` (or redeploy the service)
