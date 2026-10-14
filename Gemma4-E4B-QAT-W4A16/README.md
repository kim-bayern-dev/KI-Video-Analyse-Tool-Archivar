# Gemma4-E4B-QAT-W4A16

Docker-based, OpenAI-compatible inference server for
[`google/gemma-4-E4B-it-qat-w4a16-ct`](https://huggingface.co/google/gemma-4-E4B-it-qat-w4a16-ct)
(Gemma 4 E4B instruction-tuned, QAT W4A16 quantized, multimodal:
text + image + video), served by vLLM.

Everything is driven by the `Makefile`: it pulls the pinned vLLM image,
downloads the model into `./model`, starts a container with a measured,
fixed-budget configuration, and provides smoke/e2e tests and a benchmark
suite.

## Requirements

- Docker with the NVIDIA Container Toolkit (`--gpus` must work)
- An NVIDIA GPU with enough VRAM for the model plus the configured KV pool
  (the defaults target a single 24 GB-class card)
- [uv](https://docs.astral.sh/uv/) on the host (runs the test scripts)
- the `hf` CLI (`uv tool install huggingface-hub`) and an HF token with
  access to the gated model-put it in `.env` as `HF_TOKEN=hf_...`
  (`.env` is gitignored and auto-loaded by the Makefile)

## Quickstart

```sh
make download      # fetch the model into ./model (needs HF_TOKEN in .env)
make start         # validate config + start the container on port 9031
make status        # container state + served model list
make test          # smoke test: vision, video, tools, reasoning
make test-e2e      # e2e gate: multimodal image probe
```

Logs: `make logs` (follow) or `make log-once` (snapshot). Stop with
`make stop`, restart with `make restart`.

## Makefile targets

| Target | What it does |
|---|---|
| `setup` | Pull the image and download the model (`build` + `download`) |
| `build` | Pull the pinned `vllm/vllm-openai` image |
| `download` | Download the model (and the draft model when `SPEC_MODE=mtp`/`dflash`) into `HF_HOME` |
| `validate-config` | Reject invalid speculative-decoding combinations before start |
| `start` | Start the server container (runs `validate-config` first) |
| `start-interactive` | Start with the latency-first profile (`PERFORMANCE_MODE=interactivity`, `MAX_SEQS=4`) |
| `start-throughput` | Start with the throughput profile (`PERFORMANCE_MODE=throughput`, `MAX_SEQS=8`) |
| `stop` / `restart` | Remove / restart the container |
| `status` | Show container state and `/v1/models` |
| `logs` / `log-once` | Follow / dump container logs |
| `test` | Run `smoke_test.py` (vision, video, tool-calling, reasoning modes) |
| `test-text` | One text-only chat completion via curl |
| `test-e2e` | Run `tests/test_e2e.py` (multimodal image-probe gate) |
| `assert-kernels` | Assert the server picked non-pathological attention/linear kernels |
| `benchmark-latency` / `benchmark-long` / `benchmark-throughput` / `benchmark-mm` / `benchmark-all` | Run benchmark case subsets into `benchmark-results/` |

## Key configuration variables

Override on the command line, e.g. `make start MAX_LEN=32768`, or via `.env`
for secrets (`API_KEY`, `HF_TOKEN`).

| Variable | Default | Meaning |
|---|---|---|
| `PORT` | `9031` | Host port mapped to container port 8000 |
| `GPU_NO` | `1` | Host GPU index (resolved to a UUID for `--gpus`) |
| `IMAGE` | `vllm/vllm-openai:v0.28.0` | Server image |
| `MAX_LEN` | `65536` | Max model context |
| `MAX_SEQS` | `4` | Resident sequences; sized so 4 x `MAX_LEN` tokens fit the KV pool |
| `KV_CACHE_BYTES` | `6G` | Fixed KV-cache budget (skips vLLM memory profiling); bf16 KV at ~19 KB/token |
| `KV_QUANT` | empty (bf16 KV) | `fp8_e4m3` needs H200-class FP8 KV support |
| `ATTENTION_CONFIG` | empty (auto-select) | Pin an attention backend, e.g. `{"backend":"FLASH_ATTN","flash_attn_version":4}` for FA4-Hopper-class (SM90+) only; rejected on pre-Hopper GPUs |
| `ATTENTION_BACKEND` | empty | DEPRECATED: single-backend selector, superseded by `ATTENTION_CONFIG`; leave empty |
| `LINEAR_BACKEND` | `auto` | W4A16 GEMM kernel: `auto` (selects Marlin) \| `machete` (rejected for this checkpoint) \| `marlin`; `emulation` is never acceptable |
| `PERFORMANCE_MODE` | `throughput` | vLLM runtime mode: `interactivity` \| `balanced` \| `throughput` |
| `SPEC_MODE` | `none` | Speculative decoding: `none` \| `mtp` \| `dflash` (measured net-negative beyond ~1-2K context for this target) |
| `LIMIT_MM_IMAGE` / `LIMIT_MM_AUDIO` / `LIMIT_MM_VIDEO` | `1` / `0` / `1` | Multimodal inputs per prompt; set all to 0 for a text-only deployment |
| `VISION_SOFT_TOKENS` | `280` | Image/video soft-token budget; valid values: 70, 140, 280, 560, 1120 |
| `VIDEO_FRAMES` / `VIDEO_WIDTH` / `VIDEO_HEIGHT` | `64` / `224` / `224` | Server-side video frame sampling budget |
| `HF_HOME` / `DATA_DIR` | `./model` / `../sample_data` | Host paths; mounted absolute as `/hf` and `/sample_data` (read-only) |

## Test-data mount contract

The shared test assets live in the sibling directory `../sample_data` and are
bind-mounted read-only at `/sample_data` in the container. The server is
started with `--allowed-local-media-path /sample_data`, so requests can
reference media as `file:///sample_data/test/...` URLs (e.g.
`file:///sample_data/test/demo.png`), resolved against the *container*
filesystem. Tests fall back to inline base64 `data:` URLs when the file
transport is unavailable. `tests/test_e2e.py` locates the assets via
`../sample_data/test` relative to the project root; override with the
`SAMPLE_DATA_DIR` environment variable.

## What `tests/test_e2e.py` gates

**Image probe**-`demo.png` (first frame of the shared demo clip) must
produce a non-empty completion on a multimodal deployment, or be rejected
cleanly on a text-only one (`LIMIT_MM_IMAGE=0`).

The probe output lands in `./tmp/` on every run for inspection.

## scripts/

- `validate_vllm_config.sh`-pre-flight checks for the speculative-decoding
  config (called by `make start`)
- `assert_vllm_kernels.sh`-fail on known-bad kernel selections
  (FlashInfer SM90+SWA, FA4+FP8, emulated quantized linear, eager-only
  execution); reports Machete vs Marlin
- `benchmark_suite.sh`-runs the case matrix (D1/D2 latency, L1/L2
  long-context, T1 throughput, MM1/MM2 multimodal) into timestamped
  `benchmark-results/` directories; wraps `benchmark_gemma4.sh` and
  `bench_mm2.py`
- `summarize_results.sh`-(re)builds `summary.json`/`summary.md` for a
  result directory
- `compare_summaries.py`-merges several result directories into a
  per-configuration Markdown comparison table
- `determinism_check.sh`-captures a temperature-0 response for cross-config
  diffs
