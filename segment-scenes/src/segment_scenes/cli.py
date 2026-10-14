from __future__ import annotations

import json
import os
import sys
from pathlib import Path
from urllib.error import HTTPError, URLError
from urllib.parse import urlsplit
from urllib.request import Request, urlopen

import click

from .detectors import (
    DEFAULT_KEYFRAME_MAX_WIDTH_PX,
    DEFAULT_OUTPUT_FPS,
    DEFAULT_OUTPUT_MAX_HEIGHT_PX,
)
from .utils import VIDEO_EXTS


def _server_file_uri(value: str, data_dir: Path, container_root: Path) -> str:
    parsed = urlsplit(value)
    if parsed.scheme:
        if parsed.scheme != "file":
            raise click.UsageError("MEDIA and --output-dir only accept local paths or file:// URIs")
        return value

    path = Path(value).expanduser().resolve(strict=False)
    host_root = data_dir.expanduser().resolve(strict=False)
    try:
        relative = path.relative_to(host_root)
    except ValueError as exc:
        raise click.UsageError(
            f"{path} is outside the persistent DATA_DIR mount ({host_root}); "
            "move it below DATA_DIR or reconfigure/restart the service"
        ) from exc
    return (container_root / relative).as_uri()


def _post_json(url: str, payload: dict, timeout: float) -> dict:
    request = Request(
        url,
        data=json.dumps(payload).encode("utf-8"),
        headers={"Content-Type": "application/json", "Accept": "application/json"},
        method="POST",
    )
    try:
        with urlopen(request, timeout=timeout) as response:
            return json.loads(response.read())
    except HTTPError as exc:
        body = exc.read().decode("utf-8", errors="replace")
        try:
            detail = json.loads(body).get("detail", body)
        except json.JSONDecodeError:
            detail = body
        raise click.ClickException(f"service returned HTTP {exc.code}: {detail}") from exc
    except URLError as exc:
        raise click.ClickException(f"cannot reach segment-scenes service at {url}: {exc.reason}") from exc


@click.command()
@click.argument("media", type=str)
@click.option("--threshold", type=click.FloatRange(0.0, 1.0), default=0.5, show_default=True)
@click.option("--min-len", type=click.FloatRange(min=0.0, min_open=True), default=0.5, show_default=True)
@click.option("--max-len", type=click.FloatRange(min=0.0, min_open=True), default=None)
@click.option(
    "--fps",
    type=click.FloatRange(min=0.0, min_open=True),
    default=DEFAULT_OUTPUT_FPS,
    show_default=True,
    help="Output frame rate; fractional allowed (0.5 = 1 frame/2s, 0.25 = 1 frame/4s).",
)
@click.option(
    "--max-width-px",
    type=click.IntRange(min=1),
    default=DEFAULT_KEYFRAME_MAX_WIDTH_PX,
    show_default=True,
)
@click.option(
    "--max-height-px",
    type=click.IntRange(min=1),
    default=DEFAULT_OUTPUT_MAX_HEIGHT_PX,
    show_default=True,
)
@click.option("--device", type=click.Choice(["auto", "cpu", "cuda"]), default=None)
@click.option("--output-dir", type=str, default=None)
@click.option("--quiet", is_flag=True)
@click.option("--chunk-size", type=click.IntRange(min=1), default=1000, show_default=True)
@click.option("--visualize", is_flag=True)
@click.option("--extract-keyframes", is_flag=True)
@click.option(
    "--server-url",
    default=lambda: os.environ.get("SEGMENT_SCENES_URL", "http://127.0.0.1:8088"),
    show_default="SEGMENT_SCENES_URL or http://127.0.0.1:8088",
)
@click.option(
    "--request-timeout",
    type=click.FloatRange(min=0.0, min_open=True),
    default=lambda: float(os.environ.get("SEGMENT_SCENES_REQUEST_TIMEOUT", "3600")),
    show_default="3600",
)
def main(
    media: str,
    threshold: float,
    min_len: float,
    max_len: float | None,
    fps: float,
    max_width_px: int,
    max_height_px: int,
    device: str | None,
    output_dir: str | None,
    quiet: bool,
    chunk_size: int,
    visualize: bool,
    extract_keyframes: bool,
    server_url: str,
    request_timeout: float,
) -> None:
    """Submit one mounted video to the persistent segment-scenes service."""
    data_dir = Path(os.environ.get("SEGMENT_SCENES_DATA_DIR", os.environ.get("DATA_DIR", "./data")))
    container_root = Path(os.environ.get("SEGMENT_SCENES_CONTAINER_DATA_ROOT", "/data"))
    media_uri = _server_file_uri(media, data_dir, container_root)
    if Path(urlsplit(media_uri).path).suffix.lower() not in VIDEO_EXTS:
        raise click.UsageError("input must be a supported video file for scene detection")

    payload = {
        "media": media_uri,
        "output_dir": _server_file_uri(output_dir, data_dir, container_root) if output_dir else None,
        "threshold": threshold,
        "min_len": min_len,
        "max_len": max_len,
        "fps": fps,
        "max_width_px": max_width_px,
        "max_height_px": max_height_px,
        "chunk_size": chunk_size,
        "visualize": visualize,
        "extract_keyframes": extract_keyframes,
        "quiet": quiet,
        "device": device,
    }
    endpoint = f"{server_url.rstrip('/')}/v1/segment-scenes"
    result = _post_json(endpoint, payload, request_timeout)
    json.dump(result, sys.stdout, indent=2)
    sys.stdout.write("\n")


if __name__ == "__main__":
    main()
