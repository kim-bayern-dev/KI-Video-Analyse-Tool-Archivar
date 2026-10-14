from __future__ import annotations

import json
import os
import subprocess
from dataclasses import dataclass
from fractions import Fraction
from pathlib import Path
from typing import Callable, Sequence


@dataclass(frozen=True)
class VideoInfo:
    fps: float
    codec: str
    width: int
    height: int
    duration: float | None
    total_frames: int | None


@dataclass(frozen=True)
class FFmpegResult:
    mode: str
    encoder: str | None
    used_nvdec: bool
    used_nvenc: bool


class FFmpegOperationError(RuntimeError):
    pass


RunFunction = Callable[..., subprocess.CompletedProcess]


class FFmpegBackend:
    """Cached FFmpeg capability probes with conservative CPU fallbacks."""

    def __init__(self, acceleration: str = "auto", *, run: RunFunction = subprocess.run) -> None:
        normalized = acceleration.lower()
        if normalized not in {"auto", "cpu", "nvdec"}:
            raise ValueError("acceleration must be one of: auto, cpu, nvdec")
        self.acceleration = normalized
        self._run = run
        self._nvenc: bool | None = None
        self._nvdec_by_input: dict[tuple[str, int, int], bool] = {}

    @staticmethod
    def _cache_key(path: Path) -> tuple[str, int, int]:
        stat = path.stat()
        return str(path.resolve()), stat.st_size, stat.st_mtime_ns

    def _probe_command(self, command: Sequence[str]) -> bool:
        completed = self._run(
            list(command),
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            check=False,
        )
        return completed.returncode == 0

    def nvdec_available(self, input_path: Path) -> bool:
        if self.acceleration == "cpu":
            return False
        key = self._cache_key(input_path)
        if key not in self._nvdec_by_input:
            self._nvdec_by_input[key] = self._probe_command(
                [
                    "ffmpeg",
                    "-nostdin",
                    "-hide_banner",
                    "-loglevel",
                    "error",
                    "-hwaccel",
                    "cuda",
                    "-hwaccel_device",
                    "0",
                    "-i",
                    str(input_path),
                    "-map",
                    "0:v:0",
                    "-frames:v",
                    "1",
                    "-an",
                    "-f",
                    "null",
                    "-",
                ]
            )
        return self._nvdec_by_input[key]

    def nvenc_available(self) -> bool:
        if self.acceleration == "cpu":
            return False
        if self._nvenc is None:
            self._nvenc = self._probe_command(
                [
                    "ffmpeg",
                    "-nostdin",
                    "-hide_banner",
                    "-loglevel",
                    "error",
                    "-f",
                    "lavfi",
                    "-i",
                    "color=size=64x64:rate=1",
                    "-frames:v",
                    "1",
                    "-c:v",
                    "h264_nvenc",
                    "-gpu",
                    "0",
                    "-pix_fmt",
                    "yuv420p",
                    "-f",
                    "null",
                    "-",
                ]
            )
        return self._nvenc

    def probe_video(self, path: Path) -> VideoInfo:
        completed = self._run(
            [
                "ffprobe",
                "-v",
                "error",
                "-select_streams",
                "v:0",
                "-show_entries",
                "stream=codec_name,width,height,r_frame_rate,avg_frame_rate,nb_frames,duration:format=duration",
                "-of",
                "json",
                str(path),
            ],
            check=True,
            capture_output=True,
            text=True,
        )
        payload = json.loads(completed.stdout)
        streams = payload.get("streams") or []
        if not streams:
            raise FFmpegOperationError(f"No video stream found in {path}")
        stream = streams[0]
        rate = stream.get("avg_frame_rate") or stream.get("r_frame_rate") or "0/1"
        fps = float(Fraction(rate))
        if fps <= 0:
            raise FFmpegOperationError(f"Could not determine a positive frame rate for {path}")

        duration_raw = stream.get("duration") or (payload.get("format") or {}).get("duration")
        duration = float(duration_raw) if duration_raw not in {None, "N/A"} else None
        frames_raw = stream.get("nb_frames")
        total_frames = int(frames_raw) if frames_raw not in {None, "N/A"} else None
        return VideoInfo(
            fps=fps,
            codec=str(stream.get("codec_name") or "unknown"),
            width=int(stream.get("width") or 0),
            height=int(stream.get("height") or 0),
            duration=duration,
            total_frames=total_frames,
        )

    @staticmethod
    def _decode_prefix(use_nvdec: bool) -> list[str]:
        return ["-hwaccel", "cuda", "-hwaccel_device", "0"] if use_nvdec else []

    def _captured(self, command: Sequence[str]) -> subprocess.CompletedProcess:
        return self._run(list(command), check=False, capture_output=True)

    @staticmethod
    def _error(completed: subprocess.CompletedProcess) -> str:
        stderr = completed.stderr or b""
        if isinstance(stderr, bytes):
            return stderr.decode(errors="replace")[-2000:]
        return str(stderr)[-2000:]

    def extract_detection_frames(self, input_path: Path) -> tuple[bytes, FFmpegResult]:
        use_nvdec = self.nvdec_available(input_path)

        def command(accelerated: bool) -> list[str]:
            return [
                "ffmpeg",
                "-nostdin",
                "-hide_banner",
                "-loglevel",
                os.environ.get("SEGMENT_SCENES_FFMPEG_LOGLEVEL", "error"),
                *self._decode_prefix(accelerated),
                "-i",
                str(input_path),
                "-map",
                "0:v:0",
                "-an",
                "-sn",
                "-s:v",
                "48x27",
                "-pix_fmt",
                "rgb24",
                "-f",
                "rawvideo",
                "pipe:1",
            ]

        completed = self._captured(command(use_nvdec))
        if completed.returncode != 0 and use_nvdec:
            completed = self._captured(command(False))
            use_nvdec = False
        if completed.returncode != 0:
            raise FFmpegOperationError(f"FFmpeg frame extraction failed: {self._error(completed)}")
        return completed.stdout, FFmpegResult(
            mode="NVDEC + CPU scale" if use_nvdec else "CPU decode + CPU scale",
            encoder=None,
            used_nvdec=use_nvdec,
            used_nvenc=False,
        )

    def extract_image_frame(
        self,
        input_path: Path,
        output_path: Path,
        *,
        timestamp: float,
        max_width: int,
        jpeg: bool = False,
    ) -> FFmpegResult:
        # Single-frame extraction deliberately uses CPU decode: it is invoked once
        # per scene, and per-process CUDA init costs more than decoding one frame.
        command = [
            "ffmpeg",
            "-nostdin",
            "-hide_banner",
            "-loglevel",
            "error",
            "-y",
            "-ss",
            f"{timestamp:.6f}",
            "-i",
            str(input_path),
            "-map",
            "0:v:0",
            "-frames:v",
            "1",
            "-vf",
            f"scale=w='min(iw,{max_width})':h=-2:flags=area",
        ]
        if jpeg:
            command.extend(["-q:v", "3"])
        command.append(str(output_path))

        completed = self._captured(command)
        if completed.returncode != 0 or not output_path.is_file() or output_path.stat().st_size == 0:
            raise FFmpegOperationError(f"FFmpeg keyframe extraction failed: {self._error(completed)}")
        return FFmpegResult(
            mode="CPU decode + CPU scale",
            encoder="mjpeg" if jpeg else "png",
            used_nvdec=False,
            used_nvenc=False,
        )

    @staticmethod
    def _video_encoder_args(encoder: str, fps: float, bitrate: str) -> list[str]:
        gop = max(1, int(round(fps * 2)))
        if encoder == "h264_nvenc":
            return [
                "-c:v",
                "h264_nvenc",
                "-gpu",
                "0",
                "-preset",
                "p6",
                "-tune",
                "hq",
                "-rc",
                "vbr",
                "-cq",
                "24",
                "-b:v",
                bitrate,
                "-g",
                str(gop),
                "-forced-idr",
                "1",
            ]
        return [
            "-c:v",
            "libx264",
            "-preset",
            "fast",
            "-profile:v",
            "baseline",
            "-level:v",
            "3.1",
            "-b:v",
            bitrate,
            "-g",
            str(gop),
            "-keyint_min",
            str(gop),
            "-sc_threshold",
            "0",
        ]

    def cut_scene(
        self,
        input_path: Path,
        output_path: Path,
        *,
        start: float,
        end: float,
        fps: float,
        max_height: int,
        bitrate: str,
    ) -> FFmpegResult:
        # Scene cuts deliberately use CPU decode: this runs once per scene, and
        # per-process CUDA init costs more than decoding a short clip (measured
        # faster than NVDEC on this host). NVENC is still used when available;
        # its probe result is cached for the service lifetime.
        #
        # Zero-frame guards:
        # 1. Below one output frame interval (duration*fps < 1, e.g. <2s at
        #    0.5fps) encode at 1fps — the fps filter drops the only buffered
        #    frame at EOF in that situation (verified empirically).
        # 2. eof_action=pass: pass the final buffered frame through instead of
        #    discarding it. round=down/up can yield ZERO output frames for
        #    short clips (source-fps dependent: 25fps vs 8fps sources differ);
        #    pass produced >= 1 frame in every probed case (0.3s-6s, 8-25fps).
        if (end - start) * fps < 1:
            fps = 1.0
        # Compact rate string for ffmpeg: "1" for 1.0, "0.5" for fractional rates.
        fps_str = f"{fps:g}"
        has_nvenc = self.nvenc_available()
        attempts: list[tuple[bool, str]] = []
        if has_nvenc:
            attempts.append((False, "h264_nvenc"))
        attempts.append((False, "libx264"))

        last: subprocess.CompletedProcess | None = None
        for use_nvdec, encoder in attempts:
            command = [
                "ffmpeg",
                "-nostdin",
                "-hide_banner",
                "-loglevel",
                os.environ.get("SEGMENT_SCENES_FFMPEG_LOGLEVEL", "error"),
                "-y",
                "-fflags",
                "+genpts",
                *self._decode_prefix(use_nvdec),
                "-ss",
                f"{start:.6f}",
                "-to",
                f"{end:.6f}",
                "-i",
                str(input_path),
                "-map",
                "0:v:0",
                "-map",
                "0:a:0?",
                "-vf",
                (
                    f"fps={fps_str}:eof_action=pass,"
                    f"scale=w=-2:h='2*trunc(min(ih,{max_height})/2)':flags=area,"
                    "setsar=1,format=yuv420p"
                ),
                "-r",
                fps_str,
                "-fps_mode",
                "cfr",
                *self._video_encoder_args(encoder, fps, bitrate),
                "-pix_fmt",
                "yuv420p",
                "-c:a",
                "aac",
                "-b:a",
                "128k",
                "-movflags",
                "+faststart+omit_tfhd_offset",
                str(output_path),
            ]
            last = self._captured(command)
            if last.returncode == 0 and output_path.is_file() and output_path.stat().st_size > 0:
                mode = (
                    "CPU decode + CPU filters + NVENC"
                    if encoder == "h264_nvenc"
                    else "CPU decode + CPU filters + CPU libx264"
                )
                return FFmpegResult(
                    mode=mode,
                    encoder=encoder,
                    used_nvdec=False,
                    used_nvenc=encoder == "h264_nvenc",
                )

        detail = self._error(last) if last is not None else "no encoding attempt was made"
        raise FFmpegOperationError(f"FFmpeg scene encoding failed in all modes: {detail}")
