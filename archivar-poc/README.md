# Archivar - AI Media Analysis and Archiving Prototype

## Quick Start

The normal way to run the app is **the container** (Dockerfile + start.sh,
Caddy in front on **:8802**):

```bash
make setup   # install dependencies + seed .env.local (tests/dev) and .env (container)
make start   # build the image if missing, then start the container on http://localhost:8802
make open    # open the app in your browser
make status  # container status + model health; make logs / make stop
```

The host-local **dev server** (hot reload, on :8801) stays available for
development under clearly named targets:

```bash
make dev-start   # dev server on http://localhost:8801
make dev-status  # dev server status + health; make dev-logs / make dev-stop / make dev-restart
```

Rebuilds are explicit: `make container-build` (plain `make start` builds only
when the image is missing). The env files are deliberately separate per runtime
(see [Environment files](#environment-files-envlocal-dev-vs-env-container)):
`.env.local` for dev/tests, `.env` for the container-both are seeded by
`make setup`.

```bash
pnpm cli validate # validate archivar.config.ts
pnpm cli health # check inference health of every enabled model
pnpm cli list # list all files

pnpm cli status
pnpm cli status --status all
pnpm cli status --status done --json

pnpm cli analyze --file demo.mp4 [--workflow "default-analysis-gemma4-e4b"] [--force]
pnpm cli export --file "demo.mp4" --format docx
pnpm cli logs --file "demo.mp4"
pnpm cli export --file "demo.mp4" --format raw
pnpm cli clear-cache --file "demo.mp4"
```

The default data directory is `../sample_data/archivar`. A small demo/format-matrix corpus lives at `../sample_data/test/` (used by unit/e2e tests); copy `demo.mp4`/`demo.wav` from there into the data directory to try the examples below.

## Purpose

Modern media workflows require **intelligent analysis** and **semantic understanding** of video and audio content.

When processing media files, understanding content structure is crucial for use-cases like:

- **Content archiving** - Organizing and indexing media libraries
- **Semantic search** - Finding content by meaning, not just metadata
- **Automated annotation/** - Generating descriptions and captions automatically
- **Timeline analysis** - Understanding scene changes, speech patterns, and audio events
- **AI-powered insights** - Multi-modal understanding of visual and audio content, content moderation and metrics calculation.

**Archivar** provides a complete web-based platform for media analysis, combining state-of-the-art scene detection, speech recognition, and multi-modal AI captioning with an intuitive timeline-based interface.

## Features

- **Interactive timeline visualization** - Visual representation of scenes, audio regions, and events
- **Scene detection and segmentation** - Automatic scene boundary detection using TransNetV2
- **Temporal segmentation** - Dynamic-length video segmentation for batch processing
- **Automatic Speech Recognition (ASR)** - Transcribe speech segments via OpenAI-compatible ASR endpoints (Qwen3-ASR-0.6B by default; Whisper3-Large-Turbo-DE and Parakeet variants configured)
- **Multi-modal AI captioning** - Generate descriptions for videos, images, and audio using vision-language models (gemma-4-E4B by default; Qwen3.6-35B / Qwen3.8-27B for larger GPUs)
- **Audio analysis** - Detect speech, silence, noise, harmonic content, and ambience
- **Event tracking** - Timeline-based event system for scenes, keyframes, and audio regions
- **Real-time media playback** - Synchronized video/audio player with timeline navigation
- **File management** - Browse and organize media files with automatic output detection
- **RPC-based architecture** - Clean API separation for extensibility

## MLLM Output Validation & Retry

When a post-processing plugin asks the model for structured JSON (e.g. a scene
analysis with a fixed `scene_type` enum), the model occasionally returns output
that fails schema validation-for example `scene_type: "unknown"`, which is not
one of the allowed values. Previously this silently dropped the result, so an
aggregation could end up with **no analysis at all** (the symptom: "scene
aggregations are not created").

`PluginApi.mllm.callJson(...)` now **retries on validation failure**: it re-calls
the model (re-sending the same media files) with a correction prompt that quotes
the previous invalid answer and lists the exact field-level errors, so the model
can self-correct.

- **Default:** up to `2` retries (3 total attempts). Override per call via the
  optional `maxRetries` argument (`0` disables retry).
- **Graceful fallback:** when schema-validation retries are exhausted, `callJson`
  degrades to the best-effort parsed object and records a `"Schema validation
  exhausted"` non-fatal error instead of throwing-so a single bad aggregation
  never aborts the whole run (each plugin keeps its own fallback on top: empty
  patch / `_error` on the slice). Only JSON that is unparseable after all
  retries still throws.
- **Covers:** per-slice analysis, aggregation decision, aggregation analysis,
  whole-video summary, and the question-answer plugin.

## Technology Stack

- **Astro** - Modern SSR framework for fast, optimized web applications
- **TypeScript** - Type-safe development
- **defuss** - Reactive UI framework with RPC support
- **File-backed JSON stores** - Analysis caches persist as JSON files next to the data directory (no external database)
- **TailwindCSS + FrankenUI + UIKit** - Modern, responsive UI components
- **Docker + Caddy** - Containerized deployment with reverse proxy
- **External Analysis Tools** (sibling projects, run in parallel during pre-processing):
  1. `segment-temporal` - Dynamic-interval temporal segmentation (Silero VAD)
  2. `segment-scenes` - Scene detection (TransNetV2)
- **Inference models** (OpenAI-compatible endpoints, resolved via `MODEL_CONFIG`):
  - ASR: `qwen-asr-0.6b` (Qwen3-ASR-0.6B, S default), `Whisper3-Large-Turbo-DE`, `parakeet-primeline-de`
  - VLM captioning/aggregation: `gemma4-e4b-qat-w4a16` (gemma-4-E4B, S default), `Qwen3.6-35B-A3B-GPTQ-Int4` (M), `Qwen3.8-27B-FP8` (L)

## Inference Performance

Historical benchmark numbers (H200 / RTX 6000 Ada / DGX Spark runs against
Qwen3.6/3.8 models) were removed with the eval reports for the public release.
Rough order of magnitude for orientation: captioning scales near-linearly with
the configured per-model parallelism, and a one-hour video splits into ~560
scene clips (~6.4 s each) before captioning.


## CLI

The `cli.ts` file provides a command-line interface for interacting with the Archivar platform.

### Authentication

The CLI uses API key authentication. The key is read from the `API_KEY` environment variable (default: `your-api-key`). You can override it per-call with `--api-key <key>`.

### Commands using CLI

**Data Directory Configuration**: There is no `--data-dir` CLI flag. The data directory is configured exclusively via environment variables (see [Environment Variables](#environment-variables)). The `--file` option accepts **just the filename** (or glob pattern), which is resolved against the configured data directory.

Example: with the default `RELATIVE_SAMPLE_DATA_PATH=../sample_data/archivar`, `--file demo.mp4` resolves to `../sample_data/archivar/demo.mp4`.

```bash
# List media files
pnpm cli list
pnpm cli list "*.mp4"

# List available workflows
pnpm cli workflows

# Show workflow configuration
pnpm cli workflow-config default-analysis-gemma4-e4b

# List available models
pnpm cli models

# Run analysis on a media file (default workflow: default-analysis-gemma4-e4b)
pnpm cli analyze --file "demo.mp4"
pnpm cli analyze --file "demo.mp4" --workflow default-analysis --format md --output result.md

# Run analysis with per-clip-type model/prompt overrides
pnpm cli analyze --file "demo.mp4" --speech-model Whisper3-Large-Turbo-DE --scene-model gemma4-e4b-qat-w4a16 --scene-prompt "Describe in English"

# Run analysis with a config file for per-type overrides
pnpm cli analyze --file "demo.mp4" --config-file overrides.json

# Analyze a single segment (requires pre-processing to have run first;
# segment paths live under out_<file>_<hash>/-list them via `pnpm cli list-segments`)
pnpm cli analyze-segment --file "out_demo_mp4_e70883a9/001_0.000_6.400_speech_e70883a9.mp3" --type speech --model qwen-asr-0.6b
pnpm cli analyze-segment --file "out_demo_mp4_e70883a9/scene_keyframes/000_0.125_6.250.png" --type keyframe --model gemma4-e4b-qat-w4a16 --prompt "Describe in German"
pnpm cli analyze-segment --file "out_demo_mp4_e70883a9/scenes/000_0.225_6.150.mp4" --type scene --model gemma4-e4b-qat-w4a16 --output caption.txt

# Per-file workflow configuration (persisted as <file>.workflow.json)
pnpm cli file-config get "demo.mp4"
pnpm cli file-config set "demo.mp4" --type speech --model Whisper3-Large-Turbo-DE
pnpm cli file-config set "demo.mp4" --type scene --model Qwen3.8-27B-FP8 --prompt "Describe in English"

# Delete a file and its cache/output data
pnpm cli delete "demo.mp4"

# Clear a cache table (scene, audio, keyframe, speech, aggregated)
pnpm cli clear-cache aggregated
pnpm cli clear-cache speech

# Export analysis results (docx, md, json, raw, log, srt, vct)
# `srt` = SubRip subtitles built from the exact per-clip ASR speech timings.
# `vct` = Vision Caption Transcript (SRT structure + Markdown scene/keyframe captions).
pnpm cli export --file "demo.mp4" --format docx
pnpm cli export --file "demo.mp4" --format md,json,log
pnpm cli export --file "demo.mp4" --format srt
pnpm cli export --file "demo.mp4" --format vct

# Validate archivar.config.ts (models, workflow model references, plugin paths)
# Exit code 1 when the config is invalid-safe for scripts/harnesses
pnpm cli validate

# Check inference health of every enabled model (real minimal inference calls,
# same checks as GET /health). Exit code 1 unless every model is ok.
pnpm cli health

# List tasks (default: currently processing; one status.json per analyzed file)
pnpm cli status
pnpm cli status --status all
pnpm cli status --status done --json
```

### Commands using Makefile

Run the whole chain:

```bash
make analyze FILE="../sample_data/archivar/demo.mp4" WORKFLOW=default-analysis-gemma4-e4b FORCE=1
```

Only run the captioning:

```bash
make analyze FILE="../sample_data/archivar/demo.mp4" WORKFLOW=default-analysis-gemma4-e4b FORCE=1 ONLY="processing:scene"
```

Only run a specific postProcessing plugin:

```bash
make analyze FILE="../sample_data/archivar/demo.mp4" WORKFLOW=default-analysis-gemma4-e4b FORCE=1 ONLY="postProcessing:default"
```

### Global Options

| Option                | Description                                         |
|-----------------------|-----------------------------------------------------|
| `--server <url>`      | Server URL (default: `http://localhost:8802`)        |
| `--api-key <key>`     | API key for authentication (default: from `API_KEY`) |

### Options for `analyze`

| Option                    | Description                                                             |
|---------------------------|-------------------------------------------------------------------------|
| `--file <pattern>`        | Filename or glob pattern to analyze, resolved against the configured data directory (required) |
| `--workflow <name>`       | Workflow name (default: from server config)                             |
| `--format <fmt>`          | Output format: `json`, `md`, or `toon` (default: `json`)               |
| `--output <file>`         | Write output to file instead of stdout                                  |
| `--config-file <path>`    | JSON file with per-type overrides (see below)                           |
| `--speech-model <name>`   | Override model for speech segments                                      |
| `--speech-prompt <text>`  | Override prompt for speech segments                                     |
| `--keyframe-model <name>` | Override model for keyframe analysis                                    |
| `--keyframe-prompt <text>`| Override prompt for keyframe analysis                                   |
| `--scene-model <name>`    | Override model for scene/video analysis                                 |
| `--scene-prompt <text>`   | Override prompt for scene/video analysis                                |
| `--harmonic-model <name>` | Override model for harmonic audio analysis                              |
| `--harmonic-prompt <text>`| Override prompt for harmonic audio analysis                             |
| `--noise-model <name>`    | Override model for noise analysis                                       |
| `--noise-prompt <text>`   | Override prompt for noise analysis                                      |
| `--model <name>`          | Legacy: override model (used with `--type`)                             |
| `--prompt <text>`         | Legacy: override prompt (used with `--type`)                            |
| `--type <type>`           | Legacy: media type to override (used with `--model`)                    |

#### Config file format

The `--config-file` option accepts a JSON file with per-type overrides:

```json
{
  "speech": { "model": "qwen-asr-0.6b" },
  "scene": { "model": "gemma4-e4b-qat-w4a16", "prompt": "Describe in English." },
  "keyframe": { "model": "gemma4-e4b-qat-w4a16", "prompt": "Describe this image in German." }
}
```

Per-type CLI flags (e.g. `--speech-model`) take precedence over config file values.

### Options for `analyze-segment`

| Option                  | Description                                                        |
|-------------------------|--------------------------------------------------------------------|
| `--file <path>`         | Segment file path (required)                                       |
| `--type <type>`         | Media type (required): `speech`, `scene`, `keyframe`, `harmonic`, `noise` |
| `--model <name>`        | Model name (required)                                              |
| `--prompt <text>`       | Prompt text (default: `""`)                                        |
| `--system-prompt <text>`| System prompt (optional)                                           |
| `--output <file>`       | Write output to file instead of stdout                             |

### Options for `file-config set`

| Option              | Description                                                             |
|---------------------|-------------------------------------------------------------------------|
| `--type <type>`     | Media type (required): `speech`, `scene`, `keyframe`, `harmonic`, `noise` |
| `--model <name>`    | Model name (required)                                                   |
| `--prompt <text>`   | Prompt text (default: `""`)                                             |

### Examples

#### Full analysis workflow (clear cache + run)

```bash
pnpm cli clear-cache --file "demo.mp4" && \
pnpm cli analyze --file "demo.mp4"
```

#### Analyze a video with markdown output

```bash
pnpm cli analyze --file "demo.mp4" --format md --output demo-report.md
```

#### Switch ASR model for a specific file

Use Whisper3-Large-Turbo-DE instead of the default Qwen3-ASR-0.6B for speech transcription:

```bash
# Override just the speech model for this run
pnpm cli analyze --file "demo.mp4" --speech-model Whisper3-Large-Turbo-DE

# Or persist the override so future runs also use it
pnpm cli file-config set "demo.mp4" --type speech --model Whisper3-Large-Turbo-DE
pnpm cli analyze --file "demo.mp4"
```

#### Analyze with per-clip-type overrides

Configure different models/prompts for each media type in a single run:

```bash
pnpm cli analyze --file "demo.mp4" \
  --speech-model parakeet-primeline-de \
  --scene-model gemma4-e4b-qat-w4a16 --scene-prompt "Describe the video in English." \
  --keyframe-model gemma4-e4b-qat-w4a16 --keyframe-prompt "Describe in English."
```

Or use a config file:

```bash
pnpm cli analyze --file "demo.mp4" --config-file my-overrides.json
```

#### Analyze audio-only content

For audio files (podcasts, radio recordings), only the speech, harmonic, and noise overrides are relevant (there are no video/keyframe segments):

```bash
pnpm cli analyze --file "demo.wav" \
  --speech-model qwen-asr-0.6b \
  --harmonic-model gemma4-e4b-qat-w4a16 --harmonic-prompt "Describe the music in German." \
  --noise-model gemma4-e4b-qat-w4a16 --noise-prompt "Describe the ambient sounds."
```

(`demo.wav` is part of the small test corpus in `../sample_data/test/`-copy it into the data directory first.)

#### Analyze a single audio segment

After pre-processing has run, analyze one specific speech segment:

```bash
pnpm cli analyze-segment \
  --file "out_demo_mp4_e70883a9/001_0.000_6.400_speech_e70883a9.mp3" \
  --type speech \
  --model qwen-asr-0.6b
```

#### Analyze a single keyframe with a custom prompt

```bash
pnpm cli analyze-segment \
  --file "out_demo_mp4_e70883a9/scene_keyframes/000_0.125_6.250.png" \
  --type keyframe \
  --model gemma4-e4b-qat-w4a16 \
  --prompt "Describe this image in German. List all visible people and objects."
```

#### Analyze a video scene

```bash
pnpm cli analyze-segment \
  --file "out_demo_mp4_e70883a9/scenes/000_0.225_6.150.mp4" \
  --type scene \
  --model gemma4-e4b-qat-w4a16 \
  --prompt "Describe the video in German." \
  --output scene-caption.txt
```

#### Compare ASR models on the same segment

```bash
echo "=== Qwen3-ASR-0.6B ===" && \
pnpm cli analyze-segment --file "out_demo_mp4_e70883a9/001_0.000_6.400_speech_e70883a9.mp3" --type speech --model qwen-asr-0.6b && \
echo "=== Whisper3-Large-Turbo-DE ===" && \
pnpm cli analyze-segment --file "out_demo_mp4_e70883a9/001_0.000_6.400_speech_e70883a9.mp3" --type speech --model Whisper3-Large-Turbo-DE
```

#### View and manage per-file workflow config

```bash
# Check if a file has custom config
pnpm cli file-config get "demo.mp4"

# Set scene captioning to the L model with English output
pnpm cli file-config set "demo.mp4" \
  --type scene --model Qwen3.8-27B-FP8 --prompt "Describe the video in English."

# Set speech transcription to Whisper3-Large-Turbo-DE
pnpm cli file-config set "demo.mp4" \
  --type speech --model Whisper3-Large-Turbo-DE

# Verify the saved config
pnpm cli file-config get "demo.mp4"

# Now run analysis - it will use the saved per-file overrides automatically
pnpm cli analyze --file "demo.mp4"
```

#### Delete a file and all its data

```bash
# Deletes the source file, output directory, cache entries, and workflow config
pnpm cli delete "demo.mp4"
```

#### List available models and workflows

```bash
pnpm cli models
pnpm cli workflows
pnpm cli workflow-config default-analysis-gemma4-e4b
```

## Architecture

The application follows a clean architecture with clear separation of concerns:

- **Frontend**: Astro SSR with React components (via defuss)
- **RPC API**: Type-safe remote procedure calls for backend operations
- **File API**: Media file browsing and metadata management
- **Analysis API**: Integration with external analysis tools
- **MLLM API**: Multi-modal LLM integration for AI captioning

## Setup & Deployment

### Prerequisites

- Docker and Docker Compose
- pnpm package manager
- Access to sample media files

### Docker Deployment (the normal way to run)

```bash
# Seed env files, build the image if missing, and start the container
make setup
make start
```

The application is available at `http://localhost:8802` (override with
`make start ARCHIVAR_PORT=8803`). Management:
`make logs` / `make status` / `make stop`; rebuild explicitly with
`make container-build`.

### Local Development

```bash
# Install dependencies and create .env.local from the template (first run only)
make setup

# Start development server
make dev-start
```

The development server runs on `http://localhost:8801` with hot module replacement.

## Usage

### Dashboard Interface

The main dashboard provides three main sections:

1. **Left Panel** - File browser and upload
2. **Center Panel** - Media player and timeline visualization
3. **Right Panel** - Events list, transcription and summary views

### Timeline Features

The timeline displays:

- **Audio regions**: Color-coded regions for speech, silence, noise, harmonic content, and ambience
- **Scene regions**: Visual markers for detected scene changes
- **Transport indicator**: Red line showing current playback position
- **Time markers**: Minute and second markers for navigation

Click anywhere on the timeline to seek to that position in the media.

### File Analysis

1. **Browse files** - The left panel automatically scans for media files in the configured data directory
2. **Select a file** - Click on any video or audio file to load it
3. **View analysis** - The timeline automatically displays detected scenes and audio regions
4. **Request captions** - Click on events in the right panel to generate AI-powered captions

### Caption Generation

The platform supports multiple caption types:

- **Video captions** - Describe video content in German
- **Image captions** - Describe images with object detection and bounding boxes
- **Audio transcription** - Transcribe speech segments using ASR
- **Sound identification** - Identify and describe non-speech audio (noise, music, etc.)

#### Transcoding, Audio/Video-Splitting and Voice-Activity-Detection (VAD) using `segment-temporal`

For transcoding, audio/video splitting and VAD, this PoC uses the sibling project
`segment-temporal`:

```bash
cd ../segment-temporal
./run.sh --data-dir ../sample_data/archivar ../sample_data/archivar/demo.mp4 | jq
```

It detects speech via Silero VAD, refines non-speech regions (harmonic/noise/ambient)
and writes the segments plus a JSON manifest to
`../sample_data/archivar/out_demo_mp4_<hash>/`.

#### Auto-cutting video scenes using `segment-scenes`

Scene detection and re-encoding for maximum model compatibility is done via the
sibling project `segment-scenes`:

```bash
cd ../segment-scenes
./run.sh --output-dir ../sample_data/archivar ../sample_data/archivar/demo.mp4 | jq
```

Each detected scene prints as a JSON array entry (timings, scene file path,
encoding parameters); the re-encoded scene clips land in
`../sample_data/archivar/out_demo_mp4_<hash>/scenes/`.

Both steps run automatically as the workflow's `preProcessing` stage when you run
`pnpm cli analyze`-the manual commands above are only needed for debugging.


## API Reference

### File API

```typescript
// List files matching a glob pattern
fileApi.listFiles("*.{mp4,mov}")

// Returns FileInfo[] with metadata, scenes, keyframes, audio regions
```

### Analysis API

```typescript
// Segment video temporally
analyseApi.segmentTemporal(filePath, cliArgs)

// Segment video into scenes.
// cliArgs is built from the workflow's `preProcessing.segmentScenes` config
// (fps / maxLengthPerClipInSecs / maxWidthPx / maxHeightPx); see archivar.config.ts.
analyseApi.segmentScenes(filePath, cliArgs)

// (ASR runs as a processing step via the configured asr-api models-there is
// no separate ASR tool wrapper.)
```

### MLLM API

```typescript
// Caption videos (default: the configured default workflow's scene/VLM model)
mllmApi.captionVideos(urls)

// Caption images (same default VLM resolution)
mllmApi.captionImage(urls)

// Transcribe audio (default: the default workflow's speech/ASR model)
mllmApi.captionAudios(urls)
mllmApi.captionSound(urls /*, modelName? */)
```

### Health API

```typescript
// Structural validation of archivar.config.ts (models, workflow references, plugin paths)
healthApi.validateConfig()
// Returns { ok, errors, defaultWorkflow, workflows, models }

// Real inference health checks for every enabled model (same checks as GET /health)
healthApi.checkModels()
// Returns { status: "ok"|"degraded"|"error", checks, models }
```

### Status API

```typescript
// List task statuses (one per analyzed file), newest first; optional filter
statusApi.listStatuses("processing") // "processing" | "done" | "error" | undefined (all)
// Returns StatusFile[] = { status, file, workflow?, startedAt, completedAt?, error?, ... }
```

### Public REST endpoints (no auth)

```bash
# List tasks (harness-friendly); ?status=processing|done|error, omit for all
curl "http://localhost:8802/api/status?status=processing"
# → { "tasks": StatusFile[] }

# Download an analysis export (docx | md | json | raw | log | srt | vct); generates on demand
# `srt` returns SubRip subtitles from the per-clip ASR speech timings.
# `vct` returns a Vision Caption Transcript (SRT structure + Markdown scene captions).
curl -OJ "http://localhost:8802/api/export?file=demo.mp4&format=docx"
curl -OJ "http://localhost:8802/api/export?file=demo.mp4&format=srt"
curl -OJ "http://localhost:8802/api/export?file=demo.mp4&format=vct"

# Request eager exports with an analysis; references appear in poll + webhook responses
curl -X POST http://localhost:8802/api/analyze \
  -H 'Content-Type: application/json' \
  -d '{"file":"demo.mp4","exports":["md","json"]}'
curl "http://localhost:8802/api/raw?file=demo.mp4" | jq .exports

# Model health (schema: { status, checks, models }-the models inventory field is additive)
curl -s http://localhost:8802/health | jq .
```

The full public REST surface is documented in [`public/openapi.json`](public/openapi.json).

### Inference-Side `mm_processor_kwargs` (vLLM)

The `fps` and `do_sample_frames` parameters that control how vLLM samples frames from scene
videos can be configured at three levels (later wins):

```typescript
// archivar.config.ts
{
  models: [
    {
      name: "Qwen3.8-27B-FP8",
      // 1. Per-model default: applied to every inference call for this model
      mmProcessorKwargs: {
        fps: 4,
        do_sample_frames: true,
      },
    },
  ],
  workflows: [
    {
      processing: [
        {
          mediaType: "scene",
          // 2. Per-step: overrides the model-level values for this step only
          mmProcessorKwargs: { fps: 2 },
        },
      ],
      preProcessing: {
        segmentScenes: {
          // 3. Per-workflow: injected last for scene-type segments (video
          //    media)-wins over both model and step values
          fps: 4,
          doSampleFrames: true,
        },
      },
    },
  ],
}
```

**Precedence:** `ModelConfig.mmProcessorKwargs` < `ProcessingStep.mmProcessorKwargs` <
`SegmentScenesConfig.fps`/`doSampleFrames` (highest wins). The final kwargs are merged on top
of the vLLM defaults (`return_audio: false`, `use_audio_in_video: false`, `fps: 1`).
The `fps` and `doSampleFrames` from `SegmentScenesConfig` are only injected for video media types.

### Native JSON Schema Mode (vLLM structured outputs)

Native JSON-schema guided decoding is **on by default**: `getModel()` resolves
each model's transport from the model-name registry (gemma → `response_format`,
qwen3 → `structured_outputs`), falling back to `"auto"`, which probes the
endpoint once and picks a working transport; if none works, the pipeline
degrades gracefully to prompt-only. Set `ModelConfig.jsonSchemaMode` to pin a
specific transport or explicitly disable it (see
[`src/rpc/JSON_MODE_ARCH.md`](src/rpc/JSON_MODE_ARCH.md)):

```ts
// archivar.config.ts
models: [
  {
    name: "Qwen3.8-27B-FP8",
    type: "api",
    // endpoint usually omitted-resolved from MODEL_CONFIG at runtime
    jsonSchemaMode: "auto", // or a specific transport (see below)
  },
],
```

`jsonSchemaMode` values:

| Value                   | Behavior                                                                                  |
| ----------------------- | ----------------------------------------------------------------------------------------- |
| `false`                 | Prompt-only JSON (explicitly disabled)                                                    |
| undefined               | Model-name registry default (gemma → `response_format`, qwen3 → `structured_outputs`), else `"auto"` |
| `"auto"`                | Probe the endpoint once and pick a working transport (`response_format` → `structured_outputs` → `guided_json`) |
| `"response_format"`     | OpenAI-standard `response_format` (no probe; fails fast if rejected)                      |
| `"structured_outputs"`  | vLLM-native `structured_outputs.json` (v0.12.0+)                                          |
| `"legacy_guided_json"`  | Old `guided_json` (pre-0.12.0 only)                                                       |

When enabled, the v3 plugin pipeline converts its Yup schemas to JSON Schema and
sends them so vLLM constrains decoding; Yup validation stays as a safety net.
Disable auto-probing with the env var `ARCHIVAR_JSON_SCHEMA_PROBE=0`.

**Server prerequisite:** the vLLM OpenAI-compatible server has structured
outputs on by default; backend selection is via
`--structured-outputs-config.backend=auto`. For **reasoning models** also set
`--structured-outputs-config.enable_in_reasoning=True`, otherwise structured
output may be silently disabled.

## Configuration

### Environment files: `.env.local` (dev) vs `.env` (container)

Two separate env files, two runtimes-never shared:

| File | Created from | Consumed by |
|------|--------------|-------------|
| `.env.local` | `.env.local.example` (via `make setup`) | Dev server (`pnpm dev` sets `ENV_FILE=.env.local`), the CLI, and the vitest suite |
| `.env` | `.env.example` (manual copy) | The container deployment: sourced by `config.sh`, bind-mounted to `/app/.env` and injected via `docker run --env-file` by `start.sh`; inside the container `ENV_FILE=.env` (set by `docker/entrypoint.sh`) |

The example files are committable templates; real `.env*` files stay gitignored.
Model endpoints differ deliberately between the two: `.env.local` uses
`localhost` (dev server and model servers on the same machine), while `.env`
uses `host.docker.internal` (`start.sh` maps it to the host gateway
automatically). All paths are relative to the checkout-a fresh checkout
works without editing machine-specific absolute paths.

### Environment Variables

Key configuration options in `.env.local` (created from `.env.local.example` by `make setup`):

```bash
# Per-model endpoint/credential overrides (matched by model name)-this is
# where inference endpoints are configured. Defaults target the S
# configuration (gemma-4-E4B on :9031, Qwen3-ASR-0.6B on :8932).
MODEL_CONFIG='[{"name":"gemma4-e4b-qat-w4a16","endpoint":"http://localhost:9031","apiKey":"your-api-key"},{"name":"qwen-asr-0.6b","endpoint":"http://localhost:8932","apiKey":"your-api-key"},...]'

# API key for the CLI/REST guard (matches the code default)
API_KEY=your-api-key

# Dashboard login
AUTH_USERNAME=change-me
AUTH_PASSWORD=change-me

# Data directory configuration
# The data directory determines where media files are located for analysis.
# There is NO --data-dir CLI flag. Use one of the following environment variables:
SAMPLE_DATA_SERVER="http://127.0.0.1:8090"   # Optional HTTP server that hosts the media files for the dashboard player
SAMPLE_DATA_BASE_PATH=archivar               # URL path under the sample-data server (empty-server fallback: sample_data/archivar)
RELATIVE_SAMPLE_DATA_PATH=../sample_data/archivar  # Relative to project root (default: the archivar corpus)
SAMPLE_DATA_SUBDIR=sample_data/archivar      # Subdirectory name used to build the container-visible path (/sample_data/archivar)

# Tools path (for the external segmentation tools, resolved as sibling projects)
RELATIVE_TOOLS_PATH=..
```

#### Data Directory Resolution

The CLI resolves the `--file` pattern against the configured data directory:

1. `SAMPLE_DATA_SUBDIR` defaults to `sample_data/archivar`
2. `RELATIVE_SAMPLE_DATA_PATH` defaults to `../${SAMPLE_DATA_SUBDIR}` (relative to `process.cwd()`)

`ABSOLUTE_SAMPLE_DATA_PATH` is a different concern: it sets the
**container-visible** path prefix (`FileInfo.absolutePath`, used for `file://`
references sent to inference containers) and defaults to `/${SAMPLE_DATA_SUBDIR}`.
Host-side paths are always the real absolute paths the files were discovered at.

