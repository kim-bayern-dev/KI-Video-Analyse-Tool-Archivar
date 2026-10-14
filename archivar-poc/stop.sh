#!/usr/bin/env bash
set -euo pipefail

# Usage information
if [[ "${1:-}" == "-h" || "${1:-}" == "--help" ]]; then
  echo "Usage: $0"
  exit 0
fi

# Load shared configuration with argument
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=config.sh
source "$SCRIPT_DIR/config.sh" "${1:-}"

echo "=== Stopping Docker Container ==="
echo "  Container name: $NAME"
echo "================================="

# Check if container exists
if ! docker ps -a --format '{{.Names}}' | grep -q "^${NAME}$"; then
  echo "Container '$NAME' does not exist."
  exit 0
fi

# Check container status
CONTAINER_STATUS=$(docker inspect -f '{{.State.Status}}' "$NAME" 2>/dev/null || echo "not found")

case "$CONTAINER_STATUS" in
  "running")
    echo "Container '$NAME' is currently running."
    ;;
  "exited")
    echo "Container '$NAME' is stopped but still exists."
    ;;
  "paused")
    echo "Container '$NAME' is paused."
    ;;
  *)
    echo "Container '$NAME' status: $CONTAINER_STATUS"
    ;;
esac

# Confirmation (skippable via ASSUME_YES=1, used by the Make targets)
if [[ "${ASSUME_YES:-}" != "1" ]]; then
  read -r -p "Stop and remove container '$NAME'? [Y/n] " ans
  case "${ans:-Y}" in
    n|N) 
      echo "Aborted."
      exit 0
      ;;
  esac
fi

# Stop and remove container
echo "Stopping and removing container '$NAME'..."
if docker rm -f "$NAME" >/dev/null 2>&1; then
  echo "Container '$NAME' stopped and removed successfully!"
else
  echo "Failed to stop/remove container '$NAME'."
  exit 1
fi