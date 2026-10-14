#!/usr/bin/env bash
set -euo pipefail

# Archivar CLI - runs inside the Docker container
# Usage: ./cli.sh <command> [args...]
# Examples:
#   ./cli.sh list "*.mp4"
#   ./cli.sh workflows
#   ./cli.sh analyze --file "video.mp4" --workflow default-analysis-gemma4-e4b --format md

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/config.sh" "${1:-}"

CONTAINER_NAME="${NAME:-archivar}"

# Check if container is running  
if ! docker ps --format '{{.Names}}' | grep -q "^${CONTAINER_NAME}$"; then
  echo "Error: Container '$CONTAINER_NAME' is not running."
  echo "Start it with: ./start.sh"
  exit 1
fi

# Forward all arguments to the CLI script inside the container
docker exec "$CONTAINER_NAME" npx tsx /app/src/cli.ts "$@"
