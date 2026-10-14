#!/usr/bin/env bash
# Shared configuration for all container scripts (start/stop/build/cli/logs/
# status/shell). Reads the CONTAINER env file `.env` (see .env.example) — the
# dev server's `.env.local` is deliberately NOT used here.

# Load environment variables from .env file if it exists
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
if [ -f "${SCRIPT_DIR}/.env" ]; then
    set -a  # automatically export all variables
    source "${SCRIPT_DIR}/.env"
    set +a  # turn off automatic export
fi

# Container configuration (includes model variant in name)
export NAME="archivar"
export IMAGE="archivar:latest"
# Published port for the container (Caddy :80 inside). 8802 is the default so
# the host-local dev server can keep 8801 alongside.
export ARCHIVAR_PORT="${ARCHIVAR_PORT:-8802}"  # Allow override via environment
# Host-side volume sources, derived from this script's own location so a fresh
# checkout works on any machine without editing absolute paths:
#   DATA_DIR  (default: ../sample_data/archivar next to the checkout)
#   TOOLS_DIR (default: the checkout's parent dir, where the sibling tool
#             projects live; mounted at its identical path, see start.sh)
export DATA_DIR="${SCRIPT_DIR}/${ARCHIVAR_DATA_DIR:-../sample_data/archivar}"
export TOOLS_DIR="${SCRIPT_DIR}/${ARCHIVAR_TOOLS_DIR:-..}"
# Extra --add-host entries (comma-separated host:ip pairs) for deployments
# whose model servers are not on the Docker host. Empty by default — set it
# in .env per machine.
export EXTRA_HOSTS="${EXTRA_HOSTS:-}"

# Network configuration
export NET="local-cloud"
export ALIAS="archivar"