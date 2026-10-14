APP_NAME := archivar-poc
PID_FILE := .dev.pid
LOG_FILE := .dev.log
# dev server port (dev-* targets)
DEV_PORT := 8801
# published container port (matches config.sh's ARCHIVAR_PORT default)
CONTAINER_PORT := 8802

.PHONY: setup start stop status health logs restart analyze build test clean test-config e2e open \
        dev-start dev-stop dev-restart dev-status dev-logs \
        container-setup container-build container-start container-stop container-logs container-status

# ============================================================================
# Primary targets: the CONTAINER variant (Dockerfile + start.sh, Caddy on
# :8802). The host-local dev server remains available under dev-* (:8801).
# ============================================================================

# Install deps and seed the env files (idempotent): .env.local for tests/dev,
# .env for the container.
setup:
	pnpm install
	@if [ ! -f .env.local ]; then cp .env.local.example .env.local && echo "Created .env.local from .env.local.example — review credentials/endpoints."; fi
	@if [ ! -f .env ]; then cp .env.example .env && echo "Created .env from .env.example — review credentials/endpoints."; fi

# Seed only the container env file (also used by container-build).
container-setup:
	@if [ ! -f .env ]; then cp .env.example .env && echo "Created .env from .env.example — review credentials/endpoints."; fi

# Build the archivar:latest image explicitly (start builds only when missing).
container-build: container-setup
	./build.sh

# Start the archivar container on :8802 (builds the image only when missing —
# never on every start)
start: container-setup
	@docker image inspect archivar:latest >/dev/null 2>&1 || ./build.sh
	ASSUME_YES=1 ./start.sh

# Stop and remove the archivar container
stop:
	ASSUME_YES=1 ./stop.sh

# Fresh container instance (no image rebuild — use container-build for that)
restart: stop start

# Container status + app health (container port, default 8802)
status: health
	@./status.sh

# Health check — probes the app's /health endpoint (container port, override
# with ARCHIVAR_PORT=8801 when probing a dev server)
health:
	@PORT=$${ARCHIVAR_PORT:-$(CONTAINER_PORT)}; \
	echo "Health check (http://localhost:$$PORT/health):"; \
	curl -s --max-time 60 "http://localhost:$$PORT/health" | \
		python3 -c "import sys,json; d=json.load(sys.stdin); print('  status:', d['status']); [print(f'  {k}: ok={v[\"ok\"]} base_url={v.get(\"base_url\",\"\")[:40]}') for k,v in d['checks'].items()]" 2>/dev/null || \
		echo "  (health endpoint not ready yet — wait a few seconds after start)"

# Follow the archivar container's logs
logs:
	./logs.sh -f

# Open the app in the default browser (container port, override ARCHIVAR_PORT=...)
open:
	@PORT=$${ARCHIVAR_PORT:-$(CONTAINER_PORT)}; \
	echo "Opening http://localhost:$$PORT"; \
	xdg-open "http://localhost:$$PORT" >/dev/null 2>&1 || \
		open "http://localhost:$$PORT" 2>/dev/null || \
		echo "Could not open a browser — visit http://localhost:$$PORT manually."

# Aliases kept for muscle memory and scripts
container-start: start
container-stop: stop
container-status: status
container-logs: logs

# ============================================================================
# Dev server (host-local, PID-file based, port 8801) — for development/tests
# ============================================================================

dev-start:
	@if [ -f $(PID_FILE) ] && kill -0 $$(cat $(PID_FILE)) 2>/dev/null; then \
		echo "$(APP_NAME) dev server is already running (PID $$(cat $(PID_FILE)))"; \
	else \
		echo "Starting $(APP_NAME) dev server on :$(DEV_PORT)..."; \
		setsid nohup pnpm dev > $(LOG_FILE) 2>&1 & echo $$! > $(PID_FILE); \
		echo "$(APP_NAME) dev server started (PID $$(cat $(PID_FILE)))"; \
	fi

