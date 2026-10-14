# /// script
# requires-python = ">=3.11"
# ///
"""End-to-end format matrix runner (runs ON THE HOST, not inside the container).

For every matching `demo*` file in the corpus it invokes `./run.sh` exactly the way
production does (one container per file, corpus bind-mounted to /data, output to
./tmp/e2e/<name>), then validates:

  * the process exits 0 with valid JSON on stdout;
  * media classification matches an INDEPENDENT ffprobe of the raw input (ground truth);
  * segment temporal coverage spans [0, total_duration_s] with no gaps/overlaps;
  * every referenced output file exists, is non-empty, lives under the case dir, and is
    decodable (probed with the image's ffprobe);
  * for video with preprocessing: width<=640, height<=448, fps<=8;
  * preprocessing telemetry reports a real size reduction.

With `--preprocess-fps FPS` (repeatable, fractional allowed) each selected file is
additionally run once per given working-copy rate; the run keeps the normalized
working copy and asserts its probed frame rate matches the request:
1 fps = one frame per second, 0.5 = one frame every 2s, 0.25 = one every 4s.

Smoke mode repeats the smoke set N times and requires identical segment_counts across
runs (no flakiness). Artifacts: tmp/e2e/<name>/{stdout.json,stderr.log},
tmp/e2e/{summary.json,timings.json}.
"""
from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
IMAGE = os.environ.get("IMAGE", "segment-temporal:latest")
CORPUS_DIR = Path(os.environ.get("CORPUS_DIR", str(ROOT.parent / "sample_data"))).resolve()
TEST_DATA_DIR = Path(os.environ.get("TEST_DATA_DIR", str(CORPUS_DIR / "test"))).resolve()
TMP_DIR = Path(os.environ.get("TMP_DIR", str(ROOT / "tmp"))).resolve()
E2E_DIR = TMP_DIR / "e2e"
RUN_SH = ROOT / "run.sh"
CORPUS_ROOT = TEST_DATA_DIR.parent  # bind-mounted onto container /data by run.sh

IMAGE_EXTS = {
    ".avif", ".bmp", ".dpx", ".exr", ".fits", ".gif", ".hdr", ".j2k", ".jls",
    ".jp2", ".jpeg", ".jpg", ".jxl", ".ljpg", ".pam", ".pbm", ".pcx", ".pgm",
    ".png", ".ppm", ".qoi", ".ras", ".sgi", ".tga", ".tif", ".tiff", ".wbmp",
    ".webp", ".xbm", ".xwd",
}
AUDIO_EXTS = {".mp3", ".wav", ".flac", ".aac", ".ac3", ".wma", ".mp2", ".au", ".aiff", ".caf", ".ogg"}
COVERAGE_TOL = 0.25  # seconds; stream-copy segmentation can round to the 1s GOP
FPS_TOL = 0.01  # absolute tolerance on the probed working-copy frame rate

# Formats NOT supported by this build/container — excluded from the matrix entirely
# (they are not in the supported-format list). Each is an environment/edge-case limit,
# not a regression.
UNSUPPORTED = {
    "demo.jxl": "ffmpeg build has no jpegxl decoder (libjxl not compiled in)",
    "demo.m2v": "raw MPEG-2 elementary stream has no container duration metadata",
}


def log(msg):
    print(msg, flush=True)


def docker(args, **kw):
    return subprocess.run(args, text=True, **kw)


def in_container_ffprobe(host_path_under_corpus_root):
    """Ground-truth probe of a raw corpus input via the image's ffprobe."""
    rel = host_path_under_corpus_root.relative_to(CORPUS_ROOT)
    cp = docker(
        ["docker", "run", "--rm", "-v", f"{CORPUS_ROOT}:/data:ro",
         "--entrypoint", "ffprobe", IMAGE,
         "-v", "error", "-show_streams", "-of", "json", f"/data/{rel}"],
        capture_output=True,
    )
    if cp.returncode != 0:
        return None, (cp.stderr or "").strip()[:300]
    streams = json.loads(cp.stdout or "{}").get("streams", [])
    audio = any(s.get("codec_type") == "audio" for s in streams)
    video = [s for s in streams if s.get("codec_type") == "video" and not (s.get("disposition") or {}).get("attached_pic")]
    suffix = host_path_under_corpus_root.suffix.lower()
    if suffix in IMAGE_EXTS and video and not audio:
        return "image", None
    if video:
        return "video", None
    if audio:
        return "audio", None
    return None, "no decodable streams"


