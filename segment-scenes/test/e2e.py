#!/usr/bin/env python3
"""Black-box contract test through run.sh -> HTTP -> mounted filesystem."""
from __future__ import annotations

import argparse
import json
import os
import re
import shutil
import subprocess
import tempfile
from pathlib import Path
from urllib.request import urlopen


REQUIRED_TOP_LEVEL = {
    "video",
    "model",
    "encoding",
    "decoding",
    "shots",
    "boundaries",
    "gpu_stats",
    "scene_keyframes",
    "scene_segments",
}


def _ffprobe(path: Path) -> dict:
    completed = subprocess.run(
        ["ffprobe", "-v", "error", "-show_streams", "-show_format", "-of", "json", str(path)],
        check=True,
        capture_output=True,
        text=True,
    )
    return json.loads(completed.stdout)


def _health() -> dict:
    host = os.environ.get("BIND_HOST", "127.0.0.1")
    port = os.environ.get("PORT", "8088")
    with urlopen(f"http://{host}:{port}/health", timeout=5) as response:
        return json.loads(response.read())


def _run_once(project: Path, demo: Path, output: Path) -> dict:
    completed = subprocess.run(
        [
            str(project / "run.sh"),
            "--quiet",
            "--output-dir",
            str(output),
            str(demo),
        ],
        cwd=project,
        check=True,
        capture_output=True,
        text=True,
        env=os.environ,
    )
    payload = json.loads(completed.stdout)
    assert REQUIRED_TOP_LEVEL <= payload.keys()
    assert payload["model"]["name"] == "TransNetV2"
    assert payload["model"]["impl"] == "transnetv2-pytorch"
    assert payload["encoding"] == {"fps": 1, "max_width_px": 640, "max_height_px": 448}
    assert payload["shots"]
    assert len(payload["scene_keyframes"]) == len(payload["shots"])
    assert len(payload["scene_segments"]) == len(payload["shots"])

    if os.environ.get("REQUIRE_GPU", "1") == "1" and os.environ.get("FFMPEG_ACCELERATION", "auto") != "cpu":
        assert payload["decoding"]["used_nvdec"] is True

    out_dirs = list(output.glob("out_demo_mp4_*"))
    assert len(out_dirs) == 1
    assert re.fullmatch(r"out_demo_mp4_[0-9a-f]{8}", out_dirs[0].name)
    manifest = list(out_dirs[0].glob("demo_*_scenes.json"))
    assert len(manifest) == 1
    assert json.loads(manifest[0].read_text()) == payload

    for item in payload["scene_keyframes"]:
        relative = Path(item["keyframe_file"])
        assert not relative.is_absolute() and ".." not in relative.parts
        path = out_dirs[0] / relative
        assert path.is_file() and path.stat().st_size > 0
        video_stream = next(stream for stream in _ffprobe(path)["streams"] if stream["codec_type"] == "video")
        assert int(video_stream["width"]) <= 640

    for item in payload["scene_segments"]:
        relative = Path(item["scene_file"])
        assert not relative.is_absolute() and ".." not in relative.parts
        path = out_dirs[0] / relative
        assert path.is_file() and path.stat().st_size > 0
        video_stream = next(stream for stream in _ffprobe(path)["streams"] if stream["codec_type"] == "video")
        assert int(video_stream["height"]) <= 448
        numerator, denominator = map(int, video_stream["avg_frame_rate"].split("/"))
        assert numerator / denominator <= 8.01
        assert abs(item["adjusted_start_time_s"] - (item["raw_start_time_s"] + 0.1)) < 1e-6

    return payload


def _run_fractional_fps(project: Path, demo: Path, output: Path) -> dict:
    """Fractional --fps end-to-end: service model, manifest, and encoded rate."""
    completed = subprocess.run(
        [
            str(project / "run.sh"),
            "--quiet",
            "--output-dir",
            str(output),
            "--fps",
            "0.5",
            str(demo),
        ],
        cwd=project,
        check=True,
        capture_output=True,
        text=True,
        env=os.environ,
    )
    payload = json.loads(completed.stdout)
    assert payload["encoding"]["fps"] == 0.5
    out_dirs = list(output.glob("out_demo_mp4_*"))
    assert len(out_dirs) == 1
    for item in payload["scene_segments"]:
        assert item["fps"] == 0.5
        path = out_dirs[0] / item["scene_file"]
        assert path.is_file() and path.stat().st_size > 0
        video_stream = next(stream for stream in _ffprobe(path)["streams"] if stream["codec_type"] == "video")
        numerator, denominator = map(int, video_stream["avg_frame_rate"].split("/"))
        rate = numerator / denominator
        # Sub-interval scenes (duration*fps < 1) are intentionally encoded at
        # 1fps by the zero-frame override; everything else must be exactly 0.5.
        expected = 1.0 if (item["end_time_s"] - item["adjusted_start_time_s"]) * 0.5 < 1 else 0.5
        assert abs(rate - expected) < 1e-6, f"expected {expected}fps, got {rate} ({path})"
    return payload


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--service", action="store_true", help="Run through the persistent service")
    parser.add_argument("--baseline", action="store_true", help="Compatibility alias")
    parser.add_argument("--repeat", type=int, default=2)
    args = parser.parse_args()
    if not (args.service or args.baseline):
        parser.error("one of --service/--baseline is required")

    project = Path(__file__).resolve().parents[1]
    data_dir = Path(os.environ.get("DATA_DIR", project.parent / "sample_data")).resolve()
    demo = Path(os.environ.get("DEMO_MP4", data_dir / "test" / "demo.mp4")).resolve()
    if not demo.is_file():
        raise SystemExit(f"demo.mp4 not found: {demo} (set DEMO_MP4)")
    if not demo.is_relative_to(data_dir):
        raise SystemExit(f"DEMO_MP4 must be inside DATA_DIR ({data_dir})")

    initial_health = _health()
    assert initial_health["status"] == "ok"
    assert initial_health["model_loaded"] is True

    root = Path(tempfile.mkdtemp(prefix="segment-scenes-e2e-", dir=data_dir))
    runs: list[dict] = []
    try:
        for index in range(args.repeat):
            runs.append(_run_once(project, demo, root / f"run-{index}"))
        expected_boundaries = runs[0]["boundaries"]["predicted_ms"]
        expected_count = len(runs[0]["shots"])
        assert all(run["boundaries"]["predicted_ms"] == expected_boundaries for run in runs)
        assert all(len(run["shots"]) == expected_count for run in runs)
        _run_fractional_fps(project, demo, root / "fps-fractional")
    finally:
        shutil.rmtree(root)

    final_health = _health()
    if final_health["model_offloading"] == "NEVER" and final_health["configured_device"] == "cuda":
        assert final_health["model_in_vram"] is True

    print(
        json.dumps(
            {
                "status": "ok",
                "demo": str(demo),
                "scene_count": expected_count,
                "repeat": args.repeat,
                "decoding": runs[0]["decoding"],
            }
        )
    )


if __name__ == "__main__":
    main()
