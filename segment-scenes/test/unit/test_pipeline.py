from __future__ import annotations

import json

from segment_scenes import pipeline
from segment_scenes.pipeline import ProcessingOptions


def test_pipeline_preserves_contract_and_persists_complete_manifest(tmp_path, monkeypatch):
    video = tmp_path / "demo.mp4"
    video.write_bytes(b"video")
    output = tmp_path / "output"
    captured = {}

    def fake_detection(**kwargs):
        captured["detection"] = kwargs
        return {
            "video": {"path": str(video), "num_frames": 10, "duration_ms": 1000},
            "model": {"name": "TransNetV2", "impl": "transnetv2-pytorch"},
            "encoding": {"fps": 8, "max_width_px": 640, "max_height_px": 448},
            "shots": [{"shot_id": 0, "start_time": 0.0, "end_time": 1.0}],
            "boundaries": {"predicted_ms": []},
            "gpu_stats": {"available": False},
        }

    monkeypatch.setattr(pipeline, "run_scene_detection", fake_detection)
    monkeypatch.setattr(
        pipeline,
        "extract_scene_keyframe_pngs",
        lambda **_kwargs: [{"type": "scene_keyframe", "keyframe_file": "scene_keyframes/000.png"}],
    )
    monkeypatch.setattr(
        pipeline,
        "cut_scene_segments",
        lambda **_kwargs: [{"type": "scene_segment", "scene_file": "scenes/000.mp4"}],
    )

    model = object()
    backend = object()
    result = pipeline.process_video(
        video,
        output_dir=output,
        options=ProcessingOptions(quiet=True),
        model=model,
        model_device="cuda",
        ffmpeg_backend=backend,
    )

    assert captured["detection"]["model"] is model
    assert captured["detection"]["ffmpeg_backend"] is backend
    assert result["scene_keyframes"]
    assert result["scene_segments"]
    manifests = list(output.glob("out_demo_mp4_*/demo_*_scenes.json"))
    assert len(manifests) == 1
    assert json.loads(manifests[0].read_text()) == result


def test_pipeline_returns_empty_auxiliary_lists_when_no_shots(tmp_path, monkeypatch):
    video = tmp_path / "demo.mp4"
    video.write_bytes(b"video")
    monkeypatch.setattr(
        pipeline,
        "run_scene_detection",
        lambda **_kwargs: {"shots": [], "model": {}, "encoding": {}, "video": {}, "boundaries": {}},
    )

    result = pipeline.process_video(
        video,
        output_dir=tmp_path / "output",
        options=ProcessingOptions(quiet=True),
        model=object(),
        model_device="cpu",
        ffmpeg_backend=object(),
    )

    assert result["scene_keyframes"] == []
    assert result["scene_segments"] == []
