# Parakeet TDT 0.6B v3 + ONNX Runtime CUDA. Serves the German Primeline ONNX
# model (Buttermilk03/parakeet-primeline-onnx) by default.
# Optional .env (seeded from .env.example by "make setup"):
# API_KEY, HF_TOKEN, DATA_DIR
-include .env
export HF_TOKEN

IMAGE          ?= parakeet-tdt-0.6b-v3-cuda
CONTAINER      ?= parakeet-primeline-de
PORT           ?= 8999

# Client-side compatibility only. The server does not validate Authorization
# headers.
API_KEY        ?= your-api-key

# FastAPI service source (single fixed model; refactored from the upstream
# parakeet-tdt-0.6b-v3-fastapi-openai project). Built directly from this tree.
APP_DIR        ?= app
DOCKERFILE     ?= Dockerfile.gpu

# Select the physical host GPU by nvidia-smi index, then pin Docker to UUID.
GPU_NO         ?= 0
GPU_UUID       := $(shell nvidia-smi --query-gpu=gpu_uuid --format=csv,noheader,nounits -i $(GPU_NO))
GPU_DEVICE     := device=$(GPU_UUID)

# Shared host-side cache layout.
HF_HOME         ?= /root/.cache/huggingface
# DEPRECATED: unused by this ONNX Runtime server (no vLLM); kept so the shared
# host cache layout matches the vLLM-based sibling projects.
VLLM_CACHE_ROOT ?= $(HF_HOME)/vllm_cache
# Test/bench assets, mounted read-only at /sample_data in the container. Must
# contain test/reference.{m4a,mp3,wav} — point it at the shared ../sample_data
# checkout (.env.example does).
DATA_DIR        ?= ./files

# The image runs as the non-root "parakeet" user and expects both HF_HOME and
# HF_HUB_CACHE at /app/models. Use a dedicated writable directory beneath the
# shared host HF root instead of mounting the complete root-owned HF cache.
MODEL_CACHE_DIR ?= $(HF_HOME)/parakeet-tdt-0.6b-v3
MODEL_CACHE_CTR ?= /app/models

# The service serves exactly this FP32 checkpoint; there is no model
# selection to configure. Do not use the INT8 checkpoint on GPU; upstream
# measurements found it substantially slower on CUDA.
MODEL            ?= Buttermilk03/parakeet-primeline-onnx
SERVED_NAME      ?= $(MODEL)

# VRAM-safe defaults: the ORT CUDA arena never shrinks and onnx-asr pads every
# batch to its longest sample, so keep padded batch cost bounded and hard-cap
# the arena. Benchmark before raising MAX_BATCH_SIZE or CHUNK_*_SEC again.
BATCHED          ?= 1
MAX_BATCH_SIZE   ?= 2
BATCH_WINDOW_MS  ?= 4
CHUNK_TARGET_SEC ?= 15
CHUNK_MAX_SEC    ?= 20
CHUNK_MIN_SEC    ?= 5
GPU_MEM_LIMIT_GIB ?= 6
ORT_INTRA_THREADS ?= 1
ORT_INTER_THREADS ?= 1
AUDIO_WORKERS    ?= 8
UVICORN_WORKERS  ?= 1

CONTAINER_PORT   ?= 5092
SHM_SIZE         ?= 32g
LOG_LEVEL        ?= info

# DEPRECATED: unused; the test/bench targets reference
# $(DATA_DIR)/test/reference.wav directly.
TEST_FILE        ?= $(DATA_DIR)/test/reference.wav
# DEPRECATED: unused; the clients hardcode response_format=json.
RESPONSE_FORMAT  ?= json

.PHONY: \
	setup env-init prepare build rebuild download \
	start stop restart logs log-once status health test test-python-client bench

setup: env-init prepare build

# Seed a local .env from the committed template on first setup; kept afterwards.
env-init:
	@if [ ! -f .env ]; then \
	  cp .env.example .env; \
	  echo "Created .env from .env.example - adjust values as needed."; \
	fi

prepare:
	mkdir -p "$(MODEL_CACHE_DIR)" "$(VLLM_CACHE_ROOT)" "$(DATA_DIR)"
	chmod a+rwx "$(MODEL_CACHE_DIR)"

build:
	docker build \
	  -f "$(APP_DIR)/$(DOCKERFILE)" \
	  -t "$(IMAGE)" \
	  "$(APP_DIR)"

