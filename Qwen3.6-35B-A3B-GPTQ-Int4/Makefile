SHELL := /bin/bash
.SHELLFLAGS := -eu -o pipefail -c
.DEFAULT_GOAL := build
.DELETE_ON_ERROR:

# .env uses GNU Make syntax, not shell syntax. Command-line assignments win.
ENV_FILE ?= .env
-include $(ENV_FILE)

# Default matches the supplied H200 host. These are starting settings, not
# measured optima. A profile never chooses another physical GPU.
PROFILE ?= h200
ifeq ($(filter $(strip $(PROFILE)),ada h100 h200),)
$(error PROFILE must be ada, h100, or h200)
endif
include profiles/$(strip $(PROFILE)).mk

# -- image & auth -------------------------------------------------------------
# Stock release, no Dockerfile, no external runtime patches. make build pulls it.
# Do NOT reuse the unverified -cu130 alias.
IMAGE                 ?= vllm/vllm-openai:v0.29.0
EXPECTED_VLLM_VERSION ?= 0.29.0
PYTHON                ?= python3
API_KEY               ?= your-api-key
HF_TOKEN              ?=

# -- GPU ----------------------------------------------------------------------
GPU_NO                ?= 0
# Resolve at execution time, never during make help/check/print-config.
GPU_UUID              ?=
GPU_DEVICE            ?=
TP                    ?= 1
# Explicit KV_CACHE_BYTES overrides fraction-based KV sizing. GPU_MEM_UTIL is
# NOT a total-VRAM hard cap when an explicit KV budget is supplied.
KV_CACHE_BYTES        ?= 8G

# -- persistent host storage --------------------------------------------------
HF_HOME               ?= ./model
HF_XET_CACHE_DIR      ?= $(HF_HOME)/xet
VLLM_CACHE_ROOT       ?= $(HF_HOME)/vllm_cache
TRITON_CACHE_DIR      ?= $(VLLM_CACHE_ROOT)/triton
TORCHINDUCTOR_CACHE_DIR ?= $(VLLM_CACHE_ROOT)/torchinductor
CUDA_CACHE_DIR        ?= $(VLLM_CACHE_ROOT)/cuda
DATA_DIR              ?= ../sample_data
STATE_DIR             ?= $(CURDIR)/.state
OUTPUT_DIR            ?= $(CURDIR)/outputs
LOGS_DIR              ?= $(CURDIR)/logs

# Stable container paths. Mount the complete HF cache (blobs AND snapshots).
HF_HOME_IN_CONTAINER         ?= /hf
VLLM_CACHE_ROOT_IN_CONTAINER ?= /vllm_cache
DATA_DIR_IN_CONTAINER        ?= /sample_data

# -- target model -------------------------------------------------------------
CONTAINER             ?= Qwen3.6-35B-A3B-GPTQ-Int4
BIND_ADDR             ?= 0.0.0.0
PORT                  ?= 8931
MODEL                 ?= palmfuture/Qwen3.6-35B-A3B-GPTQ-Int4
MODEL_REVISION        ?= main
SERVED_NAME           ?= Qwen3.6-35B-A3B-GPTQ-Int4
DTYPE                 ?= bfloat16
# Leave empty: use the checkpoint's GPTQ metadata. Do NOT force moe_wna16.
QUANTIZATION          ?=
MODEL_PATH            ?=
TRUST_REMOTE_CODE     ?= 1

# -- KV cache and attention: independent of weight quantization ----------------
# Portable starting point on Ada AND Hopper; benchmark rather than assume best.
KV_QUANT              ?= bfloat16
ATTN_BACKEND          ?= FLASH_ATTN

