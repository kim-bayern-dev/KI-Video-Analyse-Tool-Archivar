"""Pure-Python preprocess-config / encoder-arg tests (no ffmpeg invocation).

Only static shape/validation checks; the actual transcode is exercised in
test/container/ against the image's ffmpeg + real pipeline.
"""
from __future__ import annotations

import pytest

from segment_temporal.preprocess import PreprocessConfig, _encoder_arguments, _gop_size


def test_validate_rejects_nonpositive():
    with pytest.raises(ValueError):
        PreprocessConfig(max_width=0).validate()
    with pytest.raises(ValueError):
        PreprocessConfig(max_height=0).validate()
    with pytest.raises(ValueError):
        PreprocessConfig(output_fps=0).validate()
    with pytest.raises(ValueError):
        PreprocessConfig(output_fps=-0.5).validate()


def test_validate_accepts_defaults():
    PreprocessConfig().validate()  # must not raise


def test_validate_accepts_fractional_fps():
    # 0.5 = one frame every 2s, 0.25 = one frame every 4s.
    PreprocessConfig(output_fps=0.5).validate()
    PreprocessConfig(output_fps=0.25).validate()


def test_gop_size_clamps_fractional_fps_up_to_one():
    assert _gop_size(8) == 8
    assert _gop_size(1.0) == 1
    assert _gop_size(0.5) == 1
    assert _gop_size(0.25) == 1


def test_encoder_args_libx264_has_one_second_gop():
    args = _encoder_arguments("libx264", 8)
    assert "libx264" in args
    # GOP length equals fps so segmentation stream-copy lands on keyframes.
    assert "-g" in args and "8" in args
    assert "-crf" in args


def test_encoder_args_libx264_fractional_fps_every_frame_idr():
    args = _encoder_arguments("libx264", 0.25)
    # Below 1 fps a one-second GOP is under one frame; clamp to 1 (all-IDR).
    assert args[args.index("-g") + 1] == "1"
    assert args[args.index("-keyint_min") + 1] == "1"


def test_encoder_args_nvenc_selects_nvenc():
    args = _encoder_arguments("h264_nvenc", 8)
    assert "h264_nvenc" in args
    assert "-g" in args
    assert "-forced-idr" in args
