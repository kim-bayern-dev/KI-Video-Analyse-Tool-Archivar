#!/usr/bin/env python3
"""Merge benchmark-suite summaries into a per-configuration comparison table.

Usage:
  scripts/compare_summaries.py <result-dir> [<result-dir> ...]

Reads summary.json, environment.json and *-config.txt from each directory and
prints a Markdown table: one row per (config, case), with percentage change
versus the immediately preceding configuration for output tok/s and TPOT.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

CASES = ["D1", "D2", "L1", "L2", "T1", "MM1", "MM2"]


def load(d: Path) -> dict:
    summary = json.loads((d / "summary.json").read_text())
    env = {}
    env_file = d / "environment.json"
    if env_file.exists():
        env = json.loads(env_file.read_text())
    # Infer config traits from the actual server command snapshot.
    traits = {"attn": "?", "linear": "?", "spec": "none", "bt": "?", "mode": "?"}
    cmd = d / "server-command.txt"
    if cmd.exists():
        args = cmd.read_text().splitlines()
        def after(flag: str) -> str | None:
            return args[args.index(flag) + 1] if flag in args else None
        traits["attn"] = after("--attention-backend") or "auto"
        traits["linear"] = after("--linear-backend") or "auto"
        traits["bt"] = after("--max-num-batched-tokens") or "?"
        traits["mode"] = after("--performance-mode") or "?"
        spec = after("--speculative-config")
        if spec:
            traits["spec"] = json.loads(spec)["method"]
    return {"dir": d.name, "env": env, "summary": summary, "traits": traits}


def main() -> None:
    dirs = [Path(a) for a in sys.argv[1:]]
    if not dirs:
        print("usage: compare_summaries.py <result-dir> [<result-dir> ...]", file=sys.stderr)
        sys.exit(2)
    configs = [load(d) for d in dirs]

    header = ("| Config | Backend | Linear | Spec | BT | Case | TTFT ms | TPOT p50/p95 ms | "
              "Output tok/s | dOut % | Prompt tok/s | Accept len |")
    sep = "|---|---|---|---|---|---|---:|---:|---:|---:|---:|---:|"
    lines = [header, sep]
    prev: dict[str, dict] = {}
    for cfg in configs:
        t, s = cfg["traits"], cfg["summary"]
        for case in [c for c in CASES if c in s]:
            r = s[case]
            out = r.get("output_tps_median")
            tpot = r.get("tpot_ms_p50")
            tpot95 = r.get("tpot_ms_p95")
            delta = ""
            if case in prev and out and prev[case].get("output_tps_median"):
                delta = f"{(out / prev[case]['output_tps_median'] - 1) * 100:+.0f}"
            def f(v, d=1):
                return f"{v:.{d}f}" if isinstance(v, (int, float)) else "-"
            lines.append(
                f"| {cfg['dir']} | {t['attn']} | {t['linear']} | {t['spec']} | {t['bt']} | {case} | "
                f"{f(r.get('ttft_ms_median'),0)} | {f(tpot,2)}/{f(tpot95,2)} | "
                f"{f(out)} | {delta or '-'} | {f(r.get('prompt_tps_median'),0)} | "
                f"{f(r.get('acceptance_length_median'),2)} |"
            )
        prev = {c: s[c] for c in CASES if c in s}
    print("\n".join(lines))


if __name__ == "__main__":
    main()
