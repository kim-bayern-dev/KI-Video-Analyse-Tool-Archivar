#!/usr/bin/env bash
set -Eeuo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=config.sh
source "$SCRIPT_DIR/config.sh"

if ! [[ "$(docker inspect -f '{{.State.Running}}' "$NAME" 2>/dev/null || true)" == "true" ]]; then
  echo "segment-scenes service is not running; run 'make start' first" >&2
  exit 1
fi

declare -a client_args=()
declare -a files=()
output_dir=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --output-dir)
      [[ $# -ge 2 ]] || { echo "--output-dir requires a value" >&2; exit 2; }
      output_dir="$2"
      shift 2
      ;;
    --threshold|--min-len|--max-len|--fps|--max-width-px|--max-height-px|--device|--chunk-size|--request-timeout)
      [[ $# -ge 2 ]] || { echo "$1 requires a value" >&2; exit 2; }
      client_args+=("$1" "$2")
      shift 2
      ;;
    --quiet|--visualize|--extract-keyframes)
      client_args+=("$1")
      shift
      ;;
    -h|--help)
      exec docker exec -i "$NAME" segment-scenes --help
      ;;
    --)
      shift
      files+=("$@")
      break
      ;;
    -*)
      echo "Unknown option: $1" >&2
      exit 2
      ;;
    *)
      files+=("$1")
      shift
      ;;
  esac
done

if (( ${#files[@]} == 0 )); then
  echo "Usage: $0 [OPTIONS] <video_files...>" >&2
  exit 2
fi

mkdir -p "$DATA_DIR"
data_abs="$(cd "$DATA_DIR" && pwd)"

map_path() {
  local value="$1"
  local require_file="$2"
  if [[ "$value" == file://* ]]; then
    MAPPED_URI="$value"
    return
  fi
  if [[ "$value" == /data/* || "$value" == /data ]]; then
    MAPPED_URI="file://$value"
    return
  fi

  local absolute
  if [[ "$require_file" == "1" ]]; then
    [[ -f "$value" ]] || { echo "File not found: $value" >&2; exit 1; }
    absolute="$(realpath "$value")"
  else
    mkdir -p "$value"
    absolute="$(cd "$value" && pwd)"
  fi
  case "$absolute" in
    "$data_abs") relative="" ;;
    "$data_abs"/*) relative="${absolute#"$data_abs"/}" ;;
    *)
      echo "$absolute is outside DATA_DIR ($data_abs); reconfigure DATA_DIR and restart" >&2
      exit 1
      ;;
  esac
  MAPPED_URI="file:///data${relative:+/$relative}"
}

if [[ -n "$output_dir" ]]; then
  map_path "$output_dir" 0
  client_args+=(--output-dir "$MAPPED_URI")
fi

for file in "${files[@]}"; do
  map_path "$file" 1
  docker exec -i \
    -e SEGMENT_SCENES_URL="http://127.0.0.1:$CONTAINER_PORT" \
    -e SEGMENT_SCENES_REQUEST_TIMEOUT="$SEGMENT_SCENES_REQUEST_TIMEOUT" \
    "$NAME" \
    segment-scenes "$MAPPED_URI" "${client_args[@]}"
done
