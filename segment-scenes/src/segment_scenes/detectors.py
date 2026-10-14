from __future__ import annotations
import numpy as np
import av
import torch
import subprocess
import sys
import os
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from typing import Dict, Any, Tuple

from transnetv2_pytorch import TransNetV2
import math

from .ffmpeg_backend import FFmpegBackend, FFmpegOperationError
from .vram import reset_peak, peak_stats


# Constants for max-len recursive splitting
THRESHOLD_FLOOR = 0.01
THRESHOLD_DECAY = 0.8

# Encoding/extraction defaults — kept here so cli.py and detectors.py share a single
# source of truth. They target the downstream video-LLM backends and can be overridden
# per request via the CLI options / API fields.
DEFAULT_OUTPUT_FPS = 1
DEFAULT_OUTPUT_MAX_HEIGHT_PX = 448
DEFAULT_KEYFRAME_MAX_WIDTH_PX = 640


def _scene_worker_count() -> int:
    """Bounded parallelism for per-scene FFmpeg child processes.

    FFmpeg does the heavy work in subprocesses, so threads are cheap and do not
    multiply Torch/model memory. Overridable via SEGMENT_SCENES_CUT_WORKERS.
    """
    raw = os.environ.get("SEGMENT_SCENES_CUT_WORKERS", "").strip()
    if raw:
        try:
            return max(1, int(raw))
        except ValueError:
            pass
    return min(8, os.cpu_count() or 1)


def _validate_length_constraints(
    min_len: float,
    max_len: float | None,
    quiet: bool = False
) -> bool:
    """
    Early validation of constraint feasibility.
    
    Returns True if constraints are satisfiable, False with warning otherwise.
    """
    if max_len is None:
        return True
    
    if max_len <= min_len:
        if not quiet:
            print(f"[segment-scenes] WARNING: max_len ({max_len}s) <= min_len ({min_len}s). "
                  f"No valid scene length exists. Ignoring max_len constraint.", file=sys.stderr)
        return False
    
    if max_len < 2 * min_len:
        if not quiet:
            print(f"[segment-scenes] WARNING: max_len ({max_len}s) < 2*min_len ({2*min_len}s). "
                  f"Some scenes may be unsplittable without violating min_len.", file=sys.stderr)
    
    return True


def _calculate_threshold_for_attempt(initial_threshold: float, attempt: int) -> float:
    """
    Calculate threshold for a given attempt number.
    
    attempt=1 is the first retry (after initial detection failed to split enough).
    Formula: new_threshold = initial_threshold * 0.8^attempt
    Floor: 0.01 to prevent infinite attempts.
    """
    new_threshold = initial_threshold * (THRESHOLD_DECAY ** attempt)
    return max(new_threshold, THRESHOLD_FLOOR)


def _max_threshold_attempts(initial_threshold: float) -> int:
    """
    Compute how many attempts until we hit the threshold floor.
    
    Solves: initial * 0.8^n <= floor
    n >= log(floor/initial) / log(0.8)
    """
    if initial_threshold <= THRESHOLD_FLOOR:
        return 1
    ratio = THRESHOLD_FLOOR / initial_threshold
    attempts = math.ceil(math.log(ratio) / math.log(THRESHOLD_DECAY))
    return max(attempts, 1)


def _select_boundaries_with_min_len(
    prob: np.ndarray,
    pts_s: np.ndarray,
    threshold: float,
    min_len: float,
    scene_start_idx: int,
    scene_end_idx: int
) -> list[int]:
    """
    Select cut boundaries within a scene slice, enforcing min_len spacing.
    
    Greedily accepts cuts only if they're at least min_len from the last accepted cut
    and ensure the remaining segment is also at least min_len.
    """
    slice_prob = prob[scene_start_idx:scene_end_idx + 1]
    slice_pts = pts_s[scene_start_idx:scene_end_idx + 1]
    
    # Find candidate cut points (local maxima above threshold)
    candidates = []
    for i in range(1, len(slice_prob) - 1):
        if slice_prob[i] > threshold and slice_prob[i] >= slice_prob[i-1] and slice_prob[i] >= slice_prob[i+1]:
            candidates.append(i)
    
    if not candidates:
        return []
    
    # Greedily select cuts respecting min_len spacing
    accepted_cuts = []
    last_cut_time = slice_pts[0]  # Start of scene
    
    for cut_idx in candidates:
        cut_time = slice_pts[cut_idx]
        if cut_time - last_cut_time >= min_len:
            # Also check if remaining segment would be >= min_len
            remaining = slice_pts[-1] - cut_time
            if remaining >= min_len:
                accepted_cuts.append(scene_start_idx + cut_idx)
                last_cut_time = cut_time
    
    return accepted_cuts


def _merge_short_segments(
    scenes: list[dict],
    min_len: float
) -> list[dict]:
    """
    Merge any segments shorter than min_len into their neighbors.
    Strategy: merge into the previous scene if available, otherwise next.
    """
    if len(scenes) <= 1:
        return scenes
    
    merged = []
    i = 0
    while i < len(scenes):
        scene = scenes[i].copy()
        
        # If this scene is too short, merge with neighbor
        if scene["duration_s"] < min_len and len(merged) > 0:
            # Merge into previous scene
            merged[-1]["end_frame"] = scene["end_frame"]
            merged[-1]["end_time"] = scene["end_time"]
            merged[-1]["end_ms"] = scene["end_ms"]
            merged[-1]["duration_s"] = round(merged[-1]["end_time"] - merged[-1]["start_time"], 6)
            merged[-1]["ffmpeg_duration"] = f"{merged[-1]['duration_s']:.6f}"
        elif scene["duration_s"] < min_len and i < len(scenes) - 1:
            # Merge into next scene (will be handled in next iteration)
            scenes[i + 1]["start_frame"] = scene["start_frame"]
            scenes[i + 1]["start_time"] = scene["start_time"]
            scenes[i + 1]["start_ms"] = scene["start_ms"]
            scenes[i + 1]["duration_s"] = round(scenes[i + 1]["end_time"] - scene["start_time"], 6)
            scenes[i + 1]["ffmpeg_start"] = scene["ffmpeg_start"]
            scenes[i + 1]["ffmpeg_duration"] = f"{scenes[i + 1]['duration_s']:.6f}"
        else:
            merged.append(scene)
        
        i += 1
    
    # Re-assign shot_ids
    for idx, scene in enumerate(merged):
        scene["shot_id"] = idx
    
    return merged