# -- DFlash (separate BF16-weight drafter; NOT DFlash2) -------------------------
SPEC_DECODE           ?= 1
SPEC_METHOD           ?= dflash
DRAFT_MODEL           ?= z-lab/Qwen3.6-35B-A3B-DFlash
DRAFT_REVISION        ?= main
# 1 explicitly refreshes moving HF revisions; otherwise downloads reuse the lock.
REFRESH_MODELS        ?= 0
DRAFT_MODEL_PATH      ?=
DRAFT_KV_QUANT        ?= bfloat16
DRAFT_ATTN_BACKEND    ?= FLASH_ATTN
# 3 proposals + the bonus position form a four-position DFlash block.
# 3 is an unbenchmarked starting point; compare 3, 7, and 15 on your workload.
NUM_SPEC_TOKENS       ?= 3
# REQUIRED by the current mixed sliding/full-attention DFlash checkpoint.
VLLM_USE_V2_MODEL_RUNNER ?= 1

# -- scheduler / context ------------------------------------------------------
MAX_LEN               ?= 65536
MAX_SEQS              ?= 4
BATCH_TOKS            ?= 8192
SEED                  ?= 42
PREFIX_CACHING        ?= 1
EAGER_ENABLED         ?= 0
LLM_ONLY              ?= 0
# 0 (default) = thinking allowed. 1 passes enable_thinking=false to the chat
# template, for lower latency (e.g. voice).
NO_REASONING          ?= 0

# -- multimodal settings ------------------------------------------------------
LIMIT_MM_IMAGE        ?= 1
LIMIT_MM_VIDEO        ?= 1
VIDEO_PROFILE_FRAMES  ?= 32
VIDEO_PROFILE_WIDTH   ?= 608
VIDEO_PROFILE_HEIGHT  ?= 448
VIDEO_FPS             ?= 1

# -- optional MoE tuning ------------------------------------------------------
MOE_CONFIG_DIR        ?= $(CURDIR)/moe_configs
# Uses the supported override directory; never shadows bundled fallback files.
# No version-specific /usr/local/lib/python3.12/... mount is needed.
MOE_BACKEND           ?=

# -- optional YaRN ------------------------------------------------------------
# Deliberately off: 65536 is within native 262144. Enabling YaRN changes target
# positions but does not automatically retrain/extend the DFlash drafter.
ROPE_ENABLED          ?= 0
ROPE_SCALING_FACTOR   ?= 2.0

# -- container and verification ------------------------------------------------
IPC_MODE              ?= host
# Used only with IPC_MODE=private; Docker ignores shm-size with host IPC.
SHM_SIZE              ?= 64g
RESTART_POLICY        ?= unless-stopped
READY_TIMEOUT         ?= 1800
REQUEST_TIMEOUT       ?= 300
# Existing files are never overwritten by flatten.
FLAT_WHICH            ?= model
FLAT_DIR              ?= $(HF_HOME)/$(CONTAINER)-$(FLAT_WHICH)-flat

# -- smoke test ----------------------------------------------------------------
OPENAI_BASE_URL		  ?= http://127.0.0.1:$(PORT)/v1
OPENAI_API_KEY		  ?= $(API_KEY)
SMOKE_MODE 			  ?= all
SMOKE_UV              ?= uv
SMOKE_BASE_URL        ?= $(OPENAI_BASE_URL)

# Export values, rather than interpolating them into shell/JSON strings.
# Numeric values are stripped by the launcher, so trailing Make comments work.
export PROFILE IMAGE EXPECTED_VLLM_VERSION API_KEY HF_TOKEN
export GPU_NO GPU_UUID GPU_DEVICE TP GPU_MEM_UTIL KV_CACHE_BYTES
export HF_HOME HF_XET_CACHE_DIR VLLM_CACHE_ROOT TRITON_CACHE_DIR
export TORCHINDUCTOR_CACHE_DIR CUDA_CACHE_DIR DATA_DIR STATE_DIR OUTPUT_DIR LOGS_DIR
export HF_HOME_IN_CONTAINER VLLM_CACHE_ROOT_IN_CONTAINER DATA_DIR_IN_CONTAINER
export CONTAINER BIND_ADDR PORT MODEL MODEL_REVISION SERVED_NAME DTYPE QUANTIZATION
export MODEL_PATH TRUST_REMOTE_CODE KV_QUANT ATTN_BACKEND
export SPEC_DECODE SPEC_METHOD DRAFT_MODEL DRAFT_REVISION DRAFT_MODEL_PATH
export REFRESH_MODELS
export DRAFT_KV_QUANT DRAFT_ATTN_BACKEND NUM_SPEC_TOKENS VLLM_USE_V2_MODEL_RUNNER
export MAX_LEN MAX_SEQS BATCH_TOKS SEED PREFIX_CACHING EAGER_ENABLED LLM_ONLY
export NO_REASONING LIMIT_MM_IMAGE LIMIT_MM_VIDEO VIDEO_PROFILE_FRAMES
export VIDEO_PROFILE_WIDTH VIDEO_PROFILE_HEIGHT VIDEO_FPS
export MOE_CONFIG_DIR MOE_BACKEND ROPE_ENABLED ROPE_SCALING_FACTOR
export IPC_MODE SHM_SIZE RESTART_POLICY READY_TIMEOUT REQUEST_TIMEOUT
export FLAT_WHICH FLAT_DIR

