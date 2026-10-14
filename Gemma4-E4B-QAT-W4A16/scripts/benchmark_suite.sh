#!/usr/bin/env bash
# benchmark_suite.sh — run the controlled Gemma4 benchmark case matrix.
#
#   scripts/benchmark_suite.sh --label LABEL [--cases "D1 D2 ..."] [--result-dir DIR]
#
# Benchmark case matrix:
#   D1  1K in / 1K out,  concurrency 1   decode-dominated latency
#   D2  8K in / 1K out,  concurrency 1   ordinary interactive request
#   L1  64K in / 512 out, concurrency 1  long prefill and decode
#   L2  120K in / 512 out, concurrency 1 near-limit behavior
#   T1  8K in / 512 out, concurrency 4   aggregate throughput
#   MM1 one 224x224 image / 512 out, concurrency 1
#   MM2 video (server-side frame sampling, 224x224) / 512 out, concurrency 1
#
# The engine is warmed once before the measured cases. Every case runs REPS
# measured repetitions (default 3) with a distinct, cross-config-stable
# dataset seed per repetition. Results land in a timestamped directory (never
# overwritten): benchmark-results/<UTC>-<label>/ with per-case JSON plus
# environment.json, server-command.txt, summary.json and summary.md
set -Eeuo pipefail

SCRIPT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
PROJECT_DIR=$(dirname "$SCRIPT_DIR")

CONTAINER=${CONTAINER:-Gemma4-E4B-QAT-W4A16}
PORT=${PORT:-9031}
API_KEY=${API_KEY:-your-api-key}
SERVED_NAME=${SERVED_NAME:-gemma-4-E4B-it-qat-w4a16-ct}
RESULT_ROOT=${RESULT_ROOT:-${PROJECT_DIR}/benchmark-results}
SEED=${SEED:-42}
ASSERT_MODE=${ASSERT_MODE:-enforce}
REPS=${REPS:-3}

LABEL=""
CASES="D1 D2 L1 L2 T1 MM1 MM2"
RESULT_DIR=""

die() { echo "benchmark_suite: ERROR: $*" >&2; exit 2; }

while [[ $# -gt 0 ]]; do
  case $1 in
    --label) LABEL=$2; shift 2 ;;
    --cases) CASES=$2; shift 2 ;;
    --result-dir) RESULT_DIR=$2; shift 2 ;;
    *) die "unknown argument: $1" ;;
  esac
done
[[ -n $LABEL ]] || die "--label is required"

if [[ -z $RESULT_DIR ]]; then
  ts=$(date -u +%Y-%m-%dT%H%M%SZ)
  RESULT_DIR="${RESULT_ROOT}/${ts}-${LABEL}"
fi
if [[ -e $RESULT_DIR ]]; then
  for case in $CASES; do
    if compgen -G "$RESULT_DIR/${case}-run-*.json" >/dev/null; then
      die "result directory ${RESULT_DIR} already contains runs for case ${case} (refusing to overwrite)"
    fi
  done
fi
mkdir -p "$RESULT_DIR"

redact() { sed "s/${API_KEY}/REDACTED/g"; }

# --- environment + server command snapshot ---------------------------------
{
  echo "{"
  echo "  \"label\": \"${LABEL}\","
  echo "  \"date_utc\": \"$(date -u +%Y-%m-%dT%H:%M:%SZ)\","
  echo "  \"container\": \"${CONTAINER}\","
  echo "  \"image\": \"$(docker inspect -f '{{.Config.Image}}' "$CONTAINER")\","
  echo "  \"image_digest\": \"$(docker inspect -f '{{.Image}}' "$CONTAINER")\","
  echo "  \"driver\": \"$(nvidia-smi --query-gpu=driver_version --format=csv,noheader | head -1)\","
  echo "  \"cuda\": \"$(nvidia-smi -q | awk -F': ' '/CUDA Version/{print $2; exit}' | tr -d ' ')\","
  echo "  \"gpu\": \"$(nvidia-smi --query-gpu=name --format=csv,noheader -i 1 | head -1)\","
  echo "  \"api_key\": \"REDACTED\""
  echo "}"
} > "$RESULT_DIR/environment.json"
docker inspect -f '{{range .Args}}{{println .}}{{end}}' "$CONTAINER" | redact > "$RESULT_DIR/server-command.txt"
docker logs "$CONTAINER" 2>&1 | redact > "$RESULT_DIR/server.log.snapshot"

# --- warmup -----------------------------------------------------------------
echo "benchmark_suite: warming engine once (1024/128, not measured)"
ASSERT_MODE=skip "$SCRIPT_DIR/benchmark_gemma4.sh" \
  --label "$LABEL" --case WARMUP --input-len 1024 --output-len 128 \
  --num-prompts 1 --concurrency 1 --reps 1 --result-dir "$RESULT_DIR" >/dev/null
rm -f "$RESULT_DIR"/WARMUP-*.json "$RESULT_DIR"/WARMUP-*.log "$RESULT_DIR"/WARMUP-config.txt

# --- case table -------------------------------------------------------------
run_case() { # name input output prompts concurrency dataset
  local name=$1 input=$2 output=$3 prompts=$4 conc=$5 dataset=${6:-random}
  echo "benchmark_suite: case ${name} (in=${input} out=${output} prompts=${prompts} C=${conc} dataset=${dataset})"
  "$SCRIPT_DIR/benchmark_gemma4.sh" \
    --label "$LABEL" --case "$name" \
    --input-len "$input" --output-len "$output" \
    --num-prompts "$prompts" --concurrency "$conc" \
    --reps "$REPS" --dataset "$dataset" \
    --result-dir "$RESULT_DIR"
}

for case in $CASES; do
  case $case in
    D1)  run_case D1 1024 1024 4 1 ;;
    D2)  run_case D2 8192 1024 3 1 ;;
    L1)  run_case L1 65536 512 1 1 ;;
    L2)  run_case L2 122880 512 1 1 ;;
    T1)  run_case T1 8192 512 8 4 ;;
    MM1) run_case MM1 128 512 3 1 random-mm ;;
    MM2)
      echo "benchmark_suite: case MM2 (video 8x224x224, out=512, C=1)"
      (cd "$PROJECT_DIR" && OPENAI_BASE_URL="http://127.0.0.1:${PORT}/v1" \
        uv run --with openai python scripts/bench_mm2.py \
          --base-url "http://127.0.0.1:${PORT}/v1" \
          --api-key "$API_KEY" \
          --model "$SERVED_NAME" \
          --output-len 512 --reps "$REPS" --seed "$SEED" \
          --result-dir "$RESULT_DIR") | redact
      ;;
    *) die "unknown case: $case" ;;
  esac
done

# --- summary -----------------------------------------------------------------
"$SCRIPT_DIR/summarize_results.sh" "$RESULT_DIR"

echo
echo "benchmark_suite: done -> ${RESULT_DIR}"
