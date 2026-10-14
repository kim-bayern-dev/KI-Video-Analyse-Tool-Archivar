#!/usr/bin/env python3
"""Measure repeated mounted-file calls against an already-running service."""
from __future__ import annotations

import argparse
import json
import os
import shutil
import subprocess
import tempfile
import time
from pathlib import Path
from statistics import mean, median
from urllib.request import urlopen


def health() -> dict:
    host = os.environ.get("BIND_HOST", "127.0.0.1")
    port = os.environ.get("PORT", "8088")
    with urlopen(f"http://{host}:{port}/health", timeout=5) as response:
        return json.loads(response.read())


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--repeat", type=int, default=3)
    parser.add_argument("--output", type=Path)
    args = parser.parse_args()
    if args.repeat < 1:
        parser.error("--repeat must be positive")

    project = Path(__file__).resolve().parents[1]
    data_dir = Path(os.environ.get("DATA_DIR", project.parent / "sample_data")).resolve()
    demo = Path(os.environ.get("DEMO_MP4", data_dir / "test" / "demo.mp4")).resolve()
    if not demo.is_file() or not demo.is_relative_to(data_dir):
        raise SystemExit(f"DEMO_MP4 must exist below DATA_DIR: {demo}")

    root = Path(tempfile.mkdtemp(prefix="segment-scenes-benchmark-", dir=data_dir))
    runs = []
    initial_health = health()
    try:
        for index in range(args.repeat):
            output = root / f"run-{index}"
            started = time.perf_counter()
            completed = subprocess.run(
                [str(project / "run.sh"), "--quiet", "--output-dir", str(output), str(demo)],
                cwd=project,
                check=True,
                capture_output=True,
                text=True,
                env=os.environ,
            )
            elapsed = time.perf_counter() - started
            payload = json.loads(completed.stdout)
            runs.append(
                {
                    "index": index,
                    "wall_seconds": round(elapsed, 6),
                    "scene_count": len(payload["shots"]),
                    "decoding": payload.get("decoding"),
                    "gpu_stats": payload.get("gpu_stats"),
                }
            )
    finally:
        shutil.rmtree(root)

    timings = [run["wall_seconds"] for run in runs]
    report = {
        "demo": str(demo),
        "repeat": args.repeat,
        "initial_health": initial_health,
        "final_health": health(),
        "runs": runs,
        "summary": {
            "first_seconds": timings[0],
            "warm_mean_seconds": round(mean(timings[1:] or timings), 6),
            "median_seconds": round(median(timings), 6),
            "min_seconds": min(timings),
            "max_seconds": max(timings),
        },
    }
    rendered = json.dumps(report, indent=2) + "\n"
    if args.output:
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output.write_text(rendered, encoding="utf-8")
    print(rendered, end="")


if __name__ == "__main__":
    main()
