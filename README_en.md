[🇩🇪 Deutsch](README.md) | 🇬🇧 English

# KI-Video-Analyse-Tool: Archivar

> [!IMPORTANT]
> The default **S** configuration is not recommended for production use; its primary purpose is testing the system's technical functionality through end-to-end tests. The best result quality is achieved with the **L** configuration, while the **M** configuration is a reasonable trade-off between quality and speed. For details, see the evaluation results in the Abschlussbericht (final report, German).

> [!WARNING]
> Please do not expect production-ready code. This is a research prototype demonstrating the capabilities of LLMs and multimodal AI systems in the context of media archiving. Use at your own risk.

> [!WARNING]
> **AI disclosure:** All analysis results produced by the Archivar system are entirely AI-generated. The AI can make mistakes. Please verify important information.

The KI-Video-Analyse-Tool Archivar is a technically complete solution for AI-powered video and audio analysis. It consists of a main application (`archivar-poc`) plus self-contained, containerized inference servers (vLLM, OpenAI-compatible APIs). Inference servers come in the T-shirt-size configurations S, M, and L and are functional - however, they must be configured for your specific hardware. All parts of the system access a shared media directory (`sample_data`).

<img src="screenshot.png">

## Get started

* Install Docker with the NVIDIA Container Toolkit.
* Install `uv`: https://docs.astral.sh/uv/getting-started/installation/
* Clone this repository.

Then four commands in the root directory are all you need:

```bash
make setup    # 1. installs everything: container images, model weights,
              #    dependencies, and the demo test data in sample_data/test
make start    # 2. starts the S configuration for test purposes 
              #    (**not recommended for production use**): 
              #    Qwen3-ASR-0.6B (:8932),
              #    Gemma4-E4B (:9031), segment-scenes, sample-data-serve,
              #    and the main application (container) on http://localhost:8802
make test     # 3. technically tests the S configuration end to end:
              #    archivar-poc unit/integration tests + live e2e suites
make open     # 4. opens the archivar web UI in your browser (:8802)
```

More useful targets: `make status` (state of all services), `make stop`, and `make download-public-dataset` (downloads the CC-licensed public eval dataset into `sample_data/archivar` and preprocesses it - only needed to re-run the evaluation).

The **M** and **L** configurations are deliberately not started via the root Makefile - they need considerably more VRAM (see table) and are started from their own project directories (`make setup && make start`). See each project's README for details.

## Configurations

> [!IMPORTANT]
> An AI inference server requires a graphics card (GPU) with sufficient memory (VRAM) that is supported by the inference server for the chosen AI model. The inference server must also be configured to use the correct GPU when several are present, and to use the optimal attention and KV-cache variant. The S configuration provided here is designed for NVIDIA systems and was tested with NVIDIA H200 NVL and RTX 3090 GPUs. The M and L configurations were tested exclusively on NVIDIA H200 NVL GPUs. Please refer to the inference server documentation (e.g. the vLLM project) for the configuration parameters required for your GPU hardware. For operation on NVIDIA DGX Spark devices, see the configurations in the corresponding subdirectories.

The main application (`archivar-poc`) defines three workflow configurations; each pairs one VLM for video/image analysis with one ASR server for transcription:

| Config | Workflow | Type | AI Model | Port | Measured VRAM peak |
|---|---|---|---|---|---|
| **S** | `default-analysis-gemma4-e4b` | VLM | gemma-4-E4B-it-qat-w4a16-ct | 9031 | 19.3 GB peak (15.6 GiB allocated, 17.3 GiB sustained) |
| **S** | `default-analysis-gemma4-e4b` | ASR | Qwen3-ASR-0.6B | 8932 | ~2.8 GB, up to 4.6 GB peak |
| **M** | `default-analysis-35b` | VLM | Qwen3.6-35B-A3B-GPTQ-Int4 | 8931 | 34.5 GB measured (20 GB Int4 weights + 8 GB KV + overhead) |
| **M** | `default-analysis-35b` | ASR | parakeet-primeline-de | 8999 | ~4.3 GB (configured limit 6 GiB) |
| **L** | `default-analysis` | VLM | Qwen3.8-27B-FP8 | 8920 | 51.8 GB measured (~30.9 GB FP8 weights + 14 GB KV) |
| **L** | `default-analysis` | ASR | Whisper3-Large-Turbo-DE | 8998 | ~4.0 GB incl. KV cache |

