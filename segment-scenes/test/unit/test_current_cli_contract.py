from __future__ import annotations

import json

from click.testing import CliRunner

from segment_scenes import cli


def test_cli_preserves_options_and_prints_service_json(tmp_path, monkeypatch):
    data = tmp_path / "data"
    data.mkdir()
    video = data / "demo.mp4"
    video.write_bytes(b"video")
    output = data / "results"
    calls = {}

    def fake_post(url, payload, timeout):
        calls.update(url=url, payload=payload, timeout=timeout)
        return {
            "video": {"path": "/data/demo.mp4"},
            "shots": [],
            "scene_keyframes": [],
            "scene_segments": [],
        }

    monkeypatch.setenv("SEGMENT_SCENES_DATA_DIR", str(data))
    monkeypatch.setattr(cli, "_post_json", fake_post)
    result = CliRunner().invoke(
        cli.main,
        [
            str(video),
            "--output-dir",
            str(output),
            "--threshold",
            "0.3",
            "--min-len",
            "1.0",
            "--max-len",
            "15",
            "--fps",
            "8",
            "--max-width-px",
            "640",
            "--max-height-px",
            "448",
            "--device",
            "cuda",
            "--quiet",
        ],
    )

    assert result.exit_code == 0, result.output
    assert json.loads(result.stdout)["video"]["path"] == "/data/demo.mp4"
    assert calls["url"] == "http://127.0.0.1:8088/v1/segment-scenes"
    assert calls["payload"]["media"] == "file:///data/demo.mp4"
    assert calls["payload"]["output_dir"] == "file:///data/results"
    assert calls["payload"]["threshold"] == 0.3
    assert calls["payload"]["max_len"] == 15.0
    assert calls["payload"]["device"] == "cuda"


def test_cli_rejects_path_outside_persistent_mount(tmp_path, monkeypatch):
    data = tmp_path / "data"
    data.mkdir()
    outside = tmp_path / "demo.mp4"
    outside.write_bytes(b"video")
    monkeypatch.setenv("SEGMENT_SCENES_DATA_DIR", str(data))

    result = CliRunner().invoke(cli.main, [str(outside)])

    assert result.exit_code == 2
    assert "outside the persistent DATA_DIR mount" in result.output


def test_cli_accepts_in_container_file_uri(monkeypatch):
    monkeypatch.setattr(cli, "_post_json", lambda _url, payload, _timeout: {"media": payload["media"]})

    result = CliRunner().invoke(cli.main, ["file:///data/test/demo.mp4", "--quiet"])

    assert result.exit_code == 0
    assert json.loads(result.stdout)["media"] == "file:///data/test/demo.mp4"
