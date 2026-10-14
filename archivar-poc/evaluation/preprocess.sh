#!/usr/bin/env bash
set -Eeuo pipefail

# Generic ffmpeg preprocessor.
#
# Usage:
#   preprocess.sh INPUT OUTPUT [--max-seconds N] [--max-width W] [--max-height H] [--fps F]
#
# Scale/fps filters are only applied when the corresponding option is given.
# Codecs: .mp4 targets get H.264/AAC, .webm targets get VP9/Opus.

usage() {
  cat >&2 <<'EOF'
Usage: preprocess.sh INPUT OUTPUT [--max-seconds N] [--max-width W] [--max-height H] [--fps F]

Options:
  --max-seconds N   Truncate the output to N seconds (positive integer).
  --max-width W     Scale down to at most W px wide (aspect ratio preserved).
  --max-height H    Scale down to at most H px high (aspect ratio preserved).
  --fps F           Resample video to F frames per second.

Codec selection by output extension:
  .mp4   H.264 (libx264) + AAC
  .webm  VP9 (libvpx-vp9) + Opus
EOF
}

die() {
  echo "preprocess.sh: $*" >&2
  exit 1
}

INPUT=""
OUTPUT=""
MAX_SECONDS=""
MAX_WIDTH=""
MAX_HEIGHT=""
FPS=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --max-seconds)
      [[ $# -ge 2 ]] || { usage; exit 2; }
      MAX_SECONDS=$2
      shift 2
      ;;
    --max-width)
      [[ $# -ge 2 ]] || { usage; exit 2; }
      MAX_WIDTH=$2
      shift 2
      ;;
    --max-height)
      [[ $# -ge 2 ]] || { usage; exit 2; }
      MAX_HEIGHT=$2
      shift 2
      ;;
    --fps)
      [[ $# -ge 2 ]] || { usage; exit 2; }
      FPS=$2
      shift 2
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    --*)
      echo "preprocess.sh: unknown option: $1" >&2
      usage
      exit 2
      ;;
    *)
      if [[ -z "$INPUT" ]]; then
        INPUT=$1
      elif [[ -z "$OUTPUT" ]]; then
        OUTPUT=$1
      else
        echo "preprocess.sh: unexpected argument: $1" >&2
        usage
        exit 2
      fi
      shift
      ;;
  esac
done

if [[ -z "$INPUT" || -z "$OUTPUT" ]]; then
  usage
  exit 2
fi

[[ -f "$INPUT" ]] || die "input file not found: $INPUT"
[[ "$INPUT" != "$OUTPUT" ]] || die "input and output must differ"

for value in "$MAX_SECONDS" "$MAX_WIDTH" "$MAX_HEIGHT" "$FPS"; do
  if [[ -n "$value" && ! "$value" =~ ^[1-9][0-9]*$ ]]; then
    die "--max-seconds, --max-width, --max-height and --fps must be positive integers (got: $value)"
  fi
done

command -v ffmpeg >/dev/null 2>&1 || {
  echo "preprocess.sh: ffmpeg is not installed or not in PATH" >&2
  exit 127
}

# ---------------------------------------------------------------------------
# Filter graph: only the filters that were requested.
# ---------------------------------------------------------------------------

FILTERS=()

if [[ -n "$FPS" ]]; then
  FILTERS+=("fps=${FPS}")
fi

if [[ -n "$MAX_WIDTH" && -n "$MAX_HEIGHT" ]]; then
  FILTERS+=("scale=w='min(iw,${MAX_WIDTH})':h='min(ih,${MAX_HEIGHT})':force_original_aspect_ratio=decrease:force_divisible_by=2:flags=area")
elif [[ -n "$MAX_WIDTH" ]]; then
  FILTERS+=("scale=w='min(iw,${MAX_WIDTH})':h=-2:flags=area")
elif [[ -n "$MAX_HEIGHT" ]]; then
  FILTERS+=("scale=w=-2:h='min(ih,${MAX_HEIGHT})':flags=area")
fi

if [[ -n "$MAX_WIDTH" || -n "$MAX_HEIGHT" ]]; then
  FILTERS+=("setsar=1")
fi

VF_ARGS=()
if ((${#FILTERS[@]} > 0)); then
  VF_ARGS=(-vf "$(IFS=,; echo "${FILTERS[*]}")")
fi

DURATION_ARGS=()
if [[ -n "$MAX_SECONDS" ]]; then
  DURATION_ARGS=(-t "$MAX_SECONDS")
fi

# ---------------------------------------------------------------------------
# Codec selection by output extension.
# ---------------------------------------------------------------------------

EXT="${OUTPUT##*.}"
EXT="${EXT,,}"

case "$EXT" in
  mp4)
    CODEC_ARGS=(
      -c:v libx264 -preset veryfast -crf 23 -pix_fmt yuv420p
      -c:a aac -b:a 192k
      -movflags +faststart
    )
    ;;
  webm)
    CODEC_ARGS=(
      -c:v libvpx-vp9 -crf 32 -b:v 0 -cpu-used 5 -row-mt 1 -pix_fmt yuv420p
      -c:a libopus -b:a 128k
    )
    ;;
  *)
    die "unsupported output extension: .$EXT (supported: mp4, webm)"
    ;;
esac

# ---------------------------------------------------------------------------
# Encode
# ---------------------------------------------------------------------------

echo "preprocess.sh: $INPUT -> $OUTPUT"
[[ -n "$MAX_SECONDS" ]] && echo "  max-seconds: $MAX_SECONDS"
[[ -n "$MAX_WIDTH" ]] && echo "  max-width:   $MAX_WIDTH"
[[ -n "$MAX_HEIGHT" ]] && echo "  max-height:  $MAX_HEIGHT"
[[ -n "$FPS" ]] && echo "  fps:         $FPS"

ffmpeg \
  -hide_banner \
  -loglevel warning \
  -stats \
  -i "$INPUT" \
  "${DURATION_ARGS[@]}" \
  -map 0:v:0 \
  -map 0:a:0? \
  "${VF_ARGS[@]}" \
  "${CODEC_ARGS[@]}" \
  -y \
  "$OUTPUT"
