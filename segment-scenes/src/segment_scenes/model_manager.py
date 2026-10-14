from __future__ import annotations

import gc
import threading
import time
from contextlib import contextmanager
from pathlib import Path
from typing import Any, Callable, Iterator

from .config import ModelOffloading, Settings

ModelFactory = Callable[[str], Any]


class ModelManager:
    """Own one TransNetV2 instance and serialize its GPU lifecycle.

    Offloading moves weights to CPU; it does not destroy the model.  The next
    request moves the same instance back to the configured inference device.
    """

    def __init__(
        self,
        settings: Settings,
        *,
        model_factory: ModelFactory | None = None,
        torch_module: Any | None = None,
    ) -> None:
        settings.validate()
        self.settings = settings
        self._torch = torch_module
        self._model_factory = model_factory
        self._model: Any | None = None
        self._inference_model: Any | None = None
        self._target_device: str | None = None
        self._resident_device: str | None = None
        self._compiled = False
        self._busy = False
        self._ready = False
        self._last_used_monotonic: float | None = None
        self._last_used_epoch: float | None = None
        self._timer: threading.Timer | None = None
        self._timer_generation = 0
        self._lock = threading.RLock()
        self._request_lock = threading.Lock()

    def _get_torch(self) -> Any:
        if self._torch is None:
            import torch

            self._torch = torch
        return self._torch

    def _resolve_target_device(self) -> str:
        if self.settings.device != "auto":
            return self.settings.device
        torch = self._get_torch()
        return "cuda" if torch.cuda.is_available() else "cpu"

    def _build_default_factory(self) -> ModelFactory:
        model_path = Path(self.settings.model_path)
        if not model_path.is_file():
            raise FileNotFoundError(
                f"TransNetV2 weights not found at {model_path}; run `make download` first"
            )

        torch = self._get_torch()
        from transnetv2_pytorch import TransNetV2

        class VolumeBackedTransNetV2(TransNetV2):
            def _load_pretrained_weights(inner_self) -> None:
                state_dict = torch.load(model_path, map_location="cpu", weights_only=True)
                inner_self.load_state_dict(state_dict)

        return lambda device: VolumeBackedTransNetV2(device=device)

    @staticmethod
    def _set_model_device(model: Any, device: str, torch: Any) -> None:
        # transnetv2-pytorch stores a separate `.device` field in addition to
        # nn.Module parameters; both must move together.
        model.to(device)
        model.device = torch.device(device)

    def start(self) -> None:
        with self._lock:
            if self._ready:
                return
            self._target_device = self._resolve_target_device()
            initial_device = (
                self._target_device
                if self.settings.model_offloading is ModelOffloading.NEVER
                else "cpu"
            )
            factory = self._model_factory or self._build_default_factory()
            self._model = factory(initial_device)
            self._model.eval()
            self._resident_device = initial_device
            self._inference_model = self._model

            if self.settings.torch_compile:
                if self._target_device != "cuda":
                    raise RuntimeError("TORCH_COMPILE=1 requires a CUDA inference device")
                torch = self._get_torch()
                self._inference_model = torch.compile(
                    self._model,
                    mode=self.settings.torch_compile_mode,
                    dynamic=False,
                )
                self._compiled = True

            self._ready = True

    def close(self) -> None:
        # Do not drop weights while a request is still using them.
        with self._request_lock, self._lock:
            self._cancel_timer_locked()
            self._inference_model = None
            self._model = None
            self._resident_device = None
            self._ready = False
            self._compiled = False
        self._release_cuda_cache()

    def _cancel_timer_locked(self) -> None:
        self._timer_generation += 1
        if self._timer is not None:
            self._timer.cancel()
            self._timer = None

    def _release_cuda_cache(self) -> None:
        torch = self._get_torch()
        if hasattr(torch, "cuda") and torch.cuda.is_available():
            torch.cuda.empty_cache()
        gc.collect()

    def _move_to_target_locked(self) -> None:
        if self._model is None or self._target_device is None:
            raise RuntimeError("ModelManager has not been started")
        if self._resident_device == self._target_device:
            return
        self._set_model_device(self._model, self._target_device, self._get_torch())
        self._resident_device = self._target_device

    def _offload_locked(self) -> bool:
        if self._model is None or self._resident_device != "cuda" or self._busy:
            return False
        self._set_model_device(self._model, "cpu", self._get_torch())
        self._resident_device = "cpu"
        return True

    def offload_now(self) -> bool:
        with self._lock:
            self._cancel_timer_locked()
            changed = self._offload_locked()
        if changed:
            self._release_cuda_cache()
        return changed

    def _schedule_timeout_locked(self) -> None:
        self._cancel_timer_locked()
        generation = self._timer_generation
        timer = threading.Timer(
            self.settings.model_offloading_timeout,
            self._timeout_callback,
            args=(generation,),
        )
        timer.daemon = True
        self._timer = timer
        timer.start()

    def _timeout_callback(self, generation: int) -> None:
        changed = False
        with self._lock:
            if generation != self._timer_generation:
                return
            self._timer = None
            if self._last_used_monotonic is None:
                return
            idle = time.monotonic() - self._last_used_monotonic
            if idle + 1e-6 < self.settings.model_offloading_timeout:
                self._schedule_timeout_locked()
                return
            changed = self._offload_locked()
        if changed:
            self._release_cuda_cache()

    @contextmanager
    def model_session(self) -> Iterator[tuple[Any, str]]:
        """Yield the resident inference model under the single-request lock."""
        with self._request_lock:
            with self._lock:
                if not self._ready:
                    raise RuntimeError("ModelManager has not been started")
                self._cancel_timer_locked()
                self._busy = True
                self._move_to_target_locked()
                assert self._inference_model is not None
                assert self._target_device is not None
                leased_model = self._inference_model
                leased_device = self._target_device
            try:
                # State queries (especially /health) remain non-blocking while
                # the long-running inference uses the separate request lock.
                yield leased_model, leased_device
            finally:
                changed = False
                with self._lock:
                    self._busy = False
                    self._last_used_monotonic = time.monotonic()
                    self._last_used_epoch = time.time()
                    if self.settings.model_offloading is ModelOffloading.IMMEDIATE:
                        changed = self._offload_locked()
                    elif self.settings.model_offloading is ModelOffloading.TIMEOUT:
                        self._schedule_timeout_locked()
                if changed:
                    self._release_cuda_cache()

    def status(self) -> dict[str, Any]:
        with self._lock:
            return {
                "ready": self._ready,
                "model_loaded": self._model is not None,
                "model_in_vram": self._resident_device == "cuda",
                "resident_device": self._resident_device,
                "configured_device": self._target_device,
                "model_offloading": self.settings.model_offloading.value,
                "model_offloading_timeout": self.settings.model_offloading_timeout,
                "offload_scheduled": self._timer is not None,
                "busy": self._busy,
                "torch_compile": self.settings.torch_compile,
                "compiled": self._compiled,
                "last_used_at": self._last_used_epoch,
            }
