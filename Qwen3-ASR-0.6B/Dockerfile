# Dockerfile for Qwen3-ASR with vLLM audio support
# Base image: vllm/vllm-openai with audio dependencies installed

FROM vllm/vllm-openai:v0.23.0-ubuntu2404 AS base

ARG DEBIAN_FRONTEND=noninteractive

# Install system dependencies: ffmpeg + libsndfile for audio, git + git-lfs
# for model repository tooling
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

# Install additional Python packages for testing and streaming
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