def _build_scenes_from_cuts(
    pts_s: np.ndarray,
    prob: np.ndarray,
    start_idx: int,
    end_idx: int,
    cut_indices: list[int],
    base_shot_id: int
) -> list[dict]:
    """
    Build scene dictionaries from cut indices.
    """
    all_boundaries = [start_idx] + cut_indices + [end_idx]
    sub_scenes = []
    
    for i in range(len(all_boundaries) - 1):
        s = all_boundaries[i]
        e = all_boundaries[i + 1]
        t0, t1 = float(pts_s[s]), float(pts_s[e])
        
        sub_scenes.append({
            "shot_id": base_shot_id * 100 + i,  # Temporary ID, will be reassigned
            "start_frame": int(s),
            "end_frame": int(e),
            "start_ms": int(round(t0 * 1000.0)),
            "end_ms": int(round(t1 * 1000.0)),
            "start_time": round(t0, 6),
            "end_time": round(t1, 6),
            "duration_s": round(t1 - t0, 6),
            "cut_prob_max": float(prob[s:e+1].max()),
            "cut_prob_mean": float(prob[s:e+1].mean()),
            "ffmpeg_start": f"{t0:.6f}",
            "ffmpeg_duration": f"{t1 - t0:.6f}",
        })
    
    return sub_scenes


def _force_split_at_max_len(
    pts_s: np.ndarray,
    prob: np.ndarray,
    scene: dict,
    max_len: float,
    min_len: float,
    quiet: bool = False
) -> list[dict]:
    """
    Force split a scene at max_len intervals when no natural boundaries are found.
    
    This is the fallback when threshold-based detection fails. Creates hard splits
    at max_len intervals to guarantee the constraint is satisfied.
    
    Algorithm:
    1. Calculate how many segments we need: ceil(duration / max_len)
    2. Distribute the duration evenly across segments
    3. Ensure each segment >= min_len (if possible)
    """
    scene_start_idx = scene["start_frame"]
    scene_end_idx = scene["end_frame"]
    start_time = scene["start_time"]
    end_time = scene["end_time"]
    duration = scene["duration_s"]
    
    # Calculate number of segments needed
    num_segments = int(np.ceil(duration / max_len))
    
    # Ensure we have at least 2 segments (otherwise why are we here?)
    if num_segments < 2:
        num_segments = 2
    
    # Calculate segment duration - distribute evenly
    segment_duration = duration / num_segments
    
    # If segments would be too short, reduce number of segments
    while segment_duration < min_len and num_segments > 2:
        num_segments -= 1
        segment_duration = duration / num_segments
    
    # Build the forced splits
    sub_scenes = []
    fps = (scene_end_idx - scene_start_idx) / duration if duration > 0 else 25.0
    
    for i in range(num_segments):
        seg_start_time = start_time + i * segment_duration
        seg_end_time = start_time + (i + 1) * segment_duration
        
        # Last segment should end exactly at scene end
        if i == num_segments - 1:
            seg_end_time = end_time
        
        # Calculate frame indices
        seg_start_frame = scene_start_idx + int((seg_start_time - start_time) * fps)
        seg_end_frame = scene_start_idx + int((seg_end_time - start_time) * fps)
        
        # Clamp to valid range
        seg_start_frame = max(scene_start_idx, min(seg_start_frame, scene_end_idx))
        seg_end_frame = max(seg_start_frame + 1, min(seg_end_frame, scene_end_idx))
        
        seg_duration = seg_end_time - seg_start_time
        
        sub_scenes.append({
            "shot_id": scene["shot_id"] * 100 + i,  # Temporary ID
            "start_frame": int(seg_start_frame),
            "end_frame": int(seg_end_frame),
            "start_ms": int(round(seg_start_time * 1000.0)),
            "end_ms": int(round(seg_end_time * 1000.0)),
            "start_time": round(seg_start_time, 6),
            "end_time": round(seg_end_time, 6),
            "duration_s": round(seg_duration, 6),
            "cut_prob_max": float(prob[seg_start_frame:seg_end_frame+1].max()) if seg_end_frame > seg_start_frame else 0.0,
            "cut_prob_mean": float(prob[seg_start_frame:seg_end_frame+1].mean()) if seg_end_frame > seg_start_frame else 0.0,
            "ffmpeg_start": f"{seg_start_time:.6f}",
            "ffmpeg_duration": f"{seg_duration:.6f}",
            "forced_split": True,  # Mark as forced split
        })
    
    if not quiet:
        print(f"[segment-scenes] Force-split scene {scene['shot_id']} ({duration:.2f}s) "
              f"into {num_segments} segments of ~{segment_duration:.2f}s each", file=sys.stderr)
    
    return sub_scenes


