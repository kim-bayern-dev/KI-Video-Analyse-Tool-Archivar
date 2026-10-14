SHELL := /usr/bin/env bash
.DEFAULT_GOAL := help

IMAGE ?= segment-temporal:latest
# In-container corpus path used as the CLI input argument. run.sh maps the host
# CORPUS_DIR onto container /data, so /data/test/demo.mp4 resolves to the corpus.
FILE ?= /data/test/demo.mp4
# Host-side corpus root (enumerated by the e2e harness) and its test subdir.
CORPUS_DIR ?= $(CURDIR)/../sample_data
TEST_DATA_DIR ?= $(CORPUS_DIR)/test
TMP_DIR ?= $(CURDIR)/tmp
# Model/weight cache lives in ./model (gitignored), mounted at /models.
MODELS_DIR ?= $(CURDIR)/model
GPU_NO ?= 0
CPUS ?= 8
WORKERS ?= 4
SHM_MEM_SIZE ?= 8g
REQUIRE_GPU ?= 1
SMOKE ?= demo.mp4 demo.wav demo.png
SMOKE_FLAGS := $(patsubst %,--pattern %,$(SMOKE))

export IMAGE FILE TEST_DATA_DIR CORPUS_DIR TMP_DIR MODELS_DIR GPU_NO CPUS WORKERS SHM_MEM_SIZE REQUIRE_GPU

.PHONY: help setup build download run test test-smoke unit unit-container lint check check-all clean

help:
	@printf '%s\n' \
	  'make setup                         Create/update the local .venv via uv sync' \
	  'make build                         Build the Docker image (pinned FFmpeg base)' \
	  'make download                      Cache the Silero ONNX model into MODELS_DIR' \
	  'make run FILE=/data/test/demo.mp4  Process one corpus file into ./tmp' \
	  'make test                          Build, download, then test every demo* format' \
	  'make test-smoke                    Test only the smoke set (demo.mp4, demo.wav, demo.png)' \
	  'make unit                          Host-side pure-Python unit tests (segmentation math, config)' \
	  'make unit-container                Container-side tests with REAL Silero VAD + ffmpeg' \
	  'make lint                          Run Ruff' \
	  'make check                         Compile + host unit tests + lint (no Docker/GPU)' \
	  'make check-all                     check + unit-container (needs image + GPU)' \
	  'make clean                         Remove ./tmp and Python caches'

setup:
	uv sync

build:
	IMAGE="$(IMAGE)" ./build.sh

download:
	IMAGE="$(IMAGE)" MODELS_DIR="$(MODELS_DIR)" ./download.sh --yes

run:
	@mkdir -p "$(TMP_DIR)"
	# OUTPUT_DIR redirects output to ./tmp for dev; unset it for the production
	# behavior (writes `out_...` next to the input, which the client globs).
	IMAGE="$(IMAGE)" OUTPUT_DIR="$(TMP_DIR)" MODELS_DIR="$(MODELS_DIR)" \
	GPU_NO="$(GPU_NO)" CPUS="$(CPUS)" WORKERS="$(WORKERS)" \
	SHM_MEM_SIZE="$(SHM_MEM_SIZE)" REQUIRE_GPU="$(REQUIRE_GPU)" \
	CORPUS_DIR="$(CORPUS_DIR)" \
	./run.sh "$(FILE)"

test: build download
	CORPUS_DIR="$(CORPUS_DIR)" TEST_DATA_DIR="$(TEST_DATA_DIR)" TMP_DIR="$(TMP_DIR)" \
	GPU_NO="$(GPU_NO)" REQUIRE_GPU="$(REQUIRE_GPU)" IMAGE="$(IMAGE)" \
	uv run test/e2e.py --all

# Smoke set, repeated 3x to assert determinism (no flakiness).
test-smoke: build download
	CORPUS_DIR="$(CORPUS_DIR)" TEST_DATA_DIR="$(TEST_DATA_DIR)" TMP_DIR="$(TMP_DIR)" \
	GPU_NO="$(GPU_NO)" REQUIRE_GPU="$(REQUIRE_GPU)" IMAGE="$(IMAGE)" \
	uv run test/e2e.py --smoke --repeat 3

unit:
	uv run test/run_unit.py

# Container-side tests with the REAL Silero VAD and the image's ffmpeg/ffprobe.
# test/ is mounted read-only; the package is baked into the image and the cached
# model is mounted from MODELS_DIR. GPU is attached so the NVENC encode path is
# exercised (decode is CPU by design; used_nvdec=false is asserted).
unit-container:
	@mkdir -p "$(TMP_DIR)"
	@GPU_UUID=$$(nvidia-smi --query-gpu=gpu_uuid --format=csv,noheader,nounits -i "$(GPU_NO)" 2>/dev/null | head -n1); \
	GPU_ARGS=; \
	if [ -n "$$GPU_UUID" ]; then GPU_ARGS="--gpus device=$$GPU_UUID -e NVIDIA_DRIVER_CAPABILITIES=compute,utility,video"; fi; \
	if [ "$(REQUIRE_GPU)" = "1" ] && [ -z "$$GPU_UUID" ]; then echo "REQUIRE_GPU=1 but GPU_NO=$(GPU_NO) unresolved" >&2; exit 1; fi; \
	docker run --rm \
	  --network none \
	  --shm-size "$(SHM_MEM_SIZE)" --cpus "$(CPUS)" $$GPU_ARGS \
	  --user "$$(id -u):$$(id -g)" \
	  -e TORCH_HOME=/models -e HOME=/tmp -e XDG_CACHE_HOME=/tmp/.cache \
	  -e NUMBA_CACHE_DIR=/tmp/numba-cache -e MPLCONFIGDIR=/tmp/matplotlib \
	  -v "$(MODELS_DIR):/models" -v "$(TMP_DIR):/output" -v "$(CURDIR)/test:/app/test:ro" \
	  --entrypoint python3 \
	  "$(IMAGE)" /app/test/container/run_tests.py

lint:
	uvx ruff@0.16.0 check src test

check:
	python3 -m compileall -q src test
	$(MAKE) unit
	$(MAKE) lint

check-all: check
	$(MAKE) unit-container

clean:
	rm -rf "$(TMP_DIR)" .pytest_cache .ruff_cache .venv
	find . -type d -name __pycache__ -prune -exec rm -rf {} +