Scene segmentation (TransNetV2) needs only ~0.9 GB in every configuration. The **peaks of the overall system** (VLM + ASR + scene segmentation) are therefore:

| Config | VLM alone | Full workflow | GPU VRAM capacity |
|---|---|---|---|
| **S** | ~16 GB | **≈ 20 GB** | 24 GB recommended |
| **M** | ~34.5 GB | **≈ 40 GB** | 48 GB recommended |
| **L** | ~51.8 GB | **≈ 57 GB** (with Qwen3-ASR-1.7B instead of Whisper: 59 GB) | 64 GB recommended |

## Layout

| Folder | Description |
|---|---|
| `archivar-poc/` | **Application service** - main application (web platform + CLI); orchestrates the analysis workflows against the inference servers. |
| `sample-data-serve/` | **Application service** - small Caddy container serving `sample_data/` over HTTP. |
| `segment-scenes/` | **Application service** - pre-processing: scene segmentation (TransNetV2) as an HTTP service. |
| `segment-temporal/` | **Application service** - pre-processing: temporal segmentation of video/audio as an HTTP service. |
| `sample_data/` | **Shared data** - common media; mounted at `/sample_data` by every server (`file:///sample_data/test/...` URLs). |
| `Gemma4-E4B-QAT-W4A16/` | **Inference server** - Gemma 4 E4B (QAT W4A16) VLM for video/image analysis (vLLM, S configuration). |
| `Qwen3-ASR-0.6B/` | **Inference server** - Qwen3-ASR 0.6B transcription (vLLM, S configuration). |
| `Qwen3.6-35B-A3B-GPTQ-Int4/` | **Inference server** - Qwen3.6 35B MoE (GPTQ-Int4) VLM (vLLM, M configuration). |
| `parakeet-primeline-de/` | **Inference server** - Parakeet German ASR, primeline pipeline (M configuration). |
| `Qwen3.8-27B-FP8/` | **Inference server** - Qwen3.8 27B (FP8) VLM (vLLM, L configuration). |
| `Whisper3-Large-Turbo-DE/` | **Inference server** - Whisper Large v3 Turbo, German ASR (vLLM, L configuration). |

## Conventions

* Model weights are downloaded into `./model` inside each server directory (gitignored) and mounted into the container.
* All servers require an API key (`your-api-key` by default; override via `.env` or `API_KEY=...`).
* Servers address sample media via `file:///sample_data/...` URLs against the read-only `sample_data` mount (`--allowed-local-media-path`).
* Every project Makefile provides - where meaningful - the targets `setup` (install dependencies), `start`, `stop`, `status`, `logs`, and `test`.

## License

The code of this project is licensed under the MIT License - see the [LICENSE](LICENSE) file for details.

All AI models and media files downloaded via the provided scripts remain subject to the license and usage terms of their respective rights holders.

The prototype is intended for use by media companies.

Copyright (c) 2026 Medien.Bayern GmbH.

## Contributors

Original development by the Medien.Bayern GmbH ([KI.M](https://www.kim-bayern.de/)) - main developer: [Aron Homberg](https://aron-homberg.de).

## A project of KI-Kompetenzzentrum Medien (KI.M)

The KI-Kompetenzzentrum Medien (KI.M) is the central hub for artificial intelligence in Bavaria's media industry. We support media companies in adopting AI solutions that are legally compliant, future-proof, and built on data-sovereign infrastructure.

We provide independent information and hands-on demonstrations of AI capabilities and limitations in media applications. Through our AI Lab, we collaborate with partners to test real-world implementations. Our feasibility studies are published as reports on our website, while the technical foundations and code are shared here in our repositories.

The KI.M is a joint initiative of the Bayerische Landeszentrale für neue Medien (BLM) and Medien.Bayern GmbH, supported by the Bavarian State Chancellery.

**Learn more:** [Visit our website](https://www.kim-bayern.de/)

<img src="RZ_Logo_KIM_RGB_D-Blau.png" alt="KI.M Logo" width="300">
