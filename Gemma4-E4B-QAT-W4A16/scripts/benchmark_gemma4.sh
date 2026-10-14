#!/usr/bin/env bash
# benchmark_gemma4.sh — run one controlled benchmark case against the Gemma4
# E4B vLLM server and save machine-readable results.
#
# The benchmark client runs inside the server container (matching vLLM and
# tokenizer); result JSON is copied out to the host result directory.
#
# Required arguments:
#   --label LABEL        configuration label (result directory name component)
#   --case CASE          case name, e.g. D1 (result file name component)
#   --input-len N        fixed random input tokens per request
#   --output-len N       fixed output tokens per request (--ignore-eos)
#   --num-prompts N      measured requests per repetition
#   --concurrency N      max concurrent requests
#
# Optional:
#   --reps N             measured repetitions (default 3)
#   --dataset NAME       random (default) | random-mm
#   --mm-image WxH       random-mm image bucket, e.g. 224x224 (default 224x224)
#   --warmup             run one warmup request before measured reps
#   --result-dir DIR     result directory (default: auto timestamped under $RESULT_ROOT)
#
# Environment: CONTAINER PORT API_KEY MODEL SERVED_NAME RESULT_ROOT SEED ASSERT_MODE
#   ASSERT_MODE=enforce (default) | warn | skip  — kernel assertion gate.
#
# The script aborts when the served model name does not match SERVED_NAME and
# (per ASSERT_MODE) when scripts/assert_vllm_kernels.sh fails. API keys are
# redacted from every artifact.
set -Eeuo pipefail

SCRIPT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)

CONTAINER=${CONTAINER:-Gemma4-E4B-QAT-W4A16}
PORT=${PORT:-9031}
API_KEY=${API_KEY:-your-api-key}
MODEL=${MODEL:-google/gemma-4-E4B-it-qat-w4a16-ct}
SERVED_NAME=${SERVED_NAME:-gemma-4-E4B-it-qat-w4a16-ct}
RESULT_ROOT=${RESULT_ROOT:-$(dirname "$SCRIPT_DIR")/benchmark-results}
SEED=${SEED:-42}
ASSERT_MODE=${ASSERT_MODE:-enforce}

LABEL=""
CASE=""
INPUT_LEN=""
OUTPUT_LEN=""
NUM_PROMPTS=""
CONCURRENCY=""
REPS=3
DATASET=random
MM_IMAGE=224x224
WARMUP=0
RESULT_DIR=""

die() { echo "benchmark_gemma4: ERROR: $*" >&2; exit 2; }

while [[ $# -gt 0 ]]; do
  case $1 in
    --label) LABEL=$2; shift 2 ;;
    --case) CASE=$2; shift 2 ;;
    --input-len) INPUT_LEN=$2; shift 2 ;;
    --output-len) OUTPUT_LEN=$2; shift 2 ;;
    --num-prompts) NUM_PROMPTS=$2; shift 2 ;;
    --concurrency) CONCURRENCY=$2; shift 2 ;;
    --reps) REPS=$2; shift 2 ;;
    --dataset) DATASET=$2; shift 2 ;;
    --mm-image) MM_IMAGE=$2; shift 2 ;;
    --warmup) WARMUP=1; shift ;;
    --result-dir) RESULT_DIR=$2; shift 2 ;;
    *) die "unknown argument: $1" ;;
  esac
done

[[ -n $LABEL && -n $CASE && -n $INPUT_LEN && -n $OUTPUT_LEN && -n $NUM_PROMPTS && -n $CONCURRENCY ]] \
  || die "--label, --case, --input-len, --output-len, --num-prompts and --concurrency are required"

# --- served-model check ----------------------------------------------------
served=$(curl -sf -H "Authorization: Bearer ${API_KEY}" "http://127.0.0.1:${PORT}/v1/models" \
  | python3 -c 'import json,sys; print(json.load(sys.stdin)["data"][0]["id"])') \
  || die "server not reachable on port ${PORT}"
if [[ $served != "$SERVED_NAME" ]]; then
  die "served model '$served' != SERVED_NAME '$SERVED_NAME'"
fi

# --- kernel assertion gate --------------------------------------------------
if [[ $ASSERT_MODE != skip && -x "$SCRIPT_DIR/assert_vllm_kernels.sh" ]]; then
  if "$SCRIPT_DIR/assert_vllm_kernels.sh" "$CONTAINER"; then
    :
  elif [[ $ASSERT_MODE == enforce ]]; then
    die "kernel assertions failed (ASSERT_MODE=enforce)"
  else
    echo "benchmark_gemma4: WARNING: kernel assertions failed (ASSERT_MODE=warn, continuing)"
  fi
fi

