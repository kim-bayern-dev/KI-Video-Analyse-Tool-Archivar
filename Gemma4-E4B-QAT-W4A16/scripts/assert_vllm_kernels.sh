#!/usr/bin/env bash
# assert_vllm_kernels.sh <container-name|log-file>
#
# Asserts that the vLLM server selected non-pathological kernels:
#   - FAIL on FlashInfer-SM90-SWA and FA4-FP8-SM100 crash signatures
#   - FAIL on TRITON_ATTN unless it is the only legal backend for the
#     platform: either fp8 KV on SM90, or vLLM itself logging "FA4 not
#     available, forcing TRITON_ATTN" (pre-Hopper GPUs: Gemma4's
#     heterogeneous head dims 256/512 are outside FA4's supported set)
#   - FAIL if a quantized linear layer uses emulation
#   - REPORT (no fail) whether the W4A16 linear kernel is Machete or Marlin
#   - FAIL if CUDA graph capture failed or eager-only execution was selected
#
# Exit code 0 on pass, 1 on assertion failure, 2 on usage/log errors.
# Matched evidence lines are printed in every case.
set -Eeuo pipefail

if [[ $# -ne 1 ]]; then
  echo "usage: $0 <container-name|log-file>" >&2
  exit 2
fi

target=$1
tmp_log=""
if [[ -f $target ]]; then
  log=$target
else
  tmp_log=$(mktemp /tmp/vllm-kernels-XXXXXX.log)
  if ! docker logs "$target" >"$tmp_log" 2>&1; then
    echo "ERROR: cannot read logs for '$target' (not a file, docker logs failed)" >&2
    rm -f "$tmp_log"
    exit 2
  fi
  log=$tmp_log
fi
trap '[[ -n $tmp_log ]] && rm -f "$tmp_log"' EXIT

fail=0

section() { echo; echo "== $1 =="; }

# --- 1. Attention backend -------------------------------------------------
# TRITON_ATTN is the ONLY legal backend for Gemma4 when (a)
# kv_cache_dtype=fp8_e4m3 on SM90 (FA4: fp8 unsupported; FA3: head_dim 512
# unsupported; FlashInfer: FP8+SWA crash), or (b) vLLM reports "FA4 not
# available, forcing TRITON_ATTN" (pre-Hopper GPUs: Gemma4's heterogeneous
# head dims 256/512 unsupported by FA4). Triton without either constraint
# remains a FAILURE (then FA4 should have been selected). Any
# FlashAttention/FA4 selection passes.
section "attention backend"
attn_lines=$(grep -hE "Using AttentionBackendEnum\.[A-Za-z0-9_]+ backend" "$log" | sort -u || true)
kv_fp8=$(grep -c "fp8_e4m3 data type to store kv cache" "$log" || true)
triton_forced=$(grep -c "FA4 not available, forcing TRITON_ATTN" "$log" || true)
if grep -q "FlashInfer backend on SM90 currently crashes" "$log"; then
  echo "FAIL: FlashInfer sliding-window crash signature present:"
  grep -m2 "FlashInfer backend on SM90 currently crashes" "$log"
  fail=1
fi
if grep -q "FP8 is only supported on SM100" "$log"; then
  echo "FAIL: FA4 CuTe FP8 assert present (SM90 cannot do FA4+fp8):"
  grep -m2 "FP8 is only supported on SM100" "$log"
  fail=1
fi
if [[ -z $attn_lines ]]; then
  echo "FAIL: no attention-backend line found in log"
  fail=1
else
  echo "$attn_lines"
  if grep -q "TRITON_ATTN" <<<"$attn_lines"; then
    if [[ $kv_fp8 -gt 0 ]]; then
      echo "NOTE: TRITON_ATTN with fp8 KV is the only legal backend on SM90 for this model (see script header)"
    elif [[ $triton_forced -gt 0 ]]; then
      echo "NOTE: TRITON_ATTN forced by vLLM (FA4 unavailable on this platform): OK"
    else
      echo "FAIL: TRITON_ATTN active without fp8 KV or platform constraint (FA4 should be selected)"
      fail=1
    fi
  elif grep -qE "AttentionBackendEnum\.(FLASH_ATTN|FLASHINFER_ATTN|FA4)" <<<"$attn_lines"; then
    echo "FlashAttention/FA4-class backend explicitly reported: OK"
  else
    echo "FAIL: unexpected attention backend selection"
    fail=1
  fi
fi

# --- 2. Quantized linear kernel -------------------------------------------
section "quantized linear kernel"
linear_lines=$(grep -hiE "LinearKernel for|linear backend|Using .*Marlin|Using .*Machete" "$log" | grep -viE "warn" | sort -u || true)
if [[ -n $linear_lines ]]; then
  echo "$linear_lines"
else
  echo "(no linear-kernel lines found)"
fi
if grep -qiE "emulat" "$log"; then
  echo "FAIL: emulation detected:"
  grep -iE "emulat" "$log" | sort -u | head -10
  fail=1
fi

# --- 3. CUDA graphs --------------------------------------------------------
section "cuda graphs"
if grep -qE "enforce_eager['=:\s]+True" "$log"; then
  echo "FAIL: enforce_eager=True (eager-only execution selected)"
  grep -E "enforce_eager['=:\s]+True" "$log" | head -2
  fail=1
fi
if grep -qiE "cudagraph.{0,40}fail|cuda graph.{0,40}fail|falling back to eager|fallback to eager" "$log"; then
  echo "FAIL: CUDA graph capture failure / eager fallback detected:"
  grep -iE "cudagraph.{0,40}fail|cuda graph.{0,40}fail|falling back to eager|fallback to eager" "$log" | sort -u | head -5
  fail=1
fi
if grep -q "Graph capturing finished" "$log" || grep -q "Capturing CUDA graphs" "$log"; then
  grep -hE "Graph capturing finished|cudagraph_mode[^,]*" "$log" | sort -u | head -3
else
  echo "FAIL: no successful CUDA graph capture reported"
  fail=1
fi

# --- verdict ---------------------------------------------------------------
echo
if [[ $fail -ne 0 ]]; then
  echo "KERNEL ASSERTIONS FAILED"
  exit 1
fi
echo "KERNEL ASSERTIONS PASSED"
