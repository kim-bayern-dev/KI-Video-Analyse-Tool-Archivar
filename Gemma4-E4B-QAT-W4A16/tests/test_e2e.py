#!/usr/bin/env python3
"""End-to-end vision probe for the OpenAI-compatible vLLM server.

Task: the image probe offers demo.png (first frame of the shared demo clip)
to the model. On a multimodal deployment it must return a non-empty
completion; on a text-only one (LIMIT_MM_IMAGE=0) the request must be
rejected cleanly.

The model output (description) is written to ./tmp with a fixed name and
overwritten on every run, so the latest output can always be inspected there.

The image is first offered as a file:// URL (resolves against the container
filesystem, gated by --allowed-local-media-path /sample_data; DATA_DIR is
bind-mounted there). If the server cannot read that transport — e.g. the
asset was not copied into DATA_DIR — the test falls back to an inline
data: URL.
"""

from __future__ import annotations

import argparse
import base64
import json
import os
import sys
import urllib.error
import urllib.request
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[1]

# Shared test assets live in ../sample_data/test relative to the project root
# and are bind-mounted read-only at /sample_data in the container (DATA_DIR).
# Override with the SAMPLE_DATA_DIR environment variable.
FILES_DIR = Path(os.environ.get("SAMPLE_DATA_DIR", ROOT.parent / "sample_data" / "test")).resolve()

# Model output of the probe is written here (overwritten on every run) so it
# can be inspected after the fact.
TMP_DIR = ROOT / "tmp"

# vLLM resolves file:// URLs against the container filesystem and only serves
# paths under --allowed-local-media-path (/sample_data, the DATA_DIR mount).
FILE_URL_PREFIX = "file:///sample_data/test/"

IMAGE_ASSET = {"name": "demo.png", "mime": "image/png"}

# Server responses (substring, case-insensitive) that mean "this deployment
# has no multimodal support" rather than a broken transport.
NO_MULTIMODAL_MARKERS = ("not supported", "no media", "multimodal", "unsupported content")


class E2EError(RuntimeError):
    pass


class HttpFailure:
    def __init__(self, code: int, body: str) -> None:
        self.code = code
        self.body = body

    def mentions_no_multimodal(self) -> bool:
        lowered = self.body.lower()
        return any(marker in lowered for marker in NO_MULTIMODAL_MARKERS)


def request_json(
    base_url: str,
    endpoint: str,
    payload: dict[str, Any] | None,
    api_key: str,
    timeout: float,
) -> dict[str, Any] | HttpFailure:
    headers = {"Content-Type": "application/json"}
    if api_key:
        headers["Authorization"] = f"Bearer {api_key}"
    data = None if payload is None else json.dumps(payload, separators=(",", ":")).encode("utf-8")
    request = urllib.request.Request(
        f"{base_url.rstrip('/')}{endpoint}",
        data=data,
        headers=headers,
        method="GET" if payload is None else "POST",
    )
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            raw = response.read()
    except urllib.error.HTTPError as exc:
        body = exc.read().decode("utf-8", errors="replace")
        return HttpFailure(exc.code, body)
    except urllib.error.URLError as exc:
        raise E2EError(f"{endpoint}: {exc.reason}") from exc
    try:
        parsed = json.loads(raw)
    except json.JSONDecodeError as exc:
        raise E2EError(f"{endpoint}: invalid JSON response") from exc
    if not isinstance(parsed, dict):
        raise E2EError(f"{endpoint}: expected a JSON object")
    return parsed


def discover_model(base_url: str, api_key: str, timeout: float) -> str:
    response = request_json(base_url, "/v1/models", None, api_key, timeout)
    if isinstance(response, HttpFailure):
        raise E2EError(f"/v1/models: HTTP {response.code}: {response.body[:500]}")
    data = response.get("data")
    if not isinstance(data, list) or not data:
        raise E2EError("/v1/models returned no models")
    model = data[0].get("id")
    if not isinstance(model, str) or not model:
        raise E2EError("/v1/models entry has no id")
    return model


