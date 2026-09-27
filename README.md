# NULLCODE

**NULLCODE** is a premium AI coding workspace. Describe software in normal human language —
NULLCODE plans, builds, runs, tests and maintains it.

NULLCODE by XEER0 · © 2026 XEER0

## Quickstart

```bash
npm install
npm start          # runs on http://localhost:4310 (configure with PORT/HOST)
```

Open the app, create an account or sign in, create a project, and describe what you want
in the chat.

## AI — works out of the box for operators, zero setup for users

Ordinary users never configure API keys. NULLCODE resolves AI in this order:

1. **Your connected providers** (Settings → AI) — your keys, your quotas, kept per-user and never exposed.
2. **Platform default model** — the operator configures a server-managed provider once:

   ```bash
   NULLCODE_AI_TYPE=openai-compatible      # or anthropic
   NULLCODE_AI_BASE_URL=https://…/v1
   NULLCODE_AI_API_KEY=…
   NULLCODE_AI_MODEL=…
   npm start
   ```

3. **Local Ollama** (free, on your own machine) — detected automatically when running.

Optional operator controls:

```bash
NULLCODE_AI_DAILY_LIMIT=50   # platform AI requests per user per UTC day (default 50)
NULLCODE_AI_TIMEOUT_MS=180000 # upstream request timeout
```

Usage is metered per authenticated user; when the daily allowance is reached users see
a clear limit message with a reset time. Provider credentials never leave the server.

### Error behavior (users never see operator details)

| Situation | User sees |
|---|---|
| No platform AI configured | "NULLCODE AI is not configured yet." |
| Provider outage / auth failure | "NULLCODE AI is temporarily unavailable. Please try again in a moment." + retry |
| Daily limit reached | "You've reached your current usage limit…" + reset time |
| Provider rejects the request | "NULLCODE couldn't process that request." |
| Not signed in | "Sign in to use NULLCODE." |

Detailed provider errors are logged server-side only.

If no AI path is available, NULLCODE says so honestly. It never fakes results, never
simulates "completed" work, and never ships secret keys to clients.

## Product behavior

- **Projects**: name required, description optional. A description becomes the project's
  initial intent (`.nullcode/intent.json`) and is supplied to the AI as build context.
- **Chat**: real streaming conversation with the AI (questions answered conversationally,
  build requests planned and executed with real tools: file writes, terminal, git).
- **Preview & tests**: run any web project on a local port, browser-test it with Playwright.
- **Git**: every project is its own repository; checkpoints and rollback built in.
- **GitHub**: optional. Add a token in Settings → GitHub to publish repositories.
- **Multi-user**: isolated workspaces, conversations, credentials and memory per account.

## Attachments

Attach screenshots, images, PDFs, code, logs, documents and ZIP archives via the
composer's attach button, drag-and-drop anywhere, or pasting a screenshot. Files are
stored in per-user isolated storage, indexed with type-appropriate analysis (text
excerpts, PDF text extraction, ZIP structure listing), and selected per request by the
context engine — pinned files stay as persistent project context and explicitly named
files are always included. The only limits are infrastructure ones (100 MB per file),
never artificial usage quotas.

## Windows executable

```bash
npm run build:exe   # produces dist/NULLCODE/ with NULLCODE.exe + public/
```

Run `NULLCODE.exe`, open http://localhost:4310. All data lives in `.nullcode-data`
next to the exe; configure AI/Google via a `.env` file (see `.env.example` in the dist).

## Google sign-in

Optional, identity-only, verified server-side. Setup steps: see **README-GOOGLE.md**.

## Project context (.nullcode/)

Each project keeps a compact understanding index in `.nullcode/` (`project.json`,
`architecture.json`, `conventions.json`, `intent.json`, `memory.json`, …) so the AI gets
relevant context instead of whole repositories.

## Development

```bash
npm run dev                # auto-reload server
npm test                   # 14 test suites (incl. real-AI round-trip via a mock provider)
npm run install:browsers   # one-time Chromium download for in-app browser testing
```

## Architecture

```
server/            Express backend: auth, projects, agent, git, runtime
server/agent/      Tool loop, AI planning, project indexing
server/providers/  Model adapters (OpenAI-compatible, Anthropic, Ollama) + routing
server/git/        Local git + GitHub modules
server/runtime/    Dev-server manager, Playwright browser testing
public/            Web interface (auth-first boot, streaming chat, settings)
test/              Node built-in test suites
```
