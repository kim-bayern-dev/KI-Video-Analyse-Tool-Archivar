# Load .env if present: API_KEY, HF_TOKEN, etc.
-include .env

comma := ,

# Production image, pinned by tag.
IMAGE                 ?= vllm/vllm-openai:v0.28.0

API_KEY               ?= your-api-key

GPU_NO                ?= 0
GPU_UUID              := $(shell nvidia-smi --query-gpu=gpu_uuid --format=csv,noheader,nounits -i $(GPU_NO))
GPU_DEVICE            ?= "device=$(GPU_UUID)"

# Host paths, relative to this Makefile. Docker -v bind mounts require
# absolute host paths, so the container mounts use the absolute variants.
HF_HOME               ?= ./model
DATA_DIR              ?= ../sample_data
HF_HOME_ABS           := $(abspath $(HF_HOME))
DATA_DIR_ABS          := $(abspath $(DATA_DIR))

CONTAINER             ?= Gemma4-E4B-QAT-W4A16
PORT                  ?= 9031

MODEL                 ?= google/gemma-4-E4B-it-qat-w4a16-ct
SERVED_NAME           ?= gemma-4-E4B-it-qat-w4a16-ct
DTYPE                 ?= auto

# Fixed KV-cache budget. --kv-cache-memory-bytes is authoritative for the KV
# allocation (it skips memory profiling). NOTE: vLLM still validates
# gpu_memory_utilization against free device memory at startup (measured:
# ValueError "Free memory ... less than desired GPU memory utilization"),
# so a small value must stay in the command; it does not change KV sizing.
GPU_MEM_UTIL          ?= 0.03

# bf16 KV pool sized so MAX_SEQS x MAX_LEN tokens stay resident (~19 KB/token
# bf16, so 6G covers 4 x 64K tokens with headroom).
KV_CACHE_BYTES        ?= 6G

# 64K context, residency-limited to 4 sequences so 4 x 65,536 tokens fit the
# 6G bf16 KV pool.
MAX_LEN               ?= 65536
MAX_SEQS              ?= 4
# 8192 gives the best KV tokens/GiB rate; 16384/32768/65536 shrink it.
MAX_BATCH_TOKENS      ?= 8192
SHM_SIZE              ?= 32g
SEED                  ?= 42

# KV cache dtype. Empty = bf16 KV (required for FA4 on SM90; fp8+FA4 is
# SM100-only, see ATTENTION_BACKEND comment). fp8_e4m3 needs a GPU with FP8
# KV support (H200 class).
KV_QUANT              ?=

# DEPRECATED: legacy single-backend selector, superseded by ATTENTION_CONFIG.
# Leave EMPTY: auto-selection applies.
# triton_attn is only needed while KV is fp8:
#   - auto-selection picks FlashInfer for the sliding-window layers and dies
#     with "NotImplementedError: FlashInfer backend on SM90 currently crashes
#     with sliding-window attention layers" (flashinfer.py, FP8-Q + SWA,
#     flashinfer issue #3578) at _initialize_kv_caches
#   - explicit FA4 is rejected: "kv_cache_dtype not supported"
#     (flash_attn.py supports_kv_cache_dtype: fp8 requires FA3 on SM90)
#   - forced FA3 dispatches the head_dim=512 global layers to FA4 CuTe, which
#     asserts "FP8 is only supported on SM100 (compute capability 10.x)"
ATTENTION_BACKEND     ?=

# Explicit attention config (JSON), applied only when set. Empty = vLLM
# auto-selects a legal backend for the local GPU.
# FA4 ({"backend":"FLASH_ATTN","flash_attn_version":4}) is Hopper-class
# (SM90+): on pre-Hopper GPUs it is rejected at startup — ValueError:
# Selected backend FLASH_ATTN is not valid for this configuration.
# Reason: ['head_size not supported'] (Gemma4's head sizes are outside FA4's
# supported set pre-Hopper). On SM90 with bf16 KV it is the fastest option.
ATTENTION_CONFIG      ?=

# Quantized linear GEMM kernel for W4A16: auto | machete | marlin.
# `emulation` is never acceptable; scripts/assert_vllm_kernels.sh enforces this.
# machete is rejected by vLLM for this checkpoint ("Failed to find a kernel
# that can implement the WNA16 linear layer"); explicit marlin measured within
# noise of auto (auto selects the same MarlinLinearKernel), so auto stays —
# less version-specific configuration risk.
LINEAR_BACKEND        ?= auto

# vLLM runtime performance mode: interactivity | balanced | throughput.
# Measured: all modes within noise at low concurrency. Default throughput
# (best average across context classes); `make start-interactive` switches
# to the interactivity profile.
PERFORMANCE_MODE      ?= throughput

