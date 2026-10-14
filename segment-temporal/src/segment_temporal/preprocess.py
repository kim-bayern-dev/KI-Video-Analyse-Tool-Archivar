from __future__ import annotations

import os
import subprocess
import sys
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Literal, Sequence

EncoderMode = Literal["libx264", "h264_nvenc"]


@dataclass(frozen=True)
class PreprocessConfig:
    """Target shape of the single normalized working copy every later step reads.

    One small, low-FPS, short-GOP H.264 file makes audio decode, VAD, scene
    analysis, stream-copy segmentation and keyframe extraction all cheap.
    """
    max_width: int = 320
    max_height: int = 180
    # Fractional rates are allowed: 0.5 = one frame every 2s, 0.25 = every 4s.
    output_fps: float = 8
    encoder: Literal["auto", "cpu", "nvenc"] = "auto"
    audio_bitrate: str = "192k"

    def validate(self) -> None:
        if self.max_width <= 0 or self.max_height <= 0 or self.output_fps <= 0:
            raise ValueError("Preprocessing width, height, and FPS must be positive")


@dataclass(frozen=True)
class PreprocessResult:
    output_path: Path
    mode: str
    encoder: EncoderMode
    used_nvdec: bool
    wall_seconds: float
    output_bytes: int


class PreprocessError(RuntimeError):
    pass


def _run_probe(arguments: Sequence[str]) -> bool:
    """Run a throwaway ffmpeg invocation; True iff it succeeded (silent)."""
    completed = subprocess.run(
        list(arguments),
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
        check=False,
    )
    return completed.returncode == 0


def _nvenc_available() -> bool:
    """Probe NVENC independently. H200 exposes NVDEC but not NVENC, so this fails there."""
    return _run_probe(
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


def _gop_size(fps: float) -> int:
    # A one-second GOP (-g fps) keeps later stream-copy segmentation accurate.
    # For fractional rates (0.5/0.25 fps) a one-second GOP is below one frame, so
    # clamp up to 1: every frame becomes an IDR and cuts stay frame-accurate.
    return max(1, round(fps))


def _encoder_arguments(mode: EncoderMode, fps: float) -> list[str]:
    gop = str(_gop_size(fps))
    if mode == "h264_nvenc":
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
            "0",
            "-pix_fmt",
            "yuv420p",
            "-g",
            gop,
            "-forced-idr",
            "1",
        ]
    return [
        "-c:v",
        "libx264",
        "-preset",
        "veryfast",
        "-crf",
        "23",
        "-pix_fmt",
        "yuv420p",
        "-g",
        gop,
        "-keyint_min",
        gop,
        "-sc_threshold",
        "0",
    ]


def _transcode(
    input_path: Path,
    output_path: Path,
    config: PreprocessConfig,
    *,
    encoder: EncoderMode,
) -> None:
    # %g keeps integer rates pretty ("8") and emits plain decimals for
    # fractional ones ("0.5", "0.25") — both accepted by the fps filter.
    filter_expr = (
        f"fps={config.output_fps:g},"
        f"scale=w='min(iw,{config.max_width})':"
        f"h='min(ih,{config.max_height})':"
        "force_original_aspect_ratio=decrease:"
        "force_divisible_by=2:flags=area,setsar=1"
    )

    # CPU decode by design: for the typical 1080p H.264 corpus, multithreaded CPU
    # decode measured faster than NVDEC + host-memory round-trip, and it keeps
    # this pass free of per-process CUDA init and driver/codec-specific failures.
    command = [
        "ffmpeg",
        "-nostdin",
        "-hide_banner",
        "-loglevel",
        os.environ.get("SEGMENT_TEMPORAL_FFMPEG_LOGLEVEL", "warning"),
        "-stats",
        "-y",
        "-filter_threads",
        "0",
        "-i",
        str(input_path),
        "-map",
        "0:v:0",
        "-map",
        "0:a:0?",
        "-vf",
        filter_expr,
        *_encoder_arguments(encoder, config.output_fps),
        "-threads:v",
        "0",
        "-c:a",
        "aac",
        "-b:a",
        config.audio_bitrate,
        "-movflags",
        "+faststart",
        str(output_path),
    ]
    subprocess.run(command, check=True)


