"""Pause-aware audio chunking with strict size invariants."""
from __future__ import annotations

import threading
from typing import List, Tuple

from .config import (
    CHUNK_MAX_SECONDS,
    CHUNK_MIN_SECONDS,
    CHUNK_TARGET_SECONDS,
    SAMPLE_RATE_HZ,
    VAD_MIN_SILENCE_MS,
    VAD_SPEECH_PADDING_MS,
    VAD_SPEECH_THRESHOLD,
    logger,
)

import numpy as np

SampleRange = Tuple[int, int]
_vad_backend = None
_vad_load_lock = threading.Lock()
_vad_inference_lock = threading.Lock()


def _load_vad_backend():
    global _vad_backend
    if _vad_backend is not None:
        return _vad_backend
    with _vad_load_lock:
        if _vad_backend is not None:
            return _vad_backend
        try:
            from silero_vad import load_silero_vad  # type: ignore

            _vad_backend = load_silero_vad(onnx=True)
            logger.info("Loaded Silero VAD (ONNX backend)")
        except Exception as exc:
            logger.warning(
                "Silero VAD unavailable (%s); falling back to energy VAD", exc
            )
            _vad_backend = "energy"
    return _vad_backend


def _detect_speech_segments(waveform: np.ndarray) -> List[SampleRange]:
    """Return speech spans as half-open sample ranges."""
    backend = _load_vad_backend()
    if backend == "energy":
        return _detect_speech_segments_by_energy(waveform)

    from silero_vad import get_speech_timestamps  # type: ignore
    import torch

    waveform_tensor = torch.from_numpy(waveform)
    # Silero resets internal state during timestamp extraction, so serialize
    # access to the shared singleton backend across preprocessing threads.
    with _vad_inference_lock:
        timestamps = get_speech_timestamps(
            waveform_tensor,
            backend,
            sampling_rate=SAMPLE_RATE_HZ,
            threshold=VAD_SPEECH_THRESHOLD,
            min_silence_duration_ms=VAD_MIN_SILENCE_MS,
            speech_pad_ms=VAD_SPEECH_PADDING_MS,
            return_seconds=False,
        )
    return [(int(item["start"]), int(item["end"])) for item in timestamps]


def _detect_speech_segments_by_energy(waveform: np.ndarray) -> List[SampleRange]:
    """Cheap RMS-based fallback when Silero is unavailable."""
    frame_length = max(1, int(0.02 * SAMPLE_RATE_HZ))
    if waveform.size < frame_length:
        return [(0, waveform.size)] if np.any(np.abs(waveform) > 1e-4) else []

    frame_count = waveform.size // frame_length
    frames = waveform[: frame_count * frame_length].reshape(frame_count, frame_length)
    rms_values = np.sqrt((frames * frames).mean(axis=1) + 1e-12)
    speech_floor = max(1e-3, float(rms_values.mean()) * 0.4)
    voiced_frames = rms_values > speech_floor
    min_silence_frames = max(1, int(VAD_MIN_SILENCE_MS / 20))

    segments: List[SampleRange] = []
    index = 0
    while index < frame_count:
        if not voiced_frames[index]:
            index += 1
            continue
        start_frame = index
        cursor = index
        silent_run = 0
        while cursor < frame_count:
            if voiced_frames[cursor]:
                silent_run = 0
            else:
                silent_run += 1
                if silent_run >= min_silence_frames:
                    break
            cursor += 1
        end_frame = max(start_frame + 1, min(cursor - silent_run, frame_count))
        segments.append(
            (start_frame * frame_length, min(end_frame * frame_length, waveform.size))
        )
        index = max(cursor, index + 1)
    return segments


def _clamp_and_merge_segments(
    segments: List[SampleRange], total_samples: int
) -> List[SampleRange]:
    merged: List[SampleRange] = []
    for start, end in sorted(segments):
        clamped_start = min(total_samples, max(0, int(start)))
        clamped_end = min(total_samples, max(clamped_start, int(end)))
        if clamped_end <= clamped_start:
            continue
        if merged and clamped_start <= merged[-1][1]:
            previous_start, previous_end = merged[-1]
            merged[-1] = (previous_start, max(previous_end, clamped_end))
        else:
            merged.append((clamped_start, clamped_end))
    return merged


def _split_oversized_range(
    start: int, end: int, target_size: int, max_size: int
) -> List[SampleRange]:
    """Split one non-empty range while guaranteeing every part <= max_size."""
    if end <= start:
        return []
    pieces: List[SampleRange] = []
    cursor = start
    while end - cursor > max_size:
        cut = min(end, cursor + target_size)
        if cut <= cursor:
            cut = min(end, cursor + max_size)
        pieces.append((cursor, cut))
        cursor = cut
    if end > cursor:
        pieces.append((cursor, end))
    return pieces


def plan_chunk_ranges(waveform: np.ndarray) -> List[SampleRange]:
    """Return ordered, non-empty, bounded ranges into the original waveform.

    Short clips bypass VAD. Long clips with no detected speech return no
    ranges, allowing the API to skip expensive ASR inference for silence.
    """
    total_samples = int(waveform.size)
    if total_samples <= 0:
        return []

    target_size = max(1, int(CHUNK_TARGET_SECONDS * SAMPLE_RATE_HZ))
    max_size = max(target_size, int(CHUNK_MAX_SECONDS * SAMPLE_RATE_HZ))
    min_size = max(0, int(CHUNK_MIN_SECONDS * SAMPLE_RATE_HZ))
    if total_samples <= max_size:
        return [(0, total_samples)]

    segments = _clamp_and_merge_segments(
        _detect_speech_segments(waveform), total_samples
    )
    if not segments:
        return []

    packed: List[SampleRange] = []
    current_start, current_end = segments[0]
    for start, end in segments[1:]:
        if end - current_start <= target_size:
            current_end = end
            continue

        if current_end - current_start >= min_size:
            cut = min(total_samples, max(current_end, (current_end + start) // 2))
            if cut > current_start:
                packed.append((current_start, cut))
            current_start = cut
            current_end = end
        else:
            current_end = end

    if current_end > current_start:
        packed.append((current_start, current_end))

    bounded: List[SampleRange] = []
    for start, end in packed:
        bounded.extend(_split_oversized_range(start, end, target_size, max_size))

    # Defensive invariant filter: malformed VAD output must never reach ORT.
    return [
        (start, end)
        for start, end in bounded
        if 0 <= start < end <= total_samples and end - start <= max_size
    ]


def extract_chunk_views(
    waveform: np.ndarray, ranges: List[SampleRange]
) -> List[np.ndarray]:
    """Return zero-copy contiguous views for the selected ranges."""
    return [waveform[start:end] for start, end in ranges if end > start]
