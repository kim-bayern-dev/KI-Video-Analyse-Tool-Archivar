"""Lightweight import stubs for host-side contract tests.

The real Torch/PyAV/TransNetV2 stack is exercised by the container tests.  Unit
tests deliberately stay runnable on a laptop and in CI without a GPU.
"""
from __future__ import annotations

import sys
import types


class _CudaStub:
    OutOfMemoryError = RuntimeError

    @staticmethod
    def is_available() -> bool:
        return False

    @staticmethod
    def empty_cache() -> None:
        return None

    @staticmethod
    def reset_peak_memory_stats() -> None:
        return None


torch = types.ModuleType("torch")
torch.cuda = _CudaStub()
torch.Tensor = object
torch.no_grad = lambda: __import__("contextlib").nullcontext()
sys.modules.setdefault("torch", torch)

av = types.ModuleType("av")
av.open = lambda *_args, **_kwargs: None
sys.modules.setdefault("av", av)

transnet = types.ModuleType("transnetv2_pytorch")


class _TransNetStub:
    pass


transnet.TransNetV2 = _TransNetStub
sys.modules.setdefault("transnetv2_pytorch", transnet)