# Prefix caching (default on; disable for cold-cache experiments).
ENABLE_PREFIX_CACHING ?= 1

# Gemma4 multimodal limits. Set all three to 0 for a text-only deployment.
LIMIT_MM_IMAGE        ?= 1
LIMIT_MM_AUDIO        ?= 0
LIMIT_MM_VIDEO        ?= 1

# Gemma4 image/video soft-token budget.
# Valid: 70, 140, 280, 560, 1120
VISION_SOFT_TOKENS    ?= 280

# Video frame budget (count and size).
VIDEO_FRAMES          ?= 64
VIDEO_WIDTH           ?= 224
VIDEO_HEIGHT          ?= 224 

# Speculative decoding:
#   none   = disabled (default; the baseline non-QAT MTP assistant is invalid
#            for this QAT target)
#   mtp    = Google's official Gemma4 assistant drafter (must be QAT-derived
#            for this QAT target; scripts/validate_vllm_config.sh enforces)
#   dflash = Z-Lab DFlash drafter
# Measured net-negative for this target beyond ~1-2K tokens of context (the
# draft's per-step cost scales with context), so SPEC_MODE=none stays.
# Deterministic outputs: MTP captures are token-identical among MTP configs;
# nospec diverges only by spec-batching numerics.
SPEC_MODE             ?= none
NUM_SPEC_TOKENS       ?= 1

MTP_DRAFT_MODEL       ?= google/gemma-4-E4B-it-assistant
DFLASH_DRAFT_MODEL    ?= google/gemma-4-E4B-it-assistant

# Gemma4 tool/reasoning chat template.
# vLLM docs say this template is included in the official container.
#CHAT_TEMPLATE         ?= examples/tool_chat_template_gemma4.jinja

.PHONY: setup start stop logs log-once status test test-text test-e2e download build restart validate-config start-interactive start-throughput assert-kernels benchmark-latency benchmark-long benchmark-throughput benchmark-mm benchmark-all

# Install everything needed to run: pull the image + download the model.
setup: build download

build:
	docker pull $(IMAGE)

validate-config:
	@MODEL="$(MODEL)" SPEC_MODE="$(SPEC_MODE)" MTP_DRAFT_MODEL="$(MTP_DRAFT_MODEL)" \
	  DFLASH_DRAFT_MODEL="$(DFLASH_DRAFT_MODEL)" NUM_SPEC_TOKENS="$(NUM_SPEC_TOKENS)" \
	  ./scripts/validate_vllm_config.sh

restart:
	$(MAKE) stop
	$(MAKE) start

# Latency-first alternative profile (interactivity + 4 resident sequences).
start-interactive:
	$(MAKE) start PERFORMANCE_MODE=interactivity MAX_SEQS=4

# Explicit throughput profile with 8 resident sequences (named for scripts/docs).
start-throughput:
	$(MAKE) start PERFORMANCE_MODE=throughput MAX_SEQS=8

