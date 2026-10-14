from __future__ import annotations

from typing import List, Tuple, Optional

import numpy as np
import torch

try:
    # Preferred: official Silero python API
    from silero_vad import load_silero_vad, get_speech_timestamps  # type: ignore
except Exception:  # pragma: no cover
    # Fallback: pysilero-vad drop-in
    from pysilero_vad import load_silero_vad, get_speech_timestamps  # type: ignore


class SileroVAD:
    """
    Thin wrapper around Silero VAD.

    Parameters
    ----------
    sr : int
        Sampling rate (8k or 16k).
    threshold : float
        Positive (enter speech) threshold in [0,1].
    min_speech_ms : int
        Minimum final speech duration (ms).
    min_silence_ms : int
        Minimum silence to close a speech segment (ms).
    speech_pad_ms : int
        Pad each detected speech segment on both sides (ms).
    neg_threshold : Optional[float]
        Negative (exit speech) threshold in [0,1]. If None, Silero defaults to (threshold - 0.15).
    median_hz : int
        Kept for interface compatibility (not used).
    """

    def __init__(
        self,
        sr: int = 16000,
        threshold: float = 0.35,        # low threshold -> higher speech recall
        min_speech_ms: int = 150,
        min_silence_ms: int = 350,      # require a real gap to end speech
        speech_pad_ms: int = 50,
        neg_threshold: Optional[float] = 0.55,
        median_hz: int = 0,
    ) -> None:
        if sr not in (8000, 16000):
            raise ValueError("SileroVAD supports sr ∈ {8000, 16000}")
        self.sr = sr
        self.threshold = float(threshold)
        self.min_speech_ms = int(min_speech_ms)
        self.min_silence_ms = int(min_silence_ms)
        self.speech_pad_ms = int(speech_pad_ms)
        self.neg_threshold = None if neg_threshold is None else float(neg_threshold)

        self.model = load_silero_vad(onnx=True)
        torch.set_num_threads(1)

    def segments(self, y: np.ndarray) -> List[Tuple[float, float]]:
        """
        Run VAD on a mono float32 waveform in [-1, 1] at self.sr.

        Returns
        -------
        List of (start_sec, end_sec) tuples.
        """
        if y.ndim != 1:
            raise ValueError("SileroVAD expects mono waveform (1-D array).")

        # Ensure dtype and writability
        if y.dtype != np.float32 or (not y.flags.writeable):
            y = y.astype(np.float32, copy=True)

        # Guard against NaNs/Infs
        if not np.isfinite(y).all():
            y = np.nan_to_num(y, nan=0.0, posinf=0.0, neginf=0.0)

        wav = torch.from_numpy(y)

        kwargs = dict(
            audio=wav,
            model=self.model,
            threshold=self.threshold,
            sampling_rate=self.sr,
            min_speech_duration_ms=self.min_speech_ms,
            min_silence_duration_ms=self.min_silence_ms,
            speech_pad_ms=self.speech_pad_ms,
            return_seconds=True,
            visualize_probs=False,
        )
        if self.neg_threshold is not None:
            kwargs["neg_threshold"] = self.neg_threshold

        ts = get_speech_timestamps(**kwargs)  # [{'start': s, 'end': e}] seconds
        out: List[Tuple[float, float]] = []
        for d in ts:
            s = float(d["start"])
            e = float(d["end"])
            if e > s:
                out.append((s, e))
        return out
