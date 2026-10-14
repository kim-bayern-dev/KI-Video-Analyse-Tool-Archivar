#!/usr/bin/env bash
# Shared configuration for all scripts

# Load environment variables from .env file if it exists
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
if [ -f "${SCRIPT_DIR}/.env" ]; then
    set -a  # automatically export all variables
    source "${SCRIPT_DIR}/.env"
    set +a  # turn off automatic export
fi

# Container configuration
export NAME="sample-data-serve"
export IMAGE="sample-data-serve:latest"
# Host port; 8080 is used by vespa
export CADDY_PORT="${CADDY_PORT:-8090}"
# Absolute path required: docker -v rejects relative sources
export DATA_DIR="${DATA_DIR:-$(cd "${SCRIPT_DIR}/../sample_data" && pwd)}"  # Directory to serve data from (optional)

# Extra arguments to pass as the container command/arguments (optional)
# If set, these will be appended after the image name in the `docker run` command.
# Example for an app that expects runtime flags:
#   EXTRA_ARGS="--port 8080 --host 0.0.0.0"
# Leave empty for images that use their own default CMD/ENTRYPOINT (like caddy).
export EXTRA_ARGS="${EXTRA_ARGS:-}"

# Network configuration
export NET="${NET:-local-cloud}"
export ALIAS="${ALIAS:-sample-data-serve}"