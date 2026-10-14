#!/usr/bin/env bash
# determinism_check.sh <outfile.json>
#
# Captures a deterministic (temperature=0, thinking disabled) response from
# the running server. Compare two captures across configurations with:
#   diff <(jq -r .content a.json) <(jq -r .content b.json)
# A token-level mismatch across attention backends is expected to be small
# and must be explainable by backend numerical tolerance.
set -Eeuo pipefail

PORT=${PORT:-9031}
API_KEY=${API_KEY:-your-api-key}
SERVED_NAME=${SERVED_NAME:-gemma-4-E4B-it-qat-w4a16-ct}

[[ $# -eq 1 ]] || { echo "usage: $0 <outfile.json>" >&2; exit 2; }

resp=$(curl -sfS "http://127.0.0.1:${PORT}/v1/chat/completions" \
  -H "Authorization: Bearer ${API_KEY}" \
  -H "Content-Type: application/json" \
  -d "{
    \"model\": \"${SERVED_NAME}\",
    \"messages\": [{\"role\": \"user\", \"content\": \"Explain in detail how chunked prefill interacts with the KV cache in vLLM, then give three examples of kernel-level optimizations.\"}],
    \"max_tokens\": 256,
    \"temperature\": 0,
    \"chat_template_kwargs\": {\"enable_thinking\": false}
  }")

echo "$resp" | jq '{
  content: .choices[0].message.content,
  finish_reason: .choices[0].finish_reason,
  completion_tokens: .usage.completion_tokens,
  prompt_tokens: .usage.prompt_tokens
}' > "$1"

echo "determinism capture -> $1"
jq -r '"finish=\(.finish_reason) tokens=\(.completion_tokens)"' "$1"
