#!/usr/bin/env bash
set -Eeuo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=config.sh
source "$SCRIPT_DIR/config.sh"

assume_yes=0
case "${1:-}" in
  --yes|-y) assume_yes=1 ;;
  "") ;;
  *) echo "Usage: $0 [--yes]" >&2; exit 2 ;;
esac

mkdir -p "$MODELS_DIR"
models_abs="$(cd "$MODELS_DIR" && pwd)"
if (( ! assume_yes )); then
  read -r -p "Materialize TransNetV2 weights under $models_abs? [y/N] " answer
  [[ "${answer:-N}" =~ ^[Yy]$ ]] || { echo "Aborted"; exit 1; }
fi

docker run --rm \
  --network none \
  --user "$(id -u):$(id -g)" \
  -e HOME=/tmp \
  -v "$models_abs:/models" \
  --entrypoint python3 \
  "$IMAGE" \
  -c 'from importlib.resources import files; from pathlib import Path; import hashlib, shutil
source = Path(str(files("transnetv2_pytorch").joinpath("transnetv2-pytorch-weights.pth")))
target = Path("/models") / "'"$MODEL_FILE"'"
source_hash = hashlib.sha256(source.read_bytes()).hexdigest()
target_hash = hashlib.sha256(target.read_bytes()).hexdigest() if target.is_file() else None
if target_hash != source_hash:
    temporary = target.with_suffix(target.suffix + ".tmp")
    shutil.copyfile(source, temporary)
    temporary.replace(target)
print(f"{target} sha256={source_hash} bytes={target.stat().st_size}")'

echo "Model available at $models_abs/$MODEL_FILE"