`ABSOLUTE_DIR_PREFIX` is an optional escape hatch (normally unset): when set,
the cache storage root anchors at `<ABSOLUTE_DIR_PREFIX>/<SAMPLE_DATA_SUBDIR>`
instead of being derived. It must never hold machine-specific absolute paths in
the shipped configuration-the container derives the storage root from the
fixed `/sample_data/archivar` mount point, the dev server from
`RELATIVE_SAMPLE_DATA_PATH`.

**Examples of overriding at runtime:**

```bash
# Use a custom relative data directory
RELATIVE_SAMPLE_DATA_PATH="../my-media" pnpm cli analyze --file demo.mp4

# Override the subdirectory name
SAMPLE_DATA_SUBDIR="videos/2024" pnpm cli analyze --file "*.mp4"
```

### File Structure

The application expects the following structure:

```
sample_data/
├── archivar/            # Default data directory (evaluation corpus)
│   ├── *.webm
│   └── out_*/           # Analysis output directories
│       ├── scenes/
│       ├── scene_keyframes/
│       ├── *_speech_*.mp3
│       ├── *_silence_*.mp3
│       └── ...
└── test/                # Small demo/format-matrix corpus (unit/e2e tests)
    ├── demo.mp4
    ├── demo.wav
    └── out_*/
```

