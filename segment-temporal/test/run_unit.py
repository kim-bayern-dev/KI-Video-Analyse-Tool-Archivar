# /// script
# requires-python = ">=3.11"
# dependencies = ["numpy>=2,<3", "click>=8.1,<9", "pytest>=8,<9"]
# ///
"""Host-side unit-test runner.

Declared dependencies live in the PEP 723 header above, so `uv run test/run_unit.py`
resolves them in an ephemeral environment (no project venv / --group dev needed).
It only exercises pure-Python/NumPy logic (segmentation math, config) that needs no
ffmpeg and no VAD model.
"""
from __future__ import annotations

import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
# Make the in-tree package importable without installing it.
sys.path.insert(0, str(ROOT / "src"))

import pytest  # noqa: E402

if __name__ == "__main__":
    raise SystemExit(pytest.main(["-q", str(ROOT / "test" / "unit")]))