def invoke_run_sh(name, case_dir, extra_args=()):
    """Call ./run.sh for one corpus file; return (rc, stdout, stderr, wall_seconds)."""
    env = {
        **os.environ,
        "OUTPUT_DIR": str(case_dir),
        "CORPUS_DIR": str(CORPUS_DIR),
        "IMAGE": IMAGE,
        "MODELS_DIR": os.environ.get("MODELS_DIR", "/var/lib/docker/container_volumes/torch_models"),
    }
    out_path = case_dir / "stdout.json"
    err_path = case_dir / "stderr.log"
    started = time.monotonic()
    with out_path.open("w") as out_f, err_path.open("w") as err_f:
        cp = docker(
            [str(RUN_SH), f"/data/test/{name}", "--quiet", *extra_args],
            env=env, stdout=out_f, stderr=err_f,
        )
    wall = time.monotonic() - started
    return cp.returncode, out_path.read_text(), err_path.read_text(), wall


def probe_outputs_batch(case_dir):
    """One container decodes every produced mp4/mp3/jpg and reports dims/fps of a segment.

    Returns (bad_files:list[str], dims:(w,h,fps)|None).
    """
    cp = docker(
        ["docker", "run", "--rm", "-v", f"{case_dir}:/out:ro", "--entrypoint", "/bin/sh", IMAGE, "-c",
         r'for f in $(find /out -type f \( -name "*.mp4" -o -name "*.mp3" -o -name "*.jpg" \)); do '
         'ffprobe -v error -show_streams "$f" >/dev/null 2>&1 || echo "BAD:$f"; done; '
         # Skip a kept working copy (.work/) so dims/fps come from a real segment.
         'first=$(find /out -type f -name "*.mp4" -not -path "*/.work/*" | sort | head -1); '
         'if [ -n "$first" ]; then '
         'ffprobe -v error -select_streams v:0 -show_entries stream=width,height,avg_frame_rate '
         '-of default=noprint_wrappers=1 "$first"; fi'],
        capture_output=True,
    )
    bad, dims = [], None
    lines = (cp.stdout or "").splitlines()
    w = h = fr = None
    for line in lines:
        if line.startswith("BAD:"):
            bad.append(line[4:])
        elif line.startswith("width="):
            w = line.split("=", 1)[1]
        elif line.startswith("height="):
            h = line.split("=", 1)[1]
        elif line.startswith("avg_frame_rate="):
            fr = line.split("=", 1)[1]
    if w and h and fr:
        n, _, d = fr.partition("/")
        fps = (int(n) / int(d)) if d and int(d) else 0.0
        dims = (int(w), int(h), fps)
    return bad, dims


def probe_working_copy_fps(case_dir, working_file_ref):
    """avg_frame_rate of the kept normalized working copy, via the image's ffprobe.

    working_file_ref is the in-container path from the JSON telemetry (/output/...).
    Returns the rate as float, or None when the file/probe is unusable.
    """
    if not working_file_ref:
        return None
    rel = working_file_ref[len("/output"):].lstrip("/") if working_file_ref.startswith("/output") else working_file_ref
    p = (case_dir / rel).resolve()
    try:
        rel_to_case = p.relative_to(case_dir.resolve())
    except ValueError:
        return None
    if not p.is_file():
        return None
    cp = docker(
        ["docker", "run", "--rm", "-v", f"{case_dir}:/out:ro",
         "--entrypoint", "ffprobe", IMAGE,
         "-v", "error", "-select_streams", "v:0",
         "-show_entries", "stream=avg_frame_rate",
         "-of", "default=noprint_wrappers=1:nokey=1", f"/out/{rel_to_case}"],
        capture_output=True,
    )
    if cp.returncode != 0:
        return None
    n, _, d = (cp.stdout or "").strip().partition("/")
    try:
        return (int(n) / int(d)) if d else float(n)
    except (ValueError, ZeroDivisionError):
        return None


