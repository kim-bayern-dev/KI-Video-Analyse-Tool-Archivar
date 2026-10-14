# /// script
# requires-python = ">=3.12"
# dependencies = [
#     "requests",
# ]
# ///
# Client for transcription using standard OpenAI chat completions API with audio_url

import argparse
import subprocess
import sys
import time
import os
import re

import requests


def probe_duration(audio_path: str) -> float:
    """Probe the real audio duration in seconds via ffprobe (0 = unknown).

    The file argument is usually a container path (/sample_data/...); map it
    back to the host via DATA_DIR (default: ../sample_data) so the probe works.
    """
    candidates = [audio_path]
    data_dir = os.environ.get("DATA_DIR", "../sample_data")
    if audio_path.startswith("/sample_data/"):
        candidates.append(os.path.join(data_dir, audio_path[len("/sample_data/"):]))
    for path in candidates:
        try:
            out = subprocess.run(
                ["ffprobe", "-v", "error", "-show_entries", "format=duration",
                 "-of", "default=noprint_wrappers=1:nokey=1", path],
                capture_output=True, text=True, timeout=30,
            )
            if out.returncode == 0:
                return float(out.stdout.strip())
        except (OSError, ValueError, subprocess.TimeoutExpired):
            continue
    return 0.0


def extract_transcript(reasoning: str) -> str:
    """Extract transcription from the model's reasoning field.
    
    Format: 'language <lang><asr_text><transcript>'
    Returns just the transcript part.
    """
    match = re.search(r'<asr_text>(.+)', reasoning)
    if match:
        return match.group(1)
    return reasoning


def transcribe_audio(endpoint_url: str, audio_path: str, api_key: str, model: str):
    """Send audio file via chat completions API with audio_url."""
    # Real audio duration for the RTF printout (probed via ffprobe; the
    # container path is mapped back to the host via DATA_DIR).
    duration = probe_duration(audio_path)
    if duration > 0:
        print(f"Audio path: {audio_path} ({duration:.2f}s)")
    else:
        print(f"Audio path: {audio_path} (duration unknown — RTF will be skipped)")

    start_time = time.time()

    headers = {
        "Authorization": f"Bearer {api_key}",
        "Content-Type": "application/json",
    }

    # file:// URL; the path must exist inside the container (e.g. under the
    # /sample_data mount)
    file_url = f"file://{audio_path}"

    payload = {
        "model": model,
        "messages": [{
            "role": "user",
            "content": [{
                "type": "audio_url",
                "audio_url": {"url": file_url}
            }]
        }]
    }

    print(f"Sending to {endpoint_url}...")

    response = requests.post(endpoint_url, headers=headers, json=payload)

    if response.status_code != 200:
        print(f"Error: HTTP {response.status_code}")
        print(f"Response: {response.text}")
        return

    result = response.json()
    
    # Extract transcription from reasoning field
    reasoning = result.get("choices", [{}])[0].get("message", {}).get("reasoning", "")
    transcript = extract_transcript(reasoning)
    
    print(f"[Final]: {transcript}")

    end_time = time.time()
    process_time = end_time - start_time
    print(f"Processing Time: {process_time:.2f}s")
    if duration > 0:
        print(f"Real-Time Factor (RTF): {process_time / duration:.4f}")
    else:
        print("Real-Time Factor (RTF): n/a (duration unknown)")


def main():
    parser = argparse.ArgumentParser(description="Qwen3-ASR Client (OpenAI chat completions API)")
    parser.add_argument("-e", "--endpoint", required=True, help="Chat completions endpoint URL (e.g., http://localhost:8932/v1/chat/completions)")
    parser.add_argument("-f", "--file", required=True, help="Path to audio file (WAV, FLAC, etc.)")
    parser.add_argument("-k", "--api-key", default="your-api-key", help="API key for authentication")
    parser.add_argument("-m", "--model", default="Qwen3-ASR-0.6B", help="Model name")
    args = parser.parse_args()

    print(f"Connecting to {args.endpoint}...")

    try:
        transcribe_audio(args.endpoint, args.file, args.api_key, args.model)
    except Exception as e:
        print(f"Connection failed: {e}")
        sys.exit(1)


if __name__ == "__main__":
    main()