def send_image(
    base_url: str,
    model: str,
    asset: dict[str, str],
    prompt: str,
    extra: dict[str, Any],
    api_key: str,
    timeout: float,
) -> dict[str, Any] | HttpFailure:
    """POST an image chat completion, file:// first with data: fallback."""
    path = FILES_DIR / asset["name"]
    if not path.is_file():
        raise E2EError(f"missing media file: {path}")
    file_url = f"{FILE_URL_PREFIX}{asset['name']}"
    data_url = f"data:{asset['mime']};base64,{base64.b64encode(path.read_bytes()).decode()}"

    def payload(url: str) -> dict[str, Any]:
        body: dict[str, Any] = {
            "model": model,
            "messages": [{"role": "user", "content": [
                {"type": "image_url", "image_url": {"url": url}},
                {"type": "text", "text": prompt},
            ]}],
            "temperature": 0,
        }
        body.update(extra)
        return body

    print(f"[{asset['name']}] trying file:// URL ({file_url})")
    result = request_json(base_url, "/v1/chat/completions", payload(file_url), api_key, timeout)
    if isinstance(result, HttpFailure) and not result.mentions_no_multimodal():
        print(f"[{asset['name']}] file:// rejected (HTTP {result.code}); falling back to data: URL")
        result = request_json(base_url, "/v1/chat/completions", payload(data_url), api_key, timeout)
    return result


def completion_message(response: dict[str, Any]) -> dict[str, Any]:
    choices = response.get("choices")
    if not isinstance(choices, list) or not choices:
        raise E2EError("completion has no choices")
    message = choices[0].get("message")
    if not isinstance(message, dict):
        raise E2EError("completion choice has no message")
    return message


def save_output(name: str, content: str) -> Path:
    """Write the probe output below ./tmp, overwriting any previous run's file."""
    TMP_DIR.mkdir(exist_ok=True)
    path = TMP_DIR / name
    path.write_text(content, encoding="utf-8")
    print(f"  output saved: {path.relative_to(ROOT)}")
    return path


def run_image_probe(base_url: str, model: str, api_key: str, timeout: float) -> bool:
    """Returns True when the deployment produced an image completion."""
    result = send_image(
        base_url, model, IMAGE_ASSET, "Describe this image briefly.",
        {"max_tokens": 64}, api_key, timeout,
    )
    if isinstance(result, HttpFailure):
        if result.mentions_no_multimodal():
            print(f"[{IMAGE_ASSET['name']}] image not servable by this deployment, "
                  f"clean rejection (HTTP {result.code}): {result.body[:200]}")
            return False
        raise E2EError(
            f"[{IMAGE_ASSET['name']}] FAILED via file:// and data:: "
            f"HTTP {result.code}: {result.body[:500]}"
        )
    message = completion_message(result)
    text = " ".join(part for part in
                    (message.get("content") or "", message.get("reasoning_content") or "") if part).strip()
    if not text:
        raise E2EError(f"[{IMAGE_ASSET['name']}] completion returned empty content")
    save_output(f"{IMAGE_ASSET['name']}.description.txt", text + "\n")
    print(f"[{IMAGE_ASSET['name']}] PASS: multimodal completion: {text[:200]}")
    return True


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--base-url", default="http://127.0.0.1:9031")
    parser.add_argument("--api-key", default="your-api-key")
    parser.add_argument("--timeout", type=float, default=120.0)
    args = parser.parse_args()

    model = discover_model(args.base_url, args.api_key, args.timeout)
    print(f"model: {model}")

    if not run_image_probe(args.base_url, model, args.api_key, args.timeout):
        print("e2e PASS: deployment is text-only; image rejected cleanly")
        return 0

    print("e2e PASS: multimodal deployment; image served with non-empty completion")
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except E2EError as exc:
        print(f"e2e FAIL: {exc}", file=sys.stderr)
        sys.exit(1)
