"""In-memory audio decoding and resampling to 16 kHz mono float32."""
from __future__ import annotations

import audioop
import subprocess
import wave
from dataclasses import dataclass
from io import BytesIO
from pathlib import Path
from typing import Optional

from .config import FFMPEG_TIMEOUT_SECONDS, SAMPLE_RATE_HZ

import numpy as np


@dataclass(slots=True, frozen=True)
class WavHeader:
    """Parsed PCM WAV container metadata."""

    frame_count: int
    sample_rate: int
    channels: int
    sample_width: int
    compression: str

    @property
    def duration_seconds(self) -> float:
        return self.frame_count / self.sample_rate if self.sample_rate else 0.0


def _read_wav_header(payload: bytes) -> Optional[WavHeader]:
    try:
        with wave.open(BytesIO(payload), "rb") as wav_file:
            return WavHeader(
                frame_count=wav_file.getnframes(),
                sample_rate=wav_file.getframerate(),
                channels=wav_file.getnchannels(),
                sample_width=wav_file.getsampwidth(),
                compression=wav_file.getcomptype(),
            )
    except (wave.Error, EOFError, OSError):
        return None


def _decode_pcm_wav(payload: bytes, header: WavHeader) -> Optional[np.ndarray]:
    """Decode an uncompressed WAV in process; return None when unsupported."""
    if header.compression != "NONE":
        return None
    if header.sample_width not in (1, 2, 3, 4) or header.channels not in (1, 2):
        return None
    try:
        with wave.open(BytesIO(payload), "rb") as wav_file:
            pcm_frames = wav_file.readframes(header.frame_count)
        channels = header.channels
        if channels == 2:
            pcm_frames = audioop.tomono(pcm_frames, header.sample_width, 0.5, 0.5)
            channels = 1
        if header.sample_rate != SAMPLE_RATE_HZ:
            pcm_frames, _ = audioop.ratecv(
                pcm_frames,
                header.sample_width,
                channels,
                header.sample_rate,
                SAMPLE_RATE_HZ,
                None,
            )
        if header.sample_width == 1:
            samples = (
                np.frombuffer(pcm_frames, dtype=np.uint8).astype(np.float32) - 128.0
            ) / 128.0
        elif header.sample_width == 2:
            samples = np.frombuffer(pcm_frames, dtype="<i2").astype(np.float32) / 32768.0
        elif header.sample_width == 4:
            samples = (
                np.frombuffer(pcm_frames, dtype="<i4").astype(np.float32) / 2147483648.0
            )
        else:
            pcm16_frames = audioop.lin2lin(pcm_frames, header.sample_width, 2)
            samples = np.frombuffer(pcm16_frames, dtype="<i2").astype(np.float32) / 32768.0
        return np.ascontiguousarray(samples, dtype=np.float32)
    except (wave.Error, EOFError, OSError, audioop.error, ValueError):
        return None


def _decode_with_ffmpeg(payload: bytes) -> np.ndarray:
    """Decode a container/codec to mono 16 kHz float32 with one FFmpeg call."""
    command = [
        "ffmpeg",
        "-hide_banner",
        "-nostdin",
        "-loglevel",
        "error",
        "-i",
        "pipe:0",
        "-map",
        "0:a:0",
        "-vn",
        "-sn",
        "-dn",
        "-ac",
        "1",
        "-ar",
        str(SAMPLE_RATE_HZ),
        "-f",
        "s16le",
        "pipe:1",
    ]
    try:
        process = subprocess.run(
            command,
            input=payload,
            capture_output=True,
            check=False,
            timeout=FFMPEG_TIMEOUT_SECONDS,
        )
    except FileNotFoundError as exc:
        raise RuntimeError("ffmpeg is not installed or not available on PATH") from exc
    except subprocess.TimeoutExpired as exc:
        raise RuntimeError(
            f"ffmpeg decode exceeded {FFMPEG_TIMEOUT_SECONDS:g} seconds"
        ) from exc
    if process.returncode != 0:
        stderr_text = process.stderr.decode(errors="replace").strip()[:500]
        raise RuntimeError(f"ffmpeg decode failed: {stderr_text or 'unknown error'}")
    if not process.stdout:
        return np.empty(0, dtype=np.float32)
    samples = np.frombuffer(process.stdout, dtype="<i2").astype(np.float32) / 32768.0
    return np.ascontiguousarray(samples, dtype=np.float32)


def decode_audio(payload: bytes) -> np.ndarray:
    """Return a finite mono float32 waveform at 16 kHz."""
    if not payload:
        return np.empty(0, dtype=np.float32)
    header = _read_wav_header(payload)
    waveform = _decode_pcm_wav(payload, header) if header is not None else None
    if waveform is None:
        waveform = _decode_with_ffmpeg(payload)
    if waveform.ndim != 1:
        waveform = np.ravel(waveform)
    if not np.isfinite(waveform).all():
        waveform = np.nan_to_num(waveform, copy=False)
    return np.ascontiguousarray(waveform, dtype=np.float32)


def decode_audio_file(path: Path) -> np.ndarray:
    return decode_audio(Path(path).read_bytes())