def _split_long_scenes(
    prob: np.ndarray,
    pts_s: np.ndarray,
    scenes: list[dict],
    max_len: float,
    min_len: float,
    initial_threshold: float,
    quiet: bool = False,
    max_recursion_depth: int = 10,
    current_depth: int = 0
) -> list[dict]:
    """
    Recursively split scenes that exceed max_len.
    
    Two separate limits:
    - max_threshold_attempts: computed from initial_threshold to floor (monotonic descent)
    - max_recursion_depth: limits nesting when sub-scenes also exceed max_len
    """
    if current_depth >= max_recursion_depth:
        if not quiet:
            print(f"[segment-scenes] Max recursion depth ({max_recursion_depth}) reached. "
                  f"Some scenes may exceed max_len.", file=sys.stderr)
        return scenes
    
    max_attempts = _max_threshold_attempts(initial_threshold)
    result_scenes = []
    any_split_occurred = False
    
    for scene in scenes:
        scene_duration = scene["duration_s"]
        
        if scene_duration <= max_len:
            result_scenes.append(scene)
            continue
        
        # This scene exceeds max_len - try to split it
        scene_start_idx = scene["start_frame"]
        scene_end_idx = scene["end_frame"]
        split_success = False
        
        # Check if splitting is even theoretically possible
        if scene_duration < 2 * min_len:
            if not quiet:
                print(f"[segment-scenes] Scene {scene['shot_id']} ({scene_duration:.2f}s) cannot be split: "
                      f"duration < 2*min_len ({2*min_len:.2f}s). Keeping as-is.", file=sys.stderr)
            result_scenes.append(scene)
            continue
        
        for attempt in range(1, max_attempts + 1):
            attempt_threshold = _calculate_threshold_for_attempt(initial_threshold, attempt)
            
            # Find boundaries with min_len enforcement
            cut_indices = _select_boundaries_with_min_len(
                prob, pts_s, attempt_threshold, min_len,
                scene_start_idx, scene_end_idx
            )
            
            if len(cut_indices) >= 1:
                # Build sub-scenes from cuts
                sub_scenes = _build_scenes_from_cuts(
                    pts_s, prob,
                    scene_start_idx, scene_end_idx,
                    cut_indices,
                    base_shot_id=scene["shot_id"]
                )
                
                if len(sub_scenes) >= 2:
                    if not quiet:
                        print(f"[segment-scenes] Split scene {scene['shot_id']} ({scene_duration:.2f}s) "
                              f"into {len(sub_scenes)} sub-scenes at threshold {attempt_threshold:.4f} "
                              f"(attempt {attempt})", file=sys.stderr)
                    result_scenes.extend(sub_scenes)
                    split_success = True
                    any_split_occurred = True
                    break
        
        if not split_success:
            # Fallback: force split at max_len intervals to guarantee constraint
            forced_sub_scenes = _force_split_at_max_len(
                pts_s, prob, scene, max_len, min_len, quiet
            )
            result_scenes.extend(forced_sub_scenes)
            any_split_occurred = True
    
    # Re-assign shot_ids for consistency
    for idx, scene in enumerate(result_scenes):
        scene["shot_id"] = idx
    
    # If any splits occurred, recursively check if new sub-scenes also exceed max_len
    if any_split_occurred:
        result_scenes = _split_long_scenes(
            prob, pts_s, result_scenes,
            max_len, min_len, initial_threshold,
            quiet, max_recursion_depth, current_depth + 1
        )
    
    # Final merge pass to clean up any sub-min segments
    result_scenes = _merge_short_segments(result_scenes, min_len)
    
    return result_scenes




def _extract_keyframes_only(path: Path) -> Tuple[np.ndarray, np.ndarray, np.ndarray]:
    """
    Extract only keyframes to dramatically reduce CPU usage and memory consumption.
    Returns (keyframes, pts_seconds, frame_indices_in_original_video).
    """
    container = av.open(str(path))
    stream = container.streams.video[0]
    tb = stream.time_base

    keyframes, keyframe_pts, original_indices = [], [], []
    frame_idx = 0
    
    try:
        for f in container.decode(stream):
            # Only process keyframes to keep CPU usage and memory low
            if f.key_frame:
                if f.pts is not None:
                    t = float(f.pts * tb)
                else:
                    t = float(f.time) if f.time is not None else 0.0
                
                # Convert only keyframes to numpy array (much less CPU intensive)
                frame_rgb = f.to_ndarray(format="rgb24")
                keyframes.append(frame_rgb)
                keyframe_pts.append(t)
                original_indices.append(frame_idx)
            
            frame_idx += 1
    finally:
        container.close()
    
    if not keyframes:
        raise ValueError("No keyframes found in video")
    
    return (
        np.asarray(keyframes, dtype=np.uint8),
        np.asarray(keyframe_pts, dtype=np.float64),
        np.asarray(original_indices, dtype=np.int32)
    )


def _pick_scenes(prob: np.ndarray,
                 pts_s: np.ndarray,
                 thr: float,
                 min_len_s: float) -> tuple[list[dict], list[int]]:
    """
    Build scenes and boundary indices from per-frame probabilities and PTS.
    Derives a percentile-based adaptive threshold when the requested threshold is
    high, and falls back to local-maxima peak detection when no transitions are found.
    """
    p = np.asarray(prob, dtype=np.float32)
    
    # Calculate adaptive threshold if needed
    adaptive_thr = thr
    if thr > 0.1:  # Only adapt if threshold is high
        # Try percentile-based adaptive threshold
        p95 = np.percentile(p, 95)
        p90 = np.percentile(p, 90)
        p75 = np.percentile(p, 75)
        
        # Use a more reasonable threshold based on data distribution
        if p95 > thr:
            adaptive_thr = max(p75, 0.01)  # Use 75th percentile but at least 0.01
        elif p90 > 0.1:
            adaptive_thr = max(p75 * 2, 0.01)
        else:
            adaptive_thr = max(np.mean(p) + 2 * np.std(p), 0.001)
    
    # Find peaks using the official TransNetV2 approach
    # Convert to binary predictions first
    predictions_binary = (p > adaptive_thr).astype(np.uint8)
    
    # Find transitions from 0 to 1 (scene boundaries)
    cut_idx = []
    for i in range(1, len(predictions_binary)):
        if predictions_binary[i-1] == 0 and predictions_binary[i] == 1:
            cut_idx.append(i)
    
    # If no cuts found with adaptive threshold, try simple peak detection
    if len(cut_idx) == 0:
        # Find local maxima above threshold
        peaks = (p > adaptive_thr)
        for i in range(1, len(p) - 1):
            if peaks[i] and p[i] > p[i-1] and p[i] > p[i+1]:
                cut_idx.append(i)
    
    starts = [0] + cut_idx
    ends   = cut_idx + [len(pts_s) - 1]

    scenes = []
    sid = 0
    for s, e in zip(starts, ends):
        t0, t1 = float(pts_s[s]), float(pts_s[e])
        if (t1 - t0) + 1e-9 < min_len_s:
            continue
        scenes.append({
            "shot_id": sid,
            "start_frame": int(s),
            "end_frame": int(e),
            "start_ms": int(round(t0 * 1000.0)),
            "end_ms":   int(round(t1 * 1000.0)),
            "start_time": round(t0, 6),  # Precise timing for ffmpeg cutting
            "end_time":   round(t1, 6),  # Precise timing for ffmpeg cutting
            "duration_s": round(t1 - t0, 6),  # Duration for convenience
            "cut_prob_max": float(p[s:e+1].max()),
            "cut_prob_mean": float(p[s:e+1].mean()),
            # FFmpeg command ready values
            "ffmpeg_start": f"{t0:.6f}",  # Ready to use with -ss
            "ffmpeg_duration": f"{t1 - t0:.6f}",  # Ready to use with -t
        })
        sid += 1

    return scenes, cut_idx


