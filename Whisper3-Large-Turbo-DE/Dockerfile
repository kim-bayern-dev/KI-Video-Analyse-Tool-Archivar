# Dockerfile for Whisper3-Large-Turbo-DE (Whisper large v3 turbo, German ASR)
# Base image: vllm/vllm-openai with audio dependencies installed

FROM vllm/vllm-openai:v0.24.0-ubuntu2404 AS base

ARG DEBIAN_FRONTEND=noninteractive

# Install system dependencies for audio processing
RUN <<EOF
apt-get update -y && apt-get install -y --no-install-recommends \
    ffmpeg \
    libsndfile1 \
    git \
    git-lfs \
&& rm -rf /var/lib/apt/lists/*
EOF

# Install vLLM audio dependencies
RUN uv pip install --system "vllm[audio]"

# Install additional Python packages used by the test/benchmark tooling
RUN uv pip install --system \
    fastapi \
    uvicorn \
    python-multipart \
    requests \
    soundfile \
    scipy \
    psutil

WORKDIR /workspace

# Expose the vLLM API port
EXPOSE 8000

# Default command - vLLM serve is started via Makefile
CMD ["bash"]