## Output Structure

Analysis tools create organized output directories:

```
out_{filename}_{extension}_{hash}/
├── {filename}_{hash}_scenes.json    # Scene detection results
├── scenes/                          # Individual scene videos
│   ├── 001_15.423_45.201.mp4
│   └── 002_45.301_78.654.mp4
├── scene_keyframes/                 # Scene thumbnails
│   ├── 001_15.423_45.201.png
│   └── 002_45.301_78.654.png
├── *_speech_*.mp3                   # Speech segments
├── *_silence_*.mp3                  # Silence segments
├── *_noise_*.mp3                    # Noise segments
├── *_harmonic_*.mp3                 # Harmonic content
└── ...
```

The File API automatically detects and organizes these outputs for display in the UI.

## Timeline Visualization

The timeline provides a comprehensive view of media content:

### Audio Regions

- **Speech** (blue) - Detected speech segments
- **Silence** (green) - Silent periods
- **Noise** (yellow) - Non-speech audio
- **Harmonic** (red) - Musical/harmonic content
- **Ambience** (purple) - Background ambience

### Scene Regions

- Visual markers showing detected scene boundaries
- Automatically extracted from scene segmentation results

### Event System

Events are created from:
- Audio regions (speech, silence, noise, etc.)
- Scene boundaries
- Scene keyframes