def _nearest_prev_kf_ms(cut_idx: list[int],
                        pts_s: np.ndarray,
                        is_kf: np.ndarray) -> list[float]:
    """
    For each boundary index, return the preceding keyframe timestamp in ms.
    """
    kf_idx = np.nonzero(is_kf)[0]
    out = []
    for c in cut_idx:
        kfpos = kf_idx[kf_idx <= c]
        if len(kfpos) == 0:
            out.append(0.0)
        else:
            out.append(float(pts_s[kfpos[-1]] * 1000.0))
    return out


def run_scene_detection(video_path: Path,
                        threshold: float = 0.5,
                        min_len: float = 0.5,
                        max_len: float | None = None,
                        device: str = "auto",
                        quiet: bool = False,
                        chunk_size: int = 1000,
                        fps: float = DEFAULT_OUTPUT_FPS,
                        max_width_px: int = DEFAULT_KEYFRAME_MAX_WIDTH_PX,
                        max_height_px: int = DEFAULT_OUTPUT_MAX_HEIGHT_PX,
                        model: Any | None = None,
                        model_device: str | None = None,
                        ffmpeg_backend: FFmpegBackend | None = None) -> Dict[str, Any]:
    """
    Memory-efficient scene detection using chunked processing.
    Processes the video in chunks to avoid loading it entirely into memory.

    fps / max_width_px / max_height_px are not used by detection itself but are echoed in
    the emitted JSON so downstream consumers know the encoding contract for the produced
    segments and keyframes.
    """
    # Baseline peak VRAM counters so the reported high-water mark reflects this
    # detection run. Resetting while a persistent model is resident retains its
    # current allocation as the new baseline.
    reset_peak()

    output_fps = fps
    if model is None:
        model = TransNetV2(device=device)
        model.eval()
    inference_device = model_device or str(getattr(model, "device", device))
    backend = ffmpeg_backend or FFmpegBackend()
    
    if not quiet:
        print(f"[segment-scenes] Processing video: {video_path.name}", file=sys.stderr)
        if torch.cuda.is_available():
            print(f"[segment-scenes] GPU memory before: {torch.cuda.memory_allocated() / 1e9:.2f} GB", file=sys.stderr)
    
    # Decode every frame to the 48x27 RGB stream TransNetV2 expects, asking FFmpeg
    # to use NVDEC when this input codec/GPU combination supports it.
    try:
        video_info = backend.probe_video(video_path)
        source_fps = video_info.fps
        video_stream, decode_result = backend.extract_detection_frames(video_path)
        frame_bytes = 27 * 48 * 3
        if len(video_stream) % frame_bytes:
            raise FFmpegOperationError(
                f"Raw frame pipe returned {len(video_stream)} bytes, not divisible by {frame_bytes}"
            )
        frames = np.frombuffer(video_stream, np.uint8).reshape([-1, 27, 48, 3])
        total_frames = frames.shape[0]
        if total_frames == 0:
            raise FFmpegOperationError("FFmpeg returned zero decoded video frames")
        
        if not quiet:
            print(f"[segment-scenes] Total frames: {total_frames}, Processing in chunks of: {chunk_size}", file=sys.stderr)
        
        # Generate timestamps for frames
        pts_s = np.arange(total_frames) / source_fps
    except FFmpegOperationError:
        # Fall back to PyAV keyframe-only extraction for unusual inputs.
        if not quiet:
            print("[segment-scenes] FFmpeg frame extraction failed; using PyAV keyframe fallback", file=sys.stderr)
        frames, pts_s, _original_indices = _extract_keyframes_only(video_path)
        total_frames = len(frames)
        source_fps = float(total_frames / max(float(pts_s[-1]), 1e-9)) if total_frames > 1 else 0.0
        decode_result = None
    
    # Process frames in chunks to avoid OOM
    all_single_preds = []
    
    if not quiet:
        print(f"[segment-scenes] Running TransNetV2 prediction on {total_frames} frames in chunks of {chunk_size}", file=sys.stderr)
    
    inference_context = getattr(torch, "inference_mode", torch.no_grad)
    with inference_context():
        for start_idx in range(0, total_frames, chunk_size):
            end_idx = min(start_idx + chunk_size, total_frames)
            chunk_frames = frames[start_idx:end_idx]
            
            if not quiet:
                chunk_num = start_idx // chunk_size + 1
                total_chunks = (total_frames - 1) // chunk_size + 1
                print(f"[segment-scenes] Processing chunk {chunk_num}/{total_chunks} "
                      f"(frames {start_idx}-{end_idx-1})", file=sys.stderr)
            
            try:
                # Convert numpy chunk to PyTorch tensor with correct shape and dtype
                # Input should be [B, T, H, W, 3] with dtype uint8
                # np.frombuffer is read-only; make one bounded writable copy per
                # chunk before exposing it to Torch.
                video_torch = torch.from_numpy(np.array(chunk_frames, copy=True)).unsqueeze(0)
                video_torch = video_torch.to(inference_device)
                
                # Call model directly (returns single_frame_pred, {"many_hot": all_frame_pred})
                single_frame_pred, all_frame_pred = model(video_torch)
                
                # Extract single frame predictions and apply sigmoid
                single_pred_cpu = torch.sigmoid(single_frame_pred).cpu().numpy()
                single_pred_squeezed = single_pred_cpu.squeeze(axis=0)  # Remove batch dim only (keeps time dim for single-frame chunks)
                
                all_single_preds.append(single_pred_squeezed)
                
                # Let the CUDA caching allocator reuse buffers across chunks;
                # empty_cache() here would slow the loop down.
                del video_torch, single_frame_pred, all_frame_pred
                    
            except torch.cuda.OutOfMemoryError as e:
                if not quiet:
                    print(f"[segment-scenes] OOM error in chunk {chunk_num}. Try reducing chunk_size.", file=sys.stderr)
                    if torch.cuda.is_available():
                        print(f"[segment-scenes] Current GPU memory: {torch.cuda.memory_allocated() / 1e9:.2f} GB", file=sys.stderr)
                raise e
    
    # Concatenate all predictions
    prob = np.concatenate(all_single_preds, axis=0)

    
    # All-frame decode: treat every frame as a keyframe
    is_kf = np.ones(len(pts_s), dtype=bool)
    
    # Add some debug info about probability distribution
    if not quiet:
        prob_stats = {
            'min': float(prob.min()),
            'max': float(prob.max()),
            'mean': float(prob.mean()),
            'std': float(prob.std()),
            'p95': float(np.percentile(prob, 95)),
            'p90': float(np.percentile(prob, 90)),
            'p75': float(np.percentile(prob, 75))
        }
        print(f"[segment-scenes] Probability stats: {prob_stats}", file=sys.stderr)
        print(f"[segment-scenes] Using threshold: {threshold}", file=sys.stderr)
    
    scenes, cut_idx = _pick_scenes(prob, pts_s, threshold, min_len)
    
    # Apply max_len constraint with recursive splitting if provided
    if max_len is not None and _validate_length_constraints(min_len, max_len, quiet):
        scenes = _split_long_scenes(
            prob=prob,
            pts_s=pts_s,
            scenes=scenes,
            max_len=max_len,
            min_len=min_len,
            initial_threshold=threshold,
            quiet=quiet
        )
        # Update cut_idx based on new scene boundaries
        cut_idx = [s["start_frame"] for s in scenes[1:]]  # All scene starts except first
    
    pred_times_s = [float(pts_s[i]) for i in cut_idx]
    kf_prev_ms = _nearest_prev_kf_ms(cut_idx, pts_s, is_kf)
    
    if not quiet:
        print(f"[segment-scenes] Found {len(cut_idx)} scene boundaries, {len(scenes)} valid scenes", file=sys.stderr)

    gpu_stats = peak_stats()
    if not quiet and gpu_stats.get("available"):
        print(
            f"[segment-scenes] Peak VRAM: {gpu_stats['peak_allocated_mb']} MB allocated / "
            f"{gpu_stats['peak_reserved_mb']} MB reserved "
            f"(of {gpu_stats['total_mb']} MB total, {gpu_stats['peak_utilization_pct']}%)",
            file=sys.stderr,
        )

    payload = {
        "video": {
            "path": str(video_path),
            "num_frames": total_frames,
            "duration_ms": int(round(float(pts_s[-1] * 1000.0))) if len(pts_s) else 0,
            "source_fps": source_fps,
        },
        "model": {
            "name": "TransNetV2",
            "impl": "transnetv2-pytorch",
            "threshold": threshold,
            "min_len_sec": min_len,
            "max_len_sec": max_len,
        },
        "encoding": {
            # Keep integer rates as ints in the JSON contract (1, not 1.0);
            # fractional rates (0.5/0.25) serialize as floats.
            "fps": int(output_fps) if float(output_fps).is_integer() else output_fps,
            "max_width_px": max_width_px,
            "max_height_px": max_height_px,
        },
        "decoding": {
            "mode": decode_result.mode if decode_result is not None else "PyAV keyframe fallback",
            "used_nvdec": decode_result.used_nvdec if decode_result is not None else False,
        },
        "shots": scenes,
        "boundaries": {
            "predicted_ms": [int(round(t * 1000.0)) for t in pred_times_s],
            "keyframe_prev_ms": [int(round(ms)) for ms in kf_prev_ms],
            "predicted_s": [round(t, 6) for t in pred_times_s],  # Precise timing for ffmpeg cutting
            "keyframe_prev_s": [round(ms / 1000.0, 6) for ms in kf_prev_ms],  # Precise timing for ffmpeg cutting
        },
    }
    payload["gpu_stats"] = gpu_stats
    return payload


