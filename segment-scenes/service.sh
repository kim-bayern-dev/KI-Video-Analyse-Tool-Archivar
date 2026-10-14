#!/usr/bin/env bash
set -Eeuo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=config.sh
source "$SCRIPT_DIR/config.sh"

# Use the container-scoped `docker container inspect`: the ambiguous `docker inspect`
# would also match the image of the same name.
container_exists() {
  docker container inspect "$NAME" >/dev/null 2>&1
}

container_running() {
  [[ "$(docker container inspect -f '{{.State.Running}}' "$NAME" 2>/dev/null || true)" == "true" ]]
}

wait_for_health() {
  local deadline=$((SECONDS + SERVICE_START_TIMEOUT))
  while (( SECONDS < deadline )); do
    if curl --fail --silent --show-error "http://$BIND_HOST:$PORT/health" >/dev/null 2>&1; then
      return 0
    fi
    if ! container_running; then
      echo "segment-scenes stopped during startup" >&2
      docker logs "$NAME" >&2 || true
      return 1
    fi
    sleep 1
  done
  echo "segment-scenes did not become healthy within ${SERVICE_START_TIMEOUT}s" >&2
  docker logs --tail 200 "$NAME" >&2 || true
  return 1
}

start_service() {
  if container_running; then
    echo "segment-scenes is already running: http://$BIND_HOST:$PORT"
    wait_for_health
    return
  fi
  if container_exists; then
    docker rm "$NAME" >/dev/null
  fi

  mkdir -p "$DATA_DIR" "$MODELS_DIR"
  local data_abs models_abs
  data_abs="$(cd "$DATA_DIR" && pwd)"
  models_abs="$(cd "$MODELS_DIR" && pwd)"
  if [[ ! -s "$models_abs/$MODEL_FILE" ]]; then
    echo "Model not found: $models_abs/$MODEL_FILE (run make download)" >&2
    exit 1
  fi

  local -a gpu_args=()
  local gpu_uuid=""
  if command -v nvidia-smi >/dev/null 2>&1; then
    gpu_uuid="$(nvidia-smi --query-gpu=gpu_uuid --format=csv,noheader,nounits -i "$GPU_NO" 2>/dev/null | head -n1 || true)"
  fi
  if [[ -n "$gpu_uuid" ]]; then
    gpu_args=(--gpus "device=$gpu_uuid" -e NVIDIA_DRIVER_CAPABILITIES=compute,utility,video)
  elif (( REQUIRE_GPU )); then
    echo "REQUIRE_GPU=1, but GPU_NO=$GPU_NO could not be resolved" >&2
    exit 1
  fi

  docker run -d \
    --name "$NAME" \
    --restart unless-stopped \
    --label "segment-scenes.data-dir=$data_abs" \
    --shm-size "$SHM_MEM_SIZE" \
    --cpus "$CPUS" \
    -p "$BIND_HOST:$PORT:$CONTAINER_PORT" \
    "${gpu_args[@]}" \
    --user "$(id -u):$(id -g)" \
    -e HOME=/tmp \
    -e XDG_CACHE_HOME=/tmp/.cache \
    -e TORCH_HOME=/models/torch \
    -e MODEL_PATH="$MODEL_PATH" \
    -e DEVICE="$DEVICE" \
    -e MODEL_OFFLOADING="$MODEL_OFFLOADING" \
    -e MODEL_OFFLOADING_TIMEOUT="$MODEL_OFFLOADING_TIMEOUT" \
    -e ALLOWED_FILE_ROOTS="$ALLOWED_FILE_ROOTS" \
    -e FFMPEG_ACCELERATION="$FFMPEG_ACCELERATION" \
    -e TORCH_COMPILE="$TORCH_COMPILE" \
    -e TORCH_COMPILE_MODE="$TORCH_COMPILE_MODE" \
    -v "$data_abs:/data" \
    -v "$models_abs:/models:ro" \
    "$IMAGE" \
    segment_scenes.api:app --host 0.0.0.0 --port "$CONTAINER_PORT" --workers 1 --log-level "$LOG_LEVEL" \
    >/dev/null

  wait_for_health
  echo "segment-scenes is ready: http://$BIND_HOST:$PORT"
}

stop_service() {
  if ! container_exists; then
    echo "segment-scenes is not created"
    return
  fi
  if container_running; then
    docker stop --time 30 "$NAME" >/dev/null
  fi
  docker rm "$NAME" >/dev/null
  echo "segment-scenes stopped"
}

case "${1:-}" in
  start)
    start_service
    ;;
  stop)
    stop_service
    ;;
  restart)
    stop_service
    start_service
    ;;
  status)
    if container_running; then
      docker ps --filter "name=^/${NAME}$"
      curl --fail --silent --show-error "http://$BIND_HOST:$PORT/health"
      printf '\n'
    else
      echo "segment-scenes is not running"
      exit 1
    fi
    ;;
  health)
    curl --fail --silent --show-error "http://$BIND_HOST:$PORT/health"
    printf '\n'
    ;;
  logs)
    docker logs --follow "$NAME"
    ;;
  *)
    echo "Usage: $0 {start|stop|restart|status|health|logs}" >&2
    exit 2
    ;;
esac
