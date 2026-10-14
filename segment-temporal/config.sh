#!/usr/bin/env bash
# Shared configuration. Every value can be overridden through the environment.
#
# Override per invocation, e.g. GPU_NO=0 REQUIRE_GPU=0 for a CPU run.

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

export NAME="${NAME:-segment-temporal}"
export IMAGE="${IMAGE:-segment-temporal:latest}"
export CPUS="${CPUS:-8}"
export WORKERS="${WORKERS:-4}"
export GPU_NO="${GPU_NO:-1}"
export SHM_MEM_SIZE="${SHM_MEM_SIZE:-8g}"
export REQUIRE_GPU="${REQUIRE_GPU:-1}"
export MODELS_DIR="${MODELS_DIR:-${SCRIPT_DIR}/model}"