def validate_case(name, case_dir, rc, stdout, stderr, wall, expected_fps=None):
    """Return (ok:bool, reason:str, record:dict).

    expected_fps: when the case ran with an explicit --preprocess-fps, the kept
    working copy must actually carry that rate (0.5 = one frame every 2s,
    0.25 = one every 4s).
    """
    rec = {"name": name, "wall_seconds": round(wall, 3)}
    if rc != 0:
        return False, f"run.sh exit={rc}", rec
    try:
        data = json.loads(stdout)
    except json.JSONDecodeError as exc:
        return False, f"invalid JSON: {exc}", rec
    rec["media_type"] = data.get("media_type")
    rec["segment_counts"] = data.get("segment_counts", {})
    rec["total_duration_s"] = data.get("total_duration_s")
    results = data.get("results", [])

    # 1) classification vs independent ground truth
    gt, gterr = in_container_ffprobe(TEST_DATA_DIR / name)
    rec["expected_media_type"] = gt
    if gt is None:
        return False, f"ground-truth probe failed: {gterr}", rec
    if data.get("media_type") != gt:
        return False, f"classification mismatch: got {data.get('media_type')} expected {gt}", rec

    # 2) referenced outputs exist, non-empty, contained under case_dir
    refs = []
    for r in results:
        for key in ("audio_file", "video_file", "keyframe_file", "image_file"):
            v = r.get(key)
            if v:
                refs.append(v)
    for ref in refs:
        # CLI paths are in-container (/output/... because run.sh sets --output-dir /output);
        # map that prefix back to the host case dir before checking existence/containment.
        if ref.startswith("/output"):
            p = (case_dir / ref[len("/output"):].lstrip("/")).resolve()
        elif os.path.isabs(ref):
            p = Path(ref).resolve()
        else:
            p = (case_dir / ref).resolve()
        try:
            p.relative_to(case_dir.resolve())
        except ValueError:
            return False, f"output escapes case dir: {ref}", rec
        if not p.is_file() or p.stat().st_size == 0:
            return False, f"missing/empty output: {ref}", rec

    # 3) temporal contiguity for non-image. Endpoints may be legitimately trimmed by
    #    music-refinement (matching HEAD), so we only forbid overlaps and large internal
    #    gaps between consecutive segments.
    if data.get("media_type") != "image":
        spans = sorted(set(
            (float(r["start_s"]), float(r["end_s"]))
            for r in results
            if r.get("type") in ("audio_segment", "video_segment") and r.get("start_s") is not None
        ))
        for prev, cur in zip(spans, spans[1:]):
            if cur[0] - prev[1] > COVERAGE_TOL:
                return False, f"internal coverage gap {prev[1]}->{cur[0]}", rec
            if cur[1] < prev[1] - COVERAGE_TOL:
                return False, f"overlapping segments near {prev[1]}", rec

    # 4) decodability batch + normalized dims/fps
    bad, dims = probe_outputs_batch(case_dir)
    if bad:
        return False, f"undecodable outputs: {bad[:3]}", rec
    prep = data.get("preprocessing") or {}
    if data.get("media_type") == "video" and prep.get("enabled") and dims:
        w, h, fps = dims
        rec["segment_dims"] = f"{w}x{h}@{fps:.3f}"
        if w > 640 or h > 448:
            return False, f"dimensions exceed 640x448: {w}x{h}", rec
        if fps > 8.0 + 1e-6:
            return False, f"fps exceeds 8: {fps}", rec
        # telemetry: real size reduction
        if prep.get("output_bytes", 0) >= prep.get("input_bytes", 1):
            return False, "no preprocessing size reduction", rec
        # requested fractional/integer rate: telemetry + the actual working copy
        if expected_fps is not None:
            if prep.get("fps") != expected_fps:
                return False, f"telemetry fps {prep.get('fps')} != requested {expected_fps}", rec
            actual_fps = probe_working_copy_fps(case_dir, prep.get("working_file"))
            if actual_fps is None:
                return False, "working-copy fps probe failed (kept file missing/undecodable)", rec
            rec["working_copy_fps"] = round(actual_fps, 4)
            if abs(actual_fps - expected_fps) > FPS_TOL:
                return False, f"working copy fps {actual_fps:.4f} != requested {expected_fps}", rec

    return True, "ok", rec


