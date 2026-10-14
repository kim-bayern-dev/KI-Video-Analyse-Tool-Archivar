# syntax=docker/dockerfile:1.7

# Pinned image proven by segment-temporal; FFmpeg includes NVDEC and NVENC.
FROM lscr.io/linuxserver/ffmpeg@sha256:595345f99ed5ecbe773388553baa9a0c0cd8f097aa76d3dc89a6b5b7dbee9c4b

USER root
SHELL ["/bin/bash", "-o", "pipefail", "-c"]

ENV DEBIAN_FRONTEND=noninteractive \
    PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    HOME=/tmp \
    XDG_CACHE_HOME=/tmp/.cache \
    TORCH_HOME=/models/torch \
    TORCHINDUCTOR_CACHE_DIR=/tmp/torchinductor \
    UV_PROJECT_ENVIRONMENT=/opt/segment-scenes \
    UV_LINK_MODE=copy \
    PATH=/opt/segment-scenes/bin:/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin

COPY --from=ghcr.io/astral-sh/uv:0.12.0 /uv /uvx /bin/

RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates \
      g++ \
      python3 \
      python3-venv \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY pyproject.toml uv.lock README.md /app/
COPY src /app/src

# grep -q closes the pipe on the first match; under this image's `pipefail` shell the
# still-running ffmpeg (notably the long `-encoders` listing) then receives SIGPIPE
# (exit 141) and aborts the build. Wrap the producer in `{ ... || true; }` to swallow
# that benign signal while keeping the capability assertion meaningful.
RUN uv sync --frozen --no-dev --no-cache \
    && segment-scenes --help >/dev/null \
    && python3 -c 'import torch; assert torch.__version__.startswith("2.8.0"); assert torch.version.cuda == "12.8"' \
    && { ffmpeg -hide_banner -hwaccels 2>/dev/null || true; } | grep -q cuda \
    && { ffmpeg -hide_banner -encoders 2>/dev/null || true; } | grep -q h264_nvenc

RUN mkdir -p /models /data /tmp/.cache /tmp/torchinductor \
    && chmod 0777 /models /data /tmp/.cache /tmp/torchinductor

VOLUME ["/models", "/data"]
EXPOSE 8000

HEALTHCHECK --interval=10s --timeout=5s --start-period=120s --retries=3 \
  CMD python3 -c 'from urllib.request import urlopen; urlopen("http://127.0.0.1:8000/health", timeout=3).read()' || exit 1

ENTRYPOINT ["uvicorn"]
CMD ["segment_scenes.api:app", "--host", "0.0.0.0", "--port", "8000", "--workers", "1"]
