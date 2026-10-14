"""Thread-safe loading of the Primeline ASR model into ONNX Runtime."""
from __future__ import annotations

import threading
from typing import Any, Dict, List

# Import config before ONNX Runtime so its thread-pool limits are active.
from .config import (
    GPU_DEVICE_INDEX,
    GPU_MEMORY_LIMIT_GIB,
    GPU_MODE,
    MODEL_ID,
    MODEL_QUANTIZATION,
    ORT_INTER_OP_THREADS,
    ORT_INTRA_OP_THREADS,
    SERVED_MODEL_NAME,
    logger,
)

import onnx_asr
import onnxruntime as ort

_MODEL_LOCK = threading.RLock()
_CACHED_MODEL: Any = None
_CUDA_LIBRARIES_PRELOADED = False


def _preload_cuda_runtime_libraries() -> bool:
    """Load CUDA/cuDNN libraries before creating any ORT session."""
    global _CUDA_LIBRARIES_PRELOADED
    if GPU_MODE not in {"true", "auto"}:
        return False
    if _CUDA_LIBRARIES_PRELOADED:
        return True
    with _MODEL_LOCK:
        if _CUDA_LIBRARIES_PRELOADED:
            return True
        preload = getattr(ort, "preload_dlls", None)
        if preload is None:
            if GPU_MODE == "true":
                raise RuntimeError(
                    "onnxruntime-gpu does not expose preload_dlls; install a "
                    "compatible ONNX Runtime GPU package"
                )
            return True
        try:
            # An empty directory explicitly prefers the NVIDIA runtime wheels
            # installed by the [cuda,cudnn] extra over potentially incompatible
            # system libraries.
            preload(cuda=True, cudnn=True, msvc=False, directory="")
            _CUDA_LIBRARIES_PRELOADED = True
            logger.info("Preloaded CUDA/cuDNN libraries for ONNX Runtime")
            return True
        except Exception as exc:
            if GPU_MODE == "true":
                raise RuntimeError("failed to preload CUDA/cuDNN libraries") from exc
            logger.warning("CUDA/cuDNN preload failed; using CPU fallback: %s", exc)
            return False


def _build_session_options() -> ort.SessionOptions:
    options = ort.SessionOptions()
    options.intra_op_num_threads = ORT_INTRA_OP_THREADS
    options.inter_op_num_threads = ORT_INTER_OP_THREADS
    options.execution_mode = ort.ExecutionMode.ORT_SEQUENTIAL
    options.graph_optimization_level = ort.GraphOptimizationLevel.ORT_ENABLE_ALL
    options.add_session_config_entry("session.set_denormal_as_zero", "1")
    options.add_session_config_entry("session.intra_op.allow_spinning", "1")
    options.add_session_config_entry("session.inter_op.allow_spinning", "0")
    return options


def _select_execution_providers() -> List[Any]:
    cuda_runtime_ready = _preload_cuda_runtime_libraries()
    available = set(ort.get_available_providers())
    cuda_available = cuda_runtime_ready and "CUDAExecutionProvider" in available

    if GPU_MODE == "true" and not cuda_available:
        raise RuntimeError(
            "PARAKEET_USE_GPU=true but CUDAExecutionProvider is unavailable; "
            f"available providers: {sorted(available)}"
        )
    if GPU_MODE == "false" or not cuda_available:
        return ["CPUExecutionProvider"]

    # Memory-safe CUDA options. The upstream defaults (EXHAUSTIVE cuDNN search,
    # maximum conv workspace, power-of-two arena growth) let the retained CUDA
    # arena ratchet up to several extra GiB over time; ORT's arena does not
    # shrink. kSameAsRequested tracks real allocation sizes, HEURISTIC + no max
    # workspace caps cuDNN scratch memory, and gpu_mem_limit hard-caps the arena.
    cuda_options: Dict[str, Any] = {
        "device_id": GPU_DEVICE_INDEX,
        "arena_extend_strategy": "kSameAsRequested",
        "cudnn_conv_algo_search": "HEURISTIC",
        "cudnn_conv_use_max_workspace": "0",
        "do_copy_in_default_stream": "1",
    }
    if GPU_MEMORY_LIMIT_GIB > 0:
        cuda_options["gpu_mem_limit"] = str(int(GPU_MEMORY_LIMIT_GIB * 1024**3))

    cuda_provider = ("CUDAExecutionProvider", cuda_options)
    return [cuda_provider] if GPU_MODE == "true" else [cuda_provider, "CPUExecutionProvider"]


def _report_session_providers(model: Any) -> Dict[str, List[str]]:
    bound_providers: Dict[str, List[str]] = {}
    candidates = [("model", model), ("asr", getattr(model, "asr", None))]
    for label, candidate in candidates:
        if candidate is None:
            continue
        for attribute in ("_model", "_encoder", "_decoder", "_decoder_joint"):
            session = getattr(candidate, attribute, None)
            get_providers = getattr(session, "get_providers", None)
            if callable(get_providers):
                bound_providers[f"{label}.{attribute}"] = list(get_providers())
    return bound_providers


def _assert_gpu_provider_binding(model: Any) -> None:
    bound_providers = _report_session_providers(model)
    if bound_providers:
        logger.info("Session providers for %s: %s", SERVED_MODEL_NAME, bound_providers)
    if GPU_MODE != "true":
        return
    if not bound_providers:
        raise RuntimeError(
            "PARAKEET_USE_GPU=true but ORT providers for "
            f"{SERVED_MODEL_NAME} could not be inspected"
        )
    if not all(
        providers
        and providers[0] in {"CUDAExecutionProvider", "TensorrtExecutionProvider"}
        for providers in bound_providers.values()
    ):
        raise RuntimeError(
            "PARAKEET_USE_GPU=true but "
            f"{SERVED_MODEL_NAME} did not bind all sessions to GPU: {bound_providers}"
        )


def load_asr_model():
    """Return the process-wide ASR model, loading it on first call.

    The single supported model is loaded once with timestamp support and
    cached; concurrent callers are serialized by the model lock.
    """
    global _CACHED_MODEL
    with _MODEL_LOCK:
        if _CACHED_MODEL is not None:
            return _CACHED_MODEL

        providers = _select_execution_providers()
        session_options = _build_session_options()
        logger.info(
            "Loading %s (quantization=%s) providers=%s intra_op=%d inter_op=%d",
            MODEL_ID,
            MODEL_QUANTIZATION,
            providers,
            ORT_INTRA_OP_THREADS,
            ORT_INTER_OP_THREADS,
        )
        model = onnx_asr.load_model(
            MODEL_ID,
            quantization=MODEL_QUANTIZATION,
            providers=providers,
            sess_options=session_options,
        ).with_timestamps()
        _assert_gpu_provider_binding(model)
        _CACHED_MODEL = model
        logger.info("Loaded %s", SERVED_MODEL_NAME)
        return model


def list_loaded_models() -> List[str]:
    with _MODEL_LOCK:
        return [SERVED_MODEL_NAME] if _CACHED_MODEL is not None else []
