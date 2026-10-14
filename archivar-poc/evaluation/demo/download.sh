#!/usr/bin/env bash
set -Eeuo pipefail

# Download the demo video and produce the demo assets in sample_data/test:
#   a) demo.webm — cut to max 60 s, max width 640 (aspect preserved), VP9/Opus
#   b) demo.png  — first content frame of demo.webm, full-quality PNG
#                  (the video fades in from white; the literal first frame
#                  is blank, so the first frame with real contrast is used)
#   c) the full transcode format matrix (via transcode.sh)
#   d) gitignored runtime copies in the app data dir, the health-check
#      fixtures, and the projects that expect local demo files
#      (segment-scenes/files, Qwen3.6/files, Qwen3.8/files)
#
# Paths (defaults resolved from this script's location, cwd-independent):
#   staging:  evaluation/demo/.staging     (STAGING_DIR to override)
#   target:   ../../../sample_data/test    (TARGET_DIR to override)

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
EVAL_DIR="$(dirname "$SCRIPT_DIR")"

STAGING_DIR="${STAGING_DIR:-$SCRIPT_DIR/.staging}"
TARGET_DIR="${TARGET_DIR:-$(realpath -m "$SCRIPT_DIR/../../../sample_data/test")}"

URL="https://upload.wikimedia.org/wikipedia/commons/e/ee/Explanatory_video_on_the_greenhouse_effect.webm"
RAW="$STAGING_DIR/Explanatory_video_on_the_greenhouse_effect.webm"
UA="movie-download-script/1.0 (curl; educational use)"

mkdir -p "$STAGING_DIR" "$TARGET_DIR"

# curl -C - on an already complete file fails with HTTP 416, so skip the
# download when the raw already exists and probes cleanly.
if [[ -f "$RAW" ]] && ffprobe -v error -show_entries format=format_name \
    -of default=noprint_wrappers=1:nokey=1 "$RAW" >/dev/null 2>&1; then
  echo "==> raw already downloaded: $(basename "$RAW")"
else
  echo "==> downloading $(basename "$RAW")"
  curl -fL -C - --retry 3 --retry-delay 2 -A "$UA" -o "$RAW" "$URL"
fi

echo "==> preprocessing to $TARGET_DIR/demo.webm (max 60 s, max width 640)"
"$EVAL_DIR/preprocess.sh" "$RAW" "$TARGET_DIR/demo.webm" \
  --max-seconds 60 --max-width 640

echo "==> extracting first content frame to $TARGET_DIR/demo.png"
# First frame whose luma range (YMAX-YMIN) exceeds 50, i.e. the first frame
# after the white fade-in that carries real content.
seek=$(
  ffprobe -v error -f lavfi -i "movie=$TARGET_DIR/demo.webm,signalstats" \
    -show_entries frame=pts_time:frame_tags=lavfi.signalstats.YMIN:frame_tags=lavfi.signalstats.YMAX \
    -of csv=p=0 2>/dev/null |
    awk -F, '($3 - $2) > 50 { print $1; exit }'
)
if [[ -n "$seek" ]]; then
  echo "   (first content frame at ${seek}s)"
  ffmpeg -hide_banner -loglevel error -y \
    -ss "$seek" -i "$TARGET_DIR/demo.webm" \
    -frames:v 1 \
    "$TARGET_DIR/demo.png"
else
  echo "   (content detection failed, using literal first frame)" >&2
  ffmpeg -hide_banner -loglevel error -y \
    -i "$TARGET_DIR/demo.webm" \
    -frames:v 1 \
    "$TARGET_DIR/demo.png"
fi

echo "==> transcoding format matrix"
"$SCRIPT_DIR/transcode.sh"

# Sync the demo assets into the locations that expect local copies. These
# targets are gitignored runtime copies of sample_data/test — they are
# (re)created here on every download run, never committed.
ROOT="$(dirname "$(dirname "$TARGET_DIR")")"
ARCHIVAR_DATA="${ARCHIVAR_DATA_DIR:-$ROOT/sample_data/archivar}"

sync_copy() {
  mkdir -p "$(dirname "$2")"
  cp "$1" "$2"
  echo "==> synced ${2#"$ROOT"/}"
}

# App data dir + health-check fixtures
sync_copy "$TARGET_DIR/demo.mp4" "$ARCHIVAR_DATA/demo.mp4"
sync_copy "$TARGET_DIR/demo.mp4" "$ARCHIVAR_DATA/test_data/test.mp4"
sync_copy "$TARGET_DIR/demo.png" "$ARCHIVAR_DATA/test_data/test_kf.png"
sync_copy "$TARGET_DIR/reference.mp3" "$ARCHIVAR_DATA/test_data/test.mp3"

# Zero-frame regression source (60s cut contains sub-interval scenes)
sync_copy "$TARGET_DIR/demo.mp4" "$ROOT/segment-scenes/files/zero-frame-scene-source.mp4"

# M/L inference-server smoke-test assets
sync_copy "$TARGET_DIR/demo.mp4" "$ROOT/Qwen3.6-35B-A3B-GPTQ-Int4/files/demo.mp4"
sync_copy "$TARGET_DIR/demo.png" "$ROOT/Qwen3.6-35B-A3B-GPTQ-Int4/files/demo.png"
sync_copy "$TARGET_DIR/demo.mp4" "$ROOT/Qwen3.8-27B-FP8/files/demo.mp4"
sync_copy "$TARGET_DIR/demo.png" "$ROOT/Qwen3.8-27B-FP8/files/demo.png"

echo "Done. Demo assets in: $TARGET_DIR"
