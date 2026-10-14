from __future__ import annotations

import pytest

from segment_scenes.config import ModelOffloading, Settings


def test_settings_defaults(monkeypatch):
    for name in (
        "MODEL_OFFLOADING",
        "MODEL_OFFLOADING_TIMEOUT",
        "model_offloading",
        "model_offloading_timeout",
        "MODEL_PATH",
        "DEVICE",
        "ALLOWED_FILE_ROOTS",
        "TORCH_COMPILE",
        "FFMPEG_ACCELERATION",
    ):
        monkeypatch.delenv(name, raising=False)

    settings = Settings.from_env()

    assert settings.model_offloading is ModelOffloading.NEVER
    assert settings.model_offloading_timeout == 60.0
    assert str(settings.model_path) == "/models/transnetv2-pytorch-weights.pth"
    assert settings.device == "cuda"


def test_settings_accept_all_offloading_modes(monkeypatch):
    for value in ("never", "TIMEOUT", "Immediate"):
        monkeypatch.setenv("MODEL_OFFLOADING", value)
        assert Settings.from_env().model_offloading.value == value.upper()


def test_settings_accept_requested_lowercase_aliases(monkeypatch):
    monkeypatch.delenv("MODEL_OFFLOADING", raising=False)
    monkeypatch.delenv("MODEL_OFFLOADING_TIMEOUT", raising=False)
    monkeypatch.setenv("model_offloading", "timeout")
    monkeypatch.setenv("model_offloading_timeout", "12.5")

    settings = Settings.from_env()

    assert settings.model_offloading is ModelOffloading.TIMEOUT
    assert settings.model_offloading_timeout == 12.5


def test_compile_and_offloading_are_rejected_together():
    with pytest.raises(ValueError, match="requires MODEL_OFFLOADING=NEVER"):
        Settings(model_offloading=ModelOffloading.TIMEOUT, torch_compile=True).validate()
