# Root-Level Configuration & Infrastructure Architecture

This document describes every root-level configuration and infrastructure file in the `archivar-poc` project. Each entry covers the file's purpose and highlights architectural concerns such as cache management, environment-variable-driven path decisions, third-party API protocol implementations (especially LLM inference), and algorithmic complexity.

---

## `archivar.config.ts`
[`archivar.config.ts`](archivar.config.ts)

**Purpose:** The central application configuration file. It defines the singleton [`ArchivarConfig`](archivar.config.ts) object via [`setArchivarConfig()`](archivar.config.ts), which is consumed by the entire runtime (workflow engine, RPC API layers, CLI). It declares authentication users, available AI models, and the full set of analysis workflows with their pre-processing, processing, and post-processing stages.

**Key Concerns:**

- **3rd Party LLM API Protocols:** Configures multiple model types that map to distinct inference protocols:
  - `type: "api"`-OpenAI-compatible chat/completion endpoints (e.g. [`Qwen3.8-27B-FP8`](archivar.config.ts), [`Qwen3.6-35B-A3B-GPTQ-Int4`](archivar.config.ts)). Each model defines hyperparameters (`temperature`, `top_p`, `top_k`, `presence_penalty`, `max_tokens`), `parallelism` concurrency limits, and `enableThinking` toggles for chain-of-thought modes.
  - `type: "asr-api"`-Speech recognition API endpoints ([`qwen-asr-0.6b`](archivar.config.ts), [`Whisper3-Large-Turbo-DE`](archivar.config.ts), [`parakeet-primeline-de`](archivar.config.ts)) with optional language targeting and `maxLengthInSec` (speech segments longer than this are split by temporal segmentation via `--max-len-speech`, so the ASR encoder cache is never exceeded).
  - `type: "tool"`-External CLI tool invocation via `AnalyseApi.executeScript`, with `compatibleMediaTypes` filtering. Currently unused: no shipped workflow references a tool-type model.
- **Environment-Driven Configuration:** Auth credentials use `env:` prefix resolution ([`username: "env:AUTH_USERNAME"`](archivar.config.ts), [`password: "env:AUTH_PASSWORD"`](archivar.config.ts)), meaning values are read from environment variables at runtime via the config loader.
- **Workflow Pipeline Architecture:** Defines the active workflows-`default-analysis` and its model variants `default-analysis-35b`, `default-analysis-gemma4-e4b` (same pipeline, different captioning/ASR model pairs)-each with a multi-stage pipeline: `preProcessing` (scene/temporal segmentation), `processing` (per-media-type model inference), and `postProcessing` (plugin-based aggregation/analysis). All active workflows include a `keyframe` step that ships **default-disabled** (`enabled: false` + `enabledAsFallback: true`): keyframe analysis runs only for single-image input (an image is analyzed as exactly one keyframe-see the engine's single-image pre-processing branch and `resolveEnabledProcessingSteps()`) or when explicitly enabled by the user (wizard checkbox / CLI override); when enabled for a video, only keyframes whose parent scene lacks a valid caption are captioned. Whole-video summaries are produced by post-processing plugins (e.g. `plugins/default.ts`'s `summaryFromAggregations` hook)-there is no separate summary stage.
- **Plugin System:** Post-processing stages reference plugins by `importPath` (the shipped workflows wire up only [`./plugins/default.ts`](archivar.config.ts); [`plugins/question-answer.ts`](plugins/question-answer.ts) exists as a configurable add-on) with per-plugin `config` blocks, `order` execution priority, and `enabled` toggles. The engine only invokes the named `PostProcessingPluginModule` hooks (e.g. `postProcessPerTimeSlice`, `summaryFromAggregations`)-there is no `run()`-style contract.
- **Segmentation Tuning:** The workflows use the object-form `segmentScenes` config with `fps`, `doSampleFrames`, `maxLengthPerClipInSecs`, `maxWidthPx`, `maxHeightPx` to tune the scene segmentation CLI for the video model's constraints.
- **Inference-side `mm_processor_kwargs` propagation:** Model configs ([`ModelConfig`](src/lib/workflow-types.ts)) can declare `mmProcessorKwargs` (e.g. `{ fps: 4, do_sample_frames: true }`) which are passed to vLLM at inference time. These are overridden per-step by `ProcessingStep.mmProcessorKwargs` and per-workflow by `SegmentScenesConfig.fps`/`doSampleFrames`. The merge logic lives in [`buildInferenceMmProcessorKwargs()`](src/lib/archivar-config.ts) and the vLLM default+override merge in [`resolveMmProcessorKwargs()`](src/rpc/mllm-api.ts).
- **Defaults:** The active default workflow is [`default-analysis-gemma4-e4b`](archivar.config.ts) (S configuration: gemma-4-E4B captioning + Qwen3-ASR-0.6B transcription).

