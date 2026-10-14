#!/usr/bin/env python3
"""Container-side smoke tests with the REAL Silero VAD and the image's ffmpeg/ffprobe.

Invoked by `make unit-container`, which mounts this test tree read-only at /app/test
and the output dir at /output, and attaches the GPU.

It generates synthetic fixtures in-container, runs the `segment-temporal` CLI
end-to-end (real VAD, real preprocessing), and asserts classification, schema,
normalized dimensions/FPS, and decodability.
"""
from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path

FX = Path("/tmp/st_fixtures")
OUT = Path("/output/st_container")
FX.mkdir(parents=True, exist_ok=True)
OUT.mkdir(parents=True, exist_ok=True)


def sh(cmd):
    subprocess.run(cmd, check=True)


def gen_fixtures():
    # 4s video 640x480@30 + sine audio (real decode + preprocessing path).
    sh(["ffmpeg", "-hide_banner", "-loglevel", "error", "-y",
        "-f", "lavfi", "-i", "testsrc=size=640x480:rate=30",
        "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=16000",
        "-t", "4", "-shortest", str(FX / "video.mp4")])
    sh(["ffmpeg", "-hide_banner", "-loglevel", "error", "-y",
        "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=16000", "-t", "4", str(FX / "audio.wav")])
    # audio-only WebM: stream-probe must classify as audio, NOT video.
    sh(["ffmpeg", "-hide_banner", "-loglevel", "error", "-y",
        "-f", "lavfi", "-i", "sine=frequency=440", "-t", "4", str(FX / "audio_only.webm")])
    sh(["ffmpeg", "-hide_banner", "-loglevel", "error", "-y",
        "-f", "lavfi", "-i", "testsrc=size=320x240", "-frames:v", "1", str(FX / "image.png")])


def run_cli(fixture, *extra):
    outdir = OUT / fixture.stem
    outdir.mkdir(parents=True, exist_ok=True)
    cp = subprocess.run(
        ["segment-temporal", str(fixture), "--output-dir", str(outdir), "--quiet", *extra],
        capture_output=True, text=True, check=False,
    )
    if cp.returncode != 0:
        raise AssertionError(f"CLI failed on {fixture.name}: rc={cp.returncode}\nSTDERR tail:\n{cp.stderr[-1500:]}")
    return json.loads(cp.stdout), outdir


def probe_video(path):
    cp = subprocess.run(
        ["ffprobe", "-v", "error", "-select_streams", "v:0",
         "-show_entries", "stream=width,height,avg_frame_rate,codec_name", "-of", "json", str(path)],
        capture_output=True, text=True, check=True,
    )
    return json.loads(cp.stdout)["streams"][0]


def fps_to_float(rate):
    if "/" in rate:
        n, d = rate.split("/")
        return int(n) / int(d) if int(d) else 0.0
    return float(rate)


FAILURES: list[str] = []


def check(name, cond, detail=""):
    print(f"  {'PASS' if cond else 'FAIL'}: {name}" + ("" if cond else f"  ({detail})"))
    if not cond:
        FAILURES.append(name)


def main():
    gen_fixtures()

    print("== video.mp4 (real VAD + preprocessing) ==")
    d, outdir = run_cli(FX / "video.mp4", "--segment-videos")
    types = [r["type"] for r in d["results"]]
    check("media_type=video", d["media_type"] == "video")
    check("has video_segment", "video_segment" in types)
    check("has audio_segment", "audio_segment" in types)
    check("has keyframe", "keyframe" in types)
    p = d["preprocessing"]
    check("preprocessing.enabled", p.get("enabled") is True)
    check("cpu decode (used_nvdec=false)", p.get("used_nvdec") is False, str(p))
    vs = next((r for r in d["results"] if r["type"] == "video_segment"), None)
    if vs:
        st = probe_video(outdir / vs["video_file"])
        w, h = int(st["width"]), int(st["height"])
        fr = fps_to_float(st["avg_frame_rate"])
        check("dims<=640x448", w <= 640 and h <= 448, f"{w}x{h}")
        check("fps<=8", fr <= 8.0 + 1e-6, f"{fr}")
        check("codec=h264", st["codec_name"] == "h264", st["codec_name"])
    check("single plan: segment_counts_video null", d.get("segment_counts_video") is None)
    check("single plan: max_len_video null", d.get("max_len_video") is None)

    print("== video.mp4 dual plan (--max-len-video 3) ==")
    d, dual_outdir = run_cli(FX / "video.mp4", "--max-len-video", "3", "--segment-videos")
    check("max_len_video=3.0", d.get("max_len_video") == 3.0, str(d.get("max_len_video")))
    check("dual: segment_counts_video set", d.get("segment_counts_video") is not None)
    vids = [r for r in d["results"] if r["type"] == "video_segment"]
    auds = [r for r in d["results"] if r["type"] == "audio_segment"]
    check("dual: has video+audio segments", bool(vids) and bool(auds))
    # Full 4s coverage with each clip <= 3s forces at least two video clips.
    check("dual: video split into >=2 clips", len(vids) >= 2, str(len(vids)))
    check(
        "dual: video clips <= 3s",
        all(r["duration_s"] <= 3.0 + 1e-3 for r in vids),
        str([r["duration_s"] for r in vids]),
    )
    starts = [r.get("start_s", r.get("timestamp_s", 0.0)) for r in d["results"]]
    check("dual: results chronological", starts == sorted(starts), str(starts))
    for r in vids:
        probe_video(dual_outdir / r["video_file"])  # raises if undecodable
    check("dual: video clips decodable", True)

    print("== audio.wav ==")
    d, _ = run_cli(FX / "audio.wav")
    types = [r["type"] for r in d["results"]]
    check("media_type=audio", d["media_type"] == "audio")
    check("has audio_segment", "audio_segment" in types)
    check("no video_segment", "video_segment" not in types)
    check("preprocessing disabled", d["preprocessing"].get("enabled") is False)

    print("== audio_only.webm (must NOT be video) ==")
    d, _ = run_cli(FX / "audio_only.webm")
    check("webm classified audio", d["media_type"] == "audio", d["media_type"])

    print("== image.png ==")
    d, _ = run_cli(FX / "image.png")
    imgs = [r for r in d["results"] if r["type"] == "image"]
    check("media_type=image", d["media_type"] == "image")
    check("exactly one image result", len(imgs) == 1, str(len(imgs)))

    print()
    if FAILURES:
        print(f"CONTAINER TESTS FAILED: {FAILURES}")
        sys.exit(1)
    print("CONTAINER TESTS PASSED")


if __name__ == "__main__":
    main()
