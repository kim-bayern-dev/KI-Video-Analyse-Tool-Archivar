CONTAINER := sample-data-serve
PORT      := 8090
HEALTH    := http://127.0.0.1:8090/health

.PHONY: setup start stop restart logs test status build

setup: build
	@if [ ! -f .env ]; then cp .env.example .env && echo "Created .env from .env.example"; else echo ".env already exists, keeping it"; fi

build:
	@bash ./build.sh

start:
	@bash ./start.sh

stop:
	docker rm -f $(CONTAINER) 2>/dev/null || true

restart: stop start

logs:
	docker logs -f $(CONTAINER)

status:
	@bash ./status.sh

test:
	@curl -sf $(HEALTH) && echo " OK" || echo "FAIL"
	@curl -sf http://127.0.0.1:$(PORT)/test/demo.mp4 -o /dev/null -w "demo.mp4: %{http_code} %{size_download} bytes\n"
