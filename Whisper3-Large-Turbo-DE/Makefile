-include .env

comma := ,

# Base image built from the Dockerfile - override CTR_IMAGE to use a prebuilt image
CONTAINER             ?= Whisper3-Large-Turbo-DE
CTR_IMAGE             ?= vllm-openai-v0.24.0-ubuntu2404-audio
API_KEY               ?= your-api-key
ATTN_BACKEND 	      ?= "TRITON_ATTN"

# Minimal-VRAM configuration (weights + KV cache) - see the release README for measured values
# ==> Change this value depending on your GPU
GPU_MEM_UTIL          ?= 0.0185
GPU_NO                ?= 0
GPU_UUID              := $(shell nvidia-smi --query-gpu=gpu_uuid --format=csv,noheader,nounits -i $(GPU_NO))
GPU_DEVICE            ?= "device=$(GPU_UUID)"

HF_HOME               ?= ~/.cache/huggingface
VLLM_CACHE_DIR 	      ?= ./cache
VLLM_CACHE_DIR_CTR    ?= /root/.cache
DATA_DIR              ?= ./files

PORT                  ?= 8998
MODEL                 ?= primeline/whisper-large-v3-turbo-german
SERVED_NAME           ?= Whisper3-Large-Turbo-DE
DTYPE                 ?= auto

# DEPRECATED: unused - MoE tuning configs do not apply to Whisper (not a MoE
# model) and are not referenced anywhere in this Makefile.
MOE_CONFIG_DIR        ?= #$(CURDIR)/moe_configs
VLLM_MOE_CONFIG_DIR   ?= #/usr/local/lib/python3.12/dist-packages/vllm/model_executor/layers/fused_moe/configs

# DEPRECATED: unused - superseded by DATA_DIR; kept for reference only.
FILES_DIR             ?= files
TEST_URL_LIST         ?= https://raw.githubusercontent.com/kyr0/asr-sample-files/refs/heads/main/index.m3u

# Audio receptive field: 30 seconds per chunk
# Decoder context max length (448 is the model's maximum)
MAX_LEN               ?= 448
MAX_SEQS              ?= 8
# DEPRECATED: unused - not passed to the container.
MAX_MODEL_LEN_BYTES := $(shell echo $$((512 * 1024 * 1024)))
SHM_SIZE              ?= 32g
SEED                  ?= 42
# Encoder positions
MAX_BATCH_TOKENS      ?= 1500
KV_QUANT              ?= fp8_e4m3

.PHONY: setup start stop logs log-once status test-python-client test download build restart bench

setup: env-init build download

# Seed .env from the committed template on first setup.
env-init:
	@if [ ! -f .env ]; then cp .env.example .env && echo "Created .env from .env.example"; else echo ".env already exists, keeping it"; fi

build:
	docker build -t $(CTR_IMAGE) -f Dockerfile .

restart:
	$(MAKE) stop
	$(MAKE) start

start:
	docker rm -f $(CONTAINER) >/dev/null 2>&1 || true
	docker run -d --name $(CONTAINER) \
	  --label "host.pwd=$$PWD" \
	  --gpus $(GPU_DEVICE) --ipc=host --shm-size $(SHM_SIZE) \
	  --ulimit memlock=-1 --ulimit stack=67108864 \
	  --restart unless-stopped \
	  -p $(PORT):8000 \
	  -e HF_HOME="$(HF_HOME)" \
	  -e HF_TOKEN="$(HF_TOKEN)" \
	  -e CUDA_DEVICE_ORDER=PCI_BUS_ID \
	  -v $(HF_HOME):$(HF_HOME) \
	  -v $(VLLM_CACHE_DIR):$(VLLM_CACHE_DIR_CTR) \
	  -v $(DATA_DIR):/sample_data:ro \
	  $(CTR_IMAGE) \
	    --model "$(MODEL)" \
	    --served-model-name "$(SERVED_NAME)" \
	    --host 0.0.0.0 --port 8000 \
	    --api-key "$(API_KEY)" \
	    --dtype "$(DTYPE)" \
	    --gpu-memory-utilization "$(GPU_MEM_UTIL)" \
	    --max-model-len "$(MAX_LEN)" \
	    --max-num-seqs "$(MAX_SEQS)" \
		--attention-backend $(ATTN_BACKEND) \
	    --trust-remote-code \
	    --allowed-local-media-path /sample_data \
	    $(if $(KV_QUANT),--kv-cache-dtype $(KV_QUANT)) \
		--max-num-batched-tokens $(MAX_BATCH_TOKENS) \
	    --seed $(SEED)
	make logs
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

test: test-python-client
	@echo "Running verification test..."
	@pass=0; fail=0; \
	for ext in m4a mp3 wav; do \
		file="$(DATA_DIR)/test/reference.$$ext"; \
		echo "Testing $$file"; \
		resp=$$(curl -sS --fail-with-body \
			-X POST "http://localhost:$(PORT)/v1/audio/transcriptions" \
			-H "Authorization: Bearer $(API_KEY)" \
			-F "model=$(SERVED_NAME)" \
			-F "language=de" \
			-F "response_format=json" \
			-F "file=@$$file"); \
		echo "Response: $$resp"; \
		if echo "$$resp" | grep -iq "referenz"; then \
			echo "PASS: 'referenz' found."; pass=$$((pass+1)); \
		else \
			echo "FAIL: 'referenz' not found."; fail=$$((fail+1)); \
		fi; \
	done; \
	echo "Results: $$pass PASSED, $$fail FAILED"; \
	test $$fail -eq 0

test-python-client:
	@echo "Running Whisper transcription verification..."
	@uv run test-python-client.py \
		-e http://127.0.0.1:$(PORT)/v1/audio/transcriptions \
		-f "$(DATA_DIR)/test/reference.wav" \
		-k "$(API_KEY)" \
		-m "$(SERVED_NAME)" \
		--language de

bench:
	@echo "Running transcription benchmark..."
	@uv run benchmark.py \
		--url http://127.0.0.1:$(PORT)/v1/audio/transcriptions \
		--file "$(DATA_DIR)/test/reference.wav" \
		--api-key "$(API_KEY)" \
		--model "$(SERVED_NAME)" \
		--language de \
		--clients 8 \
		--requests 1

download:
	HF_HOME=$(HF_HOME) huggingface-cli download $(MODEL)
