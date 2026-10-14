"""Runtime configuration for the Parakeet Primeline transcription service.

Settings are read from ``PARAKEET_*`` environment variables and validated at
import time, so a misconfigured deployment fails before a model is downloaded
or GPU memory is allocated. The service serves exactly one ASR model — the
German Primeline export of Parakeet TDT 0.6B v3 — so there is intentionally
no model registry or model-switching logic.
"""
from __future__ import annotations

import logging
import os
import sys
from pathlib import Path
from typing import Iterable


# Numeric libraries must not grow their own thread pools next to ONNX Runtime,
# so cap them before NumPy/ONNX Runtime are imported by any other module.
for _thread_pool_var in (
    "OMP_NUM_THREADS",
    "MKL_NUM_THREADS",
    "OPENBLAS_NUM_THREADS",
    "NUMEXPR_NUM_THREADS",
    "VECLIB_MAXIMUM_THREADS",
):
    os.environ.setdefault(_thread_pool_var, "1")


def _read_int_setting(name: str, default: int, *, minimum: int = 1) -> int:
    raw_value = os.getenv(name)
    try:
        parsed = default if raw_value is None else int(raw_value)
    except ValueError as exc:
        raise RuntimeError(f"{name} must be an integer, got {raw_value!r}") from exc
    if parsed < minimum:
        raise RuntimeError(f"{name} must be >= {minimum}, got {parsed}")
    return parsed


def _read_float_setting(name: str, default: float, *, minimum: float = 0.0) -> float:
    raw_value = os.getenv(name)
    try:
        parsed = default if raw_value is None else float(raw_value)
    except ValueError as exc:
        raise RuntimeError(f"{name} must be numeric, got {raw_value!r}") from exc
    if parsed < minimum:
        raise RuntimeError(f"{name} must be >= {minimum}, got {parsed}")
    return parsed


def _read_bool_setting(name: str, default: bool) -> bool:
    raw_value = os.getenv(name)
    if raw_value is None:
        return default
    normalized = raw_value.strip().lower()
    if normalized in {"1", "true", "yes", "on"}:
        return True
    if normalized in {"0", "false", "no", "off"}:
        return False
    raise RuntimeError(f"{name} must be a boolean, got {raw_value!r}")


def _read_choice_setting(name: str, default: str, choices: Iterable[str]) -> str:
    allowed = {choice.lower() for choice in choices}
    selected = os.getenv(name, default).strip().lower()
    if selected not in allowed:
        raise RuntimeError(
            f"{name} must be one of {sorted(allowed)}, got {selected!r}"
        )
    return selected


# ---------------------------------------------------------------------------
# Served model (fixed)
# ---------------------------------------------------------------------------
# Exactly one model is supported: the German Primeline ONNX export of NVIDIA
# Parakeet TDT 0.6B v3. MODEL_ID is the Hugging Face repository that onnx-asr
# resolves and downloads; SERVED_MODEL_NAME is the value accepted in the
# OpenAI-compatible ``model`` form field (compared case-insensitively).
MODEL_ID = "Buttermilk03/parakeet-primeline-onnx"
SERVED_MODEL_NAME = MODEL_ID.lower()
MODEL_QUANTIZATION = None  # FP32 weights; no quantized variant is served.

# ---------------------------------------------------------------------------
# Paths & caches
# ---------------------------------------------------------------------------
ROOT_DIR = Path(__file__).resolve().parent.parent
MODELS_DIR = Path(os.getenv("PARAKEET_MODELS_DIR", ROOT_DIR / "models")).expanduser()
MODELS_DIR.mkdir(parents=True, exist_ok=True)

os.environ.setdefault("HF_HOME", str(MODELS_DIR))
os.environ.setdefault("HF_HUB_CACHE", str(MODELS_DIR))
os.environ.setdefault("HF_HUB_DISABLE_SYMLINKS_WARNING", "true")

# ---------------------------------------------------------------------------
# Execution device
# ---------------------------------------------------------------------------
GPU_MODE = _read_choice_setting("PARAKEET_USE_GPU", "true", {"auto", "true", "false"})
GPU_DEVICE_INDEX = _read_int_setting("PARAKEET_GPU_DEVICE_ID", 0, minimum=0)
# Hard ceiling for each ONNX Runtime CUDA arena, in GiB. 0 disables the cap.
# The arena does not shrink once grown, so without a limit retained (not live)
# memory keeps ratcheting up to the largest padded batch ever seen.
GPU_MEMORY_LIMIT_GIB = _read_float_setting(
    "PARAKEET_GPU_MEM_LIMIT_GIB", 0.0, minimum=0.0
)

# ---------------------------------------------------------------------------
# Audio decoding & VAD chunking
# ---------------------------------------------------------------------------
SAMPLE_RATE_HZ = 16_000

