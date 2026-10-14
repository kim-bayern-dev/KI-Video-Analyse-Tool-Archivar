"""FastAPI application factory and resource lifespan."""
from __future__ import annotations

import asyncio
from concurrent.futures import ThreadPoolExecutor
from contextlib import asynccontextmanager

from fastapi import FastAPI

from .batchworker import create_inference_backend
from .config import AUDIO_DECODE_WORKERS, logger
from .model import load_asr_model
from .routes import router


def _shutdown_audio_pool(pool: ThreadPoolExecutor) -> None:
    pool.shutdown(wait=True, cancel_futures=True)


@asynccontextmanager
async def service_lifespan(app: FastAPI):
    app.state.ready = False
    app.state.inference_backend = None
    app.state.audio_pool = ThreadPoolExecutor(
        max_workers=AUDIO_DECODE_WORKERS, thread_name_prefix="audio"
    )
    try:
        logger.info("Lifespan startup: loading ASR model")
        await asyncio.to_thread(load_asr_model)
        app.state.inference_backend = create_inference_backend(load_asr_model)
        await app.state.inference_backend.start()
        app.state.ready = True
        logger.info("Service ready")
        yield
    finally:
        app.state.ready = False
        logger.info("Lifespan shutdown")
        if app.state.inference_backend is not None:
            await app.state.inference_backend.stop()
        await asyncio.to_thread(_shutdown_audio_pool, app.state.audio_pool)


def build_application() -> FastAPI:
    application = FastAPI(
        title="Parakeet Primeline DE",
        version="2.0.0",
        description=(
            "OpenAI-compatible ASR service for the German Primeline export of "
            "Parakeet TDT 0.6B v3, running on ONNX Runtime."
        ),
        lifespan=service_lifespan,
    )
    application.include_router(router)
    return application


app = build_application()
