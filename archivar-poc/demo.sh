#!/bin/bash
# DEPRECATED: smoke-run leftover. The demo_*.mp4 corpus files no longer exist in
# ../sample_data, and the `default-analysis-gemma4` workflow (gemma4-12b) was
# removed from archivar.config.ts. Kept as a usage template only — point
# run_demo at existing files and a configured workflow before running:
#   run_demo "demo.mp4" "default-analysis-gemma4-e4b"   (S: gemma4-e4b-qat-w4a16 + qwen-asr-0.6b)
#   run_demo "demo.mp4" "default-analysis-35b"          (M: Qwen3.6-35B-A3B-GPTQ-Int4 + parakeet-primeline-de)
#   run_demo "demo.mp4" "default-analysis"              (L: Qwen3.8-27B-FP8 + Whisper3-Large-Turbo-DE)
set -e
cd "$(dirname "$0")"

run_demo() {
  local file="$1"
  local workflow="$2"
  echo "============================================================"
  echo "Analyzing ${file} with workflow ${workflow}"
  echo "============================================================"
  file "../sample_data/archivar/${file}"
  time pnpm cli clear-cache --file "${file}"
  time pnpm cli analyze --file "${file}" --workflow "${workflow}"
}

run_demo "demo.mp4" "default-analysis"
run_demo "demo_35b.mp4" "default-analysis-35b"
run_demo "demo_gemma4.mp4" "default-analysis-gemma4"
run_demo "demo_gemma4_e4b.mp4" "default-analysis-gemma4-e4b"
