#!/usr/bin/env bash
set -Eeuo pipefail

# Idempotent setup of the public evaluation dataset.
#
# For each of the 16 videos:
#   1. Skip if <base>_truncated.webm already exists in the target dir.
#   2. Reuse an existing raw file: already in staging, or still sitting in
#      the target dir (moved to staging, NOT re-downloaded).
#   3. Otherwise download the raw into staging.
#   4. Preprocess with the dataset profile (15 min max, 320x180, 8 fps)
#      into <base>_truncated.webm in the target dir.
#   5. Delete the raw from staging.
#
# Paths (defaults resolved from this script's location, cwd-independent):
#   staging:  evaluation/public-dataset/.staging   (STAGING_DIR to override)
#   target:   ../../../sample_data/archivar        (TARGET_DIR to override)

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
EVAL_DIR="$(dirname "$SCRIPT_DIR")"
# shellcheck source=manifest.sh
source "$SCRIPT_DIR/manifest.sh"

PREPROCESS="$EVAL_DIR/preprocess.sh"
STAGING_DIR="${STAGING_DIR:-$SCRIPT_DIR/.staging}"
TARGET_DIR="${TARGET_DIR:-$(realpath -m "$SCRIPT_DIR/../../../sample_data/archivar")}"

[[ -x "$PREPROCESS" ]] || {
  echo "setup.sh: preprocess script missing or not executable: $PREPROCESS" >&2
  exit 1
}

mkdir -p "$STAGING_DIR"
[[ -d "$TARGET_DIR" ]] || {
  echo "setup.sh: target dir does not exist: $TARGET_DIR" >&2
  exit 1
}

# Dataset preprocessing profile (see evaluation/preprocess.sh):
PROFILE=(--max-seconds 900 --max-width 320 --max-height 180 --fps 8)

processed=0
skipped=0
failed=0
FAILED_NAMES=()

for entry in "${DATASET_VIDEOS[@]}"; do
  name="${entry%%|*}"
  base="${name%.*}"
  raw="$STAGING_DIR/$name"
  out="$TARGET_DIR/${base}_truncated.webm"

  echo "================================================================"
  if [[ -f "$out" ]]; then
    echo "SKIP: $base (${base}_truncated.webm already exists)"
    skipped=$((skipped + 1))
    continue
  fi

  if [[ ! -f "$raw" && -f "$TARGET_DIR/$name" ]]; then
    echo "Reusing existing raw from target dir: $name"
    mv -- "$TARGET_DIR/$name" "$raw"
  fi

  if [[ ! -f "$raw" ]]; then
    "$SCRIPT_DIR/download.sh" "$name"
  fi

  echo "Preprocessing: $name -> ${base}_truncated.webm (profile: ${PROFILE[*]})"
  start=$SECONDS
  if "$PREPROCESS" "$raw" "$out" "${PROFILE[@]}"; then
    rm -f -- "$raw"
    processed=$((processed + 1))
    echo "OK: $base (took $((SECONDS - start))s)"
  else
    status=$?
    echo "FAILED (exit $status): $name — raw kept in staging for resume" >&2
    failed=$((failed + 1))
    FAILED_NAMES+=("$name")
  fi
done

echo "================================================================"
printf 'Done: %d processed, %d skipped, %d failed\n' "$processed" "$skipped" "$failed"
if ((failed > 0)); then
  printf 'Failed: %s\n' "${FAILED_NAMES[@]}" >&2
  exit 1
fi
