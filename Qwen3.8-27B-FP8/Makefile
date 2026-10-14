# -----------------------------------------------------------------------------
# Qwen3.8-27B-FP8 / vLLM nightly / NVIDIA H200
# -----------------------------------------------------------------------------
#
# Optimized for:
#   - single H200
#   - TP=1
#   - low-concurrency / interactive latency
#   - FP8 weights
#   - FP8 KV cache
#   - Qwen3.8 DFlash2 speculative decoding
#   - image + video input
#   - persistent Hugging Face + vLLM compile caches
#
# Load .env if present (API_KEY, HF_TOKEN, etc.)
-include .env


# -----------------------------------------------------------------------------
# Helpers
# -----------------------------------------------------------------------------

comma := ,


# -----------------------------------------------------------------------------
# Runtime image / source patchset
# -----------------------------------------------------------------------------

# Local image produced by `make build`.
IMAGE                 ?= local/vllm-openai:qwen38-h200-k0-prefix

# Unmodified comparison image used only by `make pull`.
UPSTREAM_IMAGE        ?= vllm/vllm-openai:nightly

# Exact upstream revision observed in the supplied nightly log:
#   0.26.1rc1.dev1133+gf94666b60
#
# The first patchset is the reference implementation linked from vLLM #53670.
# It stacks dynamic-K=0 support, the opt-in draft skip, and the conditional
# EAGLE last-hit-unit drop. The final patch fixes DFlash2 construction and
# unused vocabulary allocations (vLLM #53612 / PR #53662). Every revision is
# immutable; no moving PR ref is applied during the build.
VLLM_REPO             ?= https://github.com/vllm-project/vllm.git
VLLM_BASE_REF         ?= f94666b60d4c58ec0807d22c837cfae322a1dde9
VLLM_PATCH_REPO       ?= https://github.com/Suppressor72/vllm.git
VLLM_PATCH_HEAD       ?= 25a850e6db052ce83ba45a71822289be807c6ccb
VLLM_DFLASH2_PATCH_REPO ?= https://github.com/maithilijoshi20/vllm.git
VLLM_DFLASH2_PATCH_HEAD ?= fc316015ffe337b61498555e3ee983bc6304904b
VLLM_PATCHSET_ID      ?= qwen38-k0-prefix-dflash2-init-20260825
VLLM_PATCHSET         := \
	d6ea7d06438a0dcee56c6a77c5012b61fe8f5c11 \
	add9a446fd7570913e1d8569d62975d979ce2150 \
	d1f6c54a19d5fd50d0dad3212ef22762b08a6d6f \
	6b1388a6b028cd7b663f9c9df5e570303263b77d \
	8e6e83a0c04f0c0e14d4e013f0cf90a2d86bde43 \
	dfb6eeae7978d0a98dccc132832688986191735c \
	25a850e6db052ce83ba45a71822289be807c6ccb
VLLM_DFLASH2_PATCHSET := \
	fc316015ffe337b61498555e3ee983bc6304904b

# All patchset changes are Python-only, so reuse the compiled wheel belonging
# to VLLM_BASE_REF. This avoids recompiling CUDA/C++ while preserving ABI
# identity with the pinned nightly.
VLLM_USE_PRECOMPILED  ?= 1
CUDA_ARCH_LIST        ?= 9.0

API_KEY               ?= your-api-key


# -----------------------------------------------------------------------------
# GPU
# -----------------------------------------------------------------------------

GPU_NO                ?= 0
GPU_UUID              := $(shell nvidia-smi \
	--query-gpu=gpu_uuid \
	--format=csv,noheader,nounits \
	-i $(GPU_NO))

GPU_DEVICE            ?= device=$(GPU_UUID)

# Explicitly single-GPU / TP1.
TP_SIZE               ?= 1


# -----------------------------------------------------------------------------
# Persistent storage
# -----------------------------------------------------------------------------

HF_HOME               ?= ./model
VLLM_CACHE_ROOT       ?= $(HF_HOME)/vllm_cache
DATA_DIR              ?= ../sample_data


# -----------------------------------------------------------------------------
# Server
# -----------------------------------------------------------------------------

CONTAINER             ?= Qwen3.8-27B-FP8
BIND_ADDR             ?= 0.0.0.0
PORT                  ?= 8920