---

## `astro.config.ts`
[`astro.config.ts`](astro.config.ts)

**Purpose:** Astro framework configuration for the web application. Configures the SSR server (port 8801, host 0.0.0.0), the [`defuss-astro`](astro.config.ts) JSX rendering integration, TailwindCSS + FrankenUI Vite plugins, and the Node.js standalone adapter for production.

**Key Concerns:**

- **Environment-Driven Host Allowlist:** The [`allowedHosts`](astro.config.ts) array restricts which hostnames the dev/preview server accepts-Docker-internal (`host.docker.internal`, `archivar.local`) and local (`localhost`, `127.0.0.1`).
- **HMR Client Port:** The Vite HMR client port is hardcoded to `443` ([`clientPort: 443`](astro.config.ts)), which is significant for Docker/reverse-proxy setups where the browser connects over TLS but the dev server runs on plain HTTP.
- **Asset Handling:** Native `.node` binary addons are treated as assets ([`assetsInclude: ["**/*.node"]`](astro.config.ts)) to prevent Vite from parsing them as JavaScript.
- **SSR Bundling:** `astro` is marked as `noExternal` in SSR ([`astro.config.ts`](astro.config.ts)) so it's bundled into the server output rather than treated as an external dependency.
- **FrankenUI Layer Control:** The FrankenUI plugin is configured with `preflight: false` and layer exceptions for `chart` ([`astro.config.ts`](astro.config.ts)).

---

## `Dockerfile`
[`Dockerfile`](Dockerfile)

**Purpose:** Defines the production Docker image for the application. Builds on `node:lts`, installs system dependencies (including `ffmpeg`), Caddy (reverse proxy), and Docker CE CLI (for running inference tool containers from within the app container), then builds the Astro application.

**Key Concerns:**

- **Docker-in-Docker via CLI:** Installs `docker-ce-cli` ([`Dockerfile`](Dockerfile)) so the application can spawn sibling Docker containers for inference tools (ASR, scene segmentation). This requires the host's Docker socket to be mounted (see [`start.sh`](start.sh)).
- **Non-root runtime:** The app runs as the image's built-in `node` user (UID 1000); tool containers spawned through the mounted Docker socket inherit this identity, so `out_*` folders stay writable for the segmentation services.
- **Caddy Reverse Proxy:** Caddy is installed from its official APT repository and its config is copied from [`docker/Caddyfile`](Dockerfile) to `/etc/caddy/Caddyfile`.
- **Sample Data Volume Mount:** Creates a symlink from `/sample_data` to `/app/public/sample_data` ([`Dockerfile`](Dockerfile)) so that host-mounted sample data is accessible to Astro's static file serving.
- **Tool wrapper permissions:** `run.sh` scripts under `public/tools` are chmodded executable at build time-the git executable bit does not survive every checkout.
- **Port Exposure:** Exposes ports `8801` (Astro dev server, behind Caddy on `:80`) and `9229` (reserved for the Node.js debugger; the entrypoint does not enable the inspector by default) ([`Dockerfile`](Dockerfile)).
- **Build Caching:** The dependency manifests (`package.json`, `pnpm-lock.yaml`) are copied and `pnpm install --frozen-lockfile` is run before the full application source is copied ([`Dockerfile`](Dockerfile)) for Docker layer caching and reproducible builds (floating installs without the lockfile pulled an incompatible Vite/Astro and broke the image build). pnpm is pinned to the `packageManager` version from `package.json`.

---