# --- result directory -------------------------------------------------------
if [[ -z $RESULT_DIR ]]; then
  ts=$(date -u +%Y-%m-%dT%H%M%SZ)
  RESULT_DIR="${RESULT_ROOT}/${ts}-${LABEL}"
fi
if [[ -e $RESULT_DIR && -z $(find "$RESULT_DIR" -maxdepth 1 -name "${CASE}-*" -print -quit) ]]; then
  : # directory exists from the same suite run; only same-case collisions are fatal
fi
mkdir -p "$RESULT_DIR"
if compgen -G "$RESULT_DIR/${CASE}-run-*.json" >/dev/null; then
  die "result files for case ${CASE} already exist in ${RESULT_DIR} (refusing to overwrite)"
fi

redact() { sed "s/${API_KEY}/REDACTED/g"; }

# --- expanded configuration snapshot ---------------------------------------
{
  echo "label=${LABEL}"
  echo "case=${CASE}"
  echo "dataset=${DATASET}"
  echo "input_len=${INPUT_LEN}"
  echo "output_len=${OUTPUT_LEN}"
  echo "num_prompts=${NUM_PROMPTS}"
  echo "concurrency=${CONCURRENCY}"
  echo "reps=${REPS}"
  echo "seed=${SEED}"
  echo "container=${CONTAINER}"
  echo "model=${MODEL}"
  echo "served_name=${SERVED_NAME}"
  echo "api_key=REDACTED"
  echo "image=$(docker inspect -f '{{.Image}}' "$CONTAINER")"
  echo "image_name=$(docker inspect -f '{{.Config.Image}}' "$CONTAINER")"
  echo "server_args=$(docker inspect -f '{{json .Args}}' "$CONTAINER")"
  echo "date_utc=$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  echo "driver=$(nvidia-smi --query-gpu=driver_version --format=csv,noheader | head -1)"
  echo "cuda=$(nvidia-smi -q | awk -F': ' '/CUDA Version/{print $2; exit}')"
} | redact > "$RESULT_DIR/${CASE}-config.txt"

# --- benchmark invocation ----------------------------------------------------
run_bench() { # <seed> <outfile-stem>
  local seed=$1 stem=$2
  local -a extra=()
  if [[ $DATASET == random-mm ]]; then
    local w=${MM_IMAGE%x*} h=${MM_IMAGE#*x}
    extra+=(--dataset-name random-mm
      --random-mm-base-items-per-request 1
      --random-mm-num-mm-items-range-ratio 0
      --random-mm-bucket-config "{(${h}, ${w}, 1): 1.0}"
      --random-mm-limit-mm-per-prompt '{"image": 1, "video": 0}'
      --enable-multimodal-chat)
  else
    extra+=(--dataset-name random)
  fi
  docker exec -e OPENAI_API_KEY="$API_KEY" "$CONTAINER" \
    vllm bench serve \
      --backend openai-chat \
      --base-url http://127.0.0.1:8000 \
      --endpoint /v1/chat/completions \
      --model "$MODEL" \
      --served-model-name "$SERVED_NAME" \
      --tokenizer "$MODEL" \
      --trust-remote-code \
      "${extra[@]}" \
      --random-input-len "$INPUT_LEN" \
      --random-output-len "$OUTPUT_LEN" \
      --random-range-ratio 0 \
      --num-prompts "$NUM_PROMPTS" \
      --max-concurrency "$CONCURRENCY" \
      --request-rate inf \
      --ignore-eos \
      --temperature 0 \
      --seed "$seed" \
      --extra-body '{"chat_template_kwargs":{"enable_thinking":false}}' \
      --metric-percentiles 50,90,95,99 \
      --save-result \
      --result-dir /tmp/bench-out \
      --result-filename "${stem}.json" \
    2>&1 | redact | tee "$RESULT_DIR/${stem}.log"
  local rc=${PIPESTATUS[0]}
  docker cp "$CONTAINER:/tmp/bench-out/${stem}.json" "$RESULT_DIR/${stem}.json" 2>/dev/null || true
  if [[ $rc -ne 0 || ! -s $RESULT_DIR/${stem}.json ]]; then
    die "benchmark run ${stem} failed (rc=$rc); see ${RESULT_DIR}/${stem}.log"
  fi
}

docker exec "$CONTAINER" mkdir -p /tmp/bench-out

if [[ $WARMUP -eq 1 ]]; then
  echo "benchmark_gemma4: warmup (1 prompt, not measured)"
  run_bench $((SEED + 1000)) "${CASE}-warmup"
fi

for ((rep = 1; rep <= REPS; rep++)); do
  # Distinct dataset per repetition (fixed per rep index across configs) so
  # prefix caching cannot turn a later repetition into a warm-cache run.
  run_bench $((SEED + rep)) "${CASE}-run-${rep}"
done

echo "benchmark_gemma4: ${CASE} done -> ${RESULT_DIR}"
