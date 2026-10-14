#!/bin/bash
set -euo pipefail

# The container reads `.env` (mounted at /app/.env by start.sh), not the dev
# server's `.env.local` — ENV_FILE makes that explicit so the env loaders in
# src/rpc.ts, src/db/db.ts and src/pages/health.ts resolve the same file that
# `docker run --env-file` already injected.
echo "[INFO] Starting Astro in dev mode (ENV_FILE=.env)…"
# No dev toolbar in container deployment mode (0 = off; unset enables it in dev).
export ARCHIVAR_DEV_TOOLBAR=0
cd /app && ENV_FILE=.env HOST=0.0.0.0 pnpm astro dev --host 1>&1 2>&2 &

# Start Caddy in the foreground (no daemon mode) with watch for config changes
caddy run --config /etc/caddy/Caddyfile --adapter caddyfile --watch