## `.env.local.example` / `.env.example`
[`.env.local.example`](.env.local.example) · [`.env.example`](.env.example)

**Purpose:** Committable env templates for the two separate runtime env files. `.env.local` (dev) is created from `.env.local.example` by `make setup` and read by the dev server, CLI, and tests (`ENV_FILE=.env.local`). `.env` (container) is copied from `.env.example` manually and consumed only by the container deployment: `config.sh` sources it, `start.sh` bind-mounts it to `/app/.env` and injects it via `docker run --env-file`; inside the container `ENV_FILE=.env` (set by `docker/entrypoint.sh`). Both define the connection endpoints, credentials, and data paths used at runtime. (The former single `env.default` template was removed in favor of this split.)

**Key Concerns:**

- **Model endpoints:** `MODEL_CONFIG` maps each configured model name to its endpoint + API key. Defaults target the S configuration (gemma-4-E4B VLM on :9031, Qwen3-ASR-0.6B on :8932, both `your-api-key`); the M/L model endpoints are listed but only needed for the `default-analysis`/`default-analysis-35b` workflows. Endpoints differ deliberately per variant: `.env.local.example` uses `localhost` (dev server and model servers on the same machine), `.env.example` uses `host.docker.internal` (mapped to the host gateway by `start.sh`).
- **API Key & Auth:** `AUTH_USERNAME`/`AUTH_PASSWORD` ship as placeholders; `API_KEY` is `your-api-key`, matching the code-level default so the CLI works out of the box.
- **Environment-Driven Path Decisions:** All paths are relative to the checkout-no machine-specific absolute paths anywhere:
  - `RELATIVE_SAMPLE_DATA_PATH`-relative path from app root to sample data (`../sample_data/archivar`, dev only).
  - `SAMPLE_DATA_SUBDIR`-subdirectory name used to build the container-visible path (`/sample_data/archivar`).
  - `SAMPLE_DATA_BASE_PATH`-URL path under the sample-data server (`archivar` for the dev player via sample-data-serve; `sample_data/archivar` for the container's empty-server fallback via the `/app/public/sample_data` symlink).
  - `SAMPLE_DATA_SERVER`-optional remote sample data server URL.
  - `ARCHIVAR_DATA_DIR` / `ARCHIVAR_TOOLS_DIR` (container only)-host-side mount sources, resolved by `config.sh` relative to the scripts' own location.
  - `ABSOLUTE_DIR_PREFIX`-deliberately **unset**: optional escape hatch that would anchor the cache storage root at `<prefix>/<SAMPLE_DATA_SUBDIR>` (see `src/db/db.ts`). The container derives the root from the fixed `/sample_data/archivar` mount point, the dev server from `RELATIVE_SAMPLE_DATA_PATH`.
- **Security Note:** The templates contain plaintext development credentials. The `.env*` pattern in [`.gitignore`](.gitignore) prevents committing actual `.env` files while keeping the two `*.example` templates committable.

---

## `package.json`
[`package.json`](package.json)

**Purpose:** NPM package manifest defining the project name, version, scripts, and dependencies. Private ESM module (`"type": "module"`) using pnpm 9.13.2.

**Key Concerns:**

- **Build/Dev Scripts:** The [`dev`](package.json) script sets `ENV_FILE=.env.local` and runs Astro dev on port 8801. The [`start`](package.json) script runs the prebuilt SSR bundle (`dist/server/entry.mjs`) in production mode.
- **Port-Based Stop Logic:** The [`stop`](package.json) script implements a multi-fallback PID discovery algorithm-tries `lsof`, falls back to `ss`, then `fuser`-to kill processes listening on port 8801. This is significant for cross-platform process management.
- **CLI Scripts:** [`cli`](package.json) through [`cli:analyze`](package.json) provide CLI entry points via `tsx src/cli.ts` for listing files, workflows, and running analysis.
- **Key Dependencies (Architecturally Significant):**
  - [`defuss-rpc`](package.json)-RPC framework for client-server communication.
  - [`sharp`](package.json)-Image processing (keyframe extraction/thumbnail generation).
  - [`undici`](package.json)-Modern HTTP client for LLM API calls.
  - [`fast-glob`](package.json)-File system traversal for media discovery.
  - [`marked`](package.json)-Markdown rendering for analysis results.
  - DEPRECATED/unused: [`mongodb`](package.json) and [`defuss-db`](package.json) are declared but not imported anywhere-the persistence layer is file-backed (see `src/db/db.ts` + `src/rpc/cache-api.ts`).

---

## `docker/Caddyfile`
[`docker/Caddyfile`](docker/Caddyfile)

**Purpose:** Caddy reverse proxy configuration that sits in front of the Astro dev server inside the Docker container. Caddy listens on `:80` and proxies all traffic to the Astro dev server at `127.0.0.1:8801`.

**Key Concerns:**

- **Permissive CORS:** The [`common`](docker/Caddyfile) snippet sets wildcard CORS headers (`Access-Control-Allow-Origin "*"`, all methods, all headers)-this is necessary because the browser makes direct API calls to the Caddy endpoint from potentially different origins.
- **Reverse Proxy Target:** Proxies to `127.0.0.1:8801` ([`docker/Caddyfile`](docker/Caddyfile)), which is the Astro dev server started by [`entrypoint.sh`](docker/entrypoint.sh). The container exposes `:80` which is mapped to the host port by [`start.sh`](start.sh).
- **Static Root:** Document root is set to `/app` ([`docker/Caddyfile`](docker/Caddyfile)).

---

## `docker/entrypoint.sh`
[`docker/entrypoint.sh`](docker/entrypoint.sh)

**Purpose:** Container entrypoint script that launches both the Astro dev server and Caddy reverse proxy. Runs Astro in development mode.

**Key Concerns:**

- **Dev Mode in Production Container:** Despite being the production Docker image, Astro runs in **dev mode** ([`pnpm astro dev`](docker/entrypoint.sh)) rather than serving the prebuilt SSR bundle. This is architecturally significant-the container always runs with hot module replacement and dev-time features enabled.
- **Process Management:** Astro is started in the background (`&`) while Caddy runs in the foreground with `--watch` so Caddy becomes the PID 1 process and automatically picks up Caddyfile changes.
- **Host Binding:** Astro is bound to `HOST=0.0.0.0` so Caddy (on `127.0.0.1`) can reach it.

---

## `Makefile`
[`Makefile`](Makefile)

**Purpose:** Developer convenience Makefile. The **primary lifecycle targets run the container** (`setup`, `start`, `stop`, `status`, `health`, `logs`, `open`, `restart`): `start` builds the `archivar:latest` image only when missing (explicit rebuilds via `container-build`, `.env` seeded via `setup`/`container-setup`) and publishes Caddy on `ARCHIVAR_PORT` (default **8802**, see `config.sh`). The **host-local dev server** (PID-file, port 8801) lives under `dev-start` / `dev-stop` / `dev-restart` / `dev-status` / `dev-logs`. Analysis/test targets: `analyze`, `build`, `clean`, `test-config`, `test`, `e2e`. `container-start`/`container-stop`/`container-status`/`container-logs` are aliases of the primary targets.

**Key Concerns:**

- **Container-by-default:** `restart` recreates a fresh container instance without rebuilding (code changes land via `container-build`). The mutating scripts run with `ASSUME_YES=1` to skip their interactive confirmations.
- **Process Group Management (dev server):** The [`dev-start`](Makefile) target uses `setsid nohup` to create a new process session/group so that [`dev-stop`](Makefile) can kill the entire process tree via `kill -- -$$PID` (negative PID = process group kill).
- **PID/Lock File Pattern:** Uses `.dev.pid` and `.dev.log` for the dev server's process tracking, both of which are in [`.gitignore`](.gitignore).
- **CLI Analysis Wrapper:** The [`analyze`](Makefile) target wraps the CLI with `tsx src/cli.ts analyze`, supporting `FILE`, `WORKFLOW`, `FORMAT`, `FORCE`, and `ONLY` (stage-level selective execution) parameters. The `ONLY` flag enables granular pipeline stage selection (e.g. `processing:scene`, `postProcessing:default`).
- **Test Integration:** [`test`](Makefile) runs `pnpm cli validate` first (`test-config`), then the full `vitest run` suite. Suites default to the app on :8802 (the container); `make test SERVER_URL=http://localhost:8801` targets a dev server.
- **Port Choice:** The container publishes on 8802 by default, the dev server on 8801-both can run side by side; `health`/`open` probe `ARCHIVAR_PORT` (default 8802).

---

## `start.sh`
[`start.sh`](start.sh)

**Purpose:** Orchestrates launching the Docker container with all required mounts, network configuration, and resource limits. Sources [`config.sh`](config.sh) for shared variables, validates prerequisites, and runs `docker run` with a dynamically assembled argument array.

**Key Concerns:**

- **Docker Socket Mounting:** Mounts the host Docker socket (`/var/run/docker.sock`) into the container ([`start.sh`](start.sh))-this is critical because the application spawns sibling Docker containers for inference tools (ASR, scene segmentation). GPU access (`--gpus all`) and the host's docker group (`--group-add`) are passed along for those tool containers and the non-root runtime user. `host.docker.internal` is mapped to the host gateway (`--add-host …:host-gateway`) so the container can reach model servers published on the Docker host's ports-portable, no machine-specific gateway IPs. `ABSOLUTE_TOOLS_PATH` is injected (the identically-mounted host `TOOLS_DIR`) so the app resolves the sibling tool `run.sh` scripts inside the container (dev resolves `RELATIVE_TOOLS_PATH` against the checkout instead).
- **Environment-Driven Volume Mounts:** Conditionally adds volume mounts based on environment variables:
  - [`DATA_DIR`](start.sh) → mounted to `/sample_data/archivar:rw` (read-write data access).
  - [`TOOLS_DIR`](start.sh) → mounted at its **identical host path**, read-write: tool `run.sh` scripts are spawned inside the container but their `docker run` reaches the host daemon, so only an identical path resolves on both sides; tool containers write `out_*` folders next to the media.
- **IPC & Memory Configuration:** Uses `--ipc=host` ([`start.sh`](start.sh)) and unlimited memlock with 64MB stack ulimits ([`start.sh`](start.sh))-required for GPU/inference workloads.
- **Network Aliasing:** Container gets network alias `archivar` ([`start.sh`](start.sh)) on the `local-cloud` Docker network, enabling other containers to reach it by hostname.
- **Environment File:** `.env` (the container variant, see [`.env.example`](.env.example)) is both bind-mounted read-only at `/app/.env` and injected into the process environment via `--env-file`-the bind mount alone only makes the file readable; endpoint resolution reads the process environment. Inside the container `ENV_FILE=.env` (set by `docker/entrypoint.sh`) makes the env loaders resolve the same file; the dev server's `.env.local` is never used here.
- **Extra Hosts Resolution:** Parses the comma-separated [`EXTRA_HOSTS`](start.sh) environment variable and adds `--add-host` entries for custom DNS resolution (empty by default; set per machine in `.env`).
- **Auto-Restart Policy:** Container is set to `--restart unless-stopped` ([`start.sh`](start.sh)).
- **Non-interactive Mode:** The confirmation prompts (network creation, start/stop) honor `ASSUME_YES=1`, which the Make `container-*` targets set.

---

## `stop.sh`
[`stop.sh`](stop.sh)

**Purpose:** Stops and removes the Docker container. Sources [`config.sh`](config.sh) for the container name, checks container status, prompts for confirmation, then force-removes the container.

**Key Concerns:**

- **Container State Inspection:** Queries Docker for container status ([`stop.sh`](stop.sh)) and reports whether it's running, exited, or paused before removal.
- **Force Removal:** Uses `docker rm -f` ([`stop.sh`](stop.sh)) to stop and remove in one operation, regardless of container state.

---

## `build.sh`
[`build.sh`](build.sh)

**Purpose:** Builds the Docker image. Sources [`config.sh`](config.sh) for the image name/tag, then runs `docker build` with plain-text progress output.

**Key Concerns:**

- **No Build Arguments:** The image is built without build args ([`build.sh`](build.sh))-all configuration happens at runtime via environment variables and volume mounts.

---

## `cli.sh`
[`cli.sh`](cli.sh)

**Purpose:** Convenience wrapper to execute the Archivar CLI inside the running Docker container. Sources [`config.sh`](config.sh) for the container name, verifies the container is running, then `docker exec`s `npx tsx /app/src/cli.ts` with all forwarded arguments.

**Key Concerns:**

- **Container CLI Execution:** All CLI commands (list, workflows, analyze) execute inside the container context ([`cli.sh`](cli.sh)), meaning file paths and data volumes resolve relative to the container's filesystem, not the host.

---

## `demo.sh`
[`demo.sh`](demo.sh)

**Purpose:** DEPRECATED smoke-run leftover. The `demo_*.mp4` corpus files no longer exist in `../sample_data`, and the `default-analysis-gemma4` workflow was removed from [`archivar.config.ts`](archivar.config.ts)-the script does not run as-is. Kept as a usage template: point its `run_demo` calls at existing files and a configured workflow (S: `default-analysis-gemma4-e4b`, M: `default-analysis-35b`, L: `default-analysis`) before use.

**Key Concerns:**

- **Fail-fast:** Runs with `set -e`, so the first failed analysis aborts the run.
- **Requires the dev server** on `localhost:8801` and the workflow's captioning/ASR models reachable (see `pnpm cli health`).

---

## `config.sh`
[`config.sh`](config.sh)

**Purpose:** Shared configuration source for all shell scripts (`start.sh`, `stop.sh`, `build.sh`, `cli.sh`). Loads `.env` if present, then exports container, network, and path configuration variables.

**Key Concerns:**

- **Environment File Loading:** Sources `.env` with `set -a` ([`config.sh`](config.sh)) to automatically export all variables-this is how `.env` values propagate to the Docker container launch process.
- **Environment-Driven Path Decisions:** Resolves absolute paths from relative config:
  - [`DATA_DIR`](config.sh) defaults to `../sample_data/archivar` relative to the script directory.
  - [`TOOLS_DIR`](config.sh) defaults to the parent directory of the project.
  - Both use `ARCHIVAR_DATA_DIR` and `ARCHIVAR_TOOLS_DIR` env overrides if present.
- **Extra Hosts Resolution:** Parses the comma-separated [`EXTRA_HOSTS`](config.sh) variable and adds `--add-host` entries for custom DNS resolution (e.g. model servers not on the Docker host). Empty by default-set per machine in `.env`.
- **Network Configuration:** Container network is `local-cloud` ([`config.sh`](config.sh)) with alias `archivar` ([`config.sh`](config.sh)).

---

## `.dockerignore`
[`.dockerignore`](.dockerignore)

**Purpose:** Controls which files are excluded from the Docker build context. Prevents unnecessary or sensitive files from being sent to the Docker daemon during `docker build`.

**Key Concerns:**

- **Build Artifact Exclusion:** `dist` and `.astro` ([`.dockerignore`](.dockerignore)) are excluded since the Dockerfile runs `pnpm build` itself.
- **Environment File Protection:** `.env`, `.env.local`, and `.env.*.local` are excluded ([`.dockerignore`](.dockerignore)) so secrets are never baked into the image-they're mounted at runtime via [`start.sh`](start.sh). Note `pnpm-lock.yaml` is deliberately NOT excluded: the Dockerfile copies it and installs with `--frozen-lockfile`.

---

## `.gitignore`
[`.gitignore`](.gitignore)

**Purpose:** Standard Git ignore file. Excludes build output, dependencies, environment files, IDE settings, and process artifacts from version control.

**Key Concerns:**

- **Environment File Protection:** `.env*` ([`.gitignore`](.gitignore)) prevents all environment variable files from being committed.
- **Dev Process Artifacts:** `.dev.log` and `.dev.pid` ([`.gitignore`](.gitignore)) are generated by the [`Makefile`](Makefile) dev server management.
- **Data Directory:** `public/data/` ([`.gitignore`](.gitignore)) is excluded-this is where processed/archived sample data is served, and it should not be version-controlled.
- **Python Cache:** `__pycache__/` ([`.gitignore`](.gitignore)) is excluded because the project includes Python-based helper tooling. Evaluation staging dirs (`evaluation/**/.staging/`) are likewise excluded-downloaded raw videos are not version-controlled.
