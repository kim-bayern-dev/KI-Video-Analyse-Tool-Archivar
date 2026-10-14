#!/usr/bin/env python3
"""MM2 benchmark: video-model path with server-side frame sampling.

Sends the demo video (already resident in the container at
/sample_data/test/demo.mp4; the server samples frames at 224x224 per its
--limit-mm-per-prompt/--media-io-kwargs config) through the chat API and
measures TTFT, TPOT and output tokens/s with fixed output length
(ignore_eos), temperature 0 and thinking disabled.

A per-repetition random text prefix keeps every repetition prefix-cache-cold.
Writes one JSON per repetition plus a small summary, schema-compatible with
the vllm bench serve results where the metrics overlap.
"""

from __future__ import annotations

import argparse
import json
import random
import string
import time
from pathlib import Path

from openai import OpenAI


def parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser()
    p.add_argument("--base-url", default="http://127.0.0.1:9031/v1")
    p.add_argument("--api-key", default="your-api-key")
    p.add_argument("--model", default="gemma-4-E4B-it-qat-w4a16-ct")
    p.add_argument("--video-url", default="file:///sample_data/test/demo.mp4")
    p.add_argument("--output-len", type=int, default=512)
    p.add_argument("--reps", type=int, default=3)
    p.add_argument("--seed", type=int, default=42)
    p.add_argument("--result-dir", required=True)
    p.add_argument("--case", default="MM2")
    return p.parse_args()


def main() -> None:
    args = parse_args()
    result_dir = Path(args.result_dir)
    result_dir.mkdir(parents=True, exist_ok=True)
    client = OpenAI(base_url=args.base_url, api_key=args.api_key, timeout=600)
    rng = random.Random(args.seed)

    runs: list[dict] = []
    for rep in range(1, args.reps + 1):
        # Random leading text => unique prefix per repetition (cold cache).
        nonce = "".join(rng.choices(string.ascii_lowercase + " ", k=256))
        prompt = f"{nonce}\nDescribe what happens in this video in one paragraph."
        messages = [
            {
                "role": "user",
                "content": [
                    {"type": "text", "text": prompt},
                    {"type": "video_url", "video_url": {"url": args.video_url}},
                ],
            }
        ]
        t0 = time.perf_counter()
        ttft_ms = None
        completion_tokens = 0
        prompt_tokens = 0
        stream = client.chat.completions.create(
            model=args.model,
            messages=messages,
            max_tokens=args.output_len,
            temperature=0,
            stream=True,
            stream_options={"include_usage": True},
            extra_body={
                "ignore_eos": True,
                "min_tokens": args.output_len,
                "chat_template_kwargs": {"enable_thinking": False},
            },
        )
        for chunk in stream:
            if chunk.choices and chunk.choices[0].delta.content and ttft_ms is None:
                ttft_ms = (time.perf_counter() - t0) * 1000
            if chunk.usage is not None:
                completion_tokens = chunk.usage.completion_tokens
                prompt_tokens = chunk.usage.prompt_tokens
        e2e_s = time.perf_counter() - t0
        ttft_s = (ttft_ms or 0) / 1000
        decode_s = max(e2e_s - ttft_s, 1e-9)
        rec = {
            "case": args.case,
            "repetition": rep,
            "date_utc": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
            "duration_s": round(e2e_s, 3),
            "ttft_ms": round(ttft_ms or 0, 2),
            "total_output_tokens": completion_tokens,
            "total_input_tokens": prompt_tokens,
            "output_throughput": round(completion_tokens / decode_s, 2),
            "tpot_ms": round(decode_s / max(completion_tokens - 1, 1) * 1000, 3),
        }
        runs.append(rec)
        (result_dir / f"{args.case}-run-{rep}.json").write_text(json.dumps(rec, indent=2))
        print(
            f"MM2 run {rep}: TTFT={rec['ttft_ms']:.0f} ms, "
            f"out={completion_tokens} tok, {rec['output_throughput']:.1f} tok/s, "
            f"E2E={e2e_s:.1f} s"
        )

    summary = {
        "case": args.case,
        "video_url": "file:///sample_data/test/demo.mp4 (8 frames @ 224x224 server-side)",
        "runs": runs,
        "median_output_throughput": sorted(r["output_throughput"] for r in runs)[len(runs) // 2],
        "median_ttft_ms": sorted(r["ttft_ms"] for r in runs)[len(runs) // 2],
    }
    (result_dir / f"{args.case}-summary.json").write_text(json.dumps(summary, indent=2))


if __name__ == "__main__":
    main()
