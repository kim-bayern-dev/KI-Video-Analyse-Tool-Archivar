#!/usr/bin/env python3
"""Entry point for the Parakeet Primeline transcription server.

Run with::

    python server.py                 # uvicorn defaults
    PARAKEET_USE_GPU=true python server.py
    PARAKEET_PORT=5093 python server.py

Or directly with uvicorn::

    uvicorn parakeet_service.main:app --host 0.0.0.0 --port 5092
"""
from __future__ import annotations

import os

import uvicorn


def run_server() -> None:
    bind_host = os.getenv("PARAKEET_HOST", "0.0.0.0")
    listen_port = int(os.getenv("PARAKEET_PORT", "5092"))
    worker_processes = int(os.getenv("PARAKEET_UVICORN_WORKERS", "1"))
    log_level = os.getenv("LOG_LEVEL", "info").lower()
    uvicorn.run(
        "parakeet_service.main:app",
        host=bind_host,
        port=listen_port,
        workers=worker_processes,
        log_level=log_level,
        access_log=False,
    )


if __name__ == "__main__":
    run_server()
