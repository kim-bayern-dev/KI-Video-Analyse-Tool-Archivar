from __future__ import annotations

import json
import sys
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import numpy as np

from .detectors import (
    DEFAULT_KEYFRAME_MAX_WIDTH_PX,
    DEFAULT_OUTPUT_FPS,
    DEFAULT_OUTPUT_MAX_HEIGHT_PX,
    create_scene_visualization,
    cut_scene_segments,
    extract_scene_keyframe_pngs,
    extract_scene_keyframes,
    run_scene_detection,
)
from .ffmpeg_backend import FFmpegBackend
from .utils import get_file_hash, is_video_file


@dataclass(frozen=True)
class ProcessingOptions:
    threshold: float = 0.5
    min_len: float = 0.5
    max_len: float | None = None
    fps: float = DEFAULT_OUTPUT_FPS
    max_width_px: int = DEFAULT_KEYFRAME_MAX_WIDTH_PX
    max_height_px: int = DEFAULT_OUTPUT_MAX_HEIGHT_PX
    quiet: bool = False
    chunk_size: int = 1000
    visualize: bool = False
    extract_keyframes: bool = False

    def validate(self) -> None:
        if not 0.0 <= self.threshold <= 1.0:
            raise ValueError("threshold must be between 0 and 1")
        if self.min_len <= 0:
            raise ValueError("min_len must be greater than zero")
        if self.max_len is not None and self.max_len <= 0:
            raise ValueError("max_len must be greater than zero")
        if self.fps <= 0 or self.max_width_px <= 0 or self.max_height_px <= 0:
            raise ValueError("fps, max_width_px, and max_height_px must be positive")
        if self.chunk_size <= 0:
            raise ValueError("chunk_size must be greater than zero")


def process_video(
    media_path: Path,
    *,
    output_dir: Path | None,
    options: ProcessingOptions,
    model: Any,
    model_device: str,
    ffmpeg_backend: FFmpegBackend,
) -> dict[str, Any]:
    """Run the scene pipeline with an injected persistent model and FFmpeg backend."""
    options.validate()
    media_path = media_path.resolve()
    if not is_video_file(media_path):
        raise ValueError("input must be a supported video file for scene detection")

    file_hash = get_file_hash(media_path)
    if not options.quiet:
        print(
            f"[segment-scenes] Detecting scenes in: {media_path.name} (hash={file_hash})",
            file=sys.stderr,
        )

    result = run_scene_detection(
        video_path=media_path,
        threshold=options.threshold,
        min_len=options.min_len,
        max_len=options.max_len,
        device=model_device,
        quiet=options.quiet,
        chunk_size=options.chunk_size,
        fps=options.fps,
        max_width_px=options.max_width_px,
        max_height_px=options.max_height_px,
        model=model,
        model_device=model_device,
        ffmpeg_backend=ffmpeg_backend,
    )

    base_dir = output_dir.resolve() if output_dir is not None else media_path.parent
    input_extension = media_path.suffix[1:] if media_path.suffix else "unknown"
    out_dir = base_dir / f"out_{media_path.stem}_{input_extension}_{file_hash}"
    out_dir.mkdir(parents=True, exist_ok=True)

    if options.extract_keyframes and result["shots"]:
        if not options.quiet:
            print(
                f"[segment-scenes] Extracting legacy keyframes for {len(result['shots'])} scenes",
                file=sys.stderr,
            )
        result["keyframes"] = extract_scene_keyframes(
            video_path=media_path,
            scenes=result["shots"],
            file_hash=file_hash,
            output_dir=out_dir,
            quiet=options.quiet,
            max_width_px=options.max_width_px,
            ffmpeg_backend=ffmpeg_backend,
        )

    if options.visualize:
        visualization_path = out_dir / f"{media_path.stem}_{file_hash}_visualization.png"
        try:
            raw_frames, _acceleration = ffmpeg_backend.extract_detection_frames(media_path)
            frames = np.frombuffer(raw_frames, np.uint8).reshape([-1, 27, 48, 3])
            predictions = np.zeros(len(frames))
            for scene in result["shots"]:
                start_frame = scene["start_frame"]
                if start_frame < len(predictions):
                    predictions[start_frame] = scene.get("cut_prob_max", 0.5)
            create_scene_visualization(frames, predictions, visualization_path)
        except Exception as exc:
            if not options.quiet:
                print(
                    f"[segment-scenes] Warning: Failed to create visualization: {exc}",
                    file=sys.stderr,
                )

    if result["shots"]:
        result["scene_keyframes"] = extract_scene_keyframe_pngs(
            video_path=media_path,
            scenes=result["shots"],
            file_hash=file_hash,
            output_dir=out_dir,
            quiet=options.quiet,
            max_width_px=options.max_width_px,
            ffmpeg_backend=ffmpeg_backend,
        )
        result["scene_segments"] = cut_scene_segments(
            video_path=media_path,
            scenes=result["shots"],
            file_hash=file_hash,
            output_dir=out_dir,
            quiet=options.quiet,
            fps=options.fps,
            max_height_px=options.max_height_px,
            ffmpeg_backend=ffmpeg_backend,
        )
    else:
        result["scene_keyframes"] = []
        result["scene_segments"] = []

    # Persist the complete manifest that is also returned over HTTP.
    manifest_path = out_dir / f"{media_path.stem}_{file_hash}_scenes.json"
    manifest_path.write_text(json.dumps(result, indent=2) + "\n", encoding="utf-8")
    if not options.quiet:
        print(f"[segment-scenes] Output written to: {out_dir}", file=sys.stderr)
    return result
