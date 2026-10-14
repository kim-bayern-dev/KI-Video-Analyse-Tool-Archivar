#!/usr/bin/env python3
"""Zero-frame regression test: fractional --fps must never yield empty scene clips.

Scenes shorter than one output frame interval (duration*fps < 1, e.g. <2s at
0.5fps) used to produce scene videos with no video stream at all — vLLM later
failed on them with "Could not open video stream" (400). The fix overrides the
encode rate to 1fps for those clips. This test runs the known-problematic
source (files/zero-frame-scene-source.mp4 — a 60s cut of the shared demo
video, which contains sub-interval scenes at 0.5fps) through the service and asserts every produced scene clip carries at
least one video frame, and that the override only touches sub-interval scenes.

Black-box, same contract style as e2e.py: run.sh -> HTTP -> mounted filesystem.
Requires the segment-scenes service (see Makefile) and ffmpeg/ffprobe on the host.
"""
from __future__ import annotations

import json
import os
import shutil
import subprocess
import tempfile
from pathlib import Path

from e2e import _ffprobe, _health

REQUEST_FPS = 0.5


def _video_stream(path: Path) -> dict:
    streams = _ffprobe(path)["streams"]
    return next((s for s in streams if s["codec_type"] == "video"), {})


def _frame_count(stream: dict) -> int:
    return int(stream.get("nb_frames") or 0)


def _rate(stream: dict) -> float:
    num, den = map(int, (stream.get("avg_frame_rate") or "0/0").split("/"))
    return num / den if den else 0.0


def main() -> None:
    project = Path(__file__).resolve().parents[1]
    asset = project / "files" / "zero-frame-scene-source.mp4"
    if not asset.is_file():
        raise SystemExit(f"test asset missing: {asset}")

    data_dir = Path(os.environ.get("DATA_DIR", project.parent / "sample_data")).resolve()

    health = _health()
    assert health["status"] == "ok" and health["model_loaded"] is True

    root = Path(tempfile.mkdtemp(prefix="segment-scenes-e2e-zeroframe-", dir=data_dir))
    try:
        # run.sh requires the input inside DATA_DIR — copy the repo asset in.
        demo = root / asset.name
        shutil.copyfile(asset, demo)

        completed = subprocess.run(
            [
                str(project / "run.sh"),
                "--quiet",
                "--output-dir",
                str(root / "out"),
                "--fps",
                str(REQUEST_FPS),
                str(demo),
            ],
            cwd=project,
            check=True,
            capture_output=True,
            text=True,
            env=os.environ,
        )
        payload = json.loads(completed.stdout)
        segments = payload["scene_segments"]
        assert segments, "no scene segments produced"

        out_dirs = list((root / "out").glob("out_*"))
        assert len(out_dirs) == 1
        out_dir = out_dirs[0]

        durations = [item["end_time_s"] - item["adjusted_start_time_s"] for item in segments]
        short = [d for d in durations if d * REQUEST_FPS < 1]
        assert short, (
            f"test no longer exercises the regression: shortest scene is "
            f"{min(durations):.2f}s, need < {1 / REQUEST_FPS:.1f}s at fps={REQUEST_FPS}"
        )

        for item, duration in zip(segments, durations):
            path = out_dir / item["scene_file"]
            assert path.is_file() and path.stat().st_size > 0, f"missing/empty clip: {path}"
            stream = _video_stream(path)
            frames = _frame_count(stream)
            assert stream, f"no video stream in {path.name} ({duration:.2f}s scene)"
            assert frames >= 1, f"zero-frame clip: {path.name} ({duration:.2f}s scene)"
            rate = _rate(stream)
            if duration * REQUEST_FPS < 1:
                assert abs(rate - 1.0) < 1e-6, (
                    f"override expected 1fps for {duration:.2f}s scene, got {rate} ({path.name})"
                )
            else:
                assert abs(rate - REQUEST_FPS) < 1e-6, (
                    f"expected {REQUEST_FPS}fps for {duration:.2f}s scene, got {rate} ({path.name})"
                )

        print(
            json.dumps(
                {
                    "status": "ok",
                    "scenes": len(segments),
                    "short_scenes": len(short),
                    "min_scene_duration_s": round(min(durations), 3),
                }
            )
        )
    finally:
        shutil.rmtree(root)


if __name__ == "__main__":
    main()
