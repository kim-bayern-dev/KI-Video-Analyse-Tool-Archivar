from __future__ import annotations

import json
import subprocess
from pathlib import Path

from segment_scenes.ffmpeg_backend import FFmpegBackend


class FakeRunner:
    def __init__(self, tmp_path: Path):
        self.tmp_path = tmp_path
        self.commands: list[list[str]] = []
        self.fail_accelerated_extract = False
        self.nvenc_available = False

    def __call__(self, command, **kwargs):
        command = list(command)
        self.commands.append(command)
        if command[0] == "ffprobe":
            payload = {
                "streams": [
                    {
                        "codec_name": "h264",
                        "width": 1920,
                        "height": 1080,
                        "avg_frame_rate": "30000/1001",
                        "nb_frames": "120",
                        "duration": "4.004",
                    }
                ],
                "format": {"duration": "4.004"},
            }
            return subprocess.CompletedProcess(command, 0, stdout=json.dumps(payload), stderr="")
        if "-f" in command and "lavfi" in command:
            if self.nvenc_available:
                return subprocess.CompletedProcess(command, 0, stdout=b"", stderr=b"")
            return subprocess.CompletedProcess(command, 1, stdout=b"", stderr=b"no NVENC")
        if "-frames:v" in command and "null" in command:
            return subprocess.CompletedProcess(command, 0, stdout=b"", stderr=b"")
        if command[-1] == "pipe:1":
            accelerated = "-hwaccel" in command
            if accelerated and self.fail_accelerated_extract:
                return subprocess.CompletedProcess(command, 1, stdout=b"", stderr=b"NVDEC failed")
            return subprocess.CompletedProcess(command, 0, stdout=b"rgb", stderr=b"")

        output = Path(command[-1])
        output.parent.mkdir(parents=True, exist_ok=True)
        output.write_bytes(b"media")
        return subprocess.CompletedProcess(command, 0, stdout=b"", stderr=b"")


def test_probe_uses_fraction_without_eval(tmp_path):
    video = tmp_path / "demo.mp4"
    video.write_bytes(b"video")
    backend = FFmpegBackend(run=FakeRunner(tmp_path))

    info = backend.probe_video(video)

    assert round(info.fps, 6) == round(30000 / 1001, 6)
    assert info.codec == "h264"
    assert info.total_frames == 120


def test_nvdec_failure_retries_cpu_without_changing_frame_pipe(tmp_path):
    video = tmp_path / "demo.mp4"
    video.write_bytes(b"video")
    runner = FakeRunner(tmp_path)
    runner.fail_accelerated_extract = True
    backend = FFmpegBackend(run=runner)

    raw, result = backend.extract_detection_frames(video)

    assert raw == b"rgb"
    assert result.used_nvdec is False
    extract_commands = [command for command in runner.commands if command[-1] == "pipe:1"]
    assert len(extract_commands) == 2
    assert "-hwaccel" in extract_commands[0]
    assert "-hwaccel" not in extract_commands[1]
    assert all("48x27" in command for command in extract_commands)


def test_scene_cut_uses_cpu_decode_and_falls_back_to_cpu_encoder(tmp_path):
    video = tmp_path / "demo.mp4"
    video.write_bytes(b"video")
    output = tmp_path / "out.mp4"
    runner = FakeRunner(tmp_path)
    backend = FFmpegBackend(run=runner)

    result = backend.cut_scene(
        video,
        output,
        start=0.1,
        end=2.9,
        fps=8,
        max_height=448,
        bitrate="1M",
    )

    assert result.used_nvdec is False
    assert result.used_nvenc is False
    assert result.encoder == "libx264"
    encode_command = runner.commands[-1]
    assert "-hwaccel" not in encode_command
    assert encode_command.index("-preset") < len(encode_command) - 1


def test_scene_cut_prefers_nvenc_when_available(tmp_path):
    video = tmp_path / "demo.mp4"
    video.write_bytes(b"video")
    output = tmp_path / "out.mp4"
    runner = FakeRunner(tmp_path)
    runner.nvenc_available = True
    backend = FFmpegBackend(run=runner)

    result = backend.cut_scene(
        video,
        output,
        start=0.1,
        end=2.9,
        fps=8,
        max_height=448,
        bitrate="1M",
    )

    assert result.used_nvdec is False
    assert result.used_nvenc is True
    assert result.encoder == "h264_nvenc"
    encode_command = runner.commands[-1]
    assert "-hwaccel" not in encode_command
    assert "h264_nvenc" in encode_command


def test_extract_image_frame_uses_cpu_decode(tmp_path):
    video = tmp_path / "demo.mp4"
    video.write_bytes(b"video")
    output = tmp_path / "frame.png"
    runner = FakeRunner(tmp_path)
    backend = FFmpegBackend(run=runner)

    result = backend.extract_image_frame(video, output, timestamp=1.5, max_width=640)

    assert result.used_nvdec is False
    assert result.used_nvenc is False
    extract_command = runner.commands[-1]
    assert "-hwaccel" not in extract_command
    assert "-ss" in extract_command
    assert output.is_file()
