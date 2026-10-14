#!/usr/bin/env bash
set -Eeuo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=config.sh
source "$SCRIPT_DIR/config.sh"
cd "$SCRIPT_DIR"

docker build --progress=plain -t "$IMAGE" .
echo "Built $IMAGE"
