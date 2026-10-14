# sample-data-serve - Lightweight Static File Server with Directory Browsing

## Purpose

Serves files from folder `../sample_data/` by default on port `127.0.0.1:8090` for 
LLMs and other applications to fetch them via `http://127.0.0.1:8090/$yourProjectName/**/*`.

When developing and testing applications, you often need to **serve static files over HTTP** for:
- **Testing data pipelines** - Accessing sample datasets via HTTP
- **Development environments** - Sharing files across Docker containers
- **Local web hosting** - Quick file sharing without complex setup
- **API testing** - Serving mock data and test fixtures

**sample-data-serve** provides a simple, containerized Caddy web server with directory browsing enabled, perfect for serving sample data files in development environments.

## Features

- **Simple HTTP file server** - Serve any directory over HTTP with one command
- **Directory browsing** - Built-in file browser for easy navigation
- **Docker-based** - Isolated, reproducible environment
- **Custom port mapping** - Configurable port via environment variables
- **Docker network integration** - Joins custom Docker networks for container-to-container communication
- **Read-only mounts** - Serves files without risk of modification
- **Automatic restart** - Container restarts automatically unless explicitly stopped
- **Management scripts** - Easy start, stop, status, and log viewing

## Technology Stack

- **Caddy 2** - Modern, production-ready web server (`caddy:2-alpine` image)
- **Alpine Linux** - Minimal Docker image footprint
- **Docker** - Containerized deployment

## Quick Start

```bash
# Build the Docker image (also: make setup / make build)
./build.sh

# Start the server (also: make start)
./start.sh

# Check server status (also: make status)
./status.sh

# Run health + demo file check (also: make test)
curl http://127.0.0.1:8090/health
curl -I http://127.0.0.1:8090/test/demo.mp4

# View logs (also: make logs)
./logs.sh -f

# Stop the server (also: make stop)
./stop.sh
```

### Makefile targets

| Target | Description |
|---|---|
| `make setup` | Build the image, then create `.env` from `.env.example` if missing |
| `make build` | Build the Docker image |
| `make start` | Start the container |
| `make stop` | Stop and remove the container |
| `make restart` | Stop, then start |
| `make status` | Container status, connectivity test, resource usage |
| `make test` | Health check + fetch `test/demo.mp4` |
| `make logs` | Follow container logs |

## Configuration

Configuration is managed through `config.sh`, with overrides via the environment or a `.env` file in the project directory.

### Environment Variables

Copy `.env.example` to `.env` (done automatically by `make setup`) and adjust as needed. Values from `.env` take precedence over the shell environment; anything not set falls back to the defaults in `config.sh`.

```bash
# Directory to serve files from (default: ../sample_data)
DATA_DIR=/path/to/your/data

# Port to expose the server on (default: 8090)
CADDY_PORT=8090

# Docker network name (default: local-cloud)
NET=local-cloud

# Network alias (default: sample-data-serve)
ALIAS=sample-data-serve
```

### Default Configuration

- **Container name**: `sample-data-serve`
- **Docker image**: `sample-data-serve:latest` (based on `caddy:2-alpine`)
- **Host port**: `8090` (bound to `127.0.0.1`; `8080` is used by other local services)
- **Container port**: `80`
- **Data directory**: `../sample_data` (resolved to an absolute path at start)
- **Docker network**: `local-cloud`
- **Network alias**: `sample-data-serve`

## Usage

### Starting the Server

```bash
./start.sh
```

The script will:
1. Validate the Docker image exists (fails with a build hint if missing)
2. Check/create the Docker network
3. Stop and remove any existing container with the same name
4. Mount the data directory as read-only at `/sample_data`
5. Start the container with automatic restart policy

Access the server at:
- **From host**: `http://127.0.0.1:8090`
- **From Docker network**: `http://sample-data-serve:80`

### Viewing Logs

