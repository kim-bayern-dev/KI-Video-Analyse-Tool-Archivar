# /// script
# requires-python = ">=3.10"
# dependencies = ["openai"]
# ///
"""Gemma-4 smoke test - vision, video, tool-calling and reasoning via the OpenAI-compatible API.

Usage:
    uv run smoke_test.py [vision|video|tools|reasoning|nonthinking|all] [video_path]

    ("videoframesbatch" is a DEPRECATED alias of "video", kept for compatibility.)

Environment (loaded from .env, or set manually):
    OPENAI_BASE_URL   e.g. http://127.0.0.1:9031/v1
    OPENAI_API_KEY    e.g. your-api-key
"""

import base64
import json
import os
import random
import subprocess
import sys
import time
from pathlib import Path
import argparse

from openai import OpenAI


IMAGE_CANDIDATES = [
    "demo.png",
]
IMAGE_SUFFIXES = (".png", ".jpg", ".jpeg", ".webp")

# Gemma-4 sampling profile for the smoke test. We keep temperature low and pin a
# fixed seed so runs are reproducible/comparable; top_k=64 keeps Gemma-4's full
# candidate set. At low temperature the model leans near-greedy, which triggers
# degenerate repetition loops on long multimodal prompts (e.g. video), so a
# repetition_penalty above 1 is used to break them — in place of presence_penalty.
GEMMA4_TEMPERATURE = 0.3
GEMMA4_TOP_P = 0.95
GEMMA4_TOP_K = 64
GEMMA4_REPETITION_PENALTY = 1.2
GEMMA4_SEED = 42


def build_sampling_extra_body(enable_thinking: bool, **overrides) -> dict:
    """Build a consistent vLLM extra_body for the official Gemma-4 sampling profile.

    Caller-supplied kwargs (e.g. mm_processor_kwargs, min_p) are merged on top so
    every test samples from the same well-tuned distribution instead of ad-hoc values.
    """
    body: dict = {
        "top_k": GEMMA4_TOP_K,
        "repetition_penalty": GEMMA4_REPETITION_PENALTY,
        "chat_template_kwargs": {"enable_thinking": enable_thinking},
    }
    body.update(overrides)
    return body


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

def write_a_story() -> str:
    return random.choice([
        "A long time ago in a galaxy far far away...",
        "There were 2 friends who loved sloths and code...",
        "The world was ending because every sloth evolved to have superhuman intelligence...",
        "Unbeknownst to one friend, the other accidentally coded a program to evolve sloths...",
    ])

def terminal(command: str) -> str:
    blocked = ["rm", "sudo", "dd", "chmod"]
    if any(kw in command for kw in blocked):
        msg = f"Cannot execute commands containing {blocked} since they are dangerous"
        print(msg)
        return msg
    print(f"Executing terminal command `{command}`")
    try:
        result = subprocess.run(
            command, capture_output=True, text=True, shell=True, check=True,
        )
        return result.stdout
    except subprocess.CalledProcessError as e:
        return f"Command failed: {e.stderr}"

def _unwrap_tool_arg(v):
    """Unwrap values the model wraps in redundant JSON quoting (e.g. '"12"' -> '12').

    Keeps non-string values (lists/dicts/None) untouched so structured args still work.
    """
    if isinstance(v, str):
        s = v.strip()
        if len(s) >= 2 and s[0] == s[-1] and s[0] in ("'", '"'):
            inner = s[1:-1]
            try:
                if "." in inner:
                    return float(inner)
                return int(inner)
            except ValueError:
                return inner
    return v


def python_exec(code: str) -> str:
    data: dict = {}
    exec(code, data)  # noqa: S102 - local smoke test only
    data.pop("__builtins__", None)
    return str(data)