MODEL                 ?= Qwen/Qwen3.8-27B-FP8
SERVED_NAME           ?= Qwen3.8-27B-FP8
DTYPE                 ?= auto


# -----------------------------------------------------------------------------
# Context / scheduler
# -----------------------------------------------------------------------------

# Qwen3.8 native context: 262144.
# The default below runs close to the full window; 65536 (commented out)
# is a lighter alternative for this shared-H200 deployment.
MAX_LEN                ?= 256000

#MAX_LEN               ?= 65536

# Interactive workload / low concurrency.
MAX_SEQS              ?= 4

# Chunked-prefill scheduler budget.
MAX_BATCH_TOKENS      ?= 8192

SEED                  ?= 42


# -----------------------------------------------------------------------------
# GPU / KV memory
# -----------------------------------------------------------------------------

# IMPORTANT:
#
# --kv-cache-memory-bytes explicitly controls KV allocation.
#
# Current vLLM nevertheless still evaluates gpu_memory_utilization during
# the initial free-memory admission check. Therefore BOTH parameters are
# deliberately supplied.
#
# An H200 provides ~140 GiB total; 0.50 targets roughly half of it for the
# admission check, leaving several GiB of headroom on this shared GPU.
GPU_MEM_UTIL          ?= 0.50

# Explicit KV allocation, independent of GPU_MEM_UTIL for KV sizing.
KV_CACHE_MEMORY       ?= 28G

# H200 supports native FP8 KV.
KV_QUANT              ?= fp8_e4m3


# -----------------------------------------------------------------------------
# Speculative decoding
# -----------------------------------------------------------------------------

# DFlash2 parallel drafter.
SPEC_DECODE           ?= 1
DRAFT_MODEL           ?= incoai/Qwen3.8-27B-DFlash2
NUM_SPEC_TOKENS       ?= 7
SPEC_CONFIG           = {"method":"dflash"$(comma)"model":"$(DRAFT_MODEL)"$(comma)"num_speculative_tokens":$(NUM_SPEC_TOKENS)}


# -----------------------------------------------------------------------------
# Online serving benchmark
# -----------------------------------------------------------------------------

# Fixed-length random prompts make repeated runs directly comparable. The
# default is a single-stream decode benchmark; override BENCH_CONCURRENCY to
# measure aggregate throughput under load.
BENCH_INPUT_LEN       ?= 1024
BENCH_OUTPUT_LEN      ?= 1024
BENCH_RANGE_RATIO     ?= 0.0
BENCH_NUM_PROMPTS     ?= 16
BENCH_WARMUPS         ?= 2
BENCH_CONCURRENCY     ?= 1
BENCH_REQUEST_RATE    ?= inf
BENCH_SEED            ?= $(SEED)
BENCH_LABEL           ?= dflash2-k$(NUM_SPEC_TOKENS)
BENCH_RESULT_DIR      ?= $(CURDIR)/benchmarks

# -----------------------------------------------------------------------------
# Prefix caching
# -----------------------------------------------------------------------------

PREFIX_CACHING        ?= 1


# -----------------------------------------------------------------------------
# Multimodal
# -----------------------------------------------------------------------------

LIMIT_MM_IMAGE        ?= 1
LIMIT_MM_VIDEO        ?= 1

# Multimodal activation-profiling hints.
# These do NOT control runtime video sampling or resizing.
VIDEO_PROFILE_FRAMES  ?= 32
VIDEO_PROFILE_WIDTH   ?= 608
VIDEO_PROFILE_HEIGHT  ?= 448

VIDEO_FPS             ?= 1

# DEPRECATED: not referenced by any server flag; kept only as a note that
# vision preprocessing cost may need limiting.
#IMAGE_MAX_PIXELS      ?= 409600

# Profiling is safer for a shared GPU. Set to 1 only when you deliberately
# want to skip multimodal activation profiling at startup.
SKIP_MM_PROFILING     ?= 0


# -----------------------------------------------------------------------------
# Optional external chat template
# -----------------------------------------------------------------------------
#
# Empty => use the template shipped with Qwen3.8.
#
# Example:
#   make restart CHAT_TEMPLATE="$(CURDIR)/chat_template.jinja"