def create_scene_visualization(frames: np.ndarray, predictions: np.ndarray, output_path: Path) -> None:
    """
    Create a visualization PNG showing frames with scene detection predictions.
    Based on the official TransNetV2 visualize_predictions method.
    """
    try:
        from PIL import Image, ImageDraw
    except ImportError:
        print("[segment-scenes] Warning: PIL not available, skipping visualization", file=sys.stderr)
        return

    if isinstance(predictions, np.ndarray):
        predictions = [predictions]

    ih, iw, ic = frames.shape[1:]
    width = 25

    # pad frames so that length of the video is divisible by width
    # pad frames also by len(predictions) pixels in width in order to show predictions
    pad_with = width - len(frames) % width if len(frames) % width != 0 else 0
    frames = np.pad(frames, [(0, pad_with), (0, 1), (0, len(predictions)), (0, 0)])

    predictions = [np.pad(x, (0, pad_with)) for x in predictions]
    height = len(frames) // width

    img = frames.reshape([height, width, ih + 1, iw + len(predictions), ic])
    img = np.concatenate(np.split(
        np.concatenate(np.split(img, height), axis=2)[0], width
    ), axis=2)[0, :-1]

    img = Image.fromarray(img)
    draw = ImageDraw.Draw(img)

    # iterate over all frames
    for i, pred in enumerate(zip(*predictions)):
        x, y = i % width, i // width
        x, y = x * (iw + len(predictions)) + iw, y * (ih + 1) + ih - 1

        # we can visualize multiple predictions per single frame
        for j, p in enumerate(pred):
            color = [0, 0, 0]
            color[(j + 1) % 3] = 255

            value = round(p * (ih - 1))
            if value != 0:
                draw.line((x + j, y, x + j, y - value), fill=tuple(color), width=1)
    
    # Ensure output directory exists
    output_path.parent.mkdir(parents=True, exist_ok=True)
    img.save(output_path)


