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

# -------- Validation --------
echo "=== Docker Container Configuration ==="
echo "  Container name:    $NAME"
echo "  Docker image:      $IMAGE"
echo "  Network:           $NET"
echo "  Network alias:     $ALIAS"
echo "  Port mapping:      ${ARCHIVAR_PORT}:80"
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
  if [[ "${ASSUME_YES:-}" == "1" ]]; then
    ans="Y"
  else
    read -r -p "Create network '$NET'? [Y/n] " ans
  fi
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

# -------- Confirmation (skippable via ASSUME_YES=1, used by the Make targets) --------
if [[ "${ASSUME_YES:-}" != "1" ]]; then
  read -r -p "Start the container? [Y/n] " ans
  case "${ans:-Y}" in
    n|N) echo "Aborted."; exit 1 ;;
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
  "--network" "$NET" "--network-alias" "$ALIAS"
  "-p" "${ARCHIVAR_PORT}:80"
  "--ipc=host"
  "--ulimit" "memlock=-1" "--ulimit" "stack=67108864"
  "--restart" "unless-stopped"
  # this is because the tools mounted are itself docker containers
  # and the host docker daemon should manage them when started
  "-v" "/var/run/docker.sock:/var/run/docker.sock"
  # mount the default .env file
  "-v" ".env:/app/.env:ro"
  # inject the .env into the process environment: the bind mount alone only
  # makes /app/.env readable — endpoint resolution (Override > static config
  # > env:VAR) silently falls back without it ("no endpoint configured").
  # Keep .env single-line JSON values on one line (JSON.parse fails silently).
  "--env-file" "$PWD/.env"
  # GPU access for tool containers started through the mounted Docker socket
  # (their run.sh resolves GPUs via nvidia-smi inside this container)
  "--gpus" "all"
  # Docker socket access for the non-root container (UID 1000, see Dockerfile)
  "--group-add" "$(getent group docker | cut -d: -f3)"
  # Map host.docker.internal to the host gateway so the container can reach
  # model servers published on the Docker host's ports (see .env.example's
  # MODEL_CONFIG). Portable: no machine-specific gateway IPs.
  "--add-host" "host.docker.internal:host-gateway"
  # Tool resolution inside the container: the sibling projects are mounted at
  # their identical host path (below), so the app finds their run.sh here
  # (dev uses RELATIVE_TOOLS_PATH against the checkout instead)
  "--env" "ABSOLUTE_TOOLS_PATH=${TOOLS_DIR}"
)

# Add volume mount only if DATA_DIR is set
if [[ -n "${DATA_DIR:-}" ]]; then
  RUN_ARGS+=("-v" "${DATA_DIR}:/sample_data/archivar:rw")
fi

# Add volume mount only if TOOLS_DIR is set.
# IDENTICAL host and container path (not /tools): run.sh is spawned INSIDE the
# archivar container, but its `docker run` goes to the HOST daemon — realpath
# checks the container filesystem while -v resolves on the host. Only an
# identical path makes both views coincide. rw: tool containers need to write
# out_* folders next to the media.
if [[ -n "${TOOLS_DIR:-}" ]]; then
  RUN_ARGS+=("-v" "${TOOLS_DIR}:${TOOLS_DIR}:rw")
fi

# Add extra hosts if EXTRA_HOSTS is set
if [[ -n "${EXTRA_HOSTS:-}" ]]; then
  IFS=',' read -ra HOSTS <<< "$EXTRA_HOSTS"
  for host in "${HOSTS[@]}"; do
    # Trim whitespace
    host=$(echo "$host" | xargs)
    if [[ -n "$host" ]]; then
      RUN_ARGS+=("--add-host" "$host")
    fi
  done
fi

docker rm -f "$NAME" >/dev/null 2>&1 || true

RUN_ARGS+=("$IMAGE")

# Execute docker run
docker "${RUN_ARGS[@]}"
  
echo "Container '$NAME' started successfully!"
echo "API endpoint: http://localhost:$ARCHIVAR_PORT"
echo ""
echo "To check logs: docker logs -f $NAME"
echo "To stop:       ./stop.sh"