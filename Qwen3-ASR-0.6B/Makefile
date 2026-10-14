-include .env

comma := ,

CONTAINER             ?= Qwen3-ASR-0.6B
AUDIO_IMAGE           ?= qwen3-asr-0.6b-audio
API_KEY               ?= your-api-key

# Memory tuning for the 0.6B model on a single 8 GB GPU: weights ~1.5G +
# fixed KV cache (KV_CACHE_SIZE) + CUDA graphs + CUDA context/kernels (~600M)
# + PyTorch allocator slack. --kv-cache-memory-bytes is authoritative for the
# KV allocation (it skips memory profiling); GPU_MEM_UTIL only has to pass
# vLLM's free-memory validation at startup, so it stays tiny.
GPU_MEM_UTIL          ?= 0.0025
TP                    ?= 1
GPU_NO                ?= 0
GPU_UUID              := $(shell nvidia-smi --query-gpu=gpu_uuid --format=csv,noheader,nounits -i $(GPU_NO) | paste -sd, -)

# "all" exposes every GPU. Prefer comma-separated GPU UUIDs when isolating GPUs.
GPU_DEVICE            ?= "device=$(GPU_UUID)"
# With fp8 KV (KV_QUANT below) at 57,344 B/token (28 layers x 8 kv heads x
# 128 head_dim x K+V), 1G holds ~18.7K tokens — 2 x MAX_LEN=4096 with ample
# margin. vLLM refuses to boot when KV capacity < max_model_len.
KV_CACHE_SIZE         ?= 1G

# Host paths, relative to this Makefile. Docker -v bind mounts require
# absolute host paths, so the container mounts use the absolute variants.
# The model dir is mounted at /hf in the container (HF_HOME=/hf); the shared
# test assets at /sample_data (read-only); ./cache holds the vLLM/flashinfer
# torch-compile caches (mounted over /root/.cache to speed up restarts).
HF_HOME               ?= ./model
DATA_DIR              ?= ../sample_data
VLLM_CACHE_DIR        ?= ./cache
VLLM_CACHE_DIR_CTR    ?= /root/.cache
HF_HOME_ABS           := $(abspath $(HF_HOME))
DATA_DIR_ABS          := $(abspath $(DATA_DIR))
VLLM_CACHE_DIR_ABS    := $(abspath $(VLLM_CACHE_DIR))

PORT                  ?= 8932
MODEL                 ?= Qwen/Qwen3-ASR-0.6B
SERVED_NAME           ?= Qwen3-ASR-0.6B
DTYPE                 ?= auto
LIMIT_MM_VIDEO        ?= 0

# absolute max: 65536 (model config max_position_embeddings)
MAX_LEN               ?= 4096
MAX_SEQS              ?= 2
SHM_SIZE              ?= 32g
SEED                  ?= 42
MAX_BATCH_TOKENS      ?= 2048
# KV cache quantization. fp8_e4m3 halves KV bytes (~57K vs ~115K B/token:
# 28 layers x 8 kv heads x 128 head_dim x K+V), so the 1G pool holds ~18.7K
# tokens instead of ~9.3K (2 x MAX_LEN=4096 only barely fits at bf16).
# fp8 KV is rejected by the flash_attn backend on this GPU (fp8 KV requires
# FA3 on SM90), hence ATTENTION_BACKEND=triton_attn below.
KV_QUANT              ?= fp8_e4m3

# Attention backend. triton_attn because it accepts fp8 KV cache (see KV_QUANT).
# Empty = auto-select (valid only with native KV dtype).
#
# Alternative configs for other GPUs (override on the command line):
#   GPU with enough VRAM for a bf16 KV pool (any arch):
#     make start ATTENTION_BACKEND=flash_attn KV_QUANT= KV_CACHE_SIZE=1G
#   Hopper (SM90, FA3 supports fp8 KV):
#     make start ATTENTION_BACKEND= KV_QUANT=fp8_e4m3   # auto-selects FA3
ATTENTION_BACKEND     ?= triton_attn

HF_CLI                ?= hf

.PHONY: setup start stop logs log-once status test test-streaming benchmark-streaming benchmark-batch download build-image restart

# Install everything needed to run: build the image + download the model.
setup: build-image download

build-image:
	docker build -t $(AUDIO_IMAGE) -f Dockerfile .

restart:
	$(MAKE) stop
	$(MAKE) start

start:
	docker rm -f $(CONTAINER) >/dev/null 2>&1 || true
	docker run -d --name $(CONTAINER) \
	  --label "host.pwd=$$PWD" \
	  --gpus $(GPU_DEVICE) --ipc=host --shm-size $(SHM_SIZE) \
	  -e NVIDIA_VISIBLE_DEVICES=$(GPU_UUID) \
	  --ulimit memlock=-1 --ulimit stack=67108864 \
	  --restart unless-stopped \
	  -p $(PORT):8000 \
	  -e HF_HOME=/hf \
	  -e HF_TOKEN="$(HF_TOKEN)" \
	  -e CUDA_DEVICE_ORDER=PCI_BUS_ID \
	  -v $(HF_HOME_ABS):/hf \
	  -v $(VLLM_CACHE_DIR_ABS):$(VLLM_CACHE_DIR_CTR) \
	  -v $(DATA_DIR_ABS):/sample_data:ro \
	  $(AUDIO_IMAGE) \
	    --model "$(MODEL)" \
	    --served-model-name "$(SERVED_NAME)" \
	    --tensor-parallel-size $(TP) \
	    --host 0.0.0.0 --port 8000 \
	    --api-key "$(API_KEY)" \
	    --dtype "$(DTYPE)" \
	    --kv-cache-memory-bytes $(KV_CACHE_SIZE) \
	    --gpu-memory-utilization "$(GPU_MEM_UTIL)" \
	    --max-model-len "$(MAX_LEN)" \
	    --max-num-seqs "$(MAX_SEQS)" \
	    --skip-mm-profiling \
	    --reasoning-parser qwen3 \
	    --enable-auto-tool-choice \
	    --tool-call-parser qwen3_coder \
	    --enable-prefix-caching \
		--performance-mode interactivity \
	    --optimization-level 3 \
	    --trust-remote-code \
		$(if $(ATTENTION_BACKEND),--attention-backend "$(ATTENTION_BACKEND)") \
	    --allowed-local-media-path /sample_data \
	    $(if $(KV_QUANT),--kv-cache-dtype $(KV_QUANT)) \
		--max-num-batched-tokens $(MAX_BATCH_TOKENS) \
	    --seed $(SEED)

stop:
	docker rm -f $(CONTAINER)

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
	@echo "Running verification test..."
	@pass=0; fail=0; \
	for ext in m4a mp3 wav; do \
		file="test/reference.$$ext"; \
		echo "Testing /sample_data/$$file"; \
		resp=$$(curl -s -X POST "http://localhost:$(PORT)/v1/chat/completions" \
			-H "Authorization: Bearer $(API_KEY)" \
			-H "Content-Type: application/json" \
			-d "{\"model\": \"$(SERVED_NAME)\", \"messages\": [{\"role\": \"user\", \"content\": [{\"type\": \"audio_url\", \"audio_url\": {\"url\": \"file:///sample_data/$$file\"}}]}]}"); \
		echo "Response: $$resp"; \
		if echo "$$resp" | grep -iq "referenz"; then \
			echo "PASS: 'referenz' found."; \
			pass=$$((pass+1)); \
		else \
			echo "FAIL: 'referenz' not found."; \
			fail=$$((fail+1)); \
		fi; \
	done; \
	echo "Results: $$pass PASSED, $$fail FAILED"; \
	if [ $$fail -gt 0 ]; then exit 1; fi

test-streaming:
	@echo "Running Python Test (OpenAI chat completions API with audio_url)..."
	@DATA_DIR="$(DATA_DIR)" uv run client-streaming.py -e http://127.0.0.1:$(PORT)/v1/chat/completions -f /sample_data/test/reference.wav

benchmark-streaming:
	@echo "Running Benchmark (Concurrency: 4, Requests: 20)..."
	@DATA_DIR="$(DATA_DIR)" uv run benchmark.py --mode streaming --url http://127.0.0.1:$(PORT)/v1/chat/completions --file /sample_data/test/reference.wav --clients 4 --requests 20

benchmark-batch:
	@echo "Running Batch Benchmark (Concurrency: 4, Requests: 20)..."
	@uv run benchmark.py --mode batch --url http://127.0.0.1:$(PORT)/v1/chat/completions --file /sample_data/test/reference.wav --clients 4 --requests 20

download:
	mkdir -p $(HF_HOME)
	HF_HOME=$(HF_HOME_ABS) HF_TOKEN=$(HF_TOKEN) $(HF_CLI) download $(MODEL)
