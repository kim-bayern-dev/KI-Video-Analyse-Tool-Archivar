# /// script
# requires-python = ">=3.12"
# dependencies = [
#     "httpx",
#     "mutagen",
# ]
# ///

import argparse
import asyncio
import mimetypes
import os
import statistics
import time
from dataclasses import dataclass, field

import httpx
from mutagen import File as MutagenFile


def percentile(values: list[float], p: float) -> float:
    if len(values) == 1:
        return values[0]

    ordered = sorted(values)
    index = (len(ordered) - 1) * p
    lower = int(index)
    upper = min(lower + 1, len(ordered) - 1)
    return ordered[lower] + (ordered[upper] - ordered[lower]) * (index - lower)


def audio_duration(path: str) -> float | None:
    audio = MutagenFile(path)
    if audio is None or not getattr(audio, "info", None):
        return None
    return float(audio.info.length)


@dataclass
class BenchmarkStats:
    latencies: list[float] = field(default_factory=list)
    rtfs: list[float] = field(default_factory=list)
    errors: list[str] = field(default_factory=list)

    def report(self, wall_time: float) -> None:
        successful = len(self.latencies)
        total = successful + len(self.errors)

        print("\n--- Benchmark Results ---")
        print(f"Total Requests:     {total}")
        print(f"Successful:         {successful}")
        print(f"Errors:             {len(self.errors)}")
        print(f"Total Wall Time:    {wall_time:.3f}s")
        print(f"Successful QPS:     {successful / wall_time:.3f}")

        if self.latencies:
            print("\n-- End-to-end latency (sec) --")
            print(f"Avg:  {statistics.mean(self.latencies):.3f}")
            print(f"P50:  {percentile(self.latencies, 0.50):.3f}")
            print(f"P95:  {percentile(self.latencies, 0.95):.3f}")

        if self.rtfs:
            print("\n-- Real-Time Factor --")
            print(f"Avg:  {statistics.mean(self.rtfs):.4f}")
            print(f"P50:  {percentile(self.rtfs, 0.50):.4f}")
            print(f"P95:  {percentile(self.rtfs, 0.95):.4f}")

        if self.errors:
            print("\n-- First errors --")
            for error in self.errors[:5]:
                print(f"- {error}")


async def main() -> None:
    parser = argparse.ArgumentParser(
        description="Concurrent benchmark for /v1/audio/transcriptions"
    )
    parser.add_argument("--url", required=True)
    parser.add_argument("--file", required=True)
    parser.add_argument("--model", default="Whisper-Large-vLLM")
    parser.add_argument("--api-key", default="your-api-key")
    parser.add_argument("--language", default="de")
    parser.add_argument("--clients", type=int, default=1)
    parser.add_argument("--requests", type=int, default=1)
    args = parser.parse_args()

    if args.clients < 1 or args.requests < 1:
        raise SystemExit("--clients and --requests must be >= 1")

    duration = audio_duration(args.file)
    audio_name = os.path.basename(args.file)
    mime_type = mimetypes.guess_type(args.file)[0] or "application/octet-stream"
    with open(args.file, "rb") as file:
        audio_data = file.read()

    total = args.clients * args.requests
    print(
        f"Starting transcription benchmark: {args.clients} concurrent clients, "
        f"{args.requests} requests/client ({total} requests total)."
    )
    if duration is not None:
        print(f"Audio duration: {duration:.3f}s")

    stats = BenchmarkStats()
    timeout = httpx.Timeout(120.0, connect=10.0)
    limits = httpx.Limits(
        max_connections=args.clients,
        max_keepalive_connections=args.clients,
    )

    async def transcribe(client: httpx.AsyncClient, request_number: int) -> None:
        started = time.perf_counter()
        try:
            response = await client.post(
                args.url,
                data={
                    "model": args.model,
                    "language": args.language,
                    "response_format": "json",
                },
                files={"file": (audio_name, audio_data, mime_type)},
            )
            elapsed = time.perf_counter() - started

            if response.status_code != 200:
                stats.errors.append(
                    f"request {request_number}: HTTP {response.status_code}: "
                    f"{response.text[:500]}"
                )
                return

            result = response.json()
            text = result.get("text")
            if not isinstance(text, str):
                stats.errors.append(
                    f"request {request_number}: missing text in {result}"
                )
                return

            stats.latencies.append(elapsed)
            if duration is not None and duration > 0:
                stats.rtfs.append(elapsed / duration)

        except Exception as error:
            stats.errors.append(f"request {request_number}: {error!r}")

    async with httpx.AsyncClient(
        headers={"Authorization": f"Bearer {args.api_key}"},
        timeout=timeout,
        limits=limits,
    ) as client:
        started = time.perf_counter()
        await asyncio.gather(*[
            transcribe(client, request_number)
            for request_number in range(1, total + 1)
        ])
        wall_time = time.perf_counter() - started

    stats.report(wall_time)
    if stats.errors:
        raise SystemExit(1)


if __name__ == "__main__":
    asyncio.run(main())