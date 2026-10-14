#!/bin/bash
# =============================================================================
# test-curl.sh — End-to-end test of the public API with webhook delivery
# =============================================================================
#
# What it does:
#   1. Copies test/fixtures/demo.mp4 to ../sample_data/archivar/
#   2. Starts a mini webhook server on port 9876 (detached)
#   3. Calls POST /api/analyze for demo.mp4
#   4. Polls GET /api/raw every 10 seconds until done/error
#   5. On completion, the webhook server writes the payload to .curl-webhook-test.json
#
# Usage:
#   ./test-curl.sh [--workflow <name>] [--server <url>]
#
# Defaults:
#   WORKFLOW=default-analysis
#   SERVER=http://localhost:8802 (the container; use 8801 for the dev server)
# =============================================================================

set -e

WORKFLOW="${WORKFLOW:-default-analysis}"
SERVER="${SERVER:-http://localhost:8802}"
FILE="demo.mp4"
WEBHOOK_PORT=9876
WEBHOOK_URL="http://localhost:${WEBHOOK_PORT}/webhook"
POLL_INTERVAL=10
TIMEOUT_SECS=600

# Absolute paths (resolved relative to this script's dir)
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="${SCRIPT_DIR}"
DATA_DIR="${PROJECT_DIR}/../sample_data/archivar"
FIXTURE="${PROJECT_DIR}/test/fixtures/demo.mp4"
OUTPUT_FILE="${PROJECT_DIR}/.curl-webhook-test.json"
PID_FILE="${PROJECT_DIR}/.curl-webhook.pid"

# =============================================================================
# Helper: cleanup on exit
# =============================================================================
cleanup() {
  if [ -f "${PID_FILE}" ]; then
    PID=$(cat "${PID_FILE}")
    if kill -0 "${PID}" 2>/dev/null; then
      kill "${PID}" 2>/dev/null || true
      echo "[cleanup] Killed webhook server (PID ${PID})"
    fi
    rm -f "${PID_FILE}"
  fi
}
trap cleanup EXIT

# =============================================================================
# Step 1: Copy fixture to data directory
# =============================================================================
echo "=== Step 1: Copy fixture to data directory ==="
mkdir -p "${DATA_DIR}"
cp "${FIXTURE}" "${DATA_DIR}/${FILE}"
echo "Copied ${FIXTURE} -> ${DATA_DIR}/${FILE}"

# =============================================================================
# Step 1.5: Clear cache for the test file to force fresh analysis
# =============================================================================
echo ""
echo "=== Step 1.5: Clear cache for ${FILE} ==="
CLEAR_RESPONSE=$(curl -s -X DELETE "${SERVER}/api/clear-cache?file=${FILE}")
echo "Cache clear response: ${CLEAR_RESPONSE}"

# =============================================================================
# Step 2: Start webhook server (detached)
# =============================================================================
echo ""
echo "=== Step 2: Start webhook server on port ${WEBHOOK_PORT} ==="

# Kill any existing webhook server on that port
EXISTING_PID=$(lsof -ti:${WEBHOOK_PORT} 2>/dev/null || true)
if [ -n "${EXISTING_PID}" ]; then
  echo "Killing existing process on port ${WEBHOOK_PORT} (PID ${EXISTING_PID})"
  kill "${EXISTING_PID}" 2>/dev/null || true
  sleep 1
fi

# Start the webhook server in background using external script
cd "${PROJECT_DIR}"
PORT="${WEBHOOK_PORT}" OUTPUT="${OUTPUT_FILE}" TIMEOUT="${TIMEOUT_SECS}000" node test/fixtures/webhook-server.js &
WEBHOOK_PID=$!
echo "${WEBHOOK_PID}" > "${PID_FILE}"
echo "Started webhook server (PID ${WEBHOOK_PID})"

# Wait a moment for server to start
sleep 2

# Verify it's running
if ! kill -0 "${WEBHOOK_PID}" 2>/dev/null; then
  echo "ERROR: Webhook server failed to start"
  exit 1
fi
echo "Webhook server is running"

# =============================================================================
# Step 3: Call POST /api/analyze
# =============================================================================
echo ""
echo "=== Step 3: Call POST /api/analyze ==="
echo "Workflow: ${WORKFLOW}"
echo "Webhook URL: ${WEBHOOK_URL}"

ANALYZE_RESPONSE=$(curl -s -X POST "${SERVER}/api/analyze" \
  -H "Content-Type: application/json" \
  -d "{\"file\": \"${FILE}\", \"workflow\": \"${WORKFLOW}\", \"webHookUrl\": \"${WEBHOOK_URL}\"}")

echo "Response: ${ANALYZE_RESPONSE}"
echo "${ANALYZE_RESPONSE}" | grep -q '"ok":true' || { echo "ERROR: analyze failed"; exit 1; }

# =============================================================================
# Step 4: Poll GET /api/raw every 10 seconds
# =============================================================================
echo ""
echo "=== Step 4: Poll GET /api/raw every ${POLL_INTERVAL}s ==="

ELAPSED=0
while true; do
  RESPONSE=$(curl -s "${SERVER}/api/raw?file=${FILE}")
  STATUS=$(echo "${RESPONSE}" | grep -o '"status":"[^"]*"' | cut -d'"' -f4)

  echo "[$(date '+%H:%M:%S')] [${ELAPSED}s] Status: ${STATUS}"
  echo "${RESPONSE}" | head -c 200

  if [ "${STATUS}" = "done" ] || [ "${STATUS}" = "error" ]; then
    echo ""
    echo "=== Workflow ${STATUS} ==="
    break
  fi

  if [ ${ELAPSED} -ge ${TIMEOUT_SECS} ]; then
    echo ""
    echo "TIMEOUT: No result after ${TIMEOUT_SECS}s"
    exit 1
  fi

  sleep ${POLL_INTERVAL}
  ELAPSED=$((ELAPSED + POLL_INTERVAL))
done

# =============================================================================
# Done
# =============================================================================
echo ""
echo "=== Done ==="
if [ -f "${OUTPUT_FILE}" ]; then
  echo "Webhook payload written to: ${OUTPUT_FILE}"
  echo "Contents:"
  cat "${OUTPUT_FILE}" | jq
else
  echo "No webhook payload file (workflow may have errored before webhook delivery)"
fi

echo ""
echo "Final /api/raw response (parsed .result):"
curl -s "${SERVER}/api/raw?file=${FILE}" | jq -r '.result' | jq

exit 0
