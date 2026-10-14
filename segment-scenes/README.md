# segment-scenes

Persistent TransNetV2 scene detection with an HTTP API, mounted-file I/O, and
probed NVDEC/NVENC acceleration with CPU fallback.

## Design

- `make start`, `make stop`, and `make restart` manage one always-on container.
- TransNetV2 is instantiated once. The default `MODEL_OFFLOADING=NEVER` keeps it
  resident in VRAM between requests.
- `POST /v1/segment-scenes` returns the scene result JSON over HTTP.
- The `segment-scenes` CLI is an HTTP client.
- Requests contain only `file://` URIs. Video bytes remain on bind-mounted volumes.
- The model file is stored in the host `./model` directory by default and mounted
  at `/models`.
- Detection-frame decode uses NVDEC when available. Per-scene keyframe extraction
  and segment cuts decode on CPU: they spawn one FFmpeg process per scene, where
  per-process CUDA init costs more than hardware decode saves. Output encoding
  uses NVENC when available and otherwise libx264.
- Unit, contract, and offloading-policy tests live under `test/` (see Tests and benchmark).

The scene-selection and max-length algorithms are unchanged from 0.4.0.

## Quick start

```bash
cp env-default .env                 # optional; edit GPU, mounts, and policy
make start                          # builds image/materializes model if missing
make health
make run FILE=/data/test/demo.mp4
make status                         # container status plus /health JSON
make logs                           # follow service logs
make stop
```

Default endpoint: `http://127.0.0.1:8088`.

`DATA_DIR` defaults to `../sample_data` and is mounted read-write at `/data`.
Every input and output must be below that host directory. The service deliberately
does not accept multipart uploads, base64, HTTP media URLs, or arbitrary host paths.

## API

Health:

```bash
curl -fsS http://127.0.0.1:8088/health | jq
```

Scene segmentation:

```bash
curl -fsS http://127.0.0.1:8088/v1/segment-scenes \
  -H 'Content-Type: application/json' \
  -d '{
    "media": "file:///data/test/demo.mp4",
    "output_dir": "file:///data/results",
    "threshold": 0.5,
    "min_len": 0.5,
    "max_len": 15.0,
    "fps": 1,
    "max_width_px": 640,
    "max_height_px": 448,
    "chunk_size": 1000,
    "quiet": true
  }' | jq
```

The response is the scene result itself, not a job envelope. Files named in
`scene_keyframes` and `scene_segments` are relative to the generated
`out_<stem>_<extension>_<hash>/` directory under `output_dir`.

Only local `file://` URIs under `ALLOWED_FILE_ROOTS` are accepted. Symlink-resolved
paths are checked against the allow-list before processing.

## CLI compatibility

The host wrapper performs path translation and invokes the HTTP client inside the
running container:

```bash
./run.sh --threshold 0.3 --min-len 1 --max-len 15 \
  --output-dir ../sample_data/results \
  ../sample_data/test/demo.mp4
```

Existing options remain: `--threshold`, `--min-len`, `--max-len`, `--fps`,
`--max-width-px`, `--max-height-px`, `--device`, `--chunk-size`, `--visualize`,
`--extract-keyframes`, `--output-dir`, and `--quiet`. The HTTP client additionally
accepts `--server-url` and `--request-timeout` (defaults: `SEGMENT_SCENES_URL` /
`SEGMENT_SCENES_REQUEST_TIMEOUT`).

The installed Python command can also be used directly. Set
`SEGMENT_SCENES_DATA_DIR` to the host bind mount and optionally
`SEGMENT_SCENES_URL`:

```bash
SEGMENT_SCENES_DATA_DIR=/srv/corpus \
SEGMENT_SCENES_URL=http://127.0.0.1:8088 \
segment-scenes /srv/corpus/test/demo.mp4 --quiet
```

## Model offloading

| Policy | Startup residency | After each request | Next request |
|---|---|---|---|
| `NEVER` (default) | Configured device, normally CUDA | Remains in VRAM | No transfer |
| `TIMEOUT` | CPU | Stays in VRAM until idle timeout | CPU→GPU only after timeout |
| `IMMEDIATE` | CPU | Moves to CPU before response completes | CPU→GPU transfer |

`MODEL_OFFLOADING_TIMEOUT` defaults to `60` seconds. The lowercase aliases
`model_offloading` and `model_offloading_timeout` are also accepted by the Python
service configuration; uppercase names are recommended in `.env`.

Offloading means `model.to("cpu")` plus release of unused CUDA allocator cache.
The model object and weights remain loaded in system RAM; they are not reconstructed
or downloaded on every request.

## Configuration

Copy `env-default` to `.env`. Important values:

| Variable | Default | Meaning |
|---|---:|---|
| `DATA_DIR` | `../sample_data` | Host input/output tree mounted at `/data` |
| `MODELS_DIR` | `./model` | Host model directory mounted at `/models` |
| `PORT` | `8088` | Host HTTP port, bound to `BIND_HOST` |
| `GPU_NO` | `1` | Host GPU index resolved to UUID before Docker starts |
| `REQUIRE_GPU` | `1` | Fail startup instead of silently running CPU-only |
| `DEVICE` | `cuda` | TransNetV2 inference device (`auto`, `cpu`, `cuda`) |
| `MODEL_OFFLOADING` | `NEVER` | `NEVER`, `TIMEOUT`, or `IMMEDIATE` |
| `MODEL_OFFLOADING_TIMEOUT` | `60` | Idle seconds before CPU offload |
| `FFMPEG_ACCELERATION` | `auto` | `auto`, `cpu`, or `nvdec` (still CPU-fallback safe) |
| `SEGMENT_SCENES_CUT_WORKERS` | `min(8, cpu_count)` | Concurrent FFmpeg child processes for scene cuts/keyframes |
| `TORCH_COMPILE` | `0` | Opt into `torch.compile`; requires `NEVER` + CUDA |
| `TORCH_COMPILE_MODE` | `reduce-overhead` | Compile mode; uses CUDA graphs where supported |

The service intentionally uses one Uvicorn worker. Multiple process workers would
load one independent model per process and multiply VRAM use. Concurrent HTTP calls
queue on a model request lock; `/health` remains responsive and reports `busy`.

## Acceleration behavior

Detection-frame decode is probed, not assumed:

1. Try codec-specific NVDEC for one frame (cached per input for the service lifetime).
2. Decode all original frames directly to the 48×27 RGB stream TransNetV2 expects.
3. Retry CPU decode if the driver, codec, or FFmpeg hardware path fails.

Per-scene keyframe extraction and segment cuts always decode on CPU: each spawns
its own FFmpeg process, and per-process CUDA init outweighs hardware decode for
short clips. Segment encoding probes NVENC once per service lifetime and falls
back to libx264 when unavailable. Scene cuts and keyframe extractions run concurrently in a
bounded thread pool (`SEGMENT_SCENES_CUT_WORKERS`, default `min(8, cpu_count)`);
manifest output preserves scene order.

The input is not pre-transcoded to a lower FPS: TransNetV2 boundary probabilities
depend on the original frame sequence. This avoids the semantic drift that would be
acceptable in `segment-temporal` but risky for shot detection.

The hot path uses `torch.inference_mode()`, retains the CUDA allocator cache between
chunks, caches capability probes, never upscales already-small outputs, and places
codec options before the FFmpeg output.

`TORCH_COMPILE=1` is intentionally opt-in: `reduce-overhead` can use CUDA graphs,
but first-request compilation and recompilation for the final variable-size chunk
add GPU-dependent latency.

## Model storage

`transnetv2-pytorch==1.0.5` ships its weight file inside the wheel. `make download`
copies that exact file atomically into `./model/transnetv2-pytorch-weights.pth` and
prints its SHA-256. Runtime loads only the mounted copy, making model identity and
persistence explicit even when the image is rebuilt.

## Tests and benchmark

```bash
make setup                 # create/update the local .venv via uv sync
make test                  # GPU-free unit tests (alias for unit)
make check                 # compile + GPU-free unit tests + Ruff
make build                 # requires Docker
make start
make e2e                   # demo.mp4: contract, files, decode, determinism
make e2e-offloading        # isolated NEVER/TIMEOUT/IMMEDIATE containers
make benchmark             # repeated warm-service calls; writes tmp/benchmark.json
make stop
```

`make e2e` expects `${DATA_DIR}/test/demo.mp4` by default; override `DEMO_MP4`.
The e2e harness needs `ffprobe` on the host `PATH` (the container image ships its own).

## Output compatibility notes

The core result keys are `video`, `model`, `encoding`, `shots`, `boundaries`,
`gpu_stats`, `scene_keyframes`, and `scene_segments` (unchanged from 0.4.0);
`decoding` and per-output `acceleration` objects report the actual acceleration
path used.

Correctness details:

- the persisted manifest matches the complete HTTP/stdout response;
- `encoding.fps` reports the requested output FPS, not the source FPS;
- scene keyframe `offset_ms` reports the actual 200 ms offset;
- small videos/keyframes are never upscaled.

## References

- [TransNetV2 paper](https://arxiv.org/abs/2008.04838)
- [`transnetv2-pytorch` 1.0.5 package](https://pypi.org/project/transnetv2-pytorch/)
- [NVIDIA: FFmpeg with NVDEC/NVENC](https://docs.nvidia.com/video-technologies/video-codec-sdk/13.0/ffmpeg-with-nvidia-gpu/index.html)
- [FastAPI lifespan events](https://fastapi.tiangolo.com/advanced/events/)
- [PyTorch 2.8 CUDA 12.8 install matrix](https://pytorch.org/get-started/previous-versions/)
- [`torch.compile` modes and CUDA graphs](https://docs.pytorch.org/docs/stable/generated/torch.compile.html)
