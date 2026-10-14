# segment-temporal

Fast media normalization, voice-activity (VAD) segmentation, media extraction, and
video keyframes-built to run inside a single FFmpeg container.

## Performance architecture

For video inputs the CLI first creates **one** temporary normalized MP4:

- `640x448` (max), `1 fps` (defaults), aspect preserved (no upscaling), H.264 with a one-second GOP
- first audio stream retained as AAC
- CPU decode by design-measured faster than NVDEC on the target host and free
  of per-process CUDA init and codec/driver-specific hardware paths
- NVENC used when available (e.g. NVIDIA RTX GPUs), otherwise `CPU decode + CPU filters + CPU libx264`
- libx264 fallback if an NVENC encode fails

Video decode, scene analysis, keyframe extraction and video-segment stream-copy read this small working copy (the speed win). **Audio for VAD and the MP3 clips is decoded from the ORIGINAL audio stream**, not the AAC working copy-so transcription keeps full fidelity and the output audio format (MP3) is never silently changed. The working copy is removed unless `--keep-preprocessed`.

Preprocessing shrinks even a large video to a tiny working copy in a fraction of a
second, so all downstream work is dramatically cheaper.

Design notes:

- bounded worker pool (threads, not per-CPU processes-avoids re-importing Torch/Librosa)
- `ffprobe` stream classification instead of mimetype/extension (handles MXF/MTS/M2TS/OGV/RMVB and audio-only WebM)
- lazy Librosa / Silero loading
- CPU-only keyframe extraction (one FFmpeg process per frame; per-process CUDA init
  would cost more than decoding a single frame)

## Commands

```bash
make setup                          # create/update the local .venv via uv sync
make build                          # build the image (pinned FFmpeg base w/ NVDEC)
make download                       # cache the Silero ONNX model into MODELS_DIR
make run FILE=/data/test/demo.mp4   # process one corpus file into ./tmp
make test-smoke                     # demo.mp4/wav/png x3 (no-flakiness check)
make test                           # full demo* format matrix
make unit                           # host-side pure-Python unit tests (PEP 723 runner)
make unit-container                 # container tests with the REAL Silero VAD (GPU)
make check                          # compile + host unit + lint
make check-all                      # check + unit-container
make lint                           # ruff
make clean
```

Defaults target: `GPU_NO=0`, `REQUIRE_GPU=1`, `CPUS=8`, `WORKERS=4`, `SHM_MEM_SIZE=8g`. Override per invocation, e.g. `GPU_NO=1 REQUIRE_GPU=0`.

## Corpus and Volume Mounts (`run.sh`)

The host corpus `../sample_data` is bind-mounted **read-write** onto the container's `/data`, so a corpus file is addressed by its in-container path `/data/test/<name>`.

**Output location (client contract):** by default the CLI writes `out_<stem>_<ext>_<hash>/` **into the input file's directory** (it defaults `--output-dir` to the media parent)-exactly like the legacy service, because the client discovers segments by **globbing that directory** (it does not read JSON). Set `OUTPUT_DIR` to redirect output (used by `make run` and the test suite, which write to `./tmp`).

```bash
./run.sh /data/test/demo.mp4 --quiet             # writes out_... next to the input
OUTPUT_DIR=./tmp ./run.sh /data/test/demo.mxf    # redirect output (dev/test)
./run.sh /home/you/some/video.mp4                # arbitrary host file (writes next to it)
```

Runtime GPU assignment is by UUID: `--gpus device=<GPU UUID>`,
`NVIDIA_DRIVER_CAPABILITIES=compute,utility,video`, `--shm-size 8g`, `--cpus 8`, `--network none`, unprivileged user.

Model weights (Silero VAD ONNX) are cached in `./model` (gitignored) and mounted at `/models`; run `make download` to populate it.

## Output contract (client compatibility)

The client (`file-api.ts`) does **not** parse the JSON manifest-it discovers segments by **filesystem globbing + filename substring**. segment-temporal's contract is therefore:

| What | Form | How it's read |
|---|---|---|
| Output folder | `out_<name>_<ext>_<hash>/` | glob `out_<stem>_<ext>_*/**/*` in the input dir |
| Segment file | `<idx>_<startSec>_<endSec>_<type>_<hash>.<ext>` | `split('_')` parse |
| Type tag | `_speech_` / `_harmonic_` / `_noise_` / `_silence_` in the filename | substring filter |
| Audio | `.mp3` (libmp3lame, decoded from the ORIGINAL audio) | extension allow-list at transcription |

Tags use the client's recognized set; the legacy `non_speech` gap-fill tag is not re-introduced after music-refinement (matching the legacy service), so every segment buckets correctly.

## CLI

```bash
segment-temporal /data/test/demo.mp4 \
  --output-dir /data --workers 8 \
  --preprocess --preprocess-width 320 --preprocess-height 180 \
  --preprocess-fps 8 --preprocess-encoder auto
```

Relevant switches:

```text
--max-len S                      # cap for non-speech segments (audio and video)
--max-len-speech S               # VAD-aware cap for speech segments (ASR)
--max-len-video S                # independent cap for video/VLM clips (see below)
--preprocess / --no-preprocess
--preprocess-fps F               # working-copy rate; fractional allowed
                                 #   (0.5 = 1 frame/2s, 0.25 = 1 frame/4s; GOP clamps to all-IDR below 1 fps)
--preprocess-encoder auto|cpu|nvenc
--keep-preprocessed
--music-detection / --no-music-detection
--keyframe-method time|scene|hybrid
--workers N
SEGMENT_TEMPORAL_PREPROCESS=script   # opt-in bash preprocess fallback (no docker-in-docker)
```

### Independent audio/video limits (`--max-len-video`)

By default one shared segment plan drives both the MP3 (ASR) and MP4/keyframe (VLM)
exports. With `--max-len-video` the video side gets its own plan, capped at that many
seconds (speech and non-speech), while the audio side follows only `--max-len-speech` /
`--max-len`. Example: `--max-len-speech 30 --max-len-video 60` cuts ASR speech clips at
30 s but lets VLM clips run to 60 s. The two plans are fully independent-video clips
may be longer or shorter than audio clips. Each plan re-indexes separately; filenames
stay unique because they embed start/end. The manifest reports the resolved setup via
`max_len_video` and `segment_counts_video` (`null` when one shared plan is used), and
`results` is ordered chronologically across both plans.

### Media handling

- **Video:** normalized once, then segmented into MP4 + MP3 plus keyframes.
- **Audio:** segmented into MP3; video preprocessing is skipped.
- **Static image:** normalized to one JPEG; temporal processing is skipped.

Classification uses `ffprobe` streams, so containers like MXF, MTS, M2TS, OGV, RMVB,
audio-only WebM, and unusual extensions are handled correctly.

## Supported formats

`make test` exercises every `demo*` file in the shared corpus (classification validated
against an independent `ffprobe` ground truth; outputs checked for existence,
decodability, and normalized dimensions/FPS). `demo.jxl` (needs a libjxl-enabled
FFmpeg) and `demo.m2v` (raw MPEG-2 elementary stream, no container duration) are
**not** supported and excluded. The supported formats:

| Media type | Count | Formats (extension / container) |
|------------|------:|---------------------------------|
| Video      | 31 | `3g2` `3gp` `asf` `avi` `divx` `dv` `f4v` `flv` `m1v` `m2ts` `m4v` `mk3d` `mkv` `mov` `mp4` `mpe` `mpeg` `mpg` `mts` `mxf` `nut` `ogm` `ogv` `qt` `rm` `rmvb` `ts` `vob` `wmv` `xvid` `y4m` |
| Audio      | 11 | `ac3` `aiff` `au` `caf` `flac` `m4a` (AAC/ALAC) `mp2` `mp3` `wav` `webm` (audio-only) `wma` |
| Image      | 27 | `avif` `bmp` `dpx` `exr` `fits` `gif` `hdr` `j2k` `jls` `jp2` `jpg` `ljpg` `pam` `pbm` `pcx` `pgm` `png` `ppm` `qoi` `ras` `sgi` `tga` `tiff` `wbmp` `webp` `xbm` `xwd` |