def get_video_keyframes(video_path: Path, quiet: bool = False) -> list:
    """
    DEPRECATED: unused; detection decodes all frames, so keyframe timestamps are not needed.

    Efficiently detect keyframe timestamps by analyzing first 30 seconds and extrapolating pattern,
    or scanning full video if needed.
    """
    try:
        # First, get total video duration
        cmd_duration = [
            "ffprobe", "-hide_banner", "-loglevel", "error",
            "-show_entries", "format=duration", "-of", "csv=p=0",
            str(video_path)
        ]
        
        duration_result = subprocess.run(cmd_duration, capture_output=True, text=True, timeout=10)
        total_duration = 0.0
        
        if duration_result.returncode == 0 and duration_result.stdout.strip():
            total_duration = float(duration_result.stdout.strip())
            if not quiet:
                print(f"[segment-scenes] Video duration: {total_duration:.1f}s", file=sys.stderr)
        else:
            if not quiet:
                print("[segment-scenes] Could not determine video duration", file=sys.stderr)
            return []
        
        # Method 1: Analyze first 30 seconds to detect keyframe pattern
        if not quiet:
            print("[segment-scenes] Analyzing keyframe pattern from first 30 seconds...", file=sys.stderr)
        
        sample_duration = min(30.0, total_duration)
        cmd_sample = [
            "ffmpeg", "-hide_banner", "-loglevel", "info",
            "-t", str(sample_duration),  # Only analyze first 30 seconds
            "-i", str(video_path),
            "-vf", "select='eq(pict_type,I)',showinfo",
            "-f", "null", "-"
        ]
        
        sample_result = subprocess.run(cmd_sample, capture_output=True, text=True, timeout=60)
        
        if sample_result.returncode == 0:
            sample_keyframes = []
            import re  
            for line in sample_result.stderr.split('\n'):
                if 'showinfo' in line and 'pts_time:' in line:
                    try:
                        match = re.search(r'pts_time:(\d+\.?\d*)', line)
                        if match:
                            timestamp = float(match.group(1))
                            sample_keyframes.append(timestamp)
                    except Exception:
                        continue
            
            sample_keyframes = sorted(list(set(sample_keyframes)))
            
            if len(sample_keyframes) >= 2:
                # Calculate keyframe interval pattern
                intervals = [sample_keyframes[i+1] - sample_keyframes[i] for i in range(len(sample_keyframes)-1)]
                avg_interval = sum(intervals) / len(intervals)
                
                # Check if intervals are consistent (regular GOP)
                interval_variance = sum((i - avg_interval) ** 2 for i in intervals) / len(intervals)
                is_regular = interval_variance < 0.1  # Low variance = regular pattern
                
                if is_regular and avg_interval > 0:
                    # Extrapolate regular keyframe pattern to full video
                    keyframe_times = []
                    current_time = 0.0
                    while current_time <= total_duration:
                        keyframe_times.append(current_time)
                        current_time += avg_interval
                    
                    if not quiet:
                        print(f"[segment-scenes] Regular GOP detected: {avg_interval:.2f}s interval, extrapolated {len(keyframe_times)} keyframes", file=sys.stderr)
                    
                    return keyframe_times
                else:
                    # Irregular pattern - need to scan full video
                    if not quiet:
                        print("[segment-scenes] Irregular keyframe pattern detected, scanning full video...", file=sys.stderr)
                    
                    cmd_full = [
                        "ffmpeg", "-hide_banner", "-loglevel", "info",
                        "-i", str(video_path),
                        "-vf", "select='eq(pict_type,I)',showinfo",
                        "-f", "null", "-"
                    ]
                    
                    # For irregular patterns, give more time but still reasonable
                    timeout_seconds = min(600, max(60, total_duration * 2))  # 2x video duration, max 10 minutes
                    
                    full_result = subprocess.run(cmd_full, capture_output=True, text=True, timeout=timeout_seconds)
                    
                    if full_result.returncode == 0:
                        full_keyframes = []
                        for line in full_result.stderr.split('\n'):
                            if 'showinfo' in line and 'pts_time:' in line:
                                try:
                                    match = re.search(r'pts_time:(\d+\.?\d*)', line)
                                    if match:
                                        timestamp = float(match.group(1))
                                        full_keyframes.append(timestamp)
                                except Exception:
                                    continue
                        
                        full_keyframes = sorted(list(set(full_keyframes)))
                        
                        if full_keyframes:
                            if not quiet:
                                print(f"[segment-scenes] Detected {len(full_keyframes)} actual keyframes from full video", file=sys.stderr)
                            return full_keyframes
        
        # Method 2: Fallback to estimated GOP pattern
        if not quiet:
            print("[segment-scenes] Using estimated GOP pattern (2.0s intervals)...", file=sys.stderr)
        
        keyframe_times = []
        current_time = 0.0
        gop_interval = 2.0  # Common GOP size
        
        while current_time <= total_duration:
            keyframe_times.append(current_time)
            current_time += gop_interval
        
        if not quiet:
            print(f"[segment-scenes] Estimated {len(keyframe_times)} keyframes", file=sys.stderr)
        
        return keyframe_times
        
    except subprocess.TimeoutExpired:
        if not quiet:
            print("[segment-scenes] Keyframe detection timed out, using estimated pattern", file=sys.stderr)
        
        # Use estimated pattern based on duration
        if total_duration > 0:
            return [float(i) for i in range(0, int(total_duration) + 1, 2)]
        else:
            return [float(i) for i in range(0, 120, 2)]  # 2 minutes fallback
            
    except Exception as e:
        if not quiet:
            print(f"[segment-scenes] Warning: Error detecting keyframes: {e}", file=sys.stderr)
        return []


def find_nearest_keyframe_after(keyframe_times: list, scene_start: float) -> float:
    """
    DEPRECATED: unused; kept with get_video_keyframes.

    Find the nearest keyframe timestamp that comes after the scene start time.
    If no keyframe exists after scene_start, return the scene_start + small offset.
    """
    if not keyframe_times:
        return scene_start + 0.1  # Fallback to small offset
    
    # Find first keyframe after scene start
    for kf_time in keyframe_times:
        if kf_time >= scene_start:
            return kf_time
    
    # If no keyframe found after scene start, use the last keyframe or fallback
    return keyframe_times[-1] if keyframe_times else scene_start + 0.1