```bash
# Show last 100 lines
./logs.sh

# Follow logs in real-time
./logs.sh -f

# Show last 50 lines
./logs.sh -n 50

# Show logs from last 5 minutes
./logs.sh --since 5m
```

### Checking Status

```bash
./status.sh
```

Displays:
- Container status (running/exited/paused)
- Image information
- Uptime and port mappings
- API endpoints
- Resource usage (CPU/Memory)
- Connectivity test

### Stopping the Server

```bash
./stop.sh
```

Stops and removes the container (prompts for confirmation).

## File Structure

```
sample-data-serve/
├── .env.example           # Template for optional .env overrides
├── Caddyfile              # Caddy server configuration
├── Dockerfile             # Docker image definition
├── Makefile               # Convenience targets wrapping the scripts
├── config.sh              # Shared configuration
├── build.sh               # Build Docker image
├── start.sh               # Start container
├── stop.sh                # Stop and remove container
├── status.sh              # Check container status
└── logs.sh                # View container logs
```

## How It Works

1. **Dockerfile** builds a minimal Caddy image with custom `Caddyfile`
2. **Caddyfile** configures Caddy to serve files from `/sample_data` with directory browsing
3. **start.sh** mounts your local data directory into the container at `/sample_data` (read-only)
4. Caddy serves files on port 80 (mapped to host port 8090)
5. Directory browsing allows navigation through files in a web browser

## Network Integration

The server joins a Docker network (`local-cloud` by default) and is accessible by other containers using the network alias:

```bash
# From another container on the same network
curl http://sample-data-serve:80/
```

This is useful for:
- Microservice architectures
- Testing data pipelines
- Container-to-container file sharing
- Development environments with multiple services

## Development

### Customizing the Caddyfile

Edit `Caddyfile` to customize server behavior:

```caddyfile
:80 {
    root * /sample_data

    respond /health 200

    file_server browse
    
    # Add custom headers
    header {
        Access-Control-Allow-Origin *
    }
    
    # Enable compression
    encode gzip
}
```

After editing, rebuild and restart:

```bash
./build.sh
./stop.sh
./start.sh
```

### Using a Custom Data Directory

Set `DATA_DIR` in `.env` (created by `make setup`), or export it before starting if you have no `.env`:

```bash
# In .env
DATA_DIR=/path/to/my/data

# Or via environment (only if .env does not set DATA_DIR)
export DATA_DIR=/path/to/my/data
./start.sh
```

### Changing the Port

Set `CADDY_PORT` in `.env` (created by `make setup`), or export it before starting if you have no `.env`:

```bash
# In .env
CADDY_PORT=9000

# Or via environment (only if .env does not set CADDY_PORT)
export CADDY_PORT=9000
./start.sh
```

## Why sample-data-serve?

Traditional approaches for serving files in development:

- **Python HTTP server** - Bare-bones directory listing, not containerized
- **Nginx** - Complex configuration for simple file serving
- **Manual Caddy setup** - Requires manual configuration and management

**sample-data-serve** provides:
- **One-command setup** - Build and start with simple scripts
- **Directory browsing** - Navigate files in a web browser
- **Docker isolation** - Clean, reproducible environment
- **Easy management** - Status, logs, and lifecycle scripts included
- **Network integration** - Works seamlessly with Docker networks
- **Read-only safety** - Files can't be modified through the server

## Use Cases

### Data Pipeline Testing
```bash
# Serve sample datasets for testing
export DATA_DIR=/data/samples
./start.sh

# Access from your application
curl http://sample-data-serve:80/sample.csv
```

### Multi-Container Development
```bash
# Start file server on shared network
./start.sh

# Access from other containers
docker run --network local-cloud alpine wget http://sample-data-serve:80/data.json
```

### Quick File Sharing
```bash
# Share files in a directory
export DATA_DIR=~/Documents/share
./start.sh

# Browse at http://localhost:8090
```

## Requirements

- Docker
- Bash shell
- Unix-like environment (Linux, macOS)

## License

This is a simple utility script collection. Use freely.

