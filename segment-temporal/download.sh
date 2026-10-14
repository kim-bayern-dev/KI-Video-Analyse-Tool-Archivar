#!/usr/bin/env bash
set -Eeuo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=config.sh
source "$SCRIPT_DIR/config.sh"

ASSUME_YES=0
if [[ "${1:-}" == "--yes" || "${1:-}" == "-y" ]]; then
  ASSUME_YES=1
elif [[ $# -gt 0 ]]; then
  echo "Usage: $0 [--yes]" >&2
  exit 2
fi

mkdir -p "$MODELS_DIR"
if (( ! ASSUME_YES )); then
  read -r -p "Download/cache Silero VAD under $MODELS_DIR? [y/N] " answer
  [[ "${answer:-N}" =~ ^[Yy]$ ]] || { echo "Aborted."; exit 1; }
fi

# Cache the Silero ONNX model into the persistent models volume as the
# unprivileged runtime user, using network only for this one-off fetch.
docker run --rm \
  --network bridge \
  --user "$(id -u):$(id -g)" \
  -v "$MODELS_DIR:/models" \
  -e TORCH_HOME=/models \
  -e HOME=/tmp \
  -e XDG_CACHE_HOME=/tmp/.cache \
  -e NUMBA_CACHE_DIR=/tmp/numba-cache \
  -e MPLCONFIGDIR=/tmp/matplotlib \
  --entrypoint python3 \
  "$IMAGE" \
  -c 'from silero_vad import load_silero_vad; load_silero_vad(onnx=True); print("Silero VAD ONNX model is cached and loadable")'