def find_last_keyframe_before(keyframe_times: list, scene_end: float) -> float:
    """
    DEPRECATED: unused; kept with get_video_keyframes.

    Find the last keyframe timestamp that comes before the scene end time.
    This ensures clean cuts at actual keyframe boundaries.
    """
    if not keyframe_times:
        return scene_end - 0.1  # Fallback to small offset before
    
    # Find last keyframe before scene end
    valid_keyframes = [kf for kf in keyframe_times if kf < scene_end]
    
    if valid_keyframes:
        return valid_keyframes[-1]  # Last valid keyframe
    else:
        # No keyframe before scene end, use first available keyframe or fallback
        return keyframe_times[0] if keyframe_times else scene_end - 0.1


def extract_scene_keyframe_pngs(
    video_path: Path,
    scenes: list,
    file_hash: str,
    output_dir: Path,
    quiet: bool = False,
    max_width_px: int = DEFAULT_KEYFRAME_MAX_WIDTH_PX,
    ffmpeg_backend: FFmpegBackend | None = None,
) -> list:
    """
    Extract one PNG keyframe per scene.
    Saves them in scene_keyframes/{index}_{start_time}_{stop_time}.png format.
    Uses small offset into the scene to capture scene content rather than transition frame.

    `max_width_px` caps the output width so keyframes stay within the image-token budget
    of the downstream vision model; height is scaled proportionally (scale=-2 semantics
    require an even height, hence the explicit :max_width_px form).
    """
    scene_keyframes_dir = output_dir / "scene_keyframes"
    scene_keyframes_dir.mkdir(parents=True, exist_ok=True)
    backend = ffmpeg_backend or FFmpegBackend()

    def _extract_one(scene) -> dict | None:
        start_s = scene["start_time"]
        end_s = scene["end_time"]
        shot_id = scene["shot_id"]

        # Add small offset to capture first frame of scene content rather than transition frame
        keyframe_time = start_s + 0.2  # Move 200ms into the scene

        # Ensure we don't go past the scene end
        if keyframe_time >= end_s:
            keyframe_time = start_s + (end_s - start_s) * 0.1  # Use 10% into the scene

        # Create filename in format: {index}_{start_time}_{stop_time}.png
        keyframe_filename = f"{shot_id:03d}_{start_s:.3f}_{end_s:.3f}.png"
        keyframe_path = scene_keyframes_dir / keyframe_filename

        try:
            acceleration = backend.extract_image_frame(
                video_path,
                keyframe_path,
                timestamp=keyframe_time,
                max_width=max_width_px,
            )
            if not quiet:
                print(
                    f"[segment-scenes] Extracted scene keyframe {shot_id:03d} at {keyframe_time:.3f}s "
                    f"(200ms offset, max_width={max_width_px}px, {acceleration.mode}) -> {keyframe_filename}",
                    file=sys.stderr,
                )
            return {
                "type": "scene_keyframe",
                "shot_id": shot_id,
                "start_time_s": start_s,
                "end_time_s": end_s,
                "keyframe_time_s": keyframe_time,
                "file_hash": file_hash,
                "keyframe_file": str(keyframe_path.relative_to(output_dir)),
                "extraction_method": "scene_content_offset",
                "offset_ms": 200,
                "max_width_px": max_width_px,
                "acceleration": {
                    "mode": acceleration.mode,
                    "used_nvdec": acceleration.used_nvdec,
                },
            }
        except Exception as e:
            if not quiet:
                print(f"[segment-scenes] Warning: Error extracting keyframe for scene {shot_id}: {e}", file=sys.stderr)
            return None

    workers = _scene_worker_count()
    if workers == 1 or len(scenes) <= 1:
        results = [_extract_one(scene) for scene in scenes]
    else:
        # executor.map preserves scene order regardless of completion order.
        with ThreadPoolExecutor(max_workers=workers) as executor:
            results = list(executor.map(_extract_one, scenes))
    return [entry for entry in results if entry is not None]


def _get_optimal_codec(video_path: Path) -> tuple[str, str, str]:
    """
    Determine optimal codec and settings for web browser compatibility.
    Returns (encoder, decoder, bitrate) tuple.
    Uses H.264 for maximum browser compatibility across all platforms.
    """
    ext = video_path.suffix.lower()
    
    # Always use H.264 for maximum browser compatibility
    # H.264 has universal browser support unlike HEVC which has limited support
    if ext in {'.mp4', '.mkv', '.m4v', '.avi', '.mov', '.webm', '.flv'}:
        return ("libx264", "software", "1M")
    
    # For transport streams, use H.264 with higher bitrate
    elif ext in {'.ts', '.m2ts'}:
        return ("libx264", "software", "1.5M")
    
    # Default to H.264 for everything else (including MPG/MPEG)
    else:
        return ("libx264", "software", "1M")


