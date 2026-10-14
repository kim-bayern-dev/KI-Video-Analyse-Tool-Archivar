from __future__ import annotations

import numpy as np

from parakeet_service import chunker


def _assert_valid_ranges(ranges, total_samples, max_size):
    previous_end = -1
    for start, end in ranges:
        assert 0 <= start < end <= total_samples
        assert end - start <= max_size
        assert start >= previous_end
        previous_end = end


def test_empty_audio_has_no_chunks():
    assert chunker.plan_chunk_ranges(np.empty(0, dtype=np.float32)) == []


def test_short_audio_bypasses_vad(monkeypatch):
    monkeypatch.setattr(
        chunker,
        "_detect_speech_segments",
        lambda _waveform: (_ for _ in ()).throw(AssertionError("VAD should not run")),
    )
    waveform = np.zeros(int(chunker.CHUNK_MAX_SECONDS * chunker.SAMPLE_RATE_HZ) - 1)
    assert chunker.plan_chunk_ranges(waveform) == [(0, waveform.size)]


def test_long_silence_skips_inference(monkeypatch):
    monkeypatch.setattr(chunker, "_detect_speech_segments", lambda _waveform: [])
    waveform = np.zeros(int((chunker.CHUNK_MAX_SECONDS + 10) * chunker.SAMPLE_RATE_HZ))
    assert chunker.plan_chunk_ranges(waveform) == []


def test_long_uninterrupted_speech_has_no_phantom_tail(monkeypatch):
    total_samples = int((chunker.CHUNK_MAX_SECONDS * 2.5) * chunker.SAMPLE_RATE_HZ)
    monkeypatch.setattr(
        chunker, "_detect_speech_segments", lambda _waveform: [(0, total_samples)]
    )
    ranges = chunker.plan_chunk_ranges(np.ones(total_samples, dtype=np.float32))
    max_size = int(chunker.CHUNK_MAX_SECONDS * chunker.SAMPLE_RATE_HZ)
    _assert_valid_ranges(ranges, total_samples, max_size)
    assert ranges[0][0] == 0
    assert ranges[-1][1] == total_samples
    assert all(end - start > 1 for start, end in ranges)


def test_extract_chunk_views_returns_shared_memory():
    waveform = np.arange(20, dtype=np.float32)
    views = chunker.extract_chunk_views(waveform, [(2, 8), (8, 12)])
    assert len(views) == 2
    assert np.shares_memory(waveform, views[0])
    assert views[0].flags.c_contiguous
