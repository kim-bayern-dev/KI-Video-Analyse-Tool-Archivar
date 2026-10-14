#!/usr/bin/env bash
set -euo pipefail

# Usage information
if [[ "${1:-}" == "-h" || "${1:-}" == "--help" ]]; then
  echo "Usage: $0"
  exit 0
fi

# Load shared configuration with argument
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=config.sh
source "$SCRIPT_DIR/config.sh" "${1:-}"

# Build the image with build arguments
echo "Building Docker image..."
docker build --progress=plain \
  -t "$IMAGE" .

echo "Image '$IMAGE' built successfully!"
echo ""
echo "Next steps:"
echo "  1. Start container: ./start.sh"