Events can be filtered by time and annotated with AI-generated captions.

## Development

### Project Structure

```
archivar-poc/
├── src/
│   ├── csr/              # Client-side React components
│   │   ├── screens/      # Main application screens
│   │   └── components/   # Reusable components
│   ├── rpc/              # RPC API definitions
│   │   ├── file-api.ts   # File management
│   │   ├── analyse-api.ts # Analysis tools integration
│   │   └── mllm-api.ts   # Multi-modal LLM integration
│   ├── pages/            # Astro pages
│   └── layouts/          # Page layouts
├── public/               # Static assets
├── docker/               # Docker configuration
└── dist/                 # Build output
```

### Adding New Analysis Tools

1. Add the tool as a sibling project (`../your-tool/run.sh`, next to `segment-scenes`)-tools resolve via `RELATIVE_TOOLS_PATH`
2. Add method to `AnalyseApi` class
3. Add RPC whitelist entry in `src/rpc.ts`
4. Integrate into dashboard UI

### Adding New Caption Types

1. Add method to `MllmApi` class
2. Add RPC whitelist entry
3. Update `onCaptionRequested` handler in dashboard

## Integration with External Tools

The platform integrates with external analysis tools via shell scripts:

- **segment-scenes** - Scene detection using TransNetV2
- **segment-temporal** - Temporal segmentation with Silero VAD (transcoding, speech/silence/harmonic/noise splitting)

Tools are executed via `run.sh` scripts and expected to output JSON results.

## v3 Post-Processing Plugins, Pipeline Chaining & Question-Answer Pipeline

The v3 plugin system allows chaining multiple post-processing plugins in a single
workflow. Plugins run **sequentially** sorted by `order` (ascending), and each
plugin's results are accumulated in `AnalysisResult.postProcessing[pluginName]`.
Later plugins can access earlier plugins' results via the `input` parameter.

### Execution Order Guarantee

In `archivar.config.ts`, plugins are sorted by `order` and executed in sequence:

```typescript
postProcessing: [
  { name: "default", importPath: "./plugins/default.ts", order: 0, ... },
  { name: "question-answer", importPath: "./plugins/question-answer.ts", order: 1, ... },
]
```

The `default` plugin's **entire lifecycle** (all hooks) completes before
`question-answer.ts` starts. No parallelism between plugins.

### Uniform `input` Access Across All Hooks

Every v3 hook receives an optional `input` parameter (last position) that gives
access to `input.analysisResult.postProcessing[pluginName]`-the accumulated
results from all plugins that ran earlier in the same workflow:

| Hook | `input` access |
|------|----------------|
| `postProcessPerTimeSlice(input, ...)` | ✅ 1st param |
| `decideForAggregation(prev, curr, ..., input?)` | ✅ last param |
| `postProcessPerAggregation(agg, slices, ..., input?)` | ✅ last param |
| `summaryForAggregation(agg, ..., input?)` | ✅ last param |
| `summaryFromAggregations(aggs, ..., input?)` | ✅ last param |
| `summaryFromTimeSlices(input, ...)` | ✅ 1st param |

