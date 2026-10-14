#!/usr/bin/env bash
set -Eeuo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=config.sh
source "$SCRIPT_DIR/config.sh"

usage() {
  cat <<'EOF'
Usage: ./run.sh MEDIA [segment-temporal options]

MEDIA is normally an in-container path under the corpus mount (/data), e.g.
  /data/test/demo.mp4
The host corpus directory is bind-mounted READ-WRITE onto container /data: by default
the CLI writes `out_<stem>_<ext>_<hash>/` next to the input (client contract). Set
OUTPUT_DIR to redirect output via a host dir mounted at /output (--output-dir /output).

MEDIA may also be an arbitrary host file; its parent is then mounted read-write as
/input and read as /input/<name> (again so `out_...` lands next to the input).

Container controls (env, defaults target this host: GPU 0 = e.g. RTX 3090):
  GPU_NO=1 CPUS=8 WORKERS=4 SHM_MEM_SIZE=8g REQUIRE_GPU=1
  DATA_DIR=/path/to/output  CORPUS_DIR=/path/to/sample_data  MODELS_DIR=/path/to/cache

Examples:
  make run FILE=/data/test/demo.mp4
  ./run.sh /data/test/demo.mp4 --quiet
  ./run.sh /data/test/demo.mxf --no-music-detection
  ./run.sh /home/you/some/video.mp4 --keyframe-method scene
EOF
}

if [[ $# -eq 0 || "${1:-}" == "-h" || "${1:-}" == "--help" ]]; then
  usage
  exit 0
fi

MEDIA="$1"
shift

# ---- Corpus (read-only input) host dir -> container /data -------------------
# Resolve to an absolute path. CORPUS_HOST wins; else CORPUS_DIR (default is the
# ../sample_data sibling of this script). `cd && pwd` normalizes "."/".." safely.
if [[ -z "${CORPUS_HOST:-}" ]]; then
  CORPUS_DIR="${CORPUS_DIR:-$SCRIPT_DIR/../sample_data}"
  CORPUS_HOST="$(cd "$CORPUS_DIR" && pwd)"
fi
if [[ ! -d "$CORPUS_HOST" ]]; then
  echo "Corpus directory not found: $CORPUS_HOST (set CORPUS_DIR)" >&2
  exit 1
fi

# ---- Output redirection (optional) ------------------------------------------
# HEAD/client contract: the CLI defaults output_dir to the INPUT FILE'S DIRECTORY and
# writes `out_<stem>_<ext>_<hash>/` there; the client discovers segments by globbing
# that same directory (it does NOT read JSON). So we mount the corpus READ-WRITE and
# pass NO --output-dir by default. Set OUTPUT_DIR to redirect elsewhere (tests/`make run`).
OUTPUT_MOUNT=()
OUTPUT_FLAG=()
if [[ -n "${OUTPUT_DIR:-}" ]]; then
  mkdir -p "$OUTPUT_DIR"
  OUTPUT_ABS="$(cd "$OUTPUT_DIR" && pwd)"
  OUTPUT_MOUNT=( -v "$OUTPUT_ABS:/output" )
  OUTPUT_FLAG=( --output-dir /output )
fi
mkdir -p "$MODELS_DIR"

# ---- Resolve the in-container media path ------------------------------------
EXTRA_MOUNTS=()
if [[ "$MEDIA" == /data/* ]]; then
  # In-container corpus path: validate the host equivalent exists, read from /data.
  REL="${MEDIA#/data}"
  HOST_MEDIA="$CORPUS_HOST$REL"
  [[ -f "$HOST_MEDIA" ]] || { echo "Media file not found in corpus: $MEDIA (host: $HOST_MEDIA)" >&2; exit 1; }
  CONTAINER_MEDIA="$MEDIA"
elif [[ -f "$MEDIA" ]]; then
  # Arbitrary host file: mount its directory read-only as /input.
  MEDIA_ABS="$(realpath "$MEDIA")"
  # Read-write so the CLI can write `out_...` next to the input (client contract).
  EXTRA_MOUNTS+=( -v "$(dirname "$MEDIA_ABS"):/input" )
  CONTAINER_MEDIA="/input/$(basename "$MEDIA_ABS")"
else
  echo "Media not found: $MEDIA (expected an in-container /data path or a host file)" >&2
  exit 1
fi

# ---- GPU discovery (per-UUID; missing GPU is fatal only when REQUIRED) ------
GPU_ARGS=()
if command -v nvidia-smi >/dev/null 2>&1; then
  GPU_UUID="$(nvidia-smi --query-gpu=gpu_uuid --format=csv,noheader,nounits -i "$GPU_NO" 2>/dev/null | head -n1 || true)"
  if [[ -n "$GPU_UUID" ]]; then
    GPU_ARGS=( --gpus "device=$GPU_UUID" -e NVIDIA_DRIVER_CAPABILITIES=compute,utility,video )
  fi
fi
if (( REQUIRE_GPU )) && (( ${#GPU_ARGS[@]} == 0 )); then
  echo "REQUIRE_GPU=1, but GPU_NO=$GPU_NO could not be resolved." >&2
  exit 1
fi

exec docker run --rm \
  --name "${NAME}-$$" \
  --network none \
  --shm-size "$SHM_MEM_SIZE" \
  --cpus "$CPUS" \
  "${GPU_ARGS[@]}" \
  --user "$(id -u):$(id -g)" \
  -e TORCH_HOME=/models \
  -e HOME=/tmp \
  -e XDG_CACHE_HOME=/tmp/.cache \
  -e NUMBA_CACHE_DIR=/tmp/numba-cache \
  -e MPLCONFIGDIR=/tmp/matplotlib \
  -v "$CORPUS_HOST:/data" \
  "${OUTPUT_MOUNT[@]}" \
  -v "$MODELS_DIR:/models" \
  "${EXTRA_MOUNTS[@]}" \
  "$IMAGE" \
  "$CONTAINER_MEDIA" \
  "${OUTPUT_FLAG[@]}" \
  --workers "$WORKERS" \
  "$@"
