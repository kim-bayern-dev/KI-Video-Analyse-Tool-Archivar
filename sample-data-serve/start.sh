#!/usr/bin/env bash
set -euo pipefail

# Usage information
if [[ "${1:-}" == "-h" || "${1:-}" == "--help" ]]; then
  echo "Usage: $0"
  exit 0
fi

# Load shared configuration
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=config.sh
source "$SCRIPT_DIR/config.sh" "${1:-}"

# Resolve DATA_DIR to an absolute path (docker -v rejects relative sources)
if [[ -n "${DATA_DIR:-}" ]]; then
  if [[ ! -d "$DATA_DIR" ]]; then
    echo "Error: DATA_DIR '$DATA_DIR' does not exist."
    exit 1
  fi
  DATA_DIR="$(cd "$DATA_DIR" && pwd)"
fi

# -------- Validation --------
echo "=== Docker Container Configuration ==="
echo "  Container name:    $NAME"
echo "  Docker image:      $IMAGE"
echo "  Network:           $NET"
echo "  Network alias:     $ALIAS"
echo "  Port mapping:      127.0.0.1:${CADDY_PORT}:80"
echo "  Data directory:    ${DATA_DIR:-<none>}"
echo "====================================="

# Check if Docker image exists
if ! docker image inspect "$IMAGE" >/dev/null 2>&1; then
  echo "Error: Docker image '$IMAGE' not found."
  echo "Please build the image first: ./build.sh"
  exit 1
fi

# Check if network exists
if ! docker network inspect "$NET" >/dev/null 2>&1; then
  echo "Warning: Docker network '$NET' does not exist."
  read -r -p "Create network '$NET'? [Y/n] " ans
  case "${ans:-Y}" in
    n|N) echo "Aborted."; exit 1 ;;
    *) 
      echo "Creating Docker network '$NET'..."
      if ! docker network create "$NET" 2>/dev/null; then
        # Network might have been created by another process
        if ! docker network inspect "$NET" >/dev/null 2>&1; then
          echo "Error: Failed to create network '$NET'"
          exit 1
        fi
      fi
      ;;
  esac
fi

# -------- Container Management --------
echo "Checking for existing container..."
if docker ps -a --format '{{.Names}}' | grep -q "^${NAME}$"; then
  echo "Removing existing container '$NAME'..."
  docker rm -f "$NAME" >/dev/null
  echo "Container removed."
fi

# -------- Run Container --------
echo "Starting container '$NAME'..."

# Build docker run command
RUN_ARGS=(
  "run" "-d" "--name" "$NAME"
  "--label" "host.pwd=$PWD"
  "--network" "$NET" "--network-alias" "$ALIAS"
  "-p" "127.0.0.1:${CADDY_PORT}:80"
  "--restart" "unless-stopped"
)

# Add volume mount only if DATA_DIR is set
if [[ -n "${DATA_DIR:-}" ]]; then
  RUN_ARGS+=("-v" "${DATA_DIR}:/sample_data:ro")
fi

RUN_ARGS+=("$IMAGE")

# Optionally append extra command/args to the container. These should only be used
# for images that expect runtime flags (e.g. a model server). For images like
# caddy that provide their own CMD/ENTRYPOINT, leave EXTRA_ARGS empty in
# `config.sh` or your `.env` to avoid overriding the image command.
if [[ -n "${EXTRA_ARGS:-}" ]]; then
  # Split EXTRA_ARGS into an array on whitespace safely
  read -r -a EXTRA_ARR <<< "${EXTRA_ARGS}"
  RUN_ARGS+=("${EXTRA_ARR[@]}")
fi

docker rm -f "$NAME" >/dev/null 2>&1 || true

# Execute docker run
docker "${RUN_ARGS[@]}"
  
echo "Container '$NAME' started successfully!"
echo "Endpoint:    http://127.0.0.1:$CADDY_PORT (host)"
echo "             http://$ALIAS:80 (from '$NET' docker network)"
echo ""
echo "To check logs: ./logs.sh -f"
echo "To stop:       ./stop.sh"
