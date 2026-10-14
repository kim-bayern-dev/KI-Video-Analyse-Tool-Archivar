# /// script
# requires-python = ">=3.12"
# dependencies = [
#     "mutagen",
#     "requests",
# ]
# ///

import argparse
import mimetypes
import os
import sys
import time

import requests
from mutagen import File as MutagenFile


def audio_duration(path: str) -> float | None:
    audio = MutagenFile(path)
    if audio is None or not getattr(audio, "info", None):
        return None
    return float(audio.info.length)


def transcribe_audio(endpoint: str, audio_path: str, api_key: str,
                     model: str, language: str | None) -> None:
    duration = audio_duration(audio_path)
    if duration is not None:
        print(f"Audio path: {audio_path} ({duration:.2f}s)")
    else:
        print(f"Audio path: {audio_path}")

    mime_type = mimetypes.guess_type(audio_path)[0] or "application/octet-stream"
    data = {
        "model": model,
        "response_format": "json",
    }
    if language:
        data["language"] = language

    start = time.perf_counter()
    with open(audio_path, "rb") as audio_file:
        response = requests.post(
            endpoint,
            headers={"Authorization": f"Bearer {api_key}"},
            data=data,
            files={
                "file": (
                    os.path.basename(audio_path),
                    audio_file,
                    mime_type,
                )
            },
            timeout=120,
        )
    elapsed = time.perf_counter() - start

    if response.status_code != 200:
        print(f"Error: HTTP {response.status_code}", file=sys.stderr)
        print(f"Response: {response.text}", file=sys.stderr)
        raise SystemExit(1)

    result = response.json()
    transcript = result.get("text")
    if not isinstance(transcript, str):
        print(f"Unexpected response: {result}", file=sys.stderr)
        raise SystemExit(1)

    print(f"[Final]: {transcript}")
    print(f"Processing Time: {elapsed:.3f}s")
    if duration is not None and duration > 0:
        print(f"Real-Time Factor (RTF): {elapsed / duration:.4f}")


def main() -> None:
    parser = argparse.ArgumentParser(
        description="OpenAI-compatible Whisper transcription client"
    )
    parser.add_argument(
        "-e",
        "--endpoint",
        required=True,
        help="e.g. http://localhost:8998/v1/audio/transcriptions",
    )
    parser.add_argument("-f", "--file", required=True)
    parser.add_argument("-k", "--api-key", default="your-api-key")
    parser.add_argument("-m", "--model", default="Whisper-Large-vLLM")
    parser.add_argument("--language", default="de")
    args = parser.parse_args()

    transcribe_audio(
        args.endpoint,
        args.file,
        args.api_key,
        args.model,
        args.language or None,
    )


if __name__ == "__main__":
    main()