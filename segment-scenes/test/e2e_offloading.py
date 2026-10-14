#!/usr/bin/env python3
"""GPU E2E for NEVER, TIMEOUT, and IMMEDIATE model residency policies."""
from __future__ import annotations

import json
import os
import subprocess
import tempfile
import time
from pathlib import Path
from urllib.request import urlopen


def _health(port: int) -> dict:
    with urlopen(f"http://127.0.0.1:{port}/health", timeout=5) as response:
        return json.loads(response.read())


def _wait_for(port: int, predicate, timeout: float = 15.0) -> dict:
    deadline = time.monotonic() + timeout
    last = None
    while time.monotonic() < deadline:
        last = _health(port)
        if predicate(last):
            return last
        time.sleep(0.25)
    raise AssertionError(f"health predicate timed out; last={last}")


def main() -> None:
    project = Path(__file__).resolve().parents[1]
    data_dir = Path(os.environ.get("DATA_DIR", project.parent / "sample_data")).resolve()
    models_dir = Path(os.environ.get("MODELS_DIR", project / "model")).resolve()
    demo = Path(os.environ.get("DEMO_MP4", data_dir / "test" / "demo.mp4")).resolve()
    if not demo.is_file() or not demo.is_relative_to(data_dir):
        raise SystemExit(f"DEMO_MP4 must exist below DATA_DIR: {demo}")

    image = os.environ.get("IMAGE", "segment-scenes:latest")
    gpu_no = os.environ.get("GPU_NO", "0")
    results = {}
    for index, mode in enumerate(("NEVER", "TIMEOUT", "IMMEDIATE")):
        name = f"segment-scenes-e2e-offloading-{mode.lower()}"
        port = 18088 + index
        make_vars = [
            f"NAME={name}",
            f"PORT={port}",
            f"IMAGE={image}",
            f"DATA_DIR={data_dir}",
            f"MODELS_DIR={models_dir}",
            f"GPU_NO={gpu_no}",
            "REQUIRE_GPU=1",
            f"MODEL_OFFLOADING={mode}",
            "MODEL_OFFLOADING_TIMEOUT=2",
        ]
        environment = {
            **os.environ,
            "NAME": name,
            "PORT": str(port),
            "IMAGE": image,
            "DATA_DIR": str(data_dir),
            "MODELS_DIR": str(models_dir),
            "GPU_NO": gpu_no,
            "REQUIRE_GPU": "1",
            "MODEL_OFFLOADING": mode,
            "MODEL_OFFLOADING_TIMEOUT": "2",
        }
        try:
            subprocess.run(["make", "start", *make_vars], cwd=project, check=True, env=environment)
            initial = _health(port)
            expected_initial_vram = mode == "NEVER"
            assert initial["model_in_vram"] is expected_initial_vram

            with tempfile.TemporaryDirectory(prefix=f"offload-{mode.lower()}-", dir=data_dir) as output:
                subprocess.run(
                    [str(project / "run.sh"), "--quiet", "--output-dir", output, str(demo)],
                    cwd=project,
                    check=True,
                    stdout=subprocess.DEVNULL,
                    env=environment,
                )

            after = _health(port)
            if mode == "NEVER":
                assert after["model_in_vram"] is True
            elif mode == "IMMEDIATE":
                assert after["model_in_vram"] is False
            else:
                assert after["model_in_vram"] is True
                after = _wait_for(port, lambda health: health["model_in_vram"] is False, timeout=10)
            results[mode] = after
        finally:
            subprocess.run(["make", "stop", *make_vars], cwd=project, check=False, env=environment)

    print(json.dumps({"status": "ok", "policies": results}))


if __name__ == "__main__":
    main()
