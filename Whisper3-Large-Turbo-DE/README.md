# Whisper3-Large-Turbo-DE Inference Server

Containerized [Whisper large v3 turbo (German)](https://huggingface.co/primeline/whisper-large-v3-turbo-german)
transcription server using vLLM (OpenAI-compatible audio API). ASR server of
the release's **L** configuration; runs on a single GPU with a minimal VRAM
footprint.

## Requirements

- Docker with the NVIDIA Container Toolkit (`--gpus` must work)
- [uv](https://docs.astral.sh/uv/) on the host (runs the test/benchmark clients)
- the Hugging Face CLI (`uv tool install huggingface-hub`) for model download

## Quickstart

```sh
make setup    # build the image and download the model weights
make start    # start the container on port 8998 (follows the logs)
make status   # container state + served model list
make test     # transcribe reference.m4a/mp3/wav, expect "referenz"
```

Logs: `make logs` (follow) or `make log-once` (snapshot)-wait for
"Application startup complete". Stop with `make stop`, restart with
`make restart`.

## Makefile targets

| Target | What it does |
|---|---|
| `setup` | `build` + `download` |
| `build` | Build the image from the Dockerfile (vLLM base + ffmpeg + `vllm[audio]`) |
| `download` | Download the model into the Hugging Face cache (honors `HF_TOKEN` from `.env` if set) |
| `start` / `stop` / `restart` | Start / remove / restart the server container |
| `status` | Show container state and `/v1/models` |
| `logs` / `log-once` | Follow / dump container logs |
| `test` | Run `test-python-client`, then transcribe `reference.m4a`, `reference.mp3`, `reference.wav`; each transcript must contain "referenz" |
| `test-python-client` | Transcribe one file via `test-python-client.py` (prints transcript, processing time, RTF) |
| `bench` | Concurrent benchmark via `benchmark.py`; reports QPS, latency and RTF percentiles |

## Configuration

Override on the command line, e.g. `make start PORT=9000`, or via `.env`
(gitignored, auto-loaded) for secrets like `API_KEY`/`HF_TOKEN`.

| Variable | Default | Meaning |
|---|---|---|
| `PORT` | `8998` | Host port mapped to container port 8000 |
| `GPU_NO` | `1` | Host GPU index (resolved to a UUID for `--gpus`) |
| `MODEL` / `SERVED_NAME` | `primeline/whisper-large-v3-turbo-german` / `Whisper3-Large-Turbo-DE` | Model id / served name |
| `GPU_MEM_UTIL` | `0.0185` | Minimal-VRAM setting; raise for a larger KV pool / more concurrency |
| `KV_QUANT` | `fp8_e4m3` | KV cache dtype (empty disables) |
| `ATTN_BACKEND` | `TRITON_ATTN` | Attention backend |
| `MAX_LEN` | `448` | Decoder context length (model maximum) |
| `MAX_SEQS` | `8` | Max resident sequences |
| `MAX_BATCH_TOKENS` | `1500` | Encoder positions / max batched tokens per step |
| `DTYPE` | `auto` | Model weight dtype |
| `API_KEY` | `your-api-key` | Bearer key required by the server |
| `HF_HOME` | `~/.cache/huggingface` | Model cache; mounted into the container at the same path |
| `DATA_DIR` | `./files` | Test-media directory; mounted read-only at `/sample_data` |
| `VLLM_CACHE_DIR` | `./cache` | vLLM compile caches; mounted over `/root/.cache` to speed up restarts |

## Test-data mount contract

`$(DATA_DIR)` is bind-mounted read-only at `/sample_data` in the container and
the server runs with `--allowed-local-media-path /sample_data`. The release
convention is to point `DATA_DIR` at the shared sibling directory
`../sample_data` (on the command line or via `.env`). The `test` and
`test-python-client` targets upload `$(DATA_DIR)/test/reference.*` from the
host, so the reference files must exist under that path.

## Endpoint

### POST /v1/audio/transcriptions

Standard OpenAI-compatible audio transcription endpoint:

```bash
curl -X POST "http://localhost:8998/v1/audio/transcriptions" \
  -H "Authorization: Bearer your-api-key" \
  -F "file=@audio.wav" \
  -F "model=Whisper3-Large-Turbo-DE" \
  -F "language=de" \
  -F "response_format=json"
```

**Response**:
```json
{"text": "Das ist ein Referenztext."}
```

### Clients

`test-python-client.py` transcribes a single file and reports processing time
and Real-Time Factor (RTF):

```bash
uv run test-python-client.py \
  -e http://localhost:8998/v1/audio/transcriptions \
  -f ../sample_data/test/reference.wav \
  -m Whisper3-Large-Turbo-DE
```

`benchmark.py` fires concurrent transcription requests and reports QPS,
latency and RTF percentiles:

```bash
make bench
```