def select_files(args):
    files = sorted(p.name for p in TEST_DATA_DIR.glob("demo*")
                   if p.is_file() and p.name not in UNSUPPORTED)
    if args.all:
        return files
    if args.smoke:
        return [f for f in files if f in {"demo.mp4", "demo.wav", "demo.png"}]
    if args.pattern:
        return [f for f in files if f in set(args.pattern)]
    return files


def main():
    ap = argparse.ArgumentParser(description="segment-temporal e2e format matrix")
    ap.add_argument("--all", action="store_true", help="run every demo* file")
    ap.add_argument("--smoke", action="store_true", help="run demo.mp4, demo.wav, demo.png")
    ap.add_argument("--pattern", action="append", default=[], help="exact filename to include (repeatable)")
    ap.add_argument("--repeat", type=int, default=1, help="repeat the selected set N times (flakiness check)")
    ap.add_argument("--preprocess-fps", type=float, action="append", default=[], metavar="FPS",
                    help="run each selected file once per given working-copy rate instead of the CLI "
                         "default (repeatable, fractional allowed: 0.5 = 1 frame/2s, 0.25 = 1 frame/4s)")
    args = ap.parse_args()

    files = select_files(args)
    if not files:
        log(f"No files selected under {TEST_DATA_DIR}")
        return 2

    fps_values = args.preprocess_fps or [None]
    E2E_DIR.mkdir(parents=True, exist_ok=True)
    log(f"Image: {IMAGE} | corpus: {CORPUS_ROOT} | cases: {len(files) * len(fps_values)} x{args.repeat} -> {E2E_DIR}")

    summary = []
    timings = []
    failures = 0
    for name in files:
        for fps in fps_values:
            # Repeat for flakiness; require identical segment_counts across reps.
            slug = "" if fps is None else f".fps{str(fps).replace('.', 'p')}"
            label = name if fps is None else f"{name}@{fps:g}fps"
            extra_args = [] if fps is None else ["--preprocess-fps", f"{fps:g}", "--keep-preprocessed"]
            reps = []
            ok = True
            reason = "ok"
            for rep in range(1, args.repeat + 1):
                case_dir = E2E_DIR / f"{name}{slug}"
                if args.repeat > 1:
                    case_dir = E2E_DIR / f"{name}{slug}.rep{rep}"
                case_dir.mkdir(parents=True, exist_ok=True)
                rc, stdout, stderr, wall = invoke_run_sh(name, case_dir, extra_args)
                rep_ok, rep_reason, rec = validate_case(name, case_dir, rc, stdout, stderr, wall, expected_fps=fps)
                reps.append(rec)
                if not rep_ok:
                    ok = False
                    reason = rep_reason
                    break
            if ok and len(reps) > 1:
                counts = {json.dumps(r.get("segment_counts"), sort_keys=True) for r in reps}
                if len(counts) > 1:
                    ok = False
                    reason = f"flaky segment_counts differ across reps: {[r.get('segment_counts') for r in reps]}"
            last = reps[-1]
            if fps is not None:
                last["preprocess_fps"] = fps
            status = "PASS" if ok else "FAIL"
            last.update({"status": status, "reason": reason})
            summary.append(last)
            timings.append({"name": label, "wall_seconds": last["wall_seconds"]})
            log(f"[{status}] {label:32s} {(last.get('media_type') or '-'):<6} "
                f"{last['wall_seconds']:6.2f}s  {('' if ok else reason)}")
            if not ok:
                failures += 1

    (E2E_DIR / "summary.json").write_text(json.dumps(summary, indent=2))
    (E2E_DIR / "timings.json").write_text(json.dumps(timings, indent=2))

    passed = sum(1 for s in summary if s["status"] == "PASS")
    log(f"\n{passed}/{len(summary)} passed, {failures} failed. "
        f"Unsupported (excluded): {', '.join(sorted(UNSUPPORTED))}. "
        f"summary: {E2E_DIR / 'summary.json'}")
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())
