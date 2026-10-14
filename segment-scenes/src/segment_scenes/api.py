from __future__ import annotations

from contextlib import asynccontextmanager
from typing import Any, Literal

from fastapi import FastAPI, HTTPException
from fastapi.concurrency import run_in_threadpool
from pydantic import BaseModel, ConfigDict, Field, model_validator

from .config import Settings
from .ffmpeg_backend import FFmpegBackend
from .file_uri import FileURIError, resolve_file_uri
from .model_manager import ModelManager
from .pipeline import ProcessingOptions, process_video


class SegmentRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    media: str = Field(description="Input file:// URI inside a mounted data volume")
    output_dir: str | None = Field(
        default=None,
        description="Optional file:// directory inside a mounted data volume",
    )
    threshold: float = Field(default=0.5, ge=0.0, le=1.0)
    min_len: float = Field(default=0.5, gt=0.0)
    max_len: float | None = Field(default=None, gt=0.0)
    fps: float = Field(default=1.0, gt=0, le=120)
    max_width_px: int = Field(default=640, gt=0, le=16384)
    max_height_px: int = Field(default=448, gt=0, le=16384)
    chunk_size: int = Field(default=1000, gt=0)
    visualize: bool = False
    extract_keyframes: bool = False
    quiet: bool = False
    device: Literal["auto", "cpu", "cuda"] | None = None

    @model_validator(mode="after")
    def validate_lengths(self) -> "SegmentRequest":
        # Keep legacy semantics: max_len <= min_len is accepted and ignored by
        # the detector with a warning. Positive-value validation happens above.
        return self


def create_app(
    settings: Settings | None = None,
    *,
    model_manager: ModelManager | None = None,
    ffmpeg_backend: FFmpegBackend | None = None,
) -> FastAPI:
    resolved_settings = settings or Settings.from_env()
    manager = model_manager or ModelManager(resolved_settings)
    backend = ffmpeg_backend or FFmpegBackend(resolved_settings.ffmpeg_acceleration)

    @asynccontextmanager
    async def lifespan(_app: FastAPI):
        await run_in_threadpool(manager.start)
        try:
            yield
        finally:
            await run_in_threadpool(manager.close)

    application = FastAPI(
        title="segment-scenes",
        version="0.5.0",
        lifespan=lifespan,
    )
    application.state.settings = resolved_settings
    application.state.model_manager = manager
    application.state.ffmpeg_backend = backend

    @application.get("/health")
    async def health() -> dict[str, Any]:
        status = manager.status()
        return {"status": "ok" if status["ready"] else "starting", **status}

    @application.post("/v1/segment-scenes")
    async def segment(request: SegmentRequest) -> dict[str, Any]:
        try:
            media_path = resolve_file_uri(
                request.media,
                resolved_settings.allowed_file_roots,
                require_file=True,
            )
            output_path = (
                resolve_file_uri(
                    request.output_dir,
                    resolved_settings.allowed_file_roots,
                    require_file=False,
                )
                if request.output_dir is not None
                else None
            )
        except FileURIError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc

        configured_device = manager.status()["configured_device"]
        if request.device is not None and request.device not in {
            resolved_settings.device,
            configured_device,
        }:
            raise HTTPException(
                status_code=409,
                detail=(
                    f"Per-request device {request.device!r} conflicts with the persistent "
                    f"server device {configured_device!r}"
                ),
            )

        options = ProcessingOptions(
            threshold=request.threshold,
            min_len=request.min_len,
            max_len=request.max_len,
            fps=request.fps,
            max_width_px=request.max_width_px,
            max_height_px=request.max_height_px,
            quiet=request.quiet,
            chunk_size=request.chunk_size,
            visualize=request.visualize,
            extract_keyframes=request.extract_keyframes,
        )

        def run_request() -> dict[str, Any]:
            with manager.model_session() as (model, model_device):
                return process_video(
                    media_path,
                    output_dir=output_path,
                    options=options,
                    model=model,
                    model_device=model_device,
                    ffmpeg_backend=backend,
                )

        try:
            return await run_in_threadpool(run_request)
        except ValueError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc

    return application


app = create_app()
