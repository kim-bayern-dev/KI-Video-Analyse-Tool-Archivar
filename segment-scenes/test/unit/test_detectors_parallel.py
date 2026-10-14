from __future__ import annotations

import time
from pathlib import Path

from segment_scenes.detectors import (
    cut_scene_segments,
    extract_scene_keyframe_pngs,
    extract_scene_keyframes,
)
from segment_scenes.ffmpeg_backend import FFmpegResult


class SlowFakeBackend:
    """Completes later shots first; manifests must keep scene order anyway."""

    CPU_RESULT = FFmpegResult(
        mode="CPU decode + CPU filters + CPU libx264",
        encoder="libx264",
        used_nvdec=False,
        used_nvenc=False,
    )

    def _delay(self, output_path: Path) -> None:
        shot_id = int(output_path.name.split("_", 1)[0])
        time.sleep(0.02 * (10 - shot_id))

    def cut_scene(self, _video_path, output_path, *, start, end, fps, max_height, bitrate):
        self._delay(output_path)
        output_path.parent.mkdir(parents=True, exist_ok=True)
        output_path.write_bytes(b"media")
        return self.CPU_RESULT

    def extract_image_frame(self, _video_path, output_path, *, timestamp, max_width, jpeg=False):
        self._delay(output_path)
        output_path.parent.mkdir(parents=True, exist_ok=True)
        output_path.write_bytes(b"frame")
        return self.CPU_RESULT


def _scenes(count: int = 6) -> list[dict]:
    return [
        {"shot_id": i, "start_time": float(i * 10), "end_time": float(i * 10 + 8)}
        for i in range(count)
    ]


def test_cut_scene_segments_preserve_scene_order_under_parallelism(tmp_path):
    video = tmp_path / "demo.mp4"
    video.write_bytes(b"video")

    result = cut_scene_segments(
        video,
        _scenes(),
        file_hash="deadbeef",
        output_dir=tmp_path / "out",
        quiet=True,
        fps=1,
        max_height_px=448,
        ffmpeg_backend=SlowFakeBackend(),
    )

    assert [entry["shot_id"] for entry in result] == list(range(6))
    assert len(result) == 6


def test_extract_scene_keyframe_pngs_preserve_scene_order_under_parallelism(tmp_path):
    video = tmp_path / "demo.mp4"
    video.write_bytes(b"video")

    result = extract_scene_keyframe_pngs(
        video,
        _scenes(),
        file_hash="deadbeef",
        output_dir=tmp_path / "out",
        quiet=True,
        max_width_px=640,
        ffmpeg_backend=SlowFakeBackend(),
    )

    assert [entry["shot_id"] for entry in result] == list(range(6))
    assert len(result) == 6


def test_extract_scene_keyframes_preserve_scene_order_under_parallelism(tmp_path):
    video = tmp_path / "demo.mp4"
    video.write_bytes(b"video")

    result = extract_scene_keyframes(
        video,
        _scenes(),
        file_hash="deadbeef",
        output_dir=tmp_path / "out",
        quiet=True,
        max_width_px=640,
        ffmpeg_backend=SlowFakeBackend(),
    )

    assert [entry["shot_id"] for entry in result] == list(range(6))
    assert len(result) == 6
