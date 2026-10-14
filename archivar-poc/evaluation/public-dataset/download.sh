#!/usr/bin/env bash
set -Eeuo pipefail

# Download the 16 CC-licensed Wikimedia Commons videos into a staging dir.
#
# Usage:
#   download.sh [FILE ...]
#
# Without arguments, downloads all 16 videos. With arguments, downloads only
# the named files (e.g. "A1_All_Creatures_Welcome.webm").
#
# Downloads are resumable (curl -C -). Target dir defaults to .staging next
# to this script; override with STAGING_DIR.

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=manifest.sh
source "$SCRIPT_DIR/manifest.sh"

STAGING_DIR="${STAGING_DIR:-$SCRIPT_DIR/.staging}"
UA="movie-download-script/1.0 (curl; educational use)"

mkdir -p "$STAGING_DIR"

wanted() {
  local name="$1"
  if [[ ${#REQUESTED[@]} -eq 0 ]]; then
    return 0
  fi
  local r
  for r in "${REQUESTED[@]}"; do
    [[ "$r" == "$name" ]] && return 0
  done
  return 1
}

REQUESTED=("$@")
failed=0

for entry in "${DATASET_VIDEOS[@]}"; do
  name="${entry%%|*}"
  url="${entry#*|}"

  wanted "$name" || continue

  echo "==> $name"
  # -C - : resume partial downloads; --retry: handle transient errors; -f: fail on HTTP errors
  if ! curl -fL -C - --retry 3 --retry-delay 2 -A "$UA" -o "$STAGING_DIR/$name" "$url"; then
    echo "!! FAILED: $name" >&2
    failed=1
  fi
done

echo "Done. Files saved to: $STAGING_DIR"
exit "$failed"