start: validate-config
	docker rm -f $(CONTAINER) >/dev/null 2>&1 || true
	docker run -d --name $(CONTAINER) \
	  --label "host.pwd=$$PWD" \
	  --gpus $(GPU_DEVICE) --ipc=host --shm-size $(SHM_SIZE) \
	  --ulimit memlock=-1 --ulimit stack=67108864 \
	  --restart unless-stopped \
	  -p $(PORT):8000 \
	  -e HF_HOME=/hf \
	  -e HF_TOKEN="$(HF_TOKEN)" \
	  -e VLLM_CACHE_ROOT=/hf/vllm_cache \
	  -e CUDA_DEVICE_ORDER=PCI_BUS_ID \
	  -v $(HF_HOME_ABS):/hf \
	  -v $(DATA_DIR_ABS):/sample_data:ro \
	  $(IMAGE) \
	    --model "$(MODEL)" \
	    --served-model-name "$(SERVED_NAME)" \
	    --host 0.0.0.0 --port 8000 \
	    --api-key "$(API_KEY)" \
	    --dtype "$(DTYPE)" \
	    --gpu-memory-utilization "$(GPU_MEM_UTIL)" \
		$(if $(KV_CACHE_BYTES),--kv-cache-memory-bytes $(KV_CACHE_BYTES)) \
	    --max-model-len "$(MAX_LEN)" \
	    --max-num-seqs "$(MAX_SEQS)" \
	    --max-num-batched-tokens "$(MAX_BATCH_TOKENS)" \
		--skip-mm-profiling \
	    --tensor-parallel-size 1 \
		$(if $(ATTENTION_BACKEND),--attention-backend "$(ATTENTION_BACKEND)") \
		$(if $(ATTENTION_CONFIG),--attention-config '$(ATTENTION_CONFIG)') \
		--linear-backend "$(LINEAR_BACKEND)" \
		$(if $(filter 1 true yes,$(ENABLE_PREFIX_CACHING)),--enable-prefix-caching) \
	    --async-scheduling \
	    --reasoning-parser gemma4 \
	    --enable-auto-tool-choice \
	    --tool-call-parser gemma4 \
	    --trust-remote-code \
		--performance-mode "$(PERFORMANCE_MODE)" \
	    --optimization-level 3 \
	    --allowed-local-media-path /sample_data \
	    --structured-outputs-config '{"backend":"xgrammar"$(comma)"disable_any_whitespace":true$(comma)"enable_in_reasoning":true}' \
	    --mm-processor-kwargs '{"max_soft_tokens":$(VISION_SOFT_TOKENS)}' \
	    --limit-mm-per-prompt '{"image":$(LIMIT_MM_IMAGE)$(comma)"audio":0$(comma)"video":{"count":$(LIMIT_MM_VIDEO)$(comma)"num_frames":$(VIDEO_FRAMES)$(comma)"width":$(VIDEO_WIDTH)$(comma)"height":$(VIDEO_HEIGHT)}}' \
	    --media-io-kwargs '{"video":{"num_frames":$(VIDEO_FRAMES)}}' \
	    $(if $(filter dflash,$(SPEC_MODE)),--speculative-config '{"method":"dflash"$(comma)"model":"$(DFLASH_DRAFT_MODEL)"$(comma)"num_speculative_tokens":$(NUM_SPEC_TOKENS)}') \
	    $(if $(filter mtp,$(SPEC_MODE)),--speculative-config '{"method":"mtp"$(comma)"model":"$(MTP_DRAFT_MODEL)"$(comma)"num_speculative_tokens":$(NUM_SPEC_TOKENS)}') \
	    $(if $(KV_QUANT),--kv-cache-dtype $(KV_QUANT)) \
	    --seed $(SEED)

stop:
	docker rm -f $(CONTAINER)

assert-kernels:
	./scripts/assert_vllm_kernels.sh $(CONTAINER)

benchmark-latency:
	./scripts/benchmark_suite.sh --label "$(or $(LABEL),manual)" --cases "D1 D2"

benchmark-long:
	./scripts/benchmark_suite.sh --label "$(or $(LABEL),manual)" --cases "L1 L2"

benchmark-throughput:
	./scripts/benchmark_suite.sh --label "$(or $(LABEL),manual)" --cases "T1"

benchmark-mm:
	./scripts/benchmark_suite.sh --label "$(or $(LABEL),manual)" --cases "MM1 MM2"

benchmark-all:
	./scripts/benchmark_suite.sh --label "$(or $(LABEL),manual)"

logs:
	docker logs -f $(CONTAINER)

log-once:
	docker logs $(CONTAINER)

status:
	@echo "== $(CONTAINER) =="
	@docker ps --filter "name=$(CONTAINER)"
	@echo
	@curl -H "Authorization: Bearer $(API_KEY)" -s http://localhost:$(PORT)/v1/models | head -c 1200 | jq || true

test:
	OPENAI_BASE_URL=http://127.0.0.1:$(PORT)/v1 OPENAI_API_KEY=$(API_KEY) uv run --with openai smoke_test.py

test-text:
	curl -sS http://127.0.0.1:$(PORT)/v1/chat/completions \
	  -H "Authorization: Bearer $(API_KEY)" \
	  -H "Content-Type: application/json" \
	  -d '{"model":"$(SERVED_NAME)","messages":[{"role":"user","content":"Say one sentence about why H200 is good for vLLM."}],"max_tokens":128,"temperature":0}' | jq

test-e2e:
	uv run tests/test_e2e.py --base-url http://127.0.0.1:$(PORT) --api-key $(API_KEY)

# Draft models are only needed for speculative decoding; with the default
# SPEC_MODE=none only the target model is downloaded.
HF_CLI                ?= hf

download:
	mkdir -p $(HF_HOME)
	HF_HOME=$(HF_HOME_ABS) HF_TOKEN=$(HF_TOKEN) $(HF_CLI) download $(MODEL)
	$(if $(filter mtp,$(SPEC_MODE)),HF_HOME=$(HF_HOME_ABS) HF_TOKEN=$(HF_TOKEN) $(HF_CLI) download $(MTP_DRAFT_MODEL))
	$(if $(filter dflash,$(SPEC_MODE)),HF_HOME=$(HF_HOME_ABS) HF_TOKEN=$(HF_TOKEN) $(HF_CLI) download $(DFLASH_DRAFT_MODEL))