def _preprocess_via_script(
    input_path: Path,
    output_path: Path,
    config: PreprocessConfig,
    *,
    verbose: bool,
) -> PreprocessResult:
    """Fallback preprocessing via the in-container shell script (no docker-in-docker).

    Opt-in via SEGMENT_TEMPORAL_PREPROCESS=script. The script mirrors this module's
    probe/transcode logic in bash and emits telemetry as stderr key=value lines, which
    we parse back into a PreprocessResult so the JSON output stays consistent.
    """
    script = os.environ.get("SEGMENT_TEMPORAL_PREPROCESS_SCRIPT", "/app/scripts/preprocess_video.sh")
    env = {
        **os.environ,
        "MAX_WIDTH": str(config.max_width),
        "MAX_HEIGHT": str(config.max_height),
        "OUTPUT_FPS": f"{config.output_fps:g}",
    }
    if verbose:
        print(f"Preprocessing via script: {script}", flush=True, file=sys.stderr)
    started = time.monotonic()
    completed = subprocess.run(
        [script, str(input_path), str(output_path)],
        env=env,
        text=True,
        capture_output=True,
        check=False,
    )
    if completed.returncode != 0:
        tail = (completed.stderr or "")[-800:]
        raise PreprocessError(f"script preprocessing failed (rc={completed.returncode}): {tail}")
    if not output_path.is_file() or output_path.stat().st_size == 0:
        raise PreprocessError(f"script produced no output: {output_path}")

    mode = "script"
    used_nvdec = False
    encoder: EncoderMode = "libx264"
    for line in (completed.stderr or "").splitlines():
        if line.startswith("PREPROCESS_MODE="):
            mode = line.split("=", 1)[1].strip()
        elif line.startswith("PREPROCESS_NVDEC="):
            used_nvdec = line.split("=", 1)[1].strip() == "true"
        elif line.startswith("PREPROCESS_ENCODER="):
            encoder = "h264_nvenc" if line.split("=", 1)[1].strip().startswith("h264_nvenc") else "libx264"
    return PreprocessResult(
        output_path=output_path,
        mode=mode,
        encoder=encoder,
        used_nvdec=used_nvdec,
        wall_seconds=time.monotonic() - started,
        output_bytes=output_path.stat().st_size,
    )


def preprocess_video(
    input_path: Path,
    output_path: Path,
    config: PreprocessConfig,
    *,
    verbose: bool = False,
) -> PreprocessResult:
    """Normalize a video once: CPU decode, CPU filters, libx264/NVENC encode.

    CPU decode is deliberate: it measured faster than NVDEC on the target host and
    avoids per-process CUDA init plus codec/driver-specific hardware paths. NVENC is
    probed once per invocation and used when present; on H200 (no NVENC hardware) the
    result is "CPU decode + CPU filters + CPU libx264". An NVENC encode failure
    transparently retries the fully portable libx264 path so production never aborts.
    """
    config.validate()
    output_path.parent.mkdir(parents=True, exist_ok=True)

    # Opt-in bash fallback (no docker-in-docker); default is the Python ffmpeg path.
    if os.environ.get("SEGMENT_TEMPORAL_PREPROCESS") == "script":
        return _preprocess_via_script(input_path, output_path, config, verbose=verbose)

    has_nvenc = _nvenc_available()

    if config.encoder == "nvenc" and not has_nvenc:
        raise PreprocessError("NVENC was requested but is unavailable on the selected GPU")
    encoder: EncoderMode = (
        "h264_nvenc"
        if config.encoder == "nvenc" or (config.encoder == "auto" and has_nvenc)
        else "libx264"
    )

    mode = (
        "CPU decode + CPU filters + NVENC"
        if encoder == "h264_nvenc"
        else "CPU decode + CPU filters + CPU libx264"
    )

    if verbose:
        print(
            f"Preprocessing video: max={config.max_width}x{config.max_height}, "
            f"fps={config.output_fps}, mode={mode}",
            flush=True,
            file=sys.stderr,
        )

    started = time.monotonic()
    try:
        _transcode(
            input_path,
            output_path,
            config,
            encoder=encoder,
        )
    except subprocess.CalledProcessError as exc:
        # Hardware encode can be driver-specific. Preserve production availability
        # by retrying the fully portable libx264 path exactly once.
        if encoder == "libx264":
            raise PreprocessError(f"FFmpeg preprocessing failed: {exc}") from exc
        if verbose:
            print(
                "NVENC preprocessing failed; retrying CPU libx264.",
                flush=True,
                file=sys.stderr,
            )
        try:
            _transcode(
                input_path,
                output_path,
                config,
                encoder="libx264",
            )
        except subprocess.CalledProcessError as fallback_exc:
            raise PreprocessError(
                f"FFmpeg preprocessing failed in NVENC and libx264 fallback modes: {fallback_exc}"
            ) from fallback_exc
        encoder = "libx264"
        mode = "CPU decode + CPU filters + CPU libx264 (fallback)"

    if not output_path.is_file() or output_path.stat().st_size == 0:
        raise PreprocessError(f"Preprocessing produced no output: {output_path}")

    return PreprocessResult(
        output_path=output_path,
        mode=mode,
        encoder=encoder,
        used_nvdec=False,
        wall_seconds=time.monotonic() - started,
        output_bytes=output_path.stat().st_size,
    )
