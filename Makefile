# Root orchestration for the S configuration (small footprint, single machine):
#   VLM (video/image analysis): Gemma4-E4B-QAT-W4A16   -> http://localhost:9031
#   ASR (transcription):        Qwen3-ASR-0.6B         -> http://localhost:8932
#   Pre-processing service:     segment-scenes         (segment-temporal runs as a batch tool)
#   Main application:           archivar-poc (container) -> http://localhost:8802
#
# The M and L configurations (see README.md) are intentionally NOT wired up
# here; start them from their own project directories.
#
# Typical flow:
#   make setup    # install everything (images, models, deps, demo test data)
#   make start    # start the S configuration + the app container (:8802)
#   make test     # run archivar-poc tests + e2e against the S configuration
#   make open     # open the web UI (:8802)

ASR_DIR := Qwen3-ASR-0.6B
VLM_DIR := Gemma4-E4B-QAT-W4A16
APP_DIR := archivar-poc

.PHONY: setup download-test-data download-public-dataset start stop status test open

# Install everything: inference-server images + models, service deps, app deps,
# and the demo test data in sample_data/test.
setup:
	$(MAKE) -C $(VLM_DIR) setup
	$(MAKE) -C $(ASR_DIR) setup
	$(MAKE) -C segment-scenes setup
	$(MAKE) -C segment-temporal setup
	$(MAKE) -C sample-data-serve setup
	$(MAKE) -C $(APP_DIR) setup
	$(MAKE) download-test-data

# Demo test files for archivar (sample_data/test/demo.*): download the demo
# video, cut to 10s, extract the first frame, transcode the format matrix.
download-test-data:
	./$(APP_DIR)/evaluation/demo/download.sh

# Public eval dataset (16 CC-licensed videos): download + preprocess into
# sample_data/archivar. Only needed to re-run the evaluation.
download-public-dataset:
	./$(APP_DIR)/evaluation/public-dataset/setup.sh

start:
	$(MAKE) -C $(ASR_DIR) start
	$(MAKE) -C $(VLM_DIR) start
	$(MAKE) -C segment-scenes start
	$(MAKE) -C sample-data-serve start
	$(MAKE) -C $(APP_DIR) start

stop:
	-$(MAKE) -C $(APP_DIR) stop
	-$(MAKE) -C sample-data-serve stop
	-$(MAKE) -C segment-scenes stop
	-$(MAKE) -C $(VLM_DIR) stop
	-$(MAKE) -C $(ASR_DIR) stop

status:
	$(MAKE) -C $(ASR_DIR) status
	$(MAKE) -C $(VLM_DIR) status
	$(MAKE) -C segment-scenes status
	$(MAKE) -C sample-data-serve status
	$(MAKE) -C $(APP_DIR) status

# Full technical test of the S configuration: unit/integration tests plus the
# live e2e suites (they exercise the running inference servers and pipeline).
test:
	$(MAKE) -C $(APP_DIR) test e2e

open:
	$(MAKE) -C $(APP_DIR) open
