from __future__ import annotations

import os
from dataclasses import dataclass
from enum import Enum
from pathlib import Path


class ModelOffloading(str, Enum):
    NEVER = "NEVER"
    TIMEOUT = "TIMEOUT"
    IMMEDIATE = "IMMEDIATE"

    @classmethod
    def parse(cls, value: str) -> "ModelOffloading":
        try:
            return cls(value.strip().upper())
        except ValueError as exc:
            choices = ", ".join(item.value for item in cls)
            raise ValueError(f"MODEL_OFFLOADING must be one of: {choices}") from exc


def _env_bool(name: str, default: bool) -> bool:
    raw = os.environ.get(name)
    if raw is None:
        return default
    normalized = raw.strip().lower()
    if normalized in {"1", "true", "yes", "on"}:
        return True
    if normalized in {"0", "false", "no", "off"}:
        return False
    raise ValueError(f"{name} must be a boolean (1/0, true/false, yes/no, on/off)")


def _env(primary: str, lowercase_alias: str, default: str) -> str:
    """Prefer conventional uppercase env names while accepting requested aliases."""
    return os.environ.get(primary, os.environ.get(lowercase_alias, default))


@dataclass(frozen=True)
class Settings:
    model_offloading: ModelOffloading = ModelOffloading.NEVER
    model_offloading_timeout: float = 60.0
    model_path: Path = Path("/models/transnetv2-pytorch-weights.pth")
    device: str = "cuda"
    allowed_file_roots: tuple[Path, ...] = (Path("/data"),)
    torch_compile: bool = False
    torch_compile_mode: str = "reduce-overhead"
    ffmpeg_acceleration: str = "auto"

    @classmethod
    def from_env(cls) -> "Settings":
        roots_raw = os.environ.get("ALLOWED_FILE_ROOTS", "/data")
        roots = tuple(Path(item).resolve() for item in roots_raw.split(":") if item.strip())
        settings = cls(
            model_offloading=ModelOffloading.parse(_env("MODEL_OFFLOADING", "model_offloading", "NEVER")),
            model_offloading_timeout=float(
                _env("MODEL_OFFLOADING_TIMEOUT", "model_offloading_timeout", "60")
            ),
            model_path=Path(os.environ.get("MODEL_PATH", "/models/transnetv2-pytorch-weights.pth")),
            device=os.environ.get("DEVICE", "cuda").strip().lower(),
            allowed_file_roots=roots,
            torch_compile=_env_bool("TORCH_COMPILE", False),
            torch_compile_mode=os.environ.get("TORCH_COMPILE_MODE", "reduce-overhead").strip(),
            ffmpeg_acceleration=os.environ.get("FFMPEG_ACCELERATION", "auto").strip().lower(),
        )
        settings.validate()
        return settings

    def validate(self) -> None:
        if self.model_offloading_timeout <= 0:
            raise ValueError("MODEL_OFFLOADING_TIMEOUT must be greater than zero")
        if self.device not in {"auto", "cpu", "cuda"}:
            raise ValueError("DEVICE must be one of: auto, cpu, cuda")
        if not self.allowed_file_roots:
            raise ValueError("ALLOWED_FILE_ROOTS must contain at least one absolute path")
        if any(not root.is_absolute() for root in self.allowed_file_roots):
            raise ValueError("Every ALLOWED_FILE_ROOTS entry must be absolute")
        if self.ffmpeg_acceleration not in {"auto", "cpu", "nvdec"}:
            raise ValueError("FFMPEG_ACCELERATION must be one of: auto, cpu, nvdec")
        if self.torch_compile and self.model_offloading is not ModelOffloading.NEVER:
            raise ValueError("TORCH_COMPILE=1 currently requires MODEL_OFFLOADING=NEVER")
