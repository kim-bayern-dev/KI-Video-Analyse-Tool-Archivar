"""
GPU peak VRAM accounting helpers for segment-scenes.

A thin, dependency-light wrapper around torch.cuda's high-water-mark counters so
callers can reset the baseline at the start of a run and read the peak consumed
at the end. Used to surface "peak VRAM consumed" per detection run.

The reported peak is the true high-water mark since the last reset. Each detection
run resets the baseline at start, so the reported peak reflects that run; a resident
model's standing allocation becomes part of the baseline.

Keeps torch optional at import time so the module can be unit-tested without a
GPU (tests stub torch.cuda via sys.modules).
"""
from __future__ import annotations

try:
    import torch
except Exception:  # pragma: no cover - torch missing entirely
    torch = None

MB = 1024 * 1024


def is_available() -> bool:
    """True when a CUDA device is reachable through torch."""
    return torch is not None and torch.cuda.is_available()


def reset_peak() -> None:
    """
    Reset PyTorch's peak GPU memory counters. Call at the start of a detection
    run so the subsequent peak reflects that run only. No-op without CUDA.
    """
    if is_available():
        torch.cuda.reset_peak_memory_stats()


def peak_stats() -> dict:
    """
    Snapshot current + peak GPU memory for the active device.

    Returns a dict with: available, device, device_index, total_mb,
    allocated_mb, reserved_mb, peak_allocated_mb, peak_reserved_mb,
    peak_utilization_pct. When CUDA is unavailable returns {"available": False}.

    `peak_reserved_mb` (caching allocator high-water mark) is always >=
    `peak_allocated_mb`; both are reported so the number is unambiguous.
    """
    if not is_available():
        return {"available": False}

    i = torch.cuda.current_device()
    props = torch.cuda.get_device_properties(i)
    total = props.total_memory
    peak_reserved = torch.cuda.max_memory_reserved(i)
    return {
        "available": True,
        "device": torch.cuda.get_device_name(i),
        "device_index": int(i),
        "total_mb": int(total // MB),
        "allocated_mb": int(torch.cuda.memory_allocated(i) // MB),
        "reserved_mb": int(torch.cuda.memory_reserved(i) // MB),
        "peak_allocated_mb": int(torch.cuda.max_memory_allocated(i) // MB),
        "peak_reserved_mb": int(peak_reserved // MB),
        "peak_utilization_pct": round(100.0 * peak_reserved / total, 2) if total else 0.0,
    }
