#!/usr/bin/env bash
# summarize_results.sh <result-dir>
#
# (Re)generates summary.json and summary.md from the *-run-*.json files in a
# benchmark result directory. Called by benchmark_suite.sh; safe to re-run
# standalone after fixing summary logic.
set -Eeuo pipefail

[[ $# -eq 1 ]] || { echo "usage: $0 <result-dir>" >&2; exit 2; }

python3 - "$1" <<'PY'
import glob, json, statistics, sys
from pathlib import Path

result_dir = Path(sys.argv[1])
rows = {}
for path in sorted(glob.glob(str(result_dir / "*-run-*.json"))):
    case = Path(path).name.split("-run-")[0]
    data = json.loads(Path(path).read_text())
    rows.setdefault(case, []).append(data)

def med(values):
    vals = [v for v in values if isinstance(v, (int, float))]
    return round(statistics.median(vals), 3) if vals else None

summary = {}
for case, runs in rows.items():
    summary[case] = {
        "reps": len(runs),
        "ttft_ms_median": med([r.get("median_ttft_ms", r.get("ttft_ms")) for r in runs]),
        "tpot_ms_p50": med([r.get("median_tpot_ms", r.get("tpot_ms")) for r in runs]),
        "tpot_ms_p95": med([r.get("p95_tpot_ms") for r in runs]),
        "itl_ms_p50": med([r.get("median_itl_ms") for r in runs]),
        "itl_ms_p95": med([r.get("p95_itl_ms") for r in runs]),
        "output_tps_median": med([r.get("output_throughput") for r in runs]),
        # Prefill speed estimate: per-request input / TTFT for concurrency 1,
        # aggregate input / duration for concurrent runs.
        "prompt_tps_median": med(
            r["total_input_tokens"] / r["duration"]
            if (r.get("max_concurrency") or 1) > 1
            else (r.get("median_ttft_ms") and r["total_input_tokens"] / max(r["completed"], 1) / (r["median_ttft_ms"] / 1000))
            for r in runs
            if r.get("total_input_tokens") and r.get("duration")
        ),
        "request_tps_median": med([r.get("request_throughput") for r in runs]),
        "duration_s_median": med([r.get("duration", r.get("duration_s")) for r in runs]),
        "acceptance_rate_median": med(
            r.get("spec_decode_acceptance_rate")  # already percent in bench JSON
            for r in runs if r.get("spec_decode_acceptance_rate") is not None
        ),
        "acceptance_length_median": med(
            r.get("spec_decode_acceptance_length")
            for r in runs if r.get("spec_decode_acceptance_length") is not None
        ),
    }

(result_dir / "summary.json").write_text(json.dumps(summary, indent=2))

lines = ["| Case | Reps | TTFT ms | TPOT p50 ms | TPOT p95 ms | Output tok/s | Prompt tok/s | Req/s | Accept % |",
         "|---|---:|---:|---:|---:|---:|---:|---:|---:|"]
for case in sorted(summary):
    s = summary[case]
    def f(v, d=1):
        return f"{v:.{d}f}" if isinstance(v, (int, float)) else "-"
    lines.append(
        f"| {case} | {s['reps']} | {f(s['ttft_ms_median'],0)} | {f(s['tpot_ms_p50'],2)} | "
        f"{f(s['tpot_ms_p95'],2)} | {f(s['output_tps_median'])} | {f(s['prompt_tps_median'],0)} | "
        f"{f(s['request_tps_median'],2)} | {f(s['acceptance_rate_median'])} |"
    )
(result_dir / "summary.md").write_text("\n".join(lines) + "\n")
print("\n".join(lines))
PY
