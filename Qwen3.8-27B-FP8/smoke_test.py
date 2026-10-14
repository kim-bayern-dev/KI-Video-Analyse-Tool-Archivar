# /// script
# requires-python = ">=3.10"
# dependencies = ["openai"]
# ///
"""Qwen3.8-27B-FP8 smoke test - streaming + tool-calling.

Usage:
    uv run smoke_test.py [stream|multiturn|tools|multimodal|context|all]

Modes:
    stream      - cold streaming test (TTFT + throughput)
    multiturn   - warm-cache round-trip latency
    tools       - multi-turn tool-calling loop
    multimodal  - image captioning (vision)
    context     - full context-window stress test (requires MAX_LEN)
    all         - run stream/multiturn/tools/multimodal (default)

Environment (loaded from .env, or set manually):
    OPENAI_BASE_URL   e.g. http://127.0.0.1:8920/v1
    OPENAI_API_KEY    e.g. your-api-key
    MAX_LEN           server --max-model-len, e.g. 256000 (context mode only)
"""

import base64
import json
import os
import random
import sys
import time
from pathlib import Path

from openai import OpenAI


def _load_dotenv(path: Path = Path(__file__).parent / ".env") -> None:
    """Minimal .env loader - no external deps."""
    if not path.is_file():
        return
    for line in path.read_text().splitlines():
        line = line.strip()
        if not line or line.startswith("#"):
            continue
        key, _, val = line.partition("=")
        key, val = key.strip(), val.strip()
        if key:
            os.environ.setdefault(key, val)

_load_dotenv()

# ---------------------------------------------------------------------------
# Tool implementations
# ---------------------------------------------------------------------------

def add_number(a: str, b: str) -> float:
    return float(a) + float(b)

def multiply_number(a: str, b: str) -> float:
    return float(a) * float(b)

def substract_number(a: str, b: str) -> float:
    return float(a) - float(b)

MAP_FN = {
    "add_number": add_number,
    "multiply_number": multiply_number,
    "substract_number": substract_number,
}

# ---------------------------------------------------------------------------
# Tool schemas (OpenAI function-calling format)
# ---------------------------------------------------------------------------

