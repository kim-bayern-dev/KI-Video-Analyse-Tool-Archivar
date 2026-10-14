from __future__ import annotations

from contextlib import contextmanager
from dataclasses import replace

from fastapi.testclient import TestClient

from segment_scenes import api
from segment_scenes.config import Settings


class FakeManager:
    def __init__(self):
        self.ready = False
        self.closed = False
        self.model = object()

    def start(self):
        self.ready = True

    def close(self):
        self.closed = True
        self.ready = False

    def status(self):
        return {
            "ready": self.ready,
            "model_loaded": self.ready,
            "model_in_vram": self.ready,
            "resident_device": "cuda" if self.ready else None,
            "configured_device": "cuda",
            "model_offloading": "NEVER",
            "model_offloading_timeout": 60.0,
            "offload_scheduled": False,
            "busy": False,
            "torch_compile": False,
            "compiled": False,
            "last_used_at": None,
        }

    @contextmanager
    def model_session(self):
        yield self.model, "cuda"


def test_health_and_file_uri_segmentation(tmp_path, monkeypatch):
    video = tmp_path / "demo.mp4"
    video.write_bytes(b"video")
    output = tmp_path / "output"
    settings = replace(Settings(), allowed_file_roots=(tmp_path,))
    manager = FakeManager()
    calls = {}

    def fake_process(media_path, **kwargs):
        calls["media_path"] = media_path
        calls.update(kwargs)
        return {"shots": [], "scene_keyframes": [], "scene_segments": []}

    monkeypatch.setattr(api, "process_video", fake_process)
    application = api.create_app(settings, model_manager=manager, ffmpeg_backend=object())

    with TestClient(application) as client:
        health = client.get("/health")
        assert health.status_code == 200
        assert health.json()["status"] == "ok"
        assert health.json()["model_in_vram"] is True

        response = client.post(
            "/v1/segment-scenes",
            json={
                "media": video.as_uri(),
                "output_dir": output.as_uri(),
                "quiet": True,
            },
        )
        assert response.status_code == 200, response.text
        assert response.json()["shots"] == []
        assert calls["media_path"] == video
        assert calls["output_dir"] == output
        assert calls["model"] is manager.model
        assert calls["model_device"] == "cuda"

    assert manager.closed is True


def test_api_rejects_uploaded_or_remote_media(tmp_path):
    settings = replace(Settings(), allowed_file_roots=(tmp_path,))
    manager = FakeManager()
    application = api.create_app(settings, model_manager=manager, ffmpeg_backend=object())

    with TestClient(application) as client:
        response = client.post("/v1/segment-scenes", json={"media": "https://example.test/demo.mp4"})

    assert response.status_code == 400
    assert "Only file:// URIs" in response.json()["detail"]
