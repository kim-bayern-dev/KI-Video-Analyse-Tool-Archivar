# Qwen3.6-35B-A3B-GPTQ-Int4-vLLM Server

Docker-based, OpenAI-compatible inference server for
[`palmfuture/Qwen3.6-35B-A3B-GPTQ-Int4`](https://huggingface.co/palmfuture/Qwen3.6-35B-A3B-GPTQ-Int4)
(35B total / ~3B active MoE, 4-bit GPTQ, multimodal: text + image + video),
served by the pinned `vllm/vllm-openai:v0.29.0` image. Speculative decoding
uses a separate BF16 DFlash drafter
([`z-lab/Qwen3.6-35B-A3B-DFlash`](https://huggingface.co/z-lab/Qwen3.6-35B-A3B-DFlash)).

Everything is driven by the `Makefile`: it pulls and version-checks the image,
downloads both models into `./model` locked to immutable Hugging Face
revisions, runs a runtime preflight before every start, and provides live
smoke tests plus offline regression tests.

In the multi-project release this server is the VLM of workflow
configuration **M** (port 8931).

## Requirements

- Linux with NVIDIA drivers, Docker + NVIDIA Container Toolkit
- One NVIDIA GPU: RTX 6000 Ada (SM89), H100, or H200 (SM90)-select the
  matching `PROFILE`
- `python3` on the host (orchestrator and offline tests)
- `uv` (only for the deeper `make smoke` client tests)
- `HF_TOKEN` in `.env` if the model repositories require authentication

## Quickstart

```bash
make setup     # pull + verify the image, download/lock target and drafter
make start     # preflight (GPU, weights, draft metadata), start, await readiness
make status    # container state + served model list
make test      # live HTTP smoke: text, streaming, JSON schema, tool call
make stop
```

`make deploy` runs build + download + start + live smoke tests in sequence.
`make doctor` reruns the preflight without touching the server. Logs:
`make logs` (follow) or `make log-once` (snapshot); both also write a copy
into `logs/`. Restart with `make restart` (preflight runs before the old
container is removed).

## Hardware profiles

```bash
make start PROFILE=ada    # RTX 6000 Ada 48 GB, SM89
make start PROFILE=h100   # H100 80 GB, SM90
make start PROFILE=h200   # H200 141 GB, SM90 (default)
```

A profile only sets the `GPU_MEM_UTIL` admission fraction; it never selects a
different physical GPU (use `GPU_NO`/`GPU_UUID`/`GPU_DEVICE` for that). Set
`PROFILE` in `.env` or per invocation - `make variant-h200` and friends only
print this guidance. GB10 / DGX Spark is outside this package
(`make variant-gb10` refuses).

## Makefile targets

| Target | What it does |
|---|---|
| `setup` | `build` + `download` |
| `build` | Pull the pinned image and verify its vLLM version (no GPU needed) |
| `download` | Download/lock target + drafter to immutable HF revisions |
| `start` / `stop` / `restart` | Preflight + start / remove / replace the container |
| `deploy` | Sequential build + download + start + live smoke tests |
| `doctor` | Runtime preflight only: GPU, weight files, draft metadata |
| `status` | Container state and `/v1/models` |
| `logs` / `log-once` | Follow / snapshot Docker logs into `logs/` |
| `metrics` | Print live Prometheus metrics |
| `test` | Live HTTP smoke checks against the running server (not a benchmark) |
| `smoke` | Deeper uv-based client tests; `SMOKE_MODE=stream\|multiturn\|tools\|multimodal\|context\|all` |
| `check` | Offline regression tests; no Docker/GPU/network required |
| `paths` | Show host/container storage mappings |
| `print-config` | Print the effective vLLM arguments (API key redacted) |
| `flatten` | Optional resolved copy of a locked snapshot (`FLAT_WHICH=model\|draft`) |

## Configuration

Variables come from the Makefile defaults, then `.env` (override with
`ENV_FILE=...`), then the command line-command-line assignments win. Common
overrides:

```bash
make start GPU_NO=0            # pick a different GPU
make start MAX_LEN=131072      # within the native 262144 window
make start NO_REASONING=1      # default enable_thinking=false (lower latency)
make start LLM_ONLY=1          # text-only, no vision encoder
make download REFRESH_MODELS=1 # deliberately move the locked HF revisions
```

Key defaults: port `8931`, GPU 1, `MAX_LEN=65536`, `MAX_SEQS=4`,
`BATCH_TOKS=8192`, explicit KV budget `KV_CACHE_BYTES=8G` (empty = pure
fraction-based sizing), `KV_QUANT=bfloat16` with `FLASH_ATTN`, DFlash with
`NUM_SPEC_TOKENS=3`, prefix caching on, thinking allowed
(`NO_REASONING=0`). `QUANTIZATION` stays empty on purpose: vLLM reads the
checkpoint's GPTQ metadata-forcing `moe_wna16` is rejected. On Ada, FP8 KV
cache requires `ATTN_BACKEND=TRITON_ATTN`.

Storage: model weights live in `./model` (mounted at `/hf`, including the
complete HF cache so in-container symlinks resolve), shared sample media in
`../sample_data` (read-only at `/sample_data`, passed as
`--allowed-local-media-path`). The download lock lives in
`.state/model-lock.json`; launch reports go to `outputs/`.

## Notes

- The DFlash drafter is a separate BF16 checkpoint; its KV dtype and
  attention backend are configured independently of the target
  (`DRAFT_KV_QUANT`, `DRAFT_ATTN_BACKEND`). It requires
  `VLLM_USE_V2_MODEL_RUNNER=1` (mixed sliding/full attention).
- YaRN (`ROPE_ENABLED=1`) is off deliberately: it changes target positions
  but does not extend the drafter.
- Multimodal stays enabled: one image and one video (32 frames at 608x448,
  1 fps) per prompt by default.
- Suggested sampling for concise non-thinking answers: `temperature=0.7`,
  `top_p=0.8`, `top_k=20`, `presence_penalty=1.5` (as used by
  `smoke_test.py`).