def cut_scene_segments(
    video_path: Path,
    scenes: list,
    file_hash: str,
    output_dir: Path,
    quiet: bool = False,
    fps: float = DEFAULT_OUTPUT_FPS,
    max_height_px: int = DEFAULT_OUTPUT_MAX_HEIGHT_PX,
    ffmpeg_backend: FFmpegBackend | None = None,
) -> list:
    """
    Cut the video into individual scene segments using TransNetV2 predictions with sharp boundaries.
    Saves them in scenes/{index}_{start_time}_{end_time}.mp4 format.
    Uses H.264 encoding with web-optimized settings for maximum browser compatibility.
    Normalizes video to the configured fps / max_height_px with a consistent GOP structure
    for vLLM compatibility (defaults: 1fps / 448p; fractional fps such as 0.5 = 1 frame/2s
    is allowed). GOP size is derived from fps (max(1, round(fps*2)), i.e. one keyframe
    every 2 seconds at the 1fps default).

    Scenes are cut concurrently in FFmpeg child processes (bounded thread pool);
    the returned manifest list preserves scene order regardless of completion order.
    """
    scenes_dir = output_dir / "scenes"
    scenes_dir.mkdir(parents=True, exist_ok=True)
    backend = ffmpeg_backend or FFmpegBackend()
    # Codec/bitrate depend only on the input container, so resolve them once.
    _legacy_encoder, _decoder, bitrate = _get_optimal_codec(video_path)

    def _cut_one(i: int, scene) -> dict | None:
        start_s = scene["start_time"]
        shot_id = scene["shot_id"]

        # Start 100ms later to avoid transition frames
        adjusted_start_s = start_s + 0.1

        # Calculate sharp end time with 100ms buffer before next scene
        if i < len(scenes) - 1:
            # Use the start of the next scene minus 100ms buffer for sharp cuts
            next_scene_start = scenes[i + 1]["start_time"]
            actual_end_s = next_scene_start - 0.1  # 100ms buffer before next scene
        else:
            # Last scene: use the original end time minus 100ms
            actual_end_s = scene["end_time"] - 0.1

        # Ensure end is after start (minimum scene duration)
        if actual_end_s <= adjusted_start_s:
            actual_end_s = adjusted_start_s + 0.5  # Minimum 0.5 second scene

        # Create filename in format: {index}_{start_time}_{end_time}.mp4
        scene_filename = f"{shot_id:03d}_{adjusted_start_s:.3f}_{actual_end_s:.3f}.mp4"
        scene_path = scenes_dir / scene_filename

        try:
            acceleration = backend.cut_scene(
                video_path,
                scene_path,
                start=adjusted_start_s,
                end=actual_end_s,
                fps=fps,
                max_height=max_height_px,
                bitrate=bitrate,
            )
            if not quiet:
                print(
                    f"[segment-scenes] Cut scene segment {shot_id:03d}: "
                    f"{adjusted_start_s:.3f}s - {actual_end_s:.3f}s "
                    f"({acceleration.mode}, {fps:g}fps, max {max_height_px}p, {bitrate}) -> {scene_filename}",
                    file=sys.stderr,
                )
            return {
                "type": "scene_segment",
                "shot_id": shot_id,
                "raw_start_time_s": start_s,
                "adjusted_start_time_s": adjusted_start_s,
                "end_time_s": actual_end_s,
                "duration_s": actual_end_s - adjusted_start_s,
                "file_hash": file_hash,
                "scene_file": str(scene_path.relative_to(output_dir)),
                "extraction_method": "hardware_encoding" if acceleration.used_nvenc else "software_encoding",
                "start_offset_ms": 100,
                "end_buffer_ms": 100,
                # Keep integer rates as ints in the JSON contract (1, not 1.0).
                "fps": int(fps) if float(fps).is_integer() else fps,
                "max_height_px": max_height_px,
                "bitrate": bitrate,
                "acceleration": {
                    "mode": acceleration.mode,
                    "encoder": acceleration.encoder,
                    "used_nvdec": acceleration.used_nvdec,
                    "used_nvenc": acceleration.used_nvenc,
                },
            }
        except Exception as e:
            if not quiet:
                print(f"[segment-scenes] Warning: Error cutting scene {shot_id}: {e}", file=sys.stderr)
            return None

    workers = _scene_worker_count()
    if workers == 1 or len(scenes) <= 1:
        results = [_cut_one(i, scene) for i, scene in enumerate(scenes)]
    else:
        # executor.map preserves scene order regardless of completion order.
        with ThreadPoolExecutor(max_workers=workers) as executor:
            results = list(executor.map(lambda pair: _cut_one(*pair), enumerate(scenes)))
    return [entry for entry in results if entry is not None]


def extract_scene_keyframes(
    video_path: Path,
    scenes: list,
    file_hash: str,
    output_dir: Path,
    quiet: bool = False,
    max_width_px: int = DEFAULT_KEYFRAME_MAX_WIDTH_PX,
    ffmpeg_backend: FFmpegBackend | None = None,
) -> list:
    """
    DEPRECATED: superseded by extract_scene_keyframe_pngs; kept for the
    --extract-keyframes compatibility flag.

    Extract keyframes at scene boundaries and save them to organized folders.
    `max_width_px` caps the output width (height scales proportionally).
    """
    keyframes_dir = output_dir / "scene_change_keyframes"
    keyframes_dir.mkdir(parents=True, exist_ok=True)
    backend = ffmpeg_backend or FFmpegBackend()

    def _extract_one(scene) -> dict | None:
        start_s = scene["start_time"]
        end_s = scene["end_time"]
        shot_id = scene["shot_id"]

        # Extract keyframe at scene start
        keyframe_filename = f"{shot_id:03d}_{start_s:.3f}_{end_s:.3f}_scene_{file_hash}.jpg"
        keyframe_path = keyframes_dir / keyframe_filename

        try:
            acceleration = backend.extract_image_frame(
                video_path,
                keyframe_path,
                timestamp=start_s,
                max_width=max_width_px,
                jpeg=True,
            )
            if not quiet:
                print(
                    f"[segment-scenes] Extracted keyframe for scene {shot_id} at {start_s:.3f}s "
                    f"({acceleration.mode})",
                    file=sys.stderr,
                )
            return {
                "type": "keyframe",
                "shot_id": shot_id,
                "timestamp_s": start_s,
                "end_timestamp_s": end_s,
                "file_hash": file_hash,
                "keyframe_file": str(keyframe_path.relative_to(output_dir)),
                "extraction_method": "scene_boundary",
                "acceleration": {
                    "mode": acceleration.mode,
                    "used_nvdec": acceleration.used_nvdec,
                },
            }
        except Exception as e:
            if not quiet:
                print(f"[segment-scenes] Warning: Error extracting keyframe for scene {shot_id}: {e}", file=sys.stderr)
            return None

    workers = _scene_worker_count()
    if workers == 1 or len(scenes) <= 1:
        results = [_extract_one(scene) for scene in scenes]
    else:
        # executor.map preserves scene order regardless of completion order.
        with ThreadPoolExecutor(max_workers=workers) as executor:
            results = list(executor.map(_extract_one, scenes))
    return [entry for entry in results if entry is not None]