.PHONY: help setup build download start stop restart deploy doctor paths mkdirs \
        print-config logs log-once status test check flatten metrics \
        variant-h200 variant-h100 variant-ada variant-gb10

help:
	@printf '%s\n' \
	  'setup          Pull IMAGE and download/lock models (build + download)' \
	  'build          Pull IMAGE and verify its vLLM version (no GPU allocation)' \
	  'download       Download/lock target + DFlash to immutable HF revisions' \
	  'doctor         Check selected GPU, model files, image, and draft metadata' \
	  'start          Preflight, start, and await readiness; refuse an existing name' \
	  'restart        Preflight BEFORE stopping only CONTAINER; then start' \
	  'deploy         Sequential build + download + start + HTTP smoke tests' \
	  'paths          Show persistent host/container storage mappings' \
	  'print-config   Print effective vLLM arguments; API key redacted' \
	  'test           Live text, streaming, JSON-schema, and tool-call smoke tests' \
	  'smoke          Deeper uv client tests; SMOKE_MODE=stream|multiturn|tools|multimodal|context|all' \
	  'check          Offline regression tests; no Docker/GPU/network required' \
	  'logs/log-once  Follow/snapshot Docker logs into LOGS_DIR' \
	  'metrics        Print live Prometheus metrics (including speculation counters)' \
	  'flatten        Optional resolved copy of locked snapshot; never required' \
	  'Profiles: make <target> PROFILE=ada|h100|h200 GPU_NO=1'

setup: build download

build download start stop restart deploy doctor paths mkdirs print-config logs log-once status flatten metrics:
	@$(PYTHON) scripts/deploy.py $@

test:
	@$(PYTHON) scripts/smoke_test.py

smoke smoke-test:
	@case "$(SMOKE_MODE)" in \
	  stream|multiturn|tools|multimodal|context|all) ;; \
	  *) printf '%s\n' 'ERROR: SMOKE_MODE must be stream, multiturn, tools, multimodal, context, or all' >&2; exit 2 ;; \
	esac
	@command -v "$(SMOKE_UV)" >/dev/null 2>&1 || { printf '%s\n' 'ERROR: uv not found; install uv or set SMOKE_UV=/path/to/uv' >&2; exit 2; }
	@OPENAI_BASE_URL="$(SMOKE_BASE_URL)" \
	 OPENAI_API_KEY="$(API_KEY)" \
	 API_KEY="$(API_KEY)" \
	 MAX_LEN="$(MAX_LEN)" \
	 "$(SMOKE_UV)" run smoke_test.py "$(SMOKE_MODE)"

check:
	@$(PYTHON) -m unittest discover -s tests -v

# Profiles are supplied per invocation or in .env; never clobber secrets.
variant-h200 variant-h100 variant-ada:
	@printf '%s\n' 'Use PROFILE=$(patsubst variant-%,%,$@) in .env or on the make command line. Your .env has not been changed.'

variant-gb10:
	@printf '%s\n' 'GB10 is outside this Ada/Hopper package. Keep your existing GB10 deployment separate.' >&2
	@exit 2
