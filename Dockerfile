# NILCODE AI application server — production container.
#
# The server is stateful by design: user accounts, projects, files and git
# checkpoints live on disk, per-project preview servers listen on local
# ports, and the agent runs real terminals. The container therefore mounts
# a volume at /data (NULLCODE_DATA_DIR) — everything the product persists
# must survive restarts.
#
# Run behind a reverse proxy that terminates TLS and forwards
# https://xeer0.online/nilcode-live/* to this container (see deploy/README).
#
# Build:  docker build -t nilcode-ai .
# Run:    docker run -d -p 4310:4310 -v nilcode-data:/data \
#           -e NILCODE_BASE_PATH=/nilcode-live \
#           -e OPENROUTER_API_KEY=... --name nilcode nilcode-ai
FROM node:22-bookworm-slim

# git: the agent commits real checkpoints into every project repo.
# chromium: the browser-testing feature drives a real browser; the distro
# build is used via Playwright's channel detection (no browser download).
RUN apt-get update \
  && apt-get install -y --no-install-recommends git chromium \
  && rm -rf /var/lib/apt/lists/*
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY server ./server
COPY public ./public

ENV NULLCODE_DATA_DIR=/data \
  NULLCODE_PUBLIC_DIR=/app/public \
  NULLCODE_CHROMIUM_PATH=/usr/bin/chromium \
  PORT=4310 \
  HOST=0.0.0.0
VOLUME /data
EXPOSE 4310

CMD ["node", "server/index.js"]
