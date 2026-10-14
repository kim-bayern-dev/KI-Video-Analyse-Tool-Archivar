#!/usr/bin/env bash
set -Eeuo pipefail

# Host-side standalone preprocessing reference (the proven fast pipeline).
# It wraps the pinned FFmpeg image in `docker run`, so it is meant to be executed
# ON THE HOST, not inside the application container (the container has no Docker
# socket). The production CLI uses the equivalent direct-FFmpeg path in
# src/segment_temporal/preprocess.py (or scripts/preprocess_video.sh in-container).
#
# Default env parameters:
# TRUNCATE_MINUTES=0 MAX_WIDTH=320 MAX_HEIGHT=180 OUTPUT_FPS=8 GPU_NO=0 SHM_MEM_SIZE=16g ./preprocess_video_docker.sh input.webm output.mp4

if [[ $# -ne 2 ]]; then
  echo "Usage: $0 INPUT OUTPUT" >&2
  exit 2
fi

INPUT=$1
OUTPUT=$2

# Configuration
TRUNCATE_MINUTES=${TRUNCATE_MINUTES:-0}
GPU_NO=${GPU_NO:-0}
MAX_WIDTH=${MAX_WIDTH:-320}
MAX_HEIGHT=${MAX_HEIGHT:-180}
OUTPUT_FPS=${OUTPUT_FPS:-8}
SHM_MEM_SIZE=${SHM_MEM_SIZE:-16g}

IMAGE="lscr.io/linuxserver/ffmpeg@sha256:595345f99ed5ecbe773388553baa9a0c0cd8f097aa76d3dc89a6b5b7dbee9c4b"

# ---------------------------------------------------------------------------
# Validation
# ---------------------------------------------------------------------------

if [[ ! -f "$INPUT" ]]; then
  echo "Input file not found: $INPUT" >&2
  exit 1
fi

if [[ "$INPUT" == "$OUTPUT" ]]; then
  echo "Input and output must differ." >&2
  exit 1
fi

if [[ ! "$GPU_NO" =~ ^[0-9]+$ ]]; then
  echo "GPU_NO must be a non-negative integer." >&2
  exit 2
fi

if [[ ! "$TRUNCATE_MINUTES" =~ ^[0-9]+$ ]]; then
  echo "TRUNCATE_MINUTES must be a non-negative integer." >&2
  exit 2
fi

for value in "$MAX_WIDTH" "$MAX_HEIGHT"; do
  if [[ ! "$value" =~ ^[1-9][0-9]*$ ]]; then
    echo "MAX_WIDTH and MAX_HEIGHT must be positive integers." >&2
    exit 2
  fi
done
# Fractional rates are allowed: 0.5 = one frame every 2s, 0.25 = every 4s.
if [[ ! "$OUTPUT_FPS" =~ ^[0-9]+([.][0-9]+)?$ ]] || ! awk "BEGIN{exit !($OUTPUT_FPS > 0)}"; then
  echo "OUTPUT_FPS must be a positive number." >&2
  exit 2
fi

if [[ -z "$SHM_MEM_SIZE" ]]; then
  echo "SHM_MEM_SIZE must not be empty." >&2
  exit 2
fi

# Avoid Bash treating leading zeroes as octal.
TRUNCATE_MINUTES_NUM=$((10#$TRUNCATE_MINUTES))

now_seconds() {
  if [[ -n "${EPOCHREALTIME:-}" ]]; then
    printf '%s' "$EPOCHREALTIME"
  else
    date +%s.%N
  fi
}

# ---------------------------------------------------------------------------
# Duration
# ---------------------------------------------------------------------------

FFMPEG_DURATION_ARGS=()

if (( TRUNCATE_MINUTES_NUM > 0 )); then
  FFMPEG_DURATION_ARGS=(
    -t "$((TRUNCATE_MINUTES_NUM * 60))"
  )
  DURATION_DESCRIPTION="${TRUNCATE_MINUTES_NUM} minute(s)"
else
  DURATION_DESCRIPTION="complete input"
fi

# ---------------------------------------------------------------------------
# Default path: CPU decode + CPU libx264
# ---------------------------------------------------------------------------

DOCKER_GPU_ARGS=()

FFMPEG_VIDEO_ARGS=(
  -c:v libx264
  -preset veryfast
  -crf 23
  -pix_fmt yuv420p
)

ENCODER_DESCRIPTION="libx264, preset=veryfast, CRF=23, threads=auto"

GPU_UUID=""
GPU_NAME=""
NVENC_ENCODE=false

# ---------------------------------------------------------------------------
# Optional GPU discovery
#
# Missing nvidia-smi, an invalid GPU index, or a broken NVIDIA installation is
# intentionally non-fatal.
# ---------------------------------------------------------------------------

if command -v nvidia-smi >/dev/null 2>&1; then
  GPU_UUID=$(
    nvidia-smi \
      --query-gpu=gpu_uuid \
      --format=csv,noheader,nounits \
      -i "$GPU_NO" 2>/dev/null || true
  )

  GPU_NAME=$(
    nvidia-smi \
      --query-gpu=name \
      --format=csv,noheader,nounits \
      -i "$GPU_NO" 2>/dev/null || true
  )
fi

if [[ -n "$GPU_UUID" ]]; then
  PROBE_GPU_ARGS=(
    --gpus "device=${GPU_UUID}"
    -e NVIDIA_DRIVER_CAPABILITIES=compute,utility,video
  )

  # Probe NVENC (decode is CPU by design: faster than NVDEC on the target host
  # and free of per-process CUDA init). H200 correctly fails this probe.
  if docker run --rm \
      --network none \
      "${PROBE_GPU_ARGS[@]}" \
      "$IMAGE" \
      -hide_banner \
      -loglevel error \
      -f lavfi \
      -i "color=size=64x64:rate=1" \
      -frames:v 1 \
      -c:v h264_nvenc \
      -gpu 0 \
      -pix_fmt yuv420p \
      -f null - \
      >/dev/null 2>&1; then
    NVENC_ENCODE=true
  fi
fi

# ---------------------------------------------------------------------------
# Select processing path
# ---------------------------------------------------------------------------

if [[ "$NVENC_ENCODE" == true ]]; then
  DOCKER_GPU_ARGS=(
    --gpus "device=${GPU_UUID}"
    -e NVIDIA_DRIVER_CAPABILITIES=compute,utility,video
  )
fi

if [[ "$NVENC_ENCODE" == true ]]; then
  FFMPEG_VIDEO_ARGS=(
    -c:v h264_nvenc
    -gpu 0
    -preset p6
    -tune hq
    -rc vbr
    -cq 24
    -b:v 0
    -pix_fmt yuv420p
  )

  ENCODER_DESCRIPTION="h264_nvenc, preset=p6, tune=hq, VBR CQ=24"
fi

# ---------------------------------------------------------------------------
# Status
# ---------------------------------------------------------------------------

if [[ "$NVENC_ENCODE" == true ]]; then
  echo "Using host GPU ${GPU_NO}: ${GPU_NAME:-unknown} (${GPU_UUID})"
  echo "Mode: CPU decode + CPU filters + NVENC"
elif [[ -n "$GPU_UUID" ]]; then
  echo "Selected GPU ${GPU_NO}: ${GPU_NAME:-unknown} (${GPU_UUID})"
  echo "Mode: CPU decode + CPU filters + CPU libx264"
else
  echo "No usable NVIDIA GPU detected."
  echo "Mode: CPU decode + CPU filters + CPU libx264"
fi

echo "Duration: ${DURATION_DESCRIPTION}"
echo "Output: max ${MAX_WIDTH}x${MAX_HEIGHT} at ${OUTPUT_FPS} fps"
echo "Shared memory: ${SHM_MEM_SIZE}"
echo "CPU access: unrestricted"

# Preserve aspect ratio, never upscale, and ensure even dimensions.
VIDEO_FILTER="fps=${OUTPUT_FPS},scale=w='min(iw,${MAX_WIDTH})':h='min(ih,${MAX_HEIGHT})':force_original_aspect_ratio=decrease:force_divisible_by=2:flags=area,setsar=1"

# ---------------------------------------------------------------------------
# Encode
# ---------------------------------------------------------------------------

STARTED_AT=$(now_seconds)

if docker run --rm \
    --network none \
    --shm-size "$SHM_MEM_SIZE" \
    "${DOCKER_GPU_ARGS[@]}" \
    -e PUID="$(id -u)" \
    -e PGID="$(id -g)" \
    -v "$PWD:/data" \
    "$IMAGE" \
    -hide_banner \
    -loglevel warning \
    -stats \
    -filter_threads 0 \
    -i "/data/$INPUT" \
    "${FFMPEG_DURATION_ARGS[@]}" \
    -map 0:v:0? \
    -map 0:a:0? \
    -vf "$VIDEO_FILTER" \
    "${FFMPEG_VIDEO_ARGS[@]}" \
    -threads:v 0 \
    -c:a aac \
    -b:a 192k \
    -movflags +faststart \
    -y \
    "/data/$OUTPUT"; then
  :
else
  status=$?
  echo "Preprocessing failed with exit code ${status}." >&2
  exit "$status"
fi

FINISHED_AT=$(now_seconds)

WALL_SECONDS=$(
  awk \
    -v start="$STARTED_AT" \
    -v end="$FINISHED_AT" \
    'BEGIN { printf "%.3f", end - start }'
)

echo "Preprocessing complete (wall=${WALL_SECONDS}s, output=$OUTPUT)"