CHAT_TEMPLATE         ?=
CHAT_TEMPLATE_IN_CTR  ?= /chat_template.jinja


# -----------------------------------------------------------------------------
# Targets
# -----------------------------------------------------------------------------

.PHONY: \
	setup build pull start stop restart logs log-once status health \
	version image-info patch-info metrics mtp-metrics test download


# -----------------------------------------------------------------------------
# Setup
# -----------------------------------------------------------------------------

setup: build download


# -----------------------------------------------------------------------------
# Image
# -----------------------------------------------------------------------------

pull:
	docker pull "$(UPSTREAM_IMAGE)"

build:
	@set -eu; \
	build_root="$$(mktemp -d "$${TMPDIR:-/tmp}/vllm-patched.XXXXXX")"; \
	trap 'rm -rf "$$build_root"' EXIT INT TERM; \
	src="$$build_root/vllm"; \
	mkdir -p "$$src"; \
	git -C "$$src" init --quiet; \
	git -C "$$src" remote add upstream "$(VLLM_REPO)"; \
	git -C "$$src" fetch --quiet --depth=1 --filter=blob:none \
	  upstream "$(VLLM_BASE_REF)"; \
	git -C "$$src" checkout --quiet --detach "$(VLLM_BASE_REF)"; \
	git -C "$$src" remote add patchset "$(VLLM_PATCH_REPO)"; \
	git -C "$$src" fetch --quiet --depth=16 --filter=blob:none \
	  patchset "$(VLLM_PATCH_HEAD)"; \
	test "$$(git -C "$$src" rev-parse FETCH_HEAD)" = "$(VLLM_PATCH_HEAD)"; \
	for commit in $(VLLM_PATCHSET); do \
	  git -C "$$src" cat-file -e "$$commit^{commit}"; \
	  git -C "$$src" \
	    -c user.name='vLLM patch build' \
	    -c user.email='patch-build@localhost' \
	    cherry-pick --quiet "$$commit"; \
	done; \
	git -C "$$src" remote add dflash2-fix "$(VLLM_DFLASH2_PATCH_REPO)"; \
	git -C "$$src" fetch --quiet --depth=2 --filter=blob:none \
	  dflash2-fix "$(VLLM_DFLASH2_PATCH_HEAD)"; \
	test "$$(git -C "$$src" rev-parse FETCH_HEAD)" = "$(VLLM_DFLASH2_PATCH_HEAD)"; \
	for commit in $(VLLM_DFLASH2_PATCHSET); do \
	  git -C "$$src" cat-file -e "$$commit^{commit}"; \
	  git -C "$$src" \
	    -c user.name='vLLM patch build' \
	    -c user.email='patch-build@localhost' \
	    cherry-pick --quiet "$$commit"; \
	done; \
	patched_ref="$$(git -C "$$src" rev-parse HEAD)"; \
	DOCKER_BUILDKIT=1 docker build \
	  --target vllm-openai \
	  --tag "$(IMAGE)" \
	  --file "$$src/docker/Dockerfile" \
	  --build-arg VLLM_USE_PRECOMPILED="$(VLLM_USE_PRECOMPILED)" \
	  --build-arg VLLM_MERGE_BASE_COMMIT="$(VLLM_BASE_REF)" \
	  --build-arg VLLM_BUILD_COMMIT="$$patched_ref" \
	  --build-arg VLLM_IMAGE_TAG="$(IMAGE)" \
	  --build-arg torch_cuda_arch_list="$(CUDA_ARCH_LIST)" \
	  --label "ai.vllm.upstream-ref=$(VLLM_BASE_REF)" \
	  --label "ai.vllm.patchset=$(VLLM_PATCHSET_ID)" \
	  "$$src"


# -----------------------------------------------------------------------------
# Start / stop
# -----------------------------------------------------------------------------

