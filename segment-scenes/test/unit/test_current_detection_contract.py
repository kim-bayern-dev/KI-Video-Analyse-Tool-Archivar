from __future__ import annotations

import numpy as np

from segment_scenes.detectors import (
    _calculate_threshold_for_attempt,
    _force_split_at_max_len,
    _max_threshold_attempts,
    _pick_scenes,
    _validate_length_constraints,
)


def test_threshold_descent_is_stable():
    assert _calculate_threshold_for_attempt(0.5, 1) == 0.4
    assert _calculate_threshold_for_attempt(0.5, 100) == 0.01
    assert _max_threshold_attempts(0.5) == 18


def test_pick_scenes_preserves_current_boundary_semantics():
    probabilities = np.array([0.0, 0.1, 0.8, 0.7, 0.1, 0.0], dtype=np.float32)
    timestamps = np.arange(6, dtype=np.float64)

    scenes, cuts = _pick_scenes(probabilities, timestamps, thr=0.5, min_len_s=0.5)

    assert cuts == [2]
    assert [(scene["start_frame"], scene["end_frame"]) for scene in scenes] == [(0, 2), (2, 5)]
    assert [(scene["start_time"], scene["end_time"]) for scene in scenes] == [(0.0, 2.0), (2.0, 5.0)]
    assert all("ffmpeg_start" in scene and "ffmpeg_duration" in scene for scene in scenes)


def test_force_split_guarantees_max_len_without_losing_coverage():
    timestamps = np.linspace(0.0, 12.0, 121)
    probabilities = np.zeros(121, dtype=np.float32)
    scene = {
        "shot_id": 0,
        "start_frame": 0,
        "end_frame": 120,
        "start_time": 0.0,
        "end_time": 12.0,
        "duration_s": 12.0,
    }

    split = _force_split_at_max_len(timestamps, probabilities, scene, max_len=5.0, min_len=1.0, quiet=True)

    assert len(split) == 3
    assert split[0]["start_time"] == 0.0
    assert split[-1]["end_time"] == 12.0
    assert all(part["duration_s"] <= 5.0 for part in split)
    assert all(part["forced_split"] is True for part in split)


def test_invalid_max_len_is_ignored():
    assert _validate_length_constraints(min_len=1.0, max_len=None, quiet=True)
    assert not _validate_length_constraints(min_len=1.0, max_len=1.0, quiet=True)