**Backward-compatible:** `input` is optional on all hooks. Existing plugins with
fewer parameters are unaffected.

**Read-only contract:** Plugins should treat `input.analysisResult` as read-only.
The engine persists plugin results; plugins return data via return values.

### Question-Answer Pipeline Plugin

The generalized [`plugins/question-answer.ts`](plugins/question-answer.ts) plugin is a fully configurable pipeline. It supports
multiple question types, analysis scopes, result formats, and rendering modes.

#### Question Types

| Type | MLLM returns | Use case |
|------|-------------|----------|
| `boolean` | `{answer: true/false, reasoning}` | Yes/no classification |
| `oneOf` | `{answer: "option", reasoning}` | Constrained single-choice (requires `options`) |
| `manyOf` | `{answers: ["opt1", ...], reasoning}` | Constrained multi-choice tagging (requires `options`) |
| `singleClaim` | `{answer: "sentence", reasoning}` | Free-text single claim |
| `categorization` | `{categories: ["cat1", ...], reasoning}` | Unconstrained free tagging |

#### Analysis Scopes

| Scope | Behavior |
|-------|----------|
| `wholeSummary` | Single MLLM call against the whole-video summary |
| `everyAggregationSummaryThenConclude` | N calls per aggregation + 1 conclusion call |