start:
	@set -eu; \
	if [ -z "$(GPU_UUID)" ]; then \
		echo "ERROR: unable to resolve GPU index $(GPU_NO)"; \
		exit 1; \
	fi
	docker rm -f "$(CONTAINER)" >/dev/null 2>&1 || true
	docker run -d \
	  --name "$(CONTAINER)" \
	  --label "host.pwd=$$PWD" \
	  --gpus "$(GPU_DEVICE)" \
	  --ipc=host \
	  --ulimit memlock=-1 \
	  --ulimit stack=67108864 \
	  --restart unless-stopped \
	  -p "$(BIND_ADDR):$(PORT):8000" \
	  -e HF_HOME="$(HF_HOME)" \
	  -e HF_TOKEN="$(HF_TOKEN)" \
	  -e VLLM_CACHE_ROOT="$(VLLM_CACHE_ROOT)" \
	  -e CUDA_DEVICE_ORDER=PCI_BUS_ID \
	  -v "$(HF_HOME):$(HF_HOME)" \
	  -v "$(VLLM_CACHE_ROOT):$(VLLM_CACHE_ROOT)" \
	  -v "$(DATA_DIR):/sample_data:ro" \
	  $(if $(strip $(CHAT_TEMPLATE)),-v "$(abspath $(CHAT_TEMPLATE)):$(CHAT_TEMPLATE_IN_CTR):ro") \
	  "$(IMAGE)" \
	    --model "$(MODEL)" \
	    --served-model-name "$(SERVED_NAME)" \
	    --host 0.0.0.0 \
	    --port 8000 \
	    --api-key "$(API_KEY)" \
	    --tensor-parallel-size "$(TP_SIZE)" \
	    --dtype "$(DTYPE)" \
	    --gpu-memory-utilization "$(GPU_MEM_UTIL)" \
	    --kv-cache-memory-bytes "$(KV_CACHE_MEMORY)" \
	    --kv-cache-dtype "$(KV_QUANT)" \
	    --max-model-len "$(MAX_LEN)" \
	    --max-num-seqs "$(MAX_SEQS)" \
	    --max-num-batched-tokens "$(MAX_BATCH_TOKENS)" \
	    --reasoning-parser qwen3 \
	    --enable-auto-tool-choice \
	    --tool-call-parser qwen3_coder \
	    $(if $(filter 1,$(PREFIX_CACHING)),--enable-prefix-caching,--no-enable-prefix-caching) \
	    --performance-mode interactivity \
	    --optimization-level 3 \
	    --structured-outputs-config '{"backend":"xgrammar","disable_any_whitespace":true}' \
	    --allowed-local-media-path /sample_data \
	    --limit-mm-per-prompt '{"image":{"count":$(LIMIT_MM_IMAGE)}$(comma)"video":{"count":$(LIMIT_MM_VIDEO)$(comma)"num_frames":$(VIDEO_PROFILE_FRAMES)$(comma)"width":$(VIDEO_PROFILE_WIDTH)$(comma)"height":$(VIDEO_PROFILE_HEIGHT)}}' \
		--media-io-kwargs '{"video":{"fps":$(VIDEO_FPS)}}' \
	    $(if $(filter 1,$(SKIP_MM_PROFILING)),--skip-mm-profiling) \
	    $(if $(filter 1,$(SPEC_DECODE)),--speculative-config '$(SPEC_CONFIG)') \
	    $(if $(strip $(CHAT_TEMPLATE)),--chat-template "$(CHAT_TEMPLATE_IN_CTR)") \
	    --seed "$(SEED)"

stop:
	docker rm -f "$(CONTAINER)" >/dev/null 2>&1 || true

restart:
	$(MAKE) stop
	$(MAKE) start


# -----------------------------------------------------------------------------
# Logs / diagnostics
# -----------------------------------------------------------------------------

logs:
	docker logs -f "$(CONTAINER)"

log-once:
	docker logs "$(CONTAINER)"

status:
	@echo "== $(CONTAINER) =="
	@docker ps \
	  --filter "name=^/$(CONTAINER)$$" \
	  --format 'table {{.Names}}\t{{.Status}}\t{{.Ports}}'
	@echo
	@curl \
	  --fail \
	  --silent \
	  --show-error \
	  -H "Authorization: Bearer $(API_KEY)" \
	  "http://127.0.0.1:$(PORT)/v1/models" \
	  | jq

health:
	@curl \
	  --fail \
	  --silent \
	  --show-error \
	  "http://127.0.0.1:$(PORT)/health"
	@echo


# -----------------------------------------------------------------------------
# Version / image diagnostics
# -----------------------------------------------------------------------------