tools = [
    {
        "type": "function",
        "function": {
            "name": "add_number",
            "description": "Add two numbers.",
            "parameters": {
                "type": "object",
                "properties": {
                    "a": {"type": "string", "description": "The first number."},
                    "b": {"type": "string", "description": "The second number."},
                },
                "required": ["a", "b"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "multiply_number",
            "description": "Multiply two numbers.",
            "parameters": {
                "type": "object",
                "properties": {
                    "a": {"type": "string", "description": "The first number."},
                    "b": {"type": "string", "description": "The second number."},
                },
                "required": ["a", "b"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "substract_number",
            "description": "Substract two numbers.",
            "parameters": {
                "type": "object",
                "properties": {
                    "a": {"type": "string", "description": "The first number."},
                    "b": {"type": "string", "description": "The second number."},
                },
                "required": ["a", "b"],
            },
        },
    },
]

# ---------------------------------------------------------------------------
# Shared system prompt (prefix-caching key)
# ---------------------------------------------------------------------------

SYSTEM_PROMPT = (
    "You are a concise multiturn assistant. Keep answers under 3 sentences. "
    "Respond naturally and directly."
)

INFERENCE_PARAMS = dict(
    max_tokens=256,
    temperature=0.7,
    top_p=0.8,
    presence_penalty=1.5,
    extra_body={
        "top_k": 20,
        "chat_template_kwargs": {"enable_thinking": False},
    },
)

# ---------------------------------------------------------------------------
# Long-context test configuration
# ---------------------------------------------------------------------------

MAX_LEN_ENV = "MAX_LEN"
CONTEXT_SPLIT_IN = 0.7     # share of the window reserved for the prompt
CONTEXT_SPLIT_OUT = 0.3    # share of the window reserved for generation
CONTEXT_SAFETY_TOKENS = 512        # slack for tokenizer variance / template drift
CALIBRATION_SIZES = (1_000, 4_000)  # filler chars for the two calibration probes
PROGRESS_EVERY = 2048      # streamed chunks between progress lines (quiet mode)
CONTEXT_REQUEST_TIMEOUT = 3600.0   # seconds; a full-window request is slow

CONTEXT_INSTRUCTION = (
    "The numbered lines below form an unfinished infinite document. Continue "
    "it in the exact same format: write the identical sentence on every line "
    "and only increment the 6-digit counter by one. Never stop, never add "
    "commentary, never conclude - just keep emitting lines."
)

# ---------------------------------------------------------------------------
# Test helpers
# ---------------------------------------------------------------------------

def get_client() -> tuple[OpenAI, str]:
    if not os.environ.get("OPENAI_API_KEY"):
        os.environ["OPENAI_API_KEY"] = os.environ.get("API_KEY", "your-api-key")
    # Normalize base URL: the OpenAI SDK expects it to end with /v1,
    # but .env / Makefile may only provide the bare host:port.
    base = os.environ.get("OPENAI_BASE_URL", "").rstrip("/")
    if base and not base.endswith("/v1"):
        os.environ["OPENAI_BASE_URL"] = f"{base}/v1"
    client = OpenAI()
    model_name = next(iter(client.models.list())).id
    print(f"Using model = {model_name}")
    return client, model_name


def _encode_image_data_url(path: Path) -> str:
    """Encode a local image as a data: URL for the OpenAI vision message format.

    vLLM (and the OpenAI SDK) accept images either as remote URLs or inline
    base64 data URLs; encoding locally avoids needing a public file host.
    """
    if not path.is_file():
        raise FileNotFoundError(f"Image not found: {path}")
    b64 = base64.b64encode(path.read_bytes()).decode()
    suffix = path.suffix.lstrip(".").lower() or "png"
    return f"data:image/{suffix};base64,{b64}"


def warmup(client: OpenAI, model_name: str, n: int = 3) -> None:
    """Send throwaway requests to warm KV / prefix caches."""
    print(f"\nWarming up ({n} requests with shared system prompt)…")
    for i in range(n):
        t0 = time.perf_counter()
        resp = client.chat.completions.create(
            model=model_name,
            messages=[
                {"role": "system", "content": SYSTEM_PROMPT},
                {"role": "user", "content": f"Say hello. (warmup {i+1})"},
            ],
            max_tokens=16,
            temperature=0.7,
            extra_body={"chat_template_kwargs": {"enable_thinking": False}},
        )
        dt = (time.perf_counter() - t0) * 1000
        tok = resp.usage.completion_tokens if resp.usage else "?"
        print(f"  warmup {i+1}/{n}: {dt:.0f} ms  ({tok} tokens)")
    print("Warmup done.")


# ---------------------------------------------------------------------------
# Tests
# ---------------------------------------------------------------------------

def _stream_and_measure(
    client: OpenAI,
    model_name: str,
    messages: list,
    max_tokens: int | None = None,
    echo: bool = True,
    timeout: float | None = None,
    overrides: dict | None = None,
) -> dict:
    """Stream a response, return timing + token-usage dict.

    echo=False suppresses content printing (huge generations) and shows a
    progress counter instead. max_tokens/timeout override the defaults so
    long-context requests are not cut off by the short smoke-test settings.
    overrides merges additional/alternative sampling params (e.g. a zeroed
    presence_penalty so endless continuations are not penalized into EOS).
    """
    t0 = time.perf_counter()
    first_token_t = None
    token_count = 0
    full_text = []
    usage = None
    finish_reason = None

    params = dict(INFERENCE_PARAMS)
    if max_tokens is not None:
        params["max_tokens"] = max_tokens
    if overrides:
        params.update(overrides)

    stream = client.chat.completions.create(
        model=model_name,
        messages=messages,
        stream=True,
        stream_options={"include_usage": True},
        timeout=timeout,
        **params,
    )

    for chunk in stream:
        # the final usage chunk carries no choices - capture before dereferencing
        if getattr(chunk, "usage", None):
            usage = chunk.usage
        if chunk.choices and chunk.choices[0].finish_reason:
            finish_reason = chunk.choices[0].finish_reason
        delta = chunk.choices[0].delta if chunk.choices else None
        if delta and delta.content:
            if first_token_t is None:
                first_token_t = time.perf_counter()
            token_count += 1
            full_text.append(delta.content)
            if echo:
                print(delta.content, end="", flush=True)
            elif token_count % PROGRESS_EVERY == 0:
                print(f"\r  ... {token_count:>8,} chunks", end="", flush=True)

    t_end = time.perf_counter()
    print()

    ttft = (first_token_t - t0) * 1000 if first_token_t else float("inf")
    total = (t_end - t0) * 1000
    gen_time = (t_end - first_token_t) * 1000 if first_token_t else 0
    # server-reported counts are authoritative: with speculative decoding
    # a single streamed chunk can carry several tokens
    completion_tokens = (
        usage.completion_tokens if usage and usage.completion_tokens else token_count
    )
    tps = completion_tokens / (gen_time / 1000) if gen_time > 0 else 0

    return dict(
        ttft=ttft,
        tokens=completion_tokens,
        prompt_tokens=usage.prompt_tokens if usage else None,
        completion_tokens=completion_tokens,
        gen_time=gen_time,
        tps=tps,
        total=total,
        finish_reason=finish_reason,
        text="".join(full_text),
    )


def _print_metrics(m: dict) -> None:
    print(f"  TTFT:       {m['ttft']:.0f} ms")
    print(f"  Tokens:     {m['tokens']}")
    print(f"  Gen time:   {m['gen_time']:.0f} ms")
    print(f"  Throughput: {m['tps']:.1f} tok/s")
    print(f"  Total:      {m['total']:.0f} ms")


def smoke_test_stream(client: OpenAI, model_name: str) -> None:
    """Stream a short response and measure TTFT + throughput."""
    print("\n" + "=" * 60)
    print("STREAMING TEST (cold)")
    print("=" * 60)

    messages = [
        {"role": "system", "content": SYSTEM_PROMPT},
        {"role": "user", "content": "What causes thunder?"},
    ]

    m = _stream_and_measure(client, model_name, messages)
    print()
    _print_metrics(m)


def smoke_test_multiturn(client: OpenAI, model_name: str, n_rounds: int = 5) -> None:
    """Simulate turns with warm prefix caches.

    Uses the same system prompt so the server's prefix cache is hot.
    Measures per-turn TTFT and total round-trip time.
    """
    print("\n" + "=" * 60)
    print("WARM-CACHE TEST")
    print("=" * 60)

    user_turns = [
        "What's the weather like today?",
        "Set a timer for five minutes.",
        "Tell me a fun fact.",
        "How far is the moon?",
        "What time is it in Tokyo?",
        "Remind me to call mom at six.",
        "What's 15 percent of 80?",
        "Play some jazz music.",
        "Who invented the telephone?",
        "Translate 'good morning' to French.",
        "What's the capital of Peru?",
        "How many ounces in a gallon?",
    ]
    random.shuffle(user_turns)
    user_turns = user_turns[:n_rounds]

    # Append a unique nonce so the user portion is never a full cache hit -
    # only the system-prompt prefix cache is exercised.
    nonce = int(time.time() * 1000)
    user_turns = [f"{t} [{nonce + i}]" for i, t in enumerate(user_turns)]

    ttfts = []
    totals = []

    for i, utterance in enumerate(user_turns, 1):
        print(f"\n--- Turn {i}: \"{utterance}\" ---")
        messages = [
            {"role": "system", "content": SYSTEM_PROMPT},
            {"role": "user", "content": utterance},
        ]
        m = _stream_and_measure(client, model_name, messages)
        _print_metrics(m)
        ttfts.append(m["ttft"])
        totals.append(m["total"])

    print("\n" + "-" * 60)
    print("SUMMARY (warm cache)")
    print("-" * 60)
    print(f"  Turns:      {len(ttfts)}")
    print(f"  Avg TTFT:   {sum(ttfts)/len(ttfts):.0f} ms")
    print(f"  Min TTFT:   {min(ttfts):.0f} ms")
    print(f"  Max TTFT:   {max(ttfts):.0f} ms")
    print(f"  Avg total:  {sum(totals)/len(totals):.0f} ms")
    print(f"  Min total:  {min(totals):.0f} ms")
    print(f"  Max total:  {max(totals):.0f} ms")


def smoke_test_tools(client: OpenAI, model_name: str) -> None:
    """Run a multi-turn tool-calling loop."""
    print("\n" + "=" * 60)
    print("TOOL-CALLING TEST")
    print("=" * 60)

    messages = [
        {
            "role": "user",
            "content": "What is (12 + 8) * 3? Use the calculator tools to compute step by step.",
        }
    ]

    has_tool_calls = True
    round_num = 0
    while has_tool_calls:
        round_num += 1
        print(f"\n--- Round {round_num} ---")

        response = client.chat.completions.create(
            model=model_name,
            messages=messages,
            temperature=0.6,
            top_p=0.95,
            tools=tools,
            tool_choice="auto",
            extra_body={
                "top_k": 20,
                "chat_template_kwargs": {"enable_thinking": False},
            },
        )

        choice = response.choices[0].message
        tool_calls = choice.tool_calls or []
        content = choice.content or ""

        tool_calls_dict = [tc.to_dict() for tc in tool_calls] if tool_calls else []
        messages.append({
            "role": "assistant",
            "tool_calls": tool_calls_dict,
            "content": content,
        })

        if content:
            print(f"Assistant: {content}")

        if not tool_calls:
            has_tool_calls = False
        else:
            for tc in tool_calls:
                fx = tc.function.name
                args = json.loads(tc.function.arguments)
                print(f"  Tool call: {fx}({args})")
                out = MAP_FN[fx](**args)
                print(f"  Result: {out}")
                messages.append({
                    "role": "tool",
                    "tool_call_id": tc.id,
                    "name": fx,
                    "content": str(out),
                })

    print("\nFinal answer:", messages[-1].get("content", "(no content)"))


def smoke_test_multimodal(client: OpenAI, model_name: str) -> None:
    """Caption a local image (files/demo.png) to exercise the vision encoder."""
    print("\n" + "=" * 60)
    print("MULTIMODAL TEST (image captioning)")
    print("=" * 60)

    img_path = Path(__file__).parent / "files" / "demo.png"
    data_url = _encode_image_data_url(img_path)
    print(f"Image: {img_path.name} ({img_path.stat().st_size / 1024:.0f} KB)")

    messages = [
        {
            "role": "user",
            "content": [
                {"type": "image_url", "image_url": {"url": data_url}},
                {"type": "text", "text": "Describe this image in one or two sentences."},
            ],
        }
    ]

    m = _stream_and_measure(client, model_name, messages)
    print()
    _print_metrics(m)


def _filler_text(n_chars: int) -> str:
    """Deterministic numbered pseudo-English filler of >= n_chars characters.

    Numbered lines keep the token/char ratio stable (no degenerate repeats)
    and make every request prefix-unique when combined with a fresh nonce.
    """
    lines = []
    total = 0
    i = 0
    while total < n_chars:
        line = f"[{i:06d}] The quick brown fox jumps over the lazy dog by the river."
        lines.append(line)
        total += len(line) + 1
        i += 1
    return "\n".join(lines)


def _calibrate_prompt_tokens(
    client: OpenAI, model_name: str, instruction: str
) -> tuple[float, float]:
    """Probe the server tokenizer with two filler sizes to derive
    (chars_per_token, zero_char_overhead_tokens).

    The probes use the exact message shape of the real request, so the chat
    template overhead is folded into the intercept. This lets us solve for
    the filler length that lands the prompt on an exact token budget without
    a local tokenizer dependency.
    """
    probes = []
    for n in CALIBRATION_SIZES:
        filler = _filler_text(n)
        resp = client.chat.completions.create(
            model=model_name,
            messages=[{"role": "user", "content": f"{instruction}\n\n{filler}"}],
            max_tokens=1,
            temperature=0.0,
            extra_body={"chat_template_kwargs": {"enable_thinking": False}},
        )
        probes.append((len(filler), resp.usage.prompt_tokens))

    (c1, t1), (c2, t2) = probes
    if t2 == t1:
        raise RuntimeError(f"calibration failed: identical token counts {probes}")
    chars_per_token = (c2 - c1) / (t2 - t1)
    overhead_tokens = t1 - c1 / chars_per_token
    return chars_per_token, overhead_tokens


def smoke_test_context(client: OpenAI, model_name: str) -> None:
    """Fill the full context window with a 70% input / 30% output token split.

    Reads MAX_LEN from the environment (must match the server's
    --max-model-len). Calibrates the server-side tokenizer, builds a filler
    prompt of ~70% of the window, then lets the model generate up to 30%
    (minus a safety margin) and reports the achieved in/out split.
    """
    print("\n" + "=" * 60)
    print("FULL-CONTEXT TEST (70/30 in/out split)")
    print("=" * 60)

    raw_max_len = os.environ.get(MAX_LEN_ENV, "").strip()
    if not raw_max_len:
        sys.exit(
            f"ERROR: {MAX_LEN_ENV} is required for context mode "
            "(must match the server's --max-model-len, e.g. 131072)"
        )
    max_len = int(raw_max_len)
    in_budget = int(max_len * CONTEXT_SPLIT_IN)
    out_budget = int(max_len * CONTEXT_SPLIT_OUT)
    print(f"  window: {max_len:,} tok -> in={in_budget:,} out={out_budget:,}")

    # unique nonce at the very front defeats prefix caching -> cold prefill
    nonce = random.randrange(1 << 32)
    instruction = f"DOCUMENT NONCE {nonce}. {CONTEXT_INSTRUCTION}"

    cpt, overhead = _calibrate_prompt_tokens(client, model_name, instruction)
    print(f"  calibration: {cpt:.2f} chars/tok, ~{overhead:.0f} tok overhead")

    # aim slightly under the 70% budget: a prompt overshoot combined with
    # max_tokens would exceed max_model_len and be rejected by the server
    filler_chars = max(
        int((in_budget - overhead - CONTEXT_SAFETY_TOKENS) * cpt) - len(instruction), 0
    )
    messages = [
        {"role": "user", "content": f"{instruction}\n\n{_filler_text(filler_chars)}"}
    ]
    # keep prompt + generation inside the hard server limit
    out_tokens = max_len - in_budget - CONTEXT_SAFETY_TOKENS
    print(f"  filler: {filler_chars:,} chars, max_tokens={out_tokens:,} (streaming)")

    m = _stream_and_measure(
        client,
        model_name,
        messages,
        max_tokens=out_tokens,
        echo=False,
        timeout=CONTEXT_REQUEST_TIMEOUT,
        # the model concludes repetitive continuations early via EOS;
        # ignore_eos + neutral penalty force generation to the full budget
        overrides={
            "presence_penalty": 0.0,
            "extra_body": {**INFERENCE_PARAMS["extra_body"], "ignore_eos": True},
        },
    )
    if m["prompt_tokens"] is None:
        sys.exit("ERROR: server did not report prompt_tokens via stream usage")

    pt, ct = m["prompt_tokens"], m["completion_tokens"]
    print("\n" + "-" * 60)
    print(f"  Prompt tokens:     {pt:,}  ({pt / max_len:.1%}, target {CONTEXT_SPLIT_IN:.0%})")
    print(f"  Completion tokens: {ct:,}  ({ct / max_len:.1%}, target {CONTEXT_SPLIT_OUT:.0%})")
    print(f"  Window utilized:   {(pt + ct) / max_len:.1%}")
    print(f"  TTFT (prefill):    {m['ttft']:.0f} ms  ({pt / (m['ttft'] / 1000):,.0f} tok/s)")
    print(f"  Decode:            {m['tps']:.1f} tok/s over {m['gen_time'] / 1000:.0f} s")
    print(f"  Finish reason:     {m['finish_reason']}")
    print(f"  Total:             {m['total'] / 1000:.1f} s")

    if m["finish_reason"] != "length":
        sys.exit(
            f"ERROR: generation ended with '{m['finish_reason']}' instead of "
            "running to the output budget ('length')"
        )
    if pt < in_budget * 0.95:
        sys.exit(
            f"ERROR: prompt used only {pt / max_len:.1%} of the window; "
            "expected ~70%"
        )
    print("  Split check:       PASS (hit output budget, prompt >= 95% of target)")


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def main() -> None:
    mode = sys.argv[1] if len(sys.argv) > 1 else "all"
    client, model_name = get_client()

    # Heavy standalone modes: skip text warmup, measure cold paths
    if mode == "multimodal":
        smoke_test_multimodal(client, model_name)
        print("\nSmoke test complete!")
        return
    if mode == "context":
        smoke_test_context(client, model_name)
        print("\nSmoke test complete!")
        return

    # Always warm up caches first
    warmup(client, model_name)

    if mode in ("stream", "all"):
        smoke_test_stream(client, model_name)
    if mode in ("multiturn", "all"):
        smoke_test_multiturn(client, model_name)
    if mode in ("tools", "all"):
        smoke_test_tools(client, model_name)
    if mode == "all":
        smoke_test_multimodal(client, model_name)

    print("\nSmoke test complete!")


if __name__ == "__main__":
    main()