MAP_FN = {
    "add_number": add_number,
    "multiply_number": multiply_number,
    "substract_number": substract_number,
    "write_a_story": write_a_story,
    "terminal": terminal,
    "python": python_exec,
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
    {
        "type": "function",
        "function": {
            "name": "write_a_story",
            "description": "Writes a random story.",
            "parameters": {"type": "object", "properties": {}, "required": []},
        },
    },
    {
        "type": "function",
        "function": {
            "name": "terminal",
            "description": "Perform operations from the terminal.",
            "parameters": {
                "type": "object",
                "properties": {
                    "command": {
                        "type": "string",
                        "description": "The command you wish to launch, e.g. `ls`, `echo hello`, ...",
                    },
                },
                "required": ["command"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "python",
            "description": "Call a Python interpreter with some Python code that will be ran.",
            "parameters": {
                "type": "object",
                "properties": {
                    "code": {"type": "string", "description": "The Python code to run"},
                },
                "required": ["code"],
            },
        },
    },
]

# ---------------------------------------------------------------------------
# Test helpers
# ---------------------------------------------------------------------------

def get_client() -> tuple[OpenAI, str]:
    """DEPRECATED: shadowed by the later get_client() definition below (dead code)."""
    # API_KEY from .env is the server-side key name; map it for the OpenAI client
    if not os.environ.get("OPENAI_API_KEY"):
        os.environ["OPENAI_API_KEY"] = os.environ.get("API_KEY", "your-api-key")
    client = OpenAI()  # reads OPENAI_BASE_URL & OPENAI_API_KEY from env
    model_name = next(iter(client.models.list())).id
    print(f"Using model = {model_name}")
    return client, model_name


def _extract_content(message) -> tuple[str | None, str | None]:
    """DEPRECATED: shadowed by the later _extract_content() definition below (dead code)."""
    content = message.content
    raw = message.model_extra or {}
    reasoning = raw.get("reasoning") or raw.get("reasoning_content")
    return content, reasoning


def load_image_as_data_url(path: str) -> str:
    """DEPRECATED: shadowed by the later load_image_as_data_url() definition below (dead code)."""
    img_path = Path(path)
    if not img_path.exists():
        raise FileNotFoundError(f"Image not found: {img_path}")
    data = img_path.read_bytes()
    suffix = img_path.suffix.lower().lstrip(".")
    mime = {"jpg": "image/jpeg", "jpeg": "image/jpeg", "png": "image/png", "gif": "image/gif", "webp": "image/webp"}.get(suffix, "image/png")
    b64 = base64.b64encode(data).decode()
    return f"data:{mime};base64,{b64}"


def load_video_as_data_url(path: str) -> str:
    """Read a local video and return a base64 data URL."""
    video_path = Path(path)
    if not video_path.exists():
        raise FileNotFoundError(f"Video not found: {video_path}")
    data = video_path.read_bytes()
    suffix = video_path.suffix.lower().lstrip(".")
    mime = {
        "mp4": "video/mp4",
        "mov": "video/quicktime",
        "m4v": "video/x-m4v",
        "webm": "video/webm",
        "avi": "video/x-msvideo",
        "mkv": "video/x-matroska",
    }.get(suffix, "video/mp4")
    b64 = base64.b64encode(data).decode()
    return f"data:{mime};base64,{b64}"


def find_default_video_path(data_dir: str | None = None) -> Path:
    """Find a reasonable default local video sample for the smoke test."""
    script_dir = Path(__file__).resolve().parent
    
    # Use DATA_DIR from environment if provided
    if data_dir:
        data_path = Path(data_dir)
        if data_path.exists():
            candidates = [
                data_path / "demo.mp4",
                data_path / "demo.mov",
                data_path / "demo.m4v",
            ]
            for candidate in candidates:
                if candidate.exists():
                    return candidate
            # Search for any video file in data directory
            for pattern in ("*.mp4", "*.mov", "*.m4v", "*.webm", "*.avi", "*.mkv"):
                matches = sorted(data_path.glob(pattern))
                if matches:
                    return matches[0]
    
    # Fallback to default locations
    candidates = [
        script_dir / "demo.mp4",
    ]
    for candidate in candidates:
        if candidate.exists():
            return candidate
    for directory in (script_dir,):
        if not directory.exists():
            continue
        for pattern in ("*.mp4", "*.mov", "*.m4v", "*.webm", "*.avi", "*.mkv"):
            matches = sorted(directory.glob(pattern))
            if matches:
                return matches[0]
    raise FileNotFoundError(
        "No local video found. Pass a path, for example: uv run smoke_test.py video /path/to/demo.mp4"
    )


def resolve_video_input_url(video_path: str, data_dir: str | None = None) -> tuple[str, str]:
    """DEPRECATED: unused — video is always sent inline as a base64 data URL."""
    resolved_path = Path(video_path).resolve()
    if data_dir:
        data_path = Path(data_dir).resolve()
        try:
            relative_path = resolved_path.relative_to(data_path)
        except ValueError:
            pass
        else:
            return f"file://{relative_path.as_posix()}", "server-local"

    return load_video_as_data_url(str(resolved_path)), "inline-base64"


def smoke_test_vision(client: OpenAI, model_name: str, data_dir: str | None = None) -> None:
    """Send a vision request with a local image (base64-encoded)."""
    print("\n" + "=" * 60)
    print("VISION TEST")
    print("=" * 60)

    # Try to find an image in the data directory, fallback to script directory
    script_dir = Path(__file__).resolve().parent
    image_paths: list[str] = []
    seen_paths: set[str] = set()

    def add_candidate(candidate: Path) -> None:
        resolved = str(candidate.resolve())
        if candidate.exists() and resolved not in seen_paths:
            seen_paths.add(resolved)
            image_paths.append(str(candidate))

    # First try data directory
    if data_dir:
        data_path = Path(data_dir)
        for img_file in IMAGE_CANDIDATES:
            add_candidate(data_path / img_file)
        if not image_paths and data_path.is_dir():
            for candidate in sorted(data_path.iterdir()):
                if candidate.is_file() and candidate.suffix.lower() in IMAGE_SUFFIXES:
                    add_candidate(candidate)
    
    # Fallback to script directory
    if not image_paths:
        for img_file in IMAGE_CANDIDATES:
            add_candidate(script_dir / img_file)
        if not image_paths:
            for candidate in sorted(script_dir.iterdir()):
                if candidate.is_file() and candidate.suffix.lower() in IMAGE_SUFFIXES:
                    add_candidate(candidate)
    
    if not image_paths:
        raise FileNotFoundError(f"No test image found in {data_dir} or {script_dir}")

    for index, image_path in enumerate(image_paths, start=1):
        image_url, resolved_image_path = load_image_as_data_url(image_path, data_dir)
        print(f"\n--- Image {index}/{len(image_paths)} ---")
        print(f"Loaded {resolved_image_path} ({len(image_url)} chars base64)")

        messages = [
            {
                "role": "user",
                "content": [
                    {
                        "type": "image_url",
                        "image_url": {"url": image_url},
                    },
                    {"type": "text", "text": "What do you see in this image? Describe it briefly."},
                ],
            }
        ]

        start = time.monotonic()
        response = client.chat.completions.create(
            model=model_name,
            messages=messages,
            max_tokens=32768,
            temperature=GEMMA4_TEMPERATURE,
            top_p=GEMMA4_TOP_P,
            seed=GEMMA4_SEED,
            extra_body=build_sampling_extra_body(enable_thinking=False),
        )
        elapsed = time.monotonic() - start
        content, reasoning = _extract_content(response.choices[0].message)
        print(f"Response: {content or reasoning}")
        _print_metrics(response, elapsed, f"vision {index}")


def smoke_test_reasoning(client: OpenAI, model_name: str) -> None:
    """Test thinking (reasoning) mode with a math/logic problem."""
    print("\n" + "=" * 60)
    print("REASONING (THINKING) TEST")
    print("=" * 60)

    messages = [
        {
            "role": "user",
            "content": "How many r's are in the word 'strawberry'? Think step by step.",
        }
    ]

    # Thinking mode params
    start = time.monotonic()
    response = client.chat.completions.create(
        model=model_name,
        messages=messages,
        max_tokens=32768,
        temperature=GEMMA4_TEMPERATURE,
        top_p=GEMMA4_TOP_P,
        seed=GEMMA4_SEED,
        extra_body=build_sampling_extra_body(enable_thinking=True),
    )
    elapsed = time.monotonic() - start
    content, reasoning = _extract_content(response.choices[0].message)
    if reasoning:
        # Show a truncated version of the thinking
        preview = reasoning[:500] + ("..." if len(reasoning) > 500 else "")
        print(f"Thinking ({len(reasoning)} chars): {preview}")
    print(f"Answer: {content or '(empty - check reasoning above)'}")
    _print_metrics(response, elapsed, "reasoning")


def smoke_test_nonthinking(client: OpenAI, model_name: str) -> None:
    """Test instruct (non-thinking) mode."""
    print("\n" + "=" * 60)
    print("NON-THINKING (INSTRUCT) TEST")
    print("=" * 60)

    messages = [
        {
            "role": "user",
            "content": "Explain in 2-3 sentences what a MoE (Mixture of Experts) model is.",
        }
    ]

    # Non-thinking mode params
    start = time.monotonic()
    response = client.chat.completions.create(
        model=model_name,
        messages=messages,
        max_tokens=512,
        temperature=GEMMA4_TEMPERATURE,
        top_p=GEMMA4_TOP_P,
        seed=GEMMA4_SEED,
        extra_body=build_sampling_extra_body(enable_thinking=False),
    )
    elapsed = time.monotonic() - start
    content, reasoning = _extract_content(response.choices[0].message)
    print(f"Response: {content or reasoning}")
    _print_metrics(response, elapsed, "nonthinking")


def smoke_test_tools(
    client: OpenAI,
    model_name: str,
    temperature: float = GEMMA4_TEMPERATURE,
    top_p: float = GEMMA4_TOP_P,
    top_k: int = GEMMA4_TOP_K,
    min_p: float = 0.0,
    repetition_penalty: float = GEMMA4_REPETITION_PENALTY,
) -> None:
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
    total_prompt_tokens = 0
    total_completion_tokens = 0
    total_tokens = 0
    start = time.monotonic()
    while has_tool_calls:
        round_num += 1
        print(f"\n--- Round {round_num} ---")
        print(f"Messages ({len(messages)}): {json.dumps(messages[-1], indent=2, default=str)}")

        response = client.chat.completions.create(
            model=model_name,
            messages=messages,
            temperature=temperature,
            top_p=top_p,
            seed=GEMMA4_SEED,
            tools=tools,
            tool_choice="auto",
            extra_body={
                "top_k": top_k,
                "min_p": min_p,
                "repetition_penalty": repetition_penalty,
            },
        )
        usage = response.usage
        if usage:
            total_prompt_tokens += usage.prompt_tokens or 0
            total_completion_tokens += usage.completion_tokens or 0
            total_tokens += usage.total_tokens or 0

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
                # Models sometimes emit numbers as JSON-quoted strings, e.g.
                # {"a": "\"12\""} -> unwrap nested quoting so float()/int() works.
                args = {k: _unwrap_tool_arg(v) for k, v in args.items()}
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
    elapsed = time.monotonic() - start
    _print_usage_metrics(total_prompt_tokens, total_completion_tokens, total_tokens, elapsed, "tools")


def _print_metrics(response, elapsed_s: float, label: str = "") -> None:
    """Print token usage, elapsed time, and throughput from a chat completion response."""
    usage = response.usage
    prompt_tokens = usage.prompt_tokens if usage else 0
    completion_tokens = usage.completion_tokens if usage else 0
    total_tokens = usage.total_tokens if usage else 0

    _print_usage_metrics(prompt_tokens, completion_tokens, total_tokens, elapsed_s, label)


def _print_usage_metrics(
    prompt_tokens: int,
    completion_tokens: int,
    total_tokens: int,
    elapsed_s: float,
    label: str = "",
) -> None:
    """Print elapsed time and throughput from explicit token counts."""

    # Throughput (tokens/sec of generated output)
    throughput = completion_tokens / elapsed_s if elapsed_s > 0 else 0.0

    extra = f" ({label})" if label else ""
    print(f"\n--- Metrics{extra} ---")
    print(f"  Prompt tokens:    {prompt_tokens}")
    print(f"  Output tokens:    {completion_tokens}")
    print(f"  Total tokens:     {total_tokens}")
    print(f"  Elapsed time:     {elapsed_s:.2f}s")
    print(f"  Throughput:       {throughput:.1f} tok/s")

def smoke_test_video_native(client: OpenAI, model_name: str, video_path: str | None = None, data_dir: str | None = None) -> None:
    """Send the whole video natively as a single video_url to the vLLM OpenAI-compatible API.

    vLLM decodes the video server-side using the frame sampling configured at launch
    (--limit-mm-per-prompt / --media-io-kwargs), so we neither need ffmpeg on the host
    nor docker cp into the container. Per-request sampling can be tuned via
    mm_processor_kwargs (fps / video_num_frames); the server-side defaults still apply
    for anything we omit.
    """
    print("\n" + "=" * 60)
    print("VIDEO NATIVE TEST (video_url -> vLLM server-side decoding)")
    print("=" * 60)

    if video_path is None:
        video_path = str(find_default_video_path(data_dir))

    print(f"Using video: {video_path}")
    data_url = load_video_as_data_url(video_path)
    print(f"Loaded {video_path} ({len(data_url)} chars base64 data URL)")

    content = [
        {
            "type": "text",
            "text": (
                "Describe this video. Mention key objects, actions, and any visible text or "
                "overlays, then give one concise unified caption for the whole clip."
            ),
        },
        {"type": "video_url", "video_url": {"url": data_url}},
    ]

    start = time.monotonic()
    response = client.chat.completions.create(
        model=model_name,
        messages=[{"role": "user", "content": content}],
        max_tokens=512,
        temperature=GEMMA4_TEMPERATURE,
        top_p=GEMMA4_TOP_P,
        seed=GEMMA4_SEED,
        extra_body=build_sampling_extra_body(
            enable_thinking=False,
            # Tune per-request video sampling: ~2 fps. The server-side num_frames cap
            # (from --limit-mm-per-prompt) still clamps the total extracted frames.
            mm_processor_kwargs={"fps": 2.0},
        ),
    )
    elapsed = time.monotonic() - start
    content_text, reasoning = _extract_content(response.choices[0].message)
    print("Video caption:")
    print(content_text or reasoning)
    _print_metrics(response, elapsed, "video native")


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def main() -> None:
    import argparse
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "mode",
        nargs="?",
        default="all",
        choices=["vision", "video", "videoframesbatch", "tools", "reasoning", "nonthinking", "all"],
        help="Test mode to run (default: all)",
    )
    parser.add_argument(
        "video_path",
        nargs="?",
        help="Path to video file for video test (optional)",
    )
    parser.add_argument(
        "--data-dir",
        default=os.environ.get(
            "DATA_DIR",
            str(Path(__file__).resolve().parent.parent / "sample_data" / "test"),
        ),
        help="Directory containing test images and videos (default: ../sample_data/test, or DATA_DIR env var)",
    )
    args = parser.parse_args()
    
    client, model_name = get_client()

    if args.mode in ("vision", "all"):
        smoke_test_vision(client, model_name, args.data_dir)
    if args.mode in ("reasoning", "all"):
        smoke_test_reasoning(client, model_name)
    if args.mode in ("nonthinking", "all"):
        smoke_test_nonthinking(client, model_name)
    if args.mode in ("tools", "all"):
        smoke_test_tools(client, model_name)
    if args.mode in ("video", "videoframesbatch", "all"):
        smoke_test_video_native(client, model_name, args.video_path, args.data_dir)

    print("\nSmoke test complete!")




def load_local_env() -> None:
    """Load key=value pairs from .env next to this script into the process environment."""
    env_path = Path(__file__).resolve().parent / ".env"
    if not env_path.exists():
        return

    for raw_line in env_path.read_text().splitlines():
        line = raw_line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue

        key, value = line.split("=", 1)
        os.environ.setdefault(key.strip(), value.strip().strip('"').strip("'"))

def get_client() -> tuple[OpenAI, str]:
    """Create OpenAI client and get the served model name from OPENAI_MODEL env var."""
    load_local_env()

    if not os.environ.get("OPENAI_BASE_URL") and os.environ.get("ENDPOINT"):
        os.environ["OPENAI_BASE_URL"] = os.environ["ENDPOINT"]

    # API_KEY from .env is the server-side key name; map it for the OpenAI client
    if not os.environ.get("OPENAI_API_KEY"):
        os.environ["OPENAI_API_KEY"] = os.environ.get("API_KEY", "your-api-key")

    client = OpenAI()  # reads OPENAI_BASE_URL & OPENAI_API_KEY from env
    
    # Use OPENAI_MODEL from .env, or discover it if not set
    model_name = os.environ.get("OPENAI_MODEL")
    if model_name:
        print(f"Using model from OPENAI_MODEL = {model_name}")
    else:
        model_name = next(iter(client.models.list())).id
        print(f"Using model from API = {model_name}")
    
    return client, model_name

def resolve_image_path(path: str | None, data_dir: str | None = None) -> Path:
    """Resolve an image path from data_dir, cwd or the script directory, with extension fallback."""
    script_dir = Path(__file__).resolve().parent
    requested_path = Path(path) if path else script_dir / "real_small.jpg"

    # If data_dir is provided, check there first
    if data_dir:
        data_path = Path(data_dir)
        if data_path.is_dir():
            candidates = [
                data_path / requested_path,
                data_path / requested_path.name,
            ]
            for candidate in candidates:
                if candidate.exists():
                    return candidate

    if requested_path.is_absolute() and requested_path.exists():
        return requested_path

    candidates: list[Path] = []
    if requested_path.is_absolute():
        candidates.append(requested_path)
    else:
        candidates.extend([Path.cwd() / requested_path, script_dir / requested_path])

    for candidate in candidates:
        if candidate.exists():
            return candidate

    extension_fallbacks = [".jpg", ".jpeg", ".png", ".gif", ".webp"]
    if requested_path.suffix.lower() in extension_fallbacks:
        stem_path = requested_path.with_suffix("")
        fallback_candidates: list[Path] = []
        if requested_path.is_absolute():
            fallback_candidates = [requested_path.with_suffix(ext) for ext in extension_fallbacks]
        else:
            for base_dir in (Path.cwd(), script_dir):
                for ext in extension_fallbacks:
                    fallback_candidates.append(base_dir / stem_path.with_suffix(ext))

        for candidate in fallback_candidates:
            if candidate.exists():
                return candidate

    searched_paths = candidates
    if not requested_path.is_absolute() and requested_path.suffix.lower() in extension_fallbacks:
        for base_dir in (Path.cwd(), script_dir):
            for ext in extension_fallbacks:
                searched_paths.append(base_dir / requested_path.with_suffix(ext))

    searched_display = ", ".join(str(candidate) for candidate in searched_paths)
    raise FileNotFoundError(f"Image not found: {path or requested_path}. Searched: {searched_display}")


def load_image_as_data_url(path: str | None, data_dir: str | None = None) -> tuple[str, Path]:
    """Read a local image and return a base64 data URL with the resolved file path."""
    img_path = resolve_image_path(path, data_dir)
    data = img_path.read_bytes()
    suffix = img_path.suffix.lower().lstrip(".")
    mime = {"jpg": "image/jpeg", "jpeg": "image/jpeg", "png": "image/png", "gif": "image/gif", "webp": "image/webp"}.get(suffix, "image/png")
    b64 = base64.b64encode(data).decode()
    return f"data:{mime};base64,{b64}", img_path

def _extract_content(message) -> tuple[str | None, str | None]:
    """Extract (content, reasoning) from a chat completion message.

    With --reasoning-parser, the model's thinking goes into the 'reasoning'
    field and the final answer into 'content'.  When thinking is disabled
    the model may still route everything through reasoning, so we handle both.
    """
    content = message.content
    raw = message.model_extra or {}
    reasoning = raw.get("reasoning") or raw.get("reasoning_content")
    return content, reasoning

if __name__ == "__main__":
    main()


