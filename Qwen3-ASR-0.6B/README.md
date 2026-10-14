# Qwen3-ASR-0.6B Inference Server

Containerized [Qwen3-ASR-0.6B](https://huggingface.co/Qwen/Qwen3-ASR-0.6B)
transcription server using vLLM (OpenAI-compatible API). Runs on a single
GPU (default: GPU 0, sized for an 8 GB card) with a fixed KV-cache budget.

> **Note**: Qwen3-ASR is a multimodal model that processes audio through the
> chat API. Transcription results are returned in the `reasoning` field as
> `language <lang><asr_text><transcript>`.

## Requirements

- Docker with the NVIDIA Container Toolkit (`--gpus` must work; use the host
  daemon, i.e. `docker context use default` if Docker Desktop is installed)
- [uv](https://docs.astral.sh/uv/) on the host (runs the test/benchmark clients)
- the `hf` CLI (`uv tool install huggingface-hub`) for model download

## Quickstart

```sh
make setup         # one-time: build the image + fetch the model into ./model
                   # (equivalent: make build-image && make download)
make start         # start the container on port 8932
make status        # container state + served model list
make test          # transcribe reference.m4a/mp3/wav, expect "referenz"
```

Logs: `make logs` (follow) or `make log-once` (snapshot)-wait for
"Application startup complete". Stop with `make stop`, restart with
`make restart`.

## Makefile targets

| Target | What it does |
|---|---|
| `setup` | One-time setup: `build-image` + `download` |
| `build-image` | Build `qwen3-asr-0.6b-audio` from the Dockerfile (vLLM base + ffmpeg + `vllm[audio]`) |
| `download` | Download the model into `./model` (honors `HF_TOKEN` from `.env` if set) |
| `start` / `stop` / `restart` | Start / remove / restart the server container |
| `status` | Show container state and `/v1/models` |
| `logs` / `log-once` | Follow / dump container logs |
| `test` | Transcribe `reference.m4a`, `reference.mp3`, `reference.wav` via `file:///sample_data/test/...`; each transcript must contain "referenz" |
| `test-streaming` | Run `client-streaming.py` against the chat completions API (prints transcript, processing time, RTF) |
| `benchmark-streaming` | 4 clients x 20 requests through `client-streaming.py`; reports QPS, latency, RTF |
| `benchmark-batch` | 4 clients x 20 requests via direct curl on `/v1/chat/completions`; reports QPS and latency |

## Configuration

Override on the command line, e.g. `make start MAX_LEN=8192`, or via `.env`
(gitignored, auto-loaded) for secrets like `API_KEY`/`HF_TOKEN`.

| Variable | Default | Meaning |
|---|---|---|
| `PORT` | `8932` | Host port mapped to container port 8000 |
| `GPU_NO` | `0` | Host GPU index (resolved to a UUID for `--gpus`) |
| `MODEL` / `SERVED_NAME` | `Qwen/Qwen3-ASR-0.6B` / `Qwen3-ASR-0.6B` | Model id / served name |
| `GPU_MEM_UTIL` | `0.0025` | Only has to pass vLLM's free-memory validation; KV sizing comes from `KV_CACHE_SIZE` (`--kv-cache-memory-bytes` skips memory profiling) |
| `KV_CACHE_SIZE` | `1G` | Fixed KV-cache budget (fp8: ~57K B/token → ~18.7K tokens) |
| `KV_QUANT` | `fp8_e4m3` | KV cache dtype; halves KV bytes vs native dtype (empty disables) |
| `ATTENTION_BACKEND` | `triton_attn` | Accepts fp8 KV; flash_attn rejects fp8 KV on this GPU (needs FA3/SM90) |

Alternative configs for other GPUs (override on the command line):

```bash
# GPU with enough VRAM for a bf16 KV pool (any arch):
make start ATTENTION_BACKEND=flash_attn KV_QUANT= KV_CACHE_SIZE=1G
# Hopper (SM90, FA3 supports fp8 KV)-auto-select:
make start ATTENTION_BACKEND= KV_QUANT=fp8_e4m3
```
| `MAX_LEN` / `MAX_SEQS` | `4096` / `2` | Max context / resident sequences |
| `MAX_BATCH_TOKENS` | `2048` | Max batched tokens per step |
| `TP` | `1` | Tensor-parallel size |
| `HF_HOME` | `./model` | Model cache; mounted absolute at `/hf` in the container (`HF_HOME=/hf`) |
| `DATA_DIR` | `../sample_data` | Shared test assets; mounted absolute, read-only, at `/sample_data` |
| `VLLM_CACHE_DIR` | `./cache` | vLLM/flashinfer compile caches; mounted over `/root/.cache` to speed up restarts |

Memory budget on the 8 GB card: ~1.5G weights + 1G KV + CUDA graphs +
~600M CUDA context/kernels + allocator slack.

## Test-data mount contract

The shared test assets live in the sibling directory `../sample_data` and are
bind-mounted read-only at `/sample_data` in the container. The server runs
with `--allowed-local-media-path /sample_data`, so requests can reference
audio as `file:///sample_data/test/...` URLs (e.g.
`file:///sample_data/test/reference.wav`), resolved against the *container*
filesystem.

## Endpoints

### POST /v1/chat/completions

Chat completions API with `audio_url` content type-this is what `make
test`, `test-streaming` and the benchmarks use:

```bash
curl -X POST "http://localhost:8932/v1/chat/completions" \
  -H "Authorization: Bearer your-api-key" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "Qwen3-ASR-0.6B",
    "messages": [{
      "role": "user",
      "content": [{"type": "audio_url", "audio_url": {"url": "file:///sample_data/test/reference.wav"}}]
    }]
  }'
```

**Response** (transcription in the `reasoning` field):
```json
{
  "choices": [{
    "message": {
      "reasoning": "language German<asr_text>Das ist ein Referenztext."
    }
  }]
}
```

> **Extracting the transcript**: it is in `reasoning` after `<asr_text>`.
> Format: `language <lang_code><asr_text><transcript>`.

### Streaming client

`client-streaming.py` wraps the chat completions API and reports processing
time and Real-Time Factor (RTF):

```bash
uv run client-streaming.py \
  -e http://localhost:8932/v1/chat/completions \
  -f /sample_data/test/reference.wav
```

> **Note**: this is **not true streaming** (no WebSocket/SSE)-it uses the
> standard completions API, which is fast enough for most use cases where
> real-time streaming is not strictly required. The printed RTF is computed
> from the real audio duration, probed locally with `ffprobe` (the
> `/sample_data/...` container path is mapped back to the host via `DATA_DIR`).

### Benchmarks

```bash
make benchmark-streaming   # via client-streaming.py, includes RTF
make benchmark-batch       # direct curl, latency/QPS only
```
