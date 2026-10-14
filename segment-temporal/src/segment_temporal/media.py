from __future__ import annotations

import json
import subprocess
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Literal

MediaKind = Literal["audio", "video", "image"]

# Extensions that represent static images for ffprobe-backed classification.
# A file is only treated as an image when it has no audio stream.
IMAGE_EXTENSIONS = {
    ".avif", ".bmp", ".dpx", ".exr", ".fits", ".gif", ".hdr", ".j2k",
    ".jls", ".jp2", ".jpeg", ".jpg", ".jxl", ".ljpg", ".pam", ".pbm",
    ".pcx", ".pgm", ".png", ".ppm", ".qoi", ".ras", ".sgi", ".tga",
    ".tif", ".tiff", ".wbmp", ".webp", ".xbm", ".xwd",
}


class MediaProbeError(RuntimeError):
    pass


@dataclass(frozen=True)
class MediaInfo:
    kind: MediaKind
    duration_s: float
    has_audio: bool
    has_video: bool
    format_name: str
    video_codec: str | None = None
    audio_codec: str | None = None
    width: int | None = None
    height: int | None = None
    avg_frame_rate: str | None = None


def _as_float(value: Any) -> float | None:
    try:
        parsed = float(value)
    except (TypeError, ValueError):
        return None
    return parsed if parsed >= 0 else None


def _duration_from_probe(payload: dict[str, Any]) -> float:
    """Take the maximum plausible duration across format and per-stream values.

    Some containers (e.g. MKV) only expose per-stream DURATION tags, while others
    only set the format duration; the max is the safest single number for VAD/coverage.
    """
    values: list[float] = []
    format_duration = _as_float(payload.get("format", {}).get("duration"))
    if format_duration is not None:
        values.append(format_duration)

    for stream in payload.get("streams", []):
        duration = _as_float(stream.get("duration"))
        if duration is not None:
            values.append(duration)

        tags = stream.get("tags") or {}
        tag_duration = tags.get("DURATION")
        if isinstance(tag_duration, str) and ":" in tag_duration:
            try:
                hours, minutes, seconds = tag_duration.split(":", 2)
                values.append(int(hours) * 3600 + int(minutes) * 60 + float(seconds))
            except ValueError:
                pass

    return max(values, default=0.0)


def probe_media(path: Path) -> MediaInfo:
    """Classify a media file by its actual streams (not its extension).

    This correctly handles MXF/MTS/M2TS/OGV/RMVB, audio-only WebM, and unusual
    extensions that mimetype/extension guessing gets wrong in the legacy path.
    """
    command = [
        "ffprobe",
        "-v",
        "error",
        "-show_streams",
        "-show_format",
        "-of",
        "json",
        str(path),
    ]
    try:
        completed = subprocess.run(
            command,
            check=True,
            capture_output=True,
            text=True,
        )
        payload = json.loads(completed.stdout)
    except (subprocess.CalledProcessError, json.JSONDecodeError) as exc:
        stderr = getattr(exc, "stderr", "") or ""
        detail = stderr.strip() or str(exc)
        raise MediaProbeError(f"ffprobe failed for {path}: {detail}") from exc

    streams = payload.get("streams", [])
    audio_streams = [s for s in streams if s.get("codec_type") == "audio"]
    # attached_pic streams (e.g. cover art in MP3) are not real video timelines.
    video_streams = [
        s
        for s in streams
        if s.get("codec_type") == "video"
        and not (s.get("disposition") or {}).get("attached_pic")
    ]

    has_audio = bool(audio_streams)
    has_video = bool(video_streams)
    suffix = path.suffix.lower()

    if suffix in IMAGE_EXTENSIONS and has_video and not has_audio:
        kind: MediaKind = "image"
    elif has_video:
        kind = "video"
    elif has_audio:
        kind = "audio"
    else:
        raise MediaProbeError(f"No decodable audio, video, or image stream found in {path}")

    duration_s = 0.0 if kind == "image" else _duration_from_probe(payload)
    if kind != "image" and duration_s <= 0:
        raise MediaProbeError(f"Could not determine positive media duration for {path}")

    video_stream = video_streams[0] if video_streams else {}
    audio_stream = audio_streams[0] if audio_streams else {}

    return MediaInfo(
        kind=kind,
        duration_s=duration_s,
        has_audio=has_audio,
        has_video=has_video,
        format_name=str(payload.get("format", {}).get("format_name") or "unknown"),
        video_codec=video_stream.get("codec_name"),
        audio_codec=audio_stream.get("codec_name"),
        width=video_stream.get("width"),
        height=video_stream.get("height"),
        avg_frame_rate=video_stream.get("avg_frame_rate"),
    )
