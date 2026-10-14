SHELL := /usr/bin/env bash
.DEFAULT_GOAL := help

include env-default
-include .env

export IMAGE NAME BIND_HOST PORT CONTAINER_PORT DATA_DIR MODELS_DIR MODEL_FILE MODEL_PATH
export ALLOWED_FILE_ROOTS DEVICE GPU_NO REQUIRE_GPU CPUS SHM_MEM_SIZE
export MODEL_OFFLOADING MODEL_OFFLOADING_TIMEOUT FFMPEG_ACCELERATION
export TORCH_COMPILE TORCH_COMPILE_MODE LOG_LEVEL SERVICE_START_TIMEOUT
export SEGMENT_SCENES_REQUEST_TIMEOUT

UV_CACHE_DIR ?= $(CURDIR)/.uv-cache
TMP_DIR ?= $(CURDIR)/tmp
FILE ?= /data/test/demo.mp4
DEMO_MP4 ?= $(abspath $(DATA_DIR))/test/demo.mp4
export UV_CACHE_DIR TMP_DIR DEMO_MP4

.PHONY: help setup build download start stop restart status logs health run
.PHONY: test unit e2e e2e-offloading e2e-all e2e-baseline benchmark lint check clean ensure-image ensure-model

help:
	@printf '%s\n' \
	  'make setup                         Create/update the local .venv via uv sync' \
	  'make build                         Build pinned NVDEC/NVENC service image' \
	  'make download                      Materialize model weights into ./model' \
	  'make start                         Start persistent service and wait for /health' \
	  'make stop                          Gracefully stop and remove the service container' \
	  'make restart                       Restart without rebuilding/reloading dependencies' \
	  'make status                        Show container and model residency status' \
	  'make logs                          Follow service logs' \
	  'make health                        Print /health JSON' \
	  'make run FILE=/data/test/demo.mp4  Call the HTTP-backed compatibility CLI' \
	  'make unit                          GPU-free host unit tests' \
	  'make e2e                           Current-contract + API E2E on demo.mp4' \
	  'make e2e-offloading                GPU E2E for NEVER/TIMEOUT/IMMEDIATE' \
	  'make benchmark                     Measure repeated warm-service demo calls' \
	  'make check                         Compile, unit tests, and lint'

setup:
	uv sync

build:
	IMAGE="$(IMAGE)" ./build.sh

download: ensure-image
	IMAGE="$(IMAGE)" MODELS_DIR="$(MODELS_DIR)" MODEL_FILE="$(MODEL_FILE)" ./download.sh --yes

ensure-image:
	@if ! docker image inspect "$(IMAGE)" >/dev/null 2>&1; then $(MAKE) build; fi

ensure-model: ensure-image
	@if [[ ! -s "$(MODELS_DIR)/$(MODEL_FILE)" ]]; then $(MAKE) download; fi

start: ensure-model
	./service.sh start

stop:
	./service.sh stop

restart:
	./service.sh restart

status:
	./service.sh status

logs:
	./service.sh logs

health:
	./service.sh health

run: start
	./run.sh "$(FILE)"

test: unit

unit:
	@echo "Running unit tests (no GPU required; heavy runtime modules are stubbed)..."
	@PYTHONPATH=src uv run --quiet --no-project --with-requirements requirements-test.txt python -m pytest -q

e2e: start
	PYTHONPATH=src uv run --quiet --no-project --with-requirements requirements-test.txt test/e2e.py --service

e2e-offloading: ensure-model
	PYTHONPATH=src uv run --quiet --no-project --with-requirements requirements-test.txt test/e2e_offloading.py

e2e-all: e2e e2e-offloading

benchmark: start
	@mkdir -p "$(TMP_DIR)"
	PYTHONPATH=src uv run --quiet --no-project scripts/benchmark_service.py \
	  --output "$(TMP_DIR)/benchmark.json"

# DEPRECATED: alias of e2e, kept for older invocation scripts.
e2e-baseline: e2e

lint:
	uv run --quiet --no-project --with ruff==0.16.1 ruff check src test

check:
	python3 -m compileall -q src test
	$(MAKE) unit
	$(MAKE) lint

clean:
	rm -rf "$(TMP_DIR)" .pytest_cache .ruff_cache .uv-cache
	find src test -type d -name __pycache__ -prune -exec rm -rf {} +