## Preprocessing fallback (no docker-in-docker)

`cli.py` runs inside the container and has no Docker socket, so it can never spawn a
sibling container. The production path transcodes with ffmpeg directly in Python
(`src/segment_temporal/preprocess.py`). An equivalent, proven bash pipeline lives at
`scripts/preprocess_video.sh` (baked into the image) and is wired as an opt-in subprocess
fallback via `SEGMENT_TEMPORAL_PREPROCESS=script`. The host-side standalone wrapper
`scripts/preprocess_video_docker.sh` (which launches its own `docker run`) is preserved
for direct host use.

## Testing

### Host unit tests (`make unit`)
Pure-Python/NumPy segmentation math + config validation, via a PEP 723 runner
(`uv run test/run_unit.py`)-no ffmpeg, no VAD model.

### Container tests (`make unit-container`)
Runs `test/container/run_tests.py` inside the image with the **real Silero VAD** and the
image's ffmpeg/ffprobe: generates synthetic video/audio/image fixtures and asserts
classification, schema, normalized dimensions/FPS (≤640×448 @ ≤8 fps), CPU-decode
preprocessing, and decodability.

### E2E format matrix (`make test`)
`test/e2e.py` runs **on the host** and invokes `./run.sh` once per `demo*` file-exactly
the production path. For each case it validates, against an **independent ffprobe** ground
truth:

- classification correctness
- temporal coverage spans `[0, duration]` with no gaps/overlaps
- every referenced output exists, is non-empty, stays under the case dir, and is decodable
- normalized video ≤640×448 @ ≤8 fps and a real preprocessing size reduction

The smoke set (`demo.mp4`, `demo.wav`, `demo.png`) is repeated 3× and requires identical
`segment_counts` (no flakiness). Artifacts: `tmp/e2e/<name>/{stdout.json,stderr.log}`,
`tmp/e2e/{summary.json,timings.json}`.

Fractional working-copy rates can be exercised per run (repeatable; keeps the working
copy and asserts the probed frame rate matches-0.5 = one frame every 2s, 0.25 = one
every 4s):

```bash
uv run test/e2e.py --pattern demo.mp4 --preprocess-fps 0.5 --preprocess-fps 0.25
```

## Output JSON

Video results include preprocessing telemetry:

```json
{
  "media_type": "video",
  "source_duration_s": 6.4,
  "total_duration_s": 6.4,
  "preprocessing": {
    "enabled": true,
    "max_width": 640,
    "max_height": 448,
    "fps": 1,
    "mode": "CPU decode + CPU filters + CPU libx264",
    "encoder": "libx264",
    "used_nvdec": false,
    "input_bytes": 971359,
    "output_bytes": 335927,
    "kept": false
  }
}
```

The manifest additionally reports the resolved limits (`max_len`, `max_len_speech`,
`max_len_video`) and the per-plan counts (`segment_counts`, plus `segment_counts_video`
when `--max-len-video` produced a separate video plan; `null` otherwise).

## Project layout

```
segment-temporal/
├── Dockerfile                 # pinned LinuxServer FFmpeg (NVDEC/NVENC) + uv Python
├── Makefile                   # build/download/run/test/unit/unit-container/lint/check
├── config.sh / run.sh / build.sh / download.sh
├── scripts/
│   ├── preprocess_video.sh        # in-container, no-docker preprocess (cli.py fallback)
│   └── preprocess_video_docker.sh # host-side standalone wrapper
├── src/segment_temporal/
│   ├── cli.py                 # CLI: threads, lazy imports, preprocess wiring, image path
│   ├── media.py               # ffprobe stream classification
│   ├── preprocess.py          # CPU-decode normalize-once, NVENC when present (+ script fallback)
│   └── detectors_silero.py    # Silero VAD wrapper
└── test/
    ├── e2e.py                 # host-side format matrix (PEP 723)
    ├── run_unit.py            # host unit runner (PEP 723)
    ├── unit/                  # pure-Python segmentation/config tests
    └── container/run_tests.py # real-VAD container smoke tests
```