dev-stop:
	@if [ -f $(PID_FILE) ] && kill -0 $$(cat $(PID_FILE)) 2>/dev/null; then \
		PID=$$(cat $(PID_FILE)); \
		echo "Stopping $(APP_NAME) dev server (PID $$PID) and child processes..."; \
		kill -- -$$PID 2>/dev/null || pkill -P $$PID 2>/dev/null; \
		kill $$PID 2>/dev/null; \
		rm -f $(PID_FILE); \
		echo "$(APP_NAME) dev server stopped."; \
	else \
		echo "$(APP_NAME) dev server is not running."; \
		rm -f $(PID_FILE); \
	fi

# Restart the dev server (stop, rebuild, start)
dev-restart: dev-stop build dev-start
	@sleep 3

dev-status:
	@if [ -f $(PID_FILE) ] && kill -0 $$(cat $(PID_FILE)) 2>/dev/null; then \
		echo "$(APP_NAME) dev server is running (PID $$(cat $(PID_FILE)))"; \
	else \
		echo "$(APP_NAME) dev server is not running."; \
		rm -f $(PID_FILE); \
	fi
	@PORT=$${PORT:-$(DEV_PORT)}; \
	echo "Health check (http://localhost:$$PORT/health):"; \
	curl -s --max-time 60 "http://localhost:$$PORT/health" | \
		python3 -c "import sys,json; d=json.load(sys.stdin); print('  status:', d['status']); [print(f'  {k}: ok={v[\"ok\"]} base_url={v.get(\"base_url\",\"\")[:40]}') for k,v in d['checks'].items()]" 2>/dev/null || \
		echo "  (health endpoint not ready yet — wait a few seconds after dev-start)"

dev-logs:
	@if [ -f $(LOG_FILE) ]; then \
		tail -f $(LOG_FILE); \
	else \
		echo "No log file found."; \
	fi

# ============================================================================
# Analysis / test targets
# ============================================================================

# Analyze a file with a given workflow
# Usage: make analyze FILE=<path> WORKFLOW=<name> [FORMAT=json|text] [FORCE=1] [ONLY="stage:name"]
#   e.g. make analyze FILE="../sample_data/archivar/demo.mp4" WORKFLOW=default-analysis-gemma4-e4b
#   e.g. make analyze FILE="../sample_data/archivar/demo.mp4" WORKFLOW=default-analysis-gemma4-e4b FORMAT=json FORCE=1
#   e.g. make analyze FILE="../sample_data/archivar/demo.mp4" WORKFLOW=default-analysis-gemma4-e4b FORCE=1 ONLY="processing:scene"
#   ONLY stages: preProcessing:segmentTemporal|segmentScenes
#                processing:scene|speech|keyframe|harmonic|noise
#                postProcessing:<plugin_name>
.SECONDARY:
analyze:
	@if [ -z "$(FILE)" ]; then echo "Usage: make analyze FILE=<path> WORKFLOW=<name> [FORMAT=json|text] [FORCE=1] [ONLY=stage:name]"; exit 1; fi; \
	if [ -z "$(WORKFLOW)" ]; then echo "Usage: make analyze FILE=<path> WORKFLOW=<name> [FORMAT=json|text] [FORCE=1] [ONLY=stage:name]"; exit 1; fi; \
	ABS_FILE=$$(realpath -m "$(FILE)"); \
	EXTRA=""; \
	if [ "$(FORCE)" = "1" ]; then EXTRA="--force"; fi; \
	if [ -n "$(ONLY)" ]; then EXTRA="$$EXTRA --only $(ONLY)"; fi; \
	pnpm exec tsx src/cli.ts analyze --file "$$ABS_FILE" --workflow "$(WORKFLOW)" --format "$${FORMAT:-json}" $$EXTRA

# Build the production bundle
build: clean
	pnpm run build

test-config:
	@pnpm cli validate

# Run the full vitest suite (unit + integration + live e2e; live tests gate
# themselves on model/server health). The suites default to the app on :8802
# (the container); override for dev-server mode:
#   make test SERVER_URL=http://localhost:8801
test: test-config
	@cd $(dir $(abspath $(lastword $(MAKEFILE_LIST)))) && pnpm exec vitest run

clean:
	@pnpm run clean

e2e:
	@pnpm vitest run e2e
