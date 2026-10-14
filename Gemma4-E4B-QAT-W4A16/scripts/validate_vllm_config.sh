#!/usr/bin/env bash
# validate_vllm_config.sh
#
# Validates the speculative-decoding configuration against the target model
# before the container is started. Reads these environment variables:
#
#   MODEL              target model id (e.g. google/gemma-4-E4B-it-qat-w4a16-ct)
#   SPEC_MODE          none | mtp | dflash
#   MTP_DRAFT_MODEL    draft model for SPEC_MODE=mtp
#   DFLASH_DRAFT_MODEL draft model for SPEC_MODE=dflash
#   NUM_SPEC_TOKENS    number of speculative tokens
#
# Rules:
#   1. QAT target (name contains "-qat-") + MTP => draft must be QAT-derived.
#   2. google/gemma-4-E4B-it-assistant is explicitly rejected with a QAT target.
#   3. SPEC_MODE=dflash is rejected when DFLASH_DRAFT_MODEL points to a Gemma
#      MTP assistant (name contains "-assistant").
#   4. Unknown SPEC_MODE values are rejected.
#   5. NUM_SPEC_TOKENS >= 1 is required when speculation is enabled.
#
# Exit code 0 when the configuration is valid, 1 otherwise.
set -Eeuo pipefail

MODEL=${MODEL:?MODEL is required}
SPEC_MODE=${SPEC_MODE:-none}
MTP_DRAFT_MODEL=${MTP_DRAFT_MODEL:-}
DFLASH_DRAFT_MODEL=${DFLASH_DRAFT_MODEL:-}
NUM_SPEC_TOKENS=${NUM_SPEC_TOKENS:-0}

error() { echo "CONFIG INVALID: $*" >&2; }

safe_hint() {
  cat >&2 <<'EOF'
Safe start: SPEC_MODE=none make start
A QAT target model requires a QAT-derived assistant of matching precision
(e.g. google/gemma-4-E4B-it-qat-q4_0-unquantized-assistant), never the plain
google/gemma-4-E4B-it-assistant.
EOF
}

# Rule 4: unknown SPEC_MODE
case "$SPEC_MODE" in
  none|mtp|dflash) ;;
  *)
    error "unknown SPEC_MODE='$SPEC_MODE' (allowed: none, mtp, dflash)"
    safe_hint
    exit 1
    ;;
esac

is_qat_target=0
[[ $MODEL == *-qat-* ]] && is_qat_target=1

if [[ $SPEC_MODE != none ]]; then
  # Rule 5: NUM_SPEC_TOKENS >= 1 when speculation is enabled
  if ! [[ $NUM_SPEC_TOKENS =~ ^[0-9]+$ ]] || [[ $NUM_SPEC_TOKENS -lt 1 ]]; then
    error "SPEC_MODE=$SPEC_MODE requires NUM_SPEC_TOKENS >= 1 (got '$NUM_SPEC_TOKENS')"
    safe_hint
    exit 1
  fi
fi

if [[ $SPEC_MODE == mtp && $is_qat_target -eq 1 ]]; then
  # Rule 2: explicit rejection of the plain assistant with a QAT target
  if [[ $MTP_DRAFT_MODEL == "google/gemma-4-E4B-it-assistant" ]]; then
    error "SPEC_MODE=mtp with QAT target '$MODEL' must not use the non-QAT draft '$MTP_DRAFT_MODEL'"
    safe_hint
    exit 1
  fi
  # Rule 1: QAT target requires a QAT-derived draft
  if [[ $MTP_DRAFT_MODEL != *-qat-* ]]; then
    error "SPEC_MODE=mtp with QAT target '$MODEL' requires a QAT-derived draft, got '$MTP_DRAFT_MODEL'"
    safe_hint
    exit 1
  fi
fi

if [[ $SPEC_MODE == dflash ]]; then
  # Rule 3: dflash must not point at a Gemma MTP assistant
  if [[ $DFLASH_DRAFT_MODEL == *-assistant ]]; then
    error "SPEC_MODE=dflash requires a DFlash drafter, but DFLASH_DRAFT_MODEL='$DFLASH_DRAFT_MODEL' is a Gemma MTP assistant"
    safe_hint
    exit 1
  fi
fi

echo "config valid: MODEL=$MODEL SPEC_MODE=$SPEC_MODE NUM_SPEC_TOKENS=$NUM_SPEC_TOKENS"
