# Qwen3.8-27B-FP8 vLLM Server

Docker-based, OpenAI-compatible inference server for
[`Qwen/Qwen3.8-27B-FP8`](https://huggingface.co/Qwen/Qwen3.8-27B-FP8)
(27B, FP8 weights, multimodal: text + image + video), served by a patched
`vllm/vllm-openai` nightly image built locally by the `Makefile`. Speculative
decoding uses the DFlash2 parallel drafter
([`incoai/Qwen3.8-27B-DFlash2`](https://huggingface.co/incoai/Qwen3.8-27B-DFlash2),
7 speculative tokens).

Everything is driven by the `Makefile`: it builds the patched image from
pinned, immutable upstream revisions, downloads the model into `./model`,
and provides status/metrics endpoints, a smoke-test client, and an online
serving benchmark.

In the multi-project release this server is the VLM of workflow
configuration **L** (port 8920).

## Requirements

- Linux with NVIDIA drivers, Docker + NVIDIA Container Toolkit
- One NVIDIA H200 (SM90, ~140 GiB); the defaults target TP=1 on a shared GPU
- `uv` (runs the smoke-test client) and the `hf` CLI
  (`uv tool install huggingface-hub`) for the model download
- `HF_TOKEN` in `.env` if the model repositories require authentication

## Quickstart

```bash
make setup     # build the patched vLLM image + download the model
make start     # start the container on port 8920
make status    # container state + /v1/models
make test      # API smoke test: streaming, multiturn, tools, multimodal
make stop
```

Logs: `make logs` (follow) or `make log-once` (snapshot). Restart with
`make restart`. The server requires an API key
(`API_KEY` in `.env`, sent as `Authorization: Bearer ...`).

## Patched vLLM image

`make build` does not use a stock nightly. It fetches vLLM at an exact base
revision (`VLLM_BASE_REF`), cherry-picks two immutable patchsets on top —
dynamic-K=0 speculative decoding with the opt-in draft skip and conditional
EAGLE last-hit-unit drop (vLLM #53670), plus the DFlash2 construction and
unused-vocabulary fixes (vLLM #53612 / PR #53662) — and builds the
`vllm-openai` target reusing the precompiled wheel of the base revision
(`VLLM_USE_PRECOMPILED=1`, no CUDA/C++ recompile). Every applied revision is
pinned by SHA; no moving PR ref is used. `make patch-info` shows the labels
baked into the built image, `make pull` fetches the unmodified upstream
nightly for comparison.

## Makefile targets

| Target | What it does |
|---|---|
| `setup` | `build` + `download` |
| `build` | Build the patched `local/vllm-openai:qwen38-h200-k0-prefix` image |
| `pull` | Pull the unmodified `vllm/vllm-openai:nightly` comparison image |
| `download` | Download `Qwen/Qwen3.8-27B-FP8` into `./model` |
| `start` / `stop` / `restart` | Start / remove / replace the server container |
| `status` | Container state and `/v1/models` |
| `health` | Query `/health` |
| `logs` / `log-once` | Follow / dump container logs |
| `version` | Print vLLM / transformers / torch / CUDA versions inside the image |
| `image-info` / `patch-info` | Image ID/digests / baked-in upstream ref + patchset id |
| `metrics` | Live Prometheus metrics |
| `mtp-metrics` | Speculative-decoding acceptance metrics only |
| `bench` | `vllm bench serve` against the running server; results in `benchmarks/` |
| `test` | Live API smoke test via `smoke_test.py` |

## Configuration

Override per invocation (`make start GPU_NO=1`) or via `.env`. Key defaults:

| Variable | Default | Meaning |
|---|---|---|
| `PORT` | `8920` | Host port mapped to container port 8000 |
| `GPU_NO` | `0` | Host GPU index (resolved to a UUID for `--gpus`) |
| `MODEL` / `SERVED_NAME` | `Qwen/Qwen3.8-27B-FP8` / `Qwen3.8-27B-FP8` | HF model id / served name |
| `MAX_LEN` | `256000` | Context window (native: 262144; `65536` is a lighter alternative) |
| `MAX_SEQS` / `MAX_BATCH_TOKENS` | `4` / `8192` | Interactive low-concurrency scheduler limits |
| `GPU_MEM_UTIL` | `0.50` | Admission-check fraction on the shared H200 |
| `KV_CACHE_MEMORY` | `28G` | Explicit KV allocation (`--kv-cache-memory-bytes`) |
| `KV_QUANT` | `fp8_e4m3` | Native FP8 KV cache |
| `SPEC_DECODE` / `DRAFT_MODEL` / `NUM_SPEC_TOKENS` | `1` / `incoai/Qwen3.8-27B-DFlash2` / `7` | DFlash2 speculative decoding |
| `PREFIX_CACHING` | `1` | Prefix caching on |
| `VIDEO_FPS` / `VIDEO_PROFILE_FRAMES` | `1` / `32` | Video sampling / profiling hints (608x448) |
| `CHAT_TEMPLATE` | empty | Optional external chat template, e.g. `$(CURDIR)/chat_template.jinja` |
| `BENCH_*` | 1024/1024 tokens, 16 prompts, concurrency 1 | Online benchmark shape |

Storage: model weights live in `./model` (also the HF/vLLM cache root),
shared sample media in `../sample_data` (read-only at `/sample_data`, passed
as `--allowed-local-media-path`), benchmark results in `benchmarks/`.

## Notes

- Both `--gpu-memory-utilization` and `--kv-cache-memory-bytes` are set
  deliberately: current vLLM still runs the free-memory admission check
  against the fraction, while the KV pool is sized explicitly.
- The server enables the `qwen3` reasoning parser, auto tool choice with the
  `qwen3_coder` parser, and xgrammar structured output with whitespace
  disabled.
- Multimodal is limited to one image and one video per prompt; multimodal
  profiling stays on for a shared GPU (`SKIP_MM_PROFILING=1` only if you
  know what you are doing).
- `make test` runs `smoke_test.py` with modes
  `stream|multiturn|tools|multimodal|context|all`
  (`uv run smoke_test.py <mode>`; `context` stresses the full window and
  needs `MAX_LEN` set).
- `make bench BENCH_CONCURRENCY=4 BENCH_NUM_PROMPTS=32` measures aggregate
  throughput under load; each result file is labelled with the patchset id
  and speculative-decoding settings.
