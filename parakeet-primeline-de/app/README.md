# Parakeet Primeline DE — ASR Service

OpenAI-compatible speech-to-text service for the **German Primeline ONNX
export** of NVIDIA's Parakeet TDT 0.6B v3
([Buttermilk03/parakeet-primeline-onnx](https://huggingface.co/Buttermilk03/parakeet-primeline-onnx)),
running on ONNX Runtime with CUDA (CPU fallback available). Built with
FastAPI, packaged as a single GPU container.

This directory contains the complete server. The recommended way to build,
run and verify it is the Makefile one level up (`../Makefile`); see
`../README.md` for the deployment workflow.

## Supported model

The service is deliberately single-model. Exactly one checkpoint is served:

| | |
|---|---|
| Hugging Face repo | `Buttermilk03/parakeet-primeline-onnx` |
| Base model | `nvidia/parakeet-tdt-0.6b-v3` (TDT, 0.6B) |
| Precision | FP32 |
| Served as (API name) | `buttermilk03/parakeet-primeline-onnx` |

There is no model registry and no runtime model switching. The
OpenAI-compatible `model` form field is still accepted and validated
case-insensitively; any other value is rejected with HTTP 400. The model is
resolved from the Hugging Face Hub into the local cache (`models/` by
default, `/app/models` in the container) on first startup.

## Architecture

```
server.py                    Entry point: uvicorn "parakeet_service.main:app"
parakeet_service/
├── config.py                Env-var settings, validated at import time
├── model.py                 ONNX Runtime session: CUDA preload, providers,
│                            memory-safe arena options, model singleton
├── audio.py                 In-memory decode to 16 kHz mono float32
│                            (PCM WAV fast path, FFmpeg fallback)
├── chunker.py               Silero-VAD pause-aware chunk planning
│                            (energy-VAD fallback, strict size invariants)
├── batchworker.py           Inference backends: MicroBatchWorker (GPU
│                            micro-batching) / ParallelInferencePool (CPU)
├── routes.py                OpenAI-compatible HTTP endpoints
└── main.py                  FastAPI app factory + lifespan (startup/shutdown)
tests/                       Unit tests (no GPU or model download required)
```

Request pipeline for `POST /v1/audio/transcriptions`:

1. Upload is read with a size cap (`MAX_UPLOAD_BYTES`).
2. `audio.py` decodes the payload to a 16 kHz mono float32 waveform — PCM WAV
   files are decoded in process, everything else goes through one FFmpeg call.
3. `chunker.py` plans chunk ranges with Silero VAD, splitting long files at
   pause midpoints while guaranteeing per-chunk size bounds. Files with no
   detected speech skip inference entirely.
4. `batchworker.py` runs recognition: on GPU, a `MicroBatchWorker` coalesces
   chunks across concurrent requests within `MICRO_BATCH_WINDOW_MS`; on CPU, a
   `ParallelInferencePool` fans single-item calls out over
   `INFERENCE_WORKERS` threads.
5. `routes.py` stitches chunk results back together, offsets word/segment
   timestamps, and renders the requested response format.

## API

| Method | Path | Purpose |
|---|---|---|
| `POST` | `/v1/audio/transcriptions` | Transcribe one audio file |
| `POST` | `/v1/audio/transcriptions/batch` | Transcribe multiple files in one request |
| `GET` | `/health` | Status, served/loaded model, CPU thread layout |
| `GET` | `/healthz` | Readiness probe (503 until the model is loaded) |

Form parameters (OpenAI-compatible): `file` (required), `model`
(must equal the served model name), `response_format`
(`json` | `text` | `srt` | `vtt` | `verbose_json`),
`timestamp_granularities[]` (`word` adds word timings to `verbose_json`).
`language`, `prompt` and `temperature` are accepted for client compatibility
and ignored. The server does not validate `Authorization` headers.

```bash
curl -X POST http://localhost:8999/v1/audio/transcriptions \
  -F "file=@reference.wav" \
  -F "model=Buttermilk03/parakeet-primeline-onnx" \
  -F "response_format=json"
```

```python
from openai import OpenAI

client = OpenAI(base_url="http://localhost:8999/v1", api_key="not-required")
with open("reference.wav", "rb") as audio_file:
    transcript = client.audio.transcriptions.create(
        model="buttermilk03/parakeet-primeline-onnx",
        file=audio_file,
    )
print(transcript.text)
```

Interactive API docs (FastAPI/Swagger) are available at `/docs` on a running
server.

## Configuration

All settings are `PARAKEET_*` environment variables, validated at startup
(invalid values abort before the model loads). Defaults shown are the code
defaults; the container image and the parent Makefile ship VRAM-safe GPU
values.

| Variable | Default | Meaning |
|---|---|---|
| `PARAKEET_HOST` / `PARAKEET_PORT` | `0.0.0.0` / `5092` | Bind address (container port) |
| `PARAKEET_UVICORN_WORKERS` | `1` | HTTP worker processes |
| `PARAKEET_USE_GPU` | `true` | `true` = require CUDA, `false` = CPU only, `auto` = try CUDA, fall back to CPU |
| `PARAKEET_GPU_DEVICE_ID` | `0` | CUDA device index |
| `PARAKEET_GPU_MEM_LIMIT_GIB` | `0` (off) | Hard cap of the ORT CUDA arena in GiB |
| `PARAKEET_BATCHED` | GPU: on | Cross-request micro-batching |
| `PARAKEET_MAX_BATCH_SIZE` | `4` | Max waveforms per micro-batch |
| `PARAKEET_BATCH_WINDOW_MS` | `4` | Batch collection window |
| `PARAKEET_INFER_WORKERS` | `4` | Threads of the CPU `ParallelInferencePool` |
| `PARAKEET_CHUNK_TARGET_SEC` / `MAX_SEC` / `MIN_SEC` | `60` / `75` / `20` | VAD chunk-size bounds in seconds |
| `PARAKEET_VAD_THRESHOLD` | `0.5` | Silero speech probability threshold (0–1) |
| `PARAKEET_VAD_MIN_SILENCE_MS` / `SPEECH_PAD_MS` | `400` / `120` | Silence gap / speech padding |
| `PARAKEET_MAX_UPLOAD_BYTES` | `256 MiB` | Per-file upload cap |
| `PARAKEET_MAX_BATCH_FILES` / `MAX_BATCH_BYTES` | `16` / `512 MiB` | Batch endpoint caps |
| `PARAKEET_MAX_AUDIO_SECONDS` | `7200` | Decoded duration cap |
| `PARAKEET_MAX_REQUEST_CHUNKS` | `512` | Total chunks per request |
| `PARAKEET_FFMPEG_TIMEOUT_SEC` | `180` | Per-file FFmpeg decode timeout |
| `PARAKEET_ORT_INTRA_THREADS` / `ORT_INTER_THREADS` | `1` (GPU) | ONNX Runtime threading |
| `PARAKEET_AUDIO_WORKERS` | `min(8, cores)` | Audio decode thread pool |
| `PARAKEET_MODELS_DIR` | `./models` | Model cache (also sets `HF_HOME`/`HF_HUB_CACHE`) |
| `LOG_LEVEL` | `INFO` | Python logging level |

GPU notes: the service preloads the CUDA/cuDNN wheels of the
`onnxruntime-gpu[cuda,cudnn]` extra, pins the arena to
`kSameAsRequested` + heuristic cuDNN search, and verifies at startup that all
ONNX sessions actually bound to the GPU (`PARAKEET_USE_GPU=true` fails hard
otherwise). The ORT arena never shrinks once grown, so keep
`PARAKEET_GPU_MEM_LIMIT_GIB` set on shared GPUs.

## Running

Containerized (recommended — build/run/test via the parent Makefile):

```bash
cd ..
make setup      # build the image from app/Dockerfile.gpu
make start      # serve on port 8999
make test       # transcribe sample files, expect "referenz"
```

Directly on the host (Python 3.10+, FFmpeg installed):

```bash
pip install -r requirements.txt
python server.py                      # serve on :5092
# CPU-only:
PARAKEET_USE_GPU=false PARAKEET_BATCHED=0 python server.py
```

or with uvicorn: `uvicorn parakeet_service.main:app --host 0.0.0.0 --port 5092`.

On hybrid Intel CPUs, `pin_pcores.sh` pins the server to P-cores:
`./pin_pcores.sh python server.py`.

## Tests

```bash
pip install pytest pytest-asyncio numpy
pytest -q
```

The unit tests cover chunk-range invariants and both inference backends with
fake models — no GPU, model download, or network access needed.

## Requirements

- Docker with NVIDIA Container Toolkit for the containerized GPU deployment
- or Python 3.10+ and FFmpeg for host runs
