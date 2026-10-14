"""Pure-Python segmentation-math tests (no ffmpeg, no VAD model).

These cover the planning/normalization layer that turns speech intervals into a
contiguous, full-coverage segment plan. The VAD-dependent path is exercised in
test/container/ with the real Silero model.
"""
from __future__ import annotations

import numpy as np

from segment_temporal.cli import (
    Segment,
    _create_all_segments,
    _find_best_split_point,
    _find_silence_gaps,
    _force_split_segment,
    _normalize_planned_segments,
    _plan_segments,
)


def _contiguous(segs):
    for prev, cur in zip(segs, segs[1:]):
        assert abs(prev[2] - cur[1]) < 1e-4, f"gap/overlap between {prev} and {cur}"


def _covers(segs, duration):
    assert abs(segs[0][1]) < 1e-6, f"does not start at 0: {segs[0]}"
    assert abs(segs[-1][2] - duration) < 1e-4, f"does not reach duration: {segs[-1]}"


def test_full_coverage_single_speech():
    out = _normalize_planned_segments([(1, 1.0, 3.0, "speech")], 5.0, 1.0)
    _covers(out, 5.0)
    _contiguous(out)
    # There must be non_speech padding before and after the speech island.
    types = [t for _, _, _, t in out]
    assert types[0] == "non_speech" and types[-1] == "non_speech"
    assert "speech" in types


def test_short_island_absorbed_to_min_duration():
    segs = [
        (1, 0.0, 2.0, "non_speech"),
        (2, 2.0, 2.2, "speech"),  # 0.2s island, below min_duration=1.0
        (3, 2.2, 4.0, "non_speech"),
    ]
    out = _normalize_planned_segments(segs, 4.0, 1.0)
    _covers(out, 4.0)
    _contiguous(out)
    for _, s, e, _ in out:
        assert (e - s) >= 1.0 - 1e-6, f"segment below min_duration: {s}-{e}"


def test_empty_speech_yields_single_nonspeech():
    out = _create_all_segments([], 5.0, 1.0)
    assert len(out) == 1
    _covers(out, 5.0)
    assert out[0][3] == "non_speech"


def test_force_split_chunks_and_reason():
    seg = Segment(1, 0.0, 10.0, "non_speech")
    parts = _force_split_segment(seg, 4.0)
    assert len(parts) == 3
    assert parts[0].start_s == 0.0 and parts[-1].end_s == 10.0
    assert all(p.split_reason == "max_len" for p in parts)
    # Chunks are contiguous.
    for prev, cur in zip(parts, parts[1:]):
        assert abs(prev.end_s - cur.start_s) < 1e-9


def test_silence_gaps_and_best_split_point():
    # speech from 0-2 and 6-8 within [0,8] => silence gap [2,6]
    gaps = _find_silence_gaps([(0.0, 2.0), (6.0, 8.0)], 0.0, 8.0)
    assert gaps == [(2.0, 6.0)]
    point = _find_best_split_point(gaps, 0.0, 8.0, max_len_speech=4.0, min_duration=1.0)
    assert point is not None
    assert abs(point - 4.0) < 1e-6  # midpoint of [2,6], also == target 0+4
    left, right = point - 0.0, 8.0 - point
    assert left >= 1.0 and right >= 1.0


def test_normalize_idempotent():
    once = _normalize_planned_segments([(1, 0.0, 5.0, "non_speech")], 5.0, 1.0)
    twice = _normalize_planned_segments(once, 5.0, 1.0)
    assert once == twice


def test_plan_segments_without_limits_keeps_raw_segments():
    segs = [(1, 0.0, 90.0, "non_speech")]
    plan = _plan_segments(segs, np.zeros(0, dtype=np.float32), 16000, None, None, 0.5, 1.0, 90.0, False)
    assert len(plan) == 1
    assert plan[0].start_s == 0.0 and plan[0].end_s == 90.0
    assert plan[0].split_reason == "none"


def test_plan_segments_independent_video_limit():
    # Same input, modality-specific limits (dual-plan export): the video plan
    # force-splits at 60s while the unconstrained audio plan stays whole.
    segs = [(1, 0.0, 90.0, "non_speech")]
    y = np.zeros(0, dtype=np.float32)
    audio = _plan_segments(segs, y, 16000, None, None, 0.5, 1.0, 90.0, False)
    video = _plan_segments(segs, y, 16000, 60.0, 60.0, 0.5, 1.0, 90.0, False)
    assert len(audio) == 1
    assert [p.end_s for p in video] == [60.0, 90.0]
    assert all(p.split_reason == "max_len" for p in video)
    # Each plan re-indexes independently (filenames stay unique via start/end).
    assert [p.index for p in video] == [1, 2]


def test_plan_segments_empty_falls_back_to_full_coverage():
    plan = _plan_segments([], np.zeros(0, dtype=np.float32), 16000, None, None, 0.5, 1.0, 5.0, False)
    assert len(plan) == 1
    assert plan[0].start_s == 0.0 and plan[0].end_s == 5.0