CHUNK_TARGET_SECONDS = _read_float_setting(
    "PARAKEET_CHUNK_TARGET_SEC", 60.0, minimum=0.1
)
CHUNK_MAX_SECONDS = _read_float_setting("PARAKEET_CHUNK_MAX_SEC", 75.0, minimum=0.1)
CHUNK_MIN_SECONDS = _read_float_setting("PARAKEET_CHUNK_MIN_SEC", 20.0, minimum=0.0)
if not CHUNK_MIN_SECONDS <= CHUNK_TARGET_SECONDS <= CHUNK_MAX_SECONDS:
    raise RuntimeError(
        "chunk durations must satisfy PARAKEET_CHUNK_MIN_SEC <= "
        "PARAKEET_CHUNK_TARGET_SEC <= PARAKEET_CHUNK_MAX_SEC"
    )

VAD_SPEECH_THRESHOLD = _read_float_setting("PARAKEET_VAD_THRESHOLD", 0.5, minimum=0.0)
if VAD_SPEECH_THRESHOLD > 1.0:
    raise RuntimeError("PARAKEET_VAD_THRESHOLD must be <= 1.0")
VAD_MIN_SILENCE_MS = _read_int_setting("PARAKEET_VAD_MIN_SILENCE_MS", 400, minimum=1)
VAD_SPEECH_PADDING_MS = _read_int_setting("PARAKEET_VAD_SPEECH_PAD_MS", 120, minimum=0)

# ---------------------------------------------------------------------------
# Inference batching
# ---------------------------------------------------------------------------
MICRO_BATCHING_ENABLED = _read_bool_setting("PARAKEET_BATCHED", GPU_MODE != "false")
MAX_MICRO_BATCH_SIZE = _read_int_setting("PARAKEET_MAX_BATCH_SIZE", 4)
MICRO_BATCH_WINDOW_MS = _read_float_setting(
    "PARAKEET_BATCH_WINDOW_MS", 4.0, minimum=0.0
)
INFERENCE_WORKERS = _read_int_setting("PARAKEET_INFER_WORKERS", 4)

# ---------------------------------------------------------------------------
# Request limits
# ---------------------------------------------------------------------------
MAX_UPLOAD_BYTES = _read_int_setting(
    "PARAKEET_MAX_UPLOAD_BYTES", 256 * 1024 * 1024, minimum=1
)
MAX_BATCH_FILES = _read_int_setting("PARAKEET_MAX_BATCH_FILES", 16)
MAX_BATCH_BYTES = _read_int_setting(
    "PARAKEET_MAX_BATCH_BYTES", 512 * 1024 * 1024, minimum=1
)
MAX_AUDIO_SECONDS = _read_float_setting(
    "PARAKEET_MAX_AUDIO_SECONDS", 2 * 60 * 60, minimum=1.0
)
MAX_REQUEST_CHUNKS = _read_int_setting("PARAKEET_MAX_REQUEST_CHUNKS", 512)
FFMPEG_TIMEOUT_SECONDS = _read_float_setting(
    "PARAKEET_FFMPEG_TIMEOUT_SEC", 180.0, minimum=1.0
)
UPLOAD_READ_CHUNK_BYTES = min(1024 * 1024, MAX_UPLOAD_BYTES)

# ---------------------------------------------------------------------------
# CPU topology & ONNX Runtime threading
# ---------------------------------------------------------------------------
try:
    _available_logical_cpus = len(os.sched_getaffinity(0))
except (AttributeError, OSError):
    _available_logical_cpus = os.cpu_count() or 1

try:
    import psutil  # type: ignore

    _physical_cpu_count = psutil.cpu_count(logical=False) or _available_logical_cpus
except Exception:
    _physical_cpu_count = _available_logical_cpus

_default_intra_op_threads = (
    1 if GPU_MODE != "false" else min(_physical_cpu_count, _available_logical_cpus)
)
ORT_INTRA_OP_THREADS = _read_int_setting(
    "PARAKEET_ORT_INTRA_THREADS", _default_intra_op_threads
)
ORT_INTER_OP_THREADS = _read_int_setting("PARAKEET_ORT_INTER_THREADS", 1)
AUDIO_DECODE_WORKERS = _read_int_setting(
    "PARAKEET_AUDIO_WORKERS", min(8, _physical_cpu_count)
)

# ---------------------------------------------------------------------------
# Logging
# ---------------------------------------------------------------------------
LOG_LEVEL = os.getenv("LOG_LEVEL", "INFO").upper()
logging.basicConfig(
    level=LOG_LEVEL,
    format="%(asctime)s  %(levelname)-7s  %(name)s: %(message)s",
    stream=sys.stdout,
)
logger = logging.getLogger("parakeet_primeline")

CPU_THREAD_LAYOUT = {
    "physical": _physical_cpu_count,
    "logical": _available_logical_cpus,
    "ort_intra": ORT_INTRA_OP_THREADS,
    "ort_inter": ORT_INTER_OP_THREADS,
    "audio_workers": AUDIO_DECODE_WORKERS,
}