#### Result Formats & Rendering

| `resultFormat` | `rendering` | Effect |
|----------------|-------------|--------|
| `markdownTable` | `appendToSummary` | Markdown table appended to `long_summary` (rendered as HTML in dashboard) |
| `json` | `appendToSummary` | JSON code block appended to `long_summary` |
| any | `none` | Stored only in `result.postProcessing[pluginName].question_answer_results` |

#### Configuration Example

```typescript
config: {
  modelName: "Qwen3.8-27B-FP8",
  questions: [
    {
      prompt: "Handelt es sich bei diesem Video um Mathematik?",
      type: "oneOf",
      options: ["ja", "nein", "unsicher"],
      analyze: "wholeSummary",
      label: "isAboutMath",
      resultFormat: "markdownTable",
      rendering: "appendToSummary",
    },
    {
      prompt: "Welche Themen werden behandelt?",
      type: "manyOf",
      options: ["Politik", "Wirtschaft", "Sport", "Kultur", "Wissenschaft", "Bildung"],
      analyze: "everyAggregationSummaryThenConclude",
      label: "topics",
      rendering: "none",
    },
  ],
}
```

#### Dashboard Rendering

The dashboard renders `long_summary` as Markdown (tables, code blocks, bold) using the
`marked` library. Markdown tables from `appendToSummary` questions appear as styled HTML
tables in the summary view.

### Using the Question-Answer Plugin in a Workflow

Add it as a `postProcessing` entry in `archivar.config.ts` (after the `default`
plugin) and run:

```bash
pnpm cli analyze --file "demo.mp4" --workflow <your-workflow>
```

## Performance Considerations

- **Chunked processing** - Large files are processed in chunks to manage memory
- **Lazy loading** - File lists and metadata loaded on demand
- **Efficient decoding** - Uses optimized video/audio decoding
- **GPU acceleration** - External tools can leverage GPU when available

## Why archivar-poc?

Traditional media management tools either:

- Lack semantic understanding (only metadata-based search)
- Require manual annotation (time-consuming and error-prone)
- Don't integrate analysis tools (fragmented workflows)
- Lack timeline visualization (hard to understand content structure)
- Don't support multi-modal AI (limited to single content types)

**archivar-poc** provides a complete solution:

- **Semantic understanding** - AI-powered captioning and analysis
- **Automated workflows** - Scene detection, ASR, and segmentation
- **Integrated platform** - All tools accessible through unified interface
- **Timeline visualization** - Visual understanding of content structure
- **Multi-modal support** - Videos, images, and audio in one platform
- **Extensible architecture** - Easy to add new analysis tools and caption types