version:
	@docker run \
	  --rm \
	  --entrypoint python3 \
	  "$(IMAGE)" \
	  -c 'import torch, transformers, vllm; \
print("vLLM:", vllm.__version__); \
print("transformers:", transformers.__version__); \
print("torch:", torch.__version__); \
print("CUDA:", torch.version.cuda)'

image-info:
	@docker image inspect "$(IMAGE)" \
	  --format 'ID={{.Id}}'
	@docker image inspect "$(IMAGE)" \
	  --format '{{range .RepoDigests}}{{println .}}{{end}}'

patch-info:
	@docker image inspect "$(IMAGE)" \
	  --format 'upstream={{index .Config.Labels "ai.vllm.upstream-ref"}}'
	@docker image inspect "$(IMAGE)" \
	  --format 'patchset={{index .Config.Labels "ai.vllm.patchset"}}'


# -----------------------------------------------------------------------------
# Prometheus / speculative-decoding metrics
# -----------------------------------------------------------------------------

metrics:
	@curl \
	  --fail \
	  --silent \
	  --show-error \
	  "http://127.0.0.1:$(PORT)/metrics"

mtp-metrics:
	@curl \
	  --fail \
	  --silent \
	  --show-error \
	  "http://127.0.0.1:$(PORT)/metrics" \
	  | grep -E 'spec_decode_(num_)?(draft|accepted)_tokens' \
	  || true

# -----------------------------------------------------------------------------
# Online serving benchmark
# make bench BENCH_CONCURRENCY=4 BENCH_NUM_PROMPTS=32
# -----------------------------------------------------------------------------

bench:
	@mkdir -p "$(BENCH_RESULT_DIR)"
	@curl \
	  --fail \
	  --silent \
	  --show-error \
	  -H "Authorization: Bearer $(API_KEY)" \
	  "http://127.0.0.1:$(PORT)/v1/models" \
	  >/dev/null
	docker run --rm \
	  --network host \
	  --entrypoint vllm \
	  -e HF_HOME="$(HF_HOME)" \
	  -e HF_TOKEN="$(HF_TOKEN)" \
	  -v "$(HF_HOME):$(HF_HOME)" \
	  -v "$(abspath $(BENCH_RESULT_DIR)):/results" \
	  "$(IMAGE)" \
	    bench serve \
	    --backend openai-chat \
	    --host 127.0.0.1 \
	    --port "$(PORT)" \
	    --endpoint /v1/chat/completions \
	    --header "Authorization=Bearer $(API_KEY)" \
	    --model "$(SERVED_NAME)" \
	    --tokenizer "$(MODEL)" \
	    --dataset-name random \
	    --random-input-len "$(BENCH_INPUT_LEN)" \
	    --random-output-len "$(BENCH_OUTPUT_LEN)" \
	    --random-range-ratio "$(BENCH_RANGE_RATIO)" \
	    --num-prompts "$(BENCH_NUM_PROMPTS)" \
	    --num-warmups "$(BENCH_WARMUPS)" \
	    --max-concurrency "$(BENCH_CONCURRENCY)" \
	    --request-rate "$(BENCH_REQUEST_RATE)" \
	    --ignore-eos \
	    --seed "$(BENCH_SEED)" \
	    --save-result \
	    --result-dir /results \
	    --label "$(BENCH_LABEL)" \
	    --metadata \
	      patchset="$(VLLM_PATCHSET_ID)" \
	      speculative_method=dflash \
	      speculative_tokens="$(NUM_SPEC_TOKENS)" \
	      concurrency="$(BENCH_CONCURRENCY)" \
	      input_len="$(BENCH_INPUT_LEN)" \
	      output_len="$(BENCH_OUTPUT_LEN)"

# -----------------------------------------------------------------------------
# API smoke test
# -----------------------------------------------------------------------------

test:
	OPENAI_BASE_URL="http://127.0.0.1:$(PORT)/v1" \
	OPENAI_API_KEY="$(API_KEY)" \
	uv run --with openai smoke_test.py


# -----------------------------------------------------------------------------
# Model download
# -----------------------------------------------------------------------------

download:
	HF_HOME="$(HF_HOME)" hf download "$(MODEL)"
