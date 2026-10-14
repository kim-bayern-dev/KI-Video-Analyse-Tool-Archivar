#!/usr/bin/env bash
set -Eeuo pipefail

# In-container preprocessing: the SAME proven ffmpeg pipeline as
# scripts/preprocess_video_docker.sh, but WITHOUT any docker wrapper. It runs
# directly against the container's own ffmpeg/ffprobe (the CLI already executes
# inside the FFmpeg-capable image), so cli.py can invoke it as a subprocess with
# NO Docker socket — i.e. no docker-in-docker.
#
# Usage:   preprocess_video.sh INPUT OUTPUT
# Env:     TRUNCATE_MINUTES=0 MAX_WIDTH=320 MAX_HEIGHT=180 OUTPUT_FPS=8 GPU_NO=0
#          SEGMENT_TEMPORAL_FFMPEG_LOGLEVEL=warning

if [[ $# -ne 2 ]]; then
  echo "Usage: $0 INPUT OUTPUT" >&2
  exit 2
fi

INPUT=$1
OUTPUT=$2

TRUNCATE_MINUTES=${TRUNCATE_MINUTES:-0}
GPU_NO=${GPU_NO:-0}
MAX_WIDTH=${MAX_WIDTH:-320}
MAX_HEIGHT=${MAX_HEIGHT:-180}
OUTPUT_FPS=${OUTPUT_FPS:-8}
LOGLEVEL=${SEGMENT_TEMPORAL_FFMPEG_LOGLEVEL:-warning}

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
# One-second GOP, clamped up to 1 frame for fractional rates (every frame IDR).
GOP="$(awk "BEGIN{g=int($OUTPUT_FPS+0.5); print (g<1)?1:g}")"
if [[ ! "$TRUNCATE_MINUTES" =~ ^[0-9]+$ ]]; then
  echo "TRUNCATE_MINUTES must be a non-negative integer." >&2
  exit 2
fi
if [[ ! "$GPU_NO" =~ ^[0-9]+$ ]]; then
  echo "GPU_NO must be a non-negative integer." >&2
  exit 2
fi

TRUNCATE_MINUTES_NUM=$((10#$TRUNCATE_MINUTES))
FFMPEG_DURATION_ARGS=()
if (( TRUNCATE_MINUTES_NUM > 0 )); then
  FFMPEG_DURATION_ARGS=(-t "$((TRUNCATE_MINUTES_NUM * 60))")
fi

mkdir -p "$(dirname "$OUTPUT")"

# ---------------------------------------------------------------------------
# Probe NVENC (non-fatal). Decode is CPU by design: it measured faster than
# NVDEC on the target host and avoids per-process CUDA init.
# ---------------------------------------------------------------------------

NVENC_ENCODE=false

# H200 exposes no NVENC hardware, so this probe fails there as expected.
if ffmpeg -nostdin -hide_banner -loglevel error \
     -f lavfi -i color=size=64x64:rate=1 -frames:v 1 \
     -c:v h264_nvenc -gpu "$GPU_NO" -pix_fmt yuv420p -f null - >/dev/null 2>&1; then
  NVENC_ENCODE=true
fi

# ---------------------------------------------------------------------------
# Select encode args + human mode label
# ---------------------------------------------------------------------------

FFMPEG_VIDEO_ARGS=(-c:v libx264 -preset veryfast -crf 23 -pix_fmt yuv420p -g "$GOP" -keyint_min "$GOP" -sc_threshold 0)
ENCODER_DESC="libx264"

if [[ "$NVENC_ENCODE" == true ]]; then
  FFMPEG_VIDEO_ARGS=(-c:v h264_nvenc -gpu "$GPU_NO" -preset p6 -tune hq -rc vbr -cq 24 -b:v 0 -pix_fmt yuv420p -g "$GOP" -forced-idr 1)
  ENCODER_DESC="h264_nvenc"
fi

if [[ "$NVENC_ENCODE" == true ]]; then
  MODE="CPU decode + CPU filters + NVENC"
else
  MODE="CPU decode + CPU filters + CPU libx264"
fi

VIDEO_FILTER="fps=${OUTPUT_FPS},scale=w='min(iw,${MAX_WIDTH})':h='min(ih,${MAX_HEIGHT})':force_original_aspect_ratio=decrease:force_divisible_by=2:flags=area,setsar=1"

# ---------------------------------------------------------------------------
# Encode (retry the fully portable CPU path once on hardware failure)
# ---------------------------------------------------------------------------

run_xcode() {
  ffmpeg -nostdin -hide_banner -loglevel "$LOGLEVEL" -stats -y \
    -filter_threads 0 \
    -i "$INPUT" "${FFMPEG_DURATION_ARGS[@]}" \
    -map 0:v:0? -map 0:a:0? -vf "$VIDEO_FILTER" \
    "${FFMPEG_VIDEO_ARGS[@]}" -threads:v 0 -c:a aac -b:a 192k -movflags +faststart \
    "$OUTPUT"
}

if ! run_xcode; then
  if [[ "$NVENC_ENCODE" == false ]]; then exit 1; fi
  FFMPEG_VIDEO_ARGS=(-c:v libx264 -preset veryfast -crf 23 -pix_fmt yuv420p -g "$GOP" -keyint_min "$GOP" -sc_threshold 0)
  ENCODER_DESC="libx264"
  MODE="CPU decode + CPU filters + CPU libx264 (fallback)"
  run_xcode || exit 1
fi

[[ -s "$OUTPUT" ]] || { echo "Preprocessing produced no output: $OUTPUT" >&2; exit 1; }

# Machine-readable telemetry (key=value) on stderr for cli.py to parse.
printf 'PREPROCESS_MODE=%s\nPREPROCESS_NVDEC=%s\nPREPROCESS_ENCODER=%s\n' \
  "$MODE" false "$ENCODER_DESC" >&2
