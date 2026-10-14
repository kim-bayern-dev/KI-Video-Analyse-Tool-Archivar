#!/usr/bin/env bash
set -euo pipefail

# Usage information
if [[ "${1:-}" == "-h" || "${1:-}" == "--help" ]]; then
  echo "Usage: $0"
  exit 0
fi

# Load shared configuration
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=config.sh
source "$SCRIPT_DIR/config.sh" "${1:-}"

echo "=== Docker Container Status ==="
echo "  Container name: $NAME"
echo "  Expected image: $IMAGE"
echo "  Expected port:  $CADDY_PORT"
echo "==============================="

# Check if container exists
if ! docker ps -a --format '{{.Names}}' | grep -q "^${NAME}$"; then
  echo "❌ Container '$NAME' does not exist."
  echo ""
  echo "To create and start the container, run: ./start.sh"
  exit 0
fi

# Get container information
CONTAINER_STATUS=$(docker inspect -f '{{.State.Status}}' "$NAME" 2>/dev/null || echo "unknown")
CONTAINER_IMAGE=$(docker inspect -f '{{.Config.Image}}' "$NAME" 2>/dev/null || echo "unknown")
CONTAINER_CREATED=$(docker inspect -f '{{.Created}}' "$NAME" 2>/dev/null | cut -d'T' -f1 || echo "unknown")

# Display basic status
echo ""
echo "📋 Container Information:"
echo "  Status:     $CONTAINER_STATUS"
echo "  Image:      $CONTAINER_IMAGE"
echo "  Created:    $CONTAINER_CREATED"

# Status-specific information
case "$CONTAINER_STATUS" in
  "running")
    echo "  ✅ Container is running"
    
    # Get runtime info
    UPTIME=$(docker inspect -f '{{.State.StartedAt}}' "$NAME" 2>/dev/null | cut -d'T' -f1 || echo "unknown")
    PORTS=$(docker port "$NAME" 2>/dev/null || echo "none")
    
    echo "  Started:    $UPTIME"
    echo "  Port map:   $PORTS"
    echo ""
    echo "🌐 API Access:"
    echo "  Endpoint:   http://127.0.0.1:$CADDY_PORT"
    echo "  Health:     http://127.0.0.1:$CADDY_PORT/health"
    echo ""
    echo "📊 Quick Actions:"
    echo "  View logs:  ./logs.sh"
    echo "  Stop:       ./stop.sh"
    ;;
  "exited")
    EXIT_CODE=$(docker inspect -f '{{.State.ExitCode}}' "$NAME" 2>/dev/null || echo "unknown")
    FINISHED_AT=$(docker inspect -f '{{.State.FinishedAt}}' "$NAME" 2>/dev/null | cut -d'T' -f1 || echo "unknown")
    
    echo "  ❌ Container has exited"
    echo "  Exit code:  $EXIT_CODE"
    echo "  Stopped:    $FINISHED_AT"
    echo ""
    echo "📊 Quick Actions:"
    echo "  View logs:  ./logs.sh"
    echo "  Restart:    ./start.sh"
    echo "  Remove:     ./stop.sh"
    ;;
  "paused")
    echo "  ⏸️  Container is paused"
    echo ""
    echo "📊 Quick Actions:"
    echo "  Unpause:    docker unpause $NAME"
    echo "  Stop:       ./stop.sh"
    ;;
  *)
    echo "  ❓ Container status: $CONTAINER_STATUS"
    ;;
esac

# Check if port is accessible (only if running)
if [[ "$CONTAINER_STATUS" == "running" ]]; then
  echo ""
  echo "🔍 Connectivity Test:"
  if command -v curl >/dev/null 2>&1; then
    if curl -s --connect-timeout 3 "http://127.0.0.1:$CADDY_PORT/health" >/dev/null 2>&1; then
      echo "  ✅ API is responding on port $CADDY_PORT"
    else
      echo "  ⚠️  API not responding on port $CADDY_PORT (may still be starting up)"
    fi
  else
    echo "  ℹ️  Install curl to test API connectivity"
  fi
fi

# Resource usage (if running)
if [[ "$CONTAINER_STATUS" == "running" ]]; then
  echo ""
  echo "📈 Resource Usage:"
  if STATS=$(docker stats "$NAME" --no-stream --format "table {{.CPUPerc}}\t{{.MemUsage}}" 2>/dev/null | tail -n 1); then
    CPU_USAGE=$(echo "$STATS" | cut -f1)
    MEM_USAGE=$(echo "$STATS" | cut -f2)
    echo "  CPU:        ${CPU_USAGE:-N/A}"
    echo "  Memory:     ${MEM_USAGE:-N/A}"
  else
    echo "  CPU:        N/A (stats unavailable)"
    echo "  Memory:     N/A (stats unavailable)"
  fi
fi

echo ""