rebuild:
	docker image rm -f "$(IMAGE)" >/dev/null 2>&1 || true
	docker build --no-cache \
	  -f "$(APP_DIR)/$(DOCKERFILE)" \
	  -t "$(IMAGE)" \
	  "$(APP_DIR)"

# Optional pre-download. The server also downloads the model automatically on
# first startup. HF_HUB_CACHE must equal MODEL_CACHE_DIR because the image sets
# both HF_HOME and HF_HUB_CACHE directly to /app/models.
download: prepare
	HF_HOME="$(MODEL_CACHE_DIR)" \
	HF_HUB_CACHE="$(MODEL_CACHE_DIR)" \
	HF_TOKEN="$(HF_TOKEN)" \
	uvx --from huggingface_hub hf download "$(MODEL)"
	chmod -R a+rwX "$(MODEL_CACHE_DIR)"

restart: stop start

start: prepare
	@test -n "$(GPU_UUID)" || \
	  (echo "GPU_NO=$(GPU_NO) is not available via nvidia-smi" >&2; exit 1)
	docker rm -f "$(CONTAINER)" >/dev/null 2>&1 || true
	docker run -d --name "$(CONTAINER)" \
	  --label "host.pwd=$$PWD" \
	  --gpus "$(GPU_DEVICE)" \
	  --ipc=host \
	  --shm-size="$(SHM_SIZE)" \
	  --ulimit memlock=-1 \
	  --ulimit stack=67108864 \
	  --restart unless-stopped \
	  -p "$(PORT):$(CONTAINER_PORT)" \
	  -e HF_HOME="$(MODEL_CACHE_CTR)" \
	  -e HF_HUB_CACHE="$(MODEL_CACHE_CTR)" \
	  -e HF_TOKEN="$(HF_TOKEN)" \
	  -e CUDA_DEVICE_ORDER=PCI_BUS_ID \
	  -e PARAKEET_HOST=0.0.0.0 \
	  -e PARAKEET_PORT="$(CONTAINER_PORT)" \
	  -e PARAKEET_USE_GPU=true \
	  -e PARAKEET_BATCHED="$(BATCHED)" \
	  -e PARAKEET_MAX_BATCH_SIZE="$(MAX_BATCH_SIZE)" \
	  -e PARAKEET_BATCH_WINDOW_MS="$(BATCH_WINDOW_MS)" \
	  -e PARAKEET_CHUNK_TARGET_SEC="$(CHUNK_TARGET_SEC)" \
	  -e PARAKEET_CHUNK_MAX_SEC="$(CHUNK_MAX_SEC)" \
	  -e PARAKEET_CHUNK_MIN_SEC="$(CHUNK_MIN_SEC)" \
	  -e PARAKEET_GPU_MEM_LIMIT_GIB="$(GPU_MEM_LIMIT_GIB)" \
	  -e PARAKEET_ORT_INTRA_THREADS="$(ORT_INTRA_THREADS)" \
	  -e PARAKEET_ORT_INTER_THREADS="$(ORT_INTER_THREADS)" \
	  -e PARAKEET_AUDIO_WORKERS="$(AUDIO_WORKERS)" \
	  -e PARAKEET_UVICORN_WORKERS="$(UVICORN_WORKERS)" \
	  -e LOG_LEVEL="$(LOG_LEVEL)" \
	  -v "$(MODEL_CACHE_DIR):$(MODEL_CACHE_CTR)" \
	  -v "$(DATA_DIR):/sample_data:ro" \
	  "$(IMAGE)"

stop:
	docker rm -f "$(CONTAINER)" >/dev/null 2>&1 || true

logs:
	docker logs -f "$(CONTAINER)"

log-once:
	docker logs "$(CONTAINER)"

status:
	@docker ps --filter "name=$(CONTAINER)"
	@curl -fsS "http://127.0.0.1:$(PORT)/health" | jq

health:
	curl -fsS "http://127.0.0.1:$(PORT)/healthz" | jq

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
	@echo "Running transcription benchmark (concurrency: 8, requests: 1)..."
	@uv run benchmark.py \
		--url http://127.0.0.1:$(PORT)/v1/audio/transcriptions \
		--file "$(DATA_DIR)/test/reference.wav" \
		--api-key "$(API_KEY)" \
		--model "$(SERVED_NAME)" \
		--language de \
		--clients 8 \
		--requests 1
