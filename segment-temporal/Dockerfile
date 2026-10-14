# syntax=docker/dockerfile:1.7

# Same pinned FFmpeg image used by the proven fast preprocessing script.
# It contains the NVDEC/NVENC-enabled FFmpeg build; Python/VAD are layered on top.
FROM lscr.io/linuxserver/ffmpeg@sha256:595345f99ed5ecbe773388553baa9a0c0cd8f097aa76d3dc89a6b5b7dbee9c4b

USER root
SHELL ["/bin/bash", "-o", "pipefail", "-c"]

ENV DEBIAN_FRONTEND=noninteractive \
    PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    TORCH_HOME=/models \
    HOME=/tmp \
    XDG_CACHE_HOME=/tmp/.cache \
    NUMBA_CACHE_DIR=/tmp/numba-cache \
    MPLCONFIGDIR=/tmp/matplotlib \
    UV_PROJECT_ENVIRONMENT=/opt/segment-temporal \
    UV_LINK_MODE=copy \
    PATH=/opt/segment-temporal/bin:/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin

COPY --from=ghcr.io/astral-sh/uv:0.12.0 /uv /uvx /bin/

RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates \
      libsndfile1 \
      python3 \
      python3-venv \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY pyproject.toml uv.lock README.md /app/
COPY src /app/src
# In-container preprocess fallback script (no docker-in-docker); opt-in via env.
COPY scripts/preprocess_video.sh /app/scripts/preprocess_video.sh

# Dependencies are resolved by uv. Torch/Torchaudio come from the explicit CPU
# wheel index because Silero ONNX inference does not need CUDA PyTorch.
# --frozen: build against the committed uv.lock for reproducible dependency versions.
RUN uv sync --frozen --no-dev --no-cache \
    && segment-temporal --help >/dev/null \
    && ffmpeg -hide_banner -version >/dev/null \
    && ffprobe -hide_banner -version >/dev/null

RUN mkdir -p /models /data /input /tmp/.cache /tmp/numba-cache /tmp/matplotlib \
    && chmod 0777 /models /data /input /tmp/.cache /tmp/numba-cache /tmp/matplotlib \
    && chmod +x /app/scripts/preprocess_video.sh

VOLUME ["/models", "/data"]

ENTRYPOINT ["segment-temporal"]
CMD ["--help"]
