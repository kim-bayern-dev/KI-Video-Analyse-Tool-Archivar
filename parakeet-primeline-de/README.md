# Parakeet Primeline DE Inference Server

Containerized German speech-to-text server: [Parakeet TDT 0.6B v3](https://huggingface.co/nvidia/parakeet-tdt-0.6b-v3)
with the German Primeline ONNX export ([Buttermilk03/parakeet-primeline-onnx](https://huggingface.co/Buttermilk03/parakeet-primeline-onnx))
on ONNX Runtime CUDA, exposing the OpenAI-compatible
`/v1/audio/transcriptions` API. ASR backend of the M workflow configuration
(Qwen3.6-35B + Parakeet) of the multi-project release.

## Server code (`app/`)

`app/` contains the FastAPI transcription service (started via `server.py`,
packaged by `app/Dockerfile.gpu`). It originated from the upstream
[parakeet-tdt-0.6b-v3-fastapi-openai](https://github.com/groxaxo/parakeet-tdt-0.6b-v3-fastapi-openai)
project but has been refactored into a single-model service for this
deployment:

- only the German Primeline ONNX export is served — no model registry, no
  model switching (the OpenAI-compatible `model` field is still validated),
- memory-safe ONNX Runtime CUDA options plus the `PARAKEET_GPU_MEM_LIMIT_GIB`
  arena cap (the ORT CUDA arena never shrinks once grown),
- Silero-VAD pause-aware chunking and cross-request GPU micro-batching.

The legacy upstream files (Flask `app.py`, web UI, compose file, CPU
Dockerfile, multi-model tests) were removed. See `app/README.md` for the
service documentation.

## Model resolution at runtime

The container loads the model **from the Hugging Face Hub**, not from this
checkout: `onnx_asr.load_model("Buttermilk03/parakeet-primeline-onnx")`
resolves/downloads the FP32 model into the HF cache (`/app/models` in the
container, bind-mounted from `MODEL_CACHE_DIR` on the host). No file under
this repo's root is consumed by the running server.

## Requirements

- Docker with the NVIDIA Container Toolkit (`--gpus` must work)
- [uv](https://docs.astral.sh/uv/) on the host (runs the test/benchmark clients)
- the `hf` CLI (`uv tool install huggingface-hub`) for the optional model
  pre-download

## Quickstart

```sh
make setup      # one-time: seed .env from .env.example, prepare host dirs,
                # build the image from app/Dockerfile.gpu
make download   # optional: pre-download the model (the server also downloads
                # it automatically on first startup)
make start      # start the container on port 8999
make status     # container state + /health
make test       # transcribe test/reference.m4a/mp3/wav, expect "referenz"
```

Logs: `make logs` (follow) or `make log-once` (snapshot). Stop with
`make stop`, restart with `make restart`.

## Makefile targets

| Target | What it does |
|---|---|
| `setup` | One-time setup: `env-init` + `prepare` (host cache dirs) + `build` |
| `env-init` | Create `.env` from `.env.example` if `.env` is absent |
| `build` / `rebuild` | Build the image from `app/Dockerfile.gpu` (rebuild: no cache) |
| `download` | Pre-download the model into the host model cache (honors `HF_TOKEN` from `.env`) |
| `start` / `stop` / `restart` | Start / remove / restart the server container |
| `status` | Show container state and `/health` |
| `health` | Query `/healthz` |
| `logs` / `log-once` | Follow / dump container logs |
| `test` | Transcribe `test/reference.m4a`, `test/reference.mp3`, `test/reference.wav` under `DATA_DIR`; each transcript must contain "referenz" |
| `test-python-client` | Run `test-python-client.py` against the API (prints transcript, processing time, RTF) |
| `bench` | Run `benchmark.py` (8 concurrent clients x 1 request); reports QPS, latency, RTF |

## Configuration

Override on the command line, e.g. `make start PORT=9000`, or via `.env`
(gitignored, auto-loaded; seeded from `.env.example` by `make setup`) for
values like `API_KEY`/`HF_TOKEN`/`DATA_DIR`.

| Variable | Default | Meaning |
|---|---|---|
| `PORT` | `8999` | Host port mapped to container port `5092` |
| `GPU_NO` | `0` | Host GPU index (resolved to a UUID for `--gpus`) |
| `MODEL` / `SERVED_NAME` | `Buttermilk03/parakeet-primeline-onnx` | HF model id / served name |
| `DATA_DIR` | `./files` | Test assets; mounted read-only at `/sample_data` (see below) |
| `MODEL_CACHE_DIR` | `$HF_HOME/parakeet-tdt-0.6b-v3` | Host model cache; mounted at `/app/models` |
| `MAX_BATCH_SIZE` / `BATCH_WINDOW_MS` | `2` / `4` | GPU micro-batching bounds |
| `CHUNK_TARGET_SEC` / `CHUNK_MAX_SEC` / `CHUNK_MIN_SEC` | `15` / `20` / `5` | VAD chunking bounds (seconds) |
| `GPU_MEM_LIMIT_GIB` | `6` | Hard cap for the ONNX Runtime CUDA arena (0 disables) |
| `ORT_INTRA_THREADS` / `ORT_INTER_THREADS` | `1` / `1` | ONNX Runtime threading |
| `AUDIO_WORKERS` / `UVICORN_WORKERS` | `8` / `1` | Audio decode / HTTP workers |

The batch/chunk defaults are VRAM-safe: the ORT CUDA arena never shrinks once
grown, so padded batch cost must stay bounded. Benchmark before raising them.

> **Note on `API_KEY`**: client-side compatibility only-the server does not
> validate `Authorization` headers.

## Test-data layout

`make test`/`bench` expect `$(DATA_DIR)/test/reference.{m4a,mp3,wav}`, i.e.
point `DATA_DIR` at the shared `../sample_data` checkout of the release (the
committed `.env.example` does this). The committed `./files/reference.*`
copies are flat (no `test/` subdir), so the default `DATA_DIR=./files` does
not satisfy the test/bench layout on its own.

## Host-side tooling

- `test-python-client.py`-single-file transcription client (used by `make test`).
- `benchmark.py`-concurrent benchmark for `/v1/audio/transcriptions` (used by `make bench`).
