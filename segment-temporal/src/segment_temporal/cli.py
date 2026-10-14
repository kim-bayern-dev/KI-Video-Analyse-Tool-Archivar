from __future__ import annotations

import hashlib
import json
import re
import shutil
import subprocess
import sys
from dataclasses import dataclass
from pathlib import Path
from typing import List, Literal, Optional, Tuple
from concurrent.futures import ThreadPoolExecutor, as_completed
from multiprocessing import cpu_count
from functools import lru_cache

import click
import numpy as np
from .media import MediaProbeError, probe_media
from .preprocess import PreprocessConfig, PreprocessError, preprocess_video

# Type alias for split reason
SplitReason = Literal["none", "max_len", "speech_pause", "speech_fallback"]


@lru_cache(maxsize=1)
def _load_librosa():
    """Lazy-load librosa so import time and memory stay low until music detection runs."""
    import librosa

    return librosa


@lru_cache(maxsize=1)
def _silero_vad_class():
    """Lazy-load the Silero wrapper (pulls in Torch) only when VAD is actually needed."""
    from .detectors_silero import SileroVAD

    return SileroVAD

@dataclass
class Segment:
    """Represents an audio/video segment with metadata."""
    index: int
    start_s: float
    end_s: float
    segment_type: str
    split_reason: SplitReason = "none"
    
    @property
    def duration(self) -> float:
        return self.end_s - self.start_s

def _get_file_hash(path: Path) -> str:
    """Generate short hash from file path and size"""
    stat = path.stat()
    data = f"{path.name}_{stat.st_size}_{stat.st_mtime}".encode()
    return hashlib.sha256(data).hexdigest()[:8]

def _strip_input_prefix(path: Path) -> str:
    """Strip /input/ prefix from path for cleaner JSON output"""
    path_str = str(path)
    if path_str.startswith('/input/'):
        return path_str[7:]  # Remove '/input/' (7 characters)
    return path_str

def _read_audio_ffmpeg(path: Path, sr: int) -> Tuple[np.ndarray, float]:
    cmd = [
        "ffmpeg", "-hide_banner", "-loglevel", "error",
        "-i", str(path),
        "-ac", "1", "-ar", str(sr), "-f", "f32le", "pipe:1",
    ]
    raw = subprocess.check_output(cmd)
    y = np.frombuffer(raw, dtype=np.float32)
    return y, len(y) / float(sr)

def _export_audio_segment(inp: Path, out: Path, start_s: float, end_s: float) -> None:
    cmd = [
        "ffmpeg", "-nostdin", "-hide_banner", "-loglevel", "error", "-y",
        "-ss", f"{start_s:.6f}",
        "-to", f"{end_s:.6f}",
        "-i", str(inp),
        "-vn",
        "-threads", "1",
        "-c:a", "libmp3lame", "-q:a", "2",
        str(out),
    ]
    subprocess.run(cmd, check=True)


def _export_video_segment(inp: Path, out: Path, start_s: float, end_s: float) -> None:
    """Stream-copy a segment from the normalized processing video."""
    cmd = [
        "ffmpeg", "-nostdin", "-hide_banner", "-loglevel", "error", "-y",
        "-ss", f"{start_s:.6f}",
        "-to", f"{end_s:.6f}",
        "-i", str(inp),
        "-map", "0:v:0",
        "-map", "0:a:0?",
        "-c", "copy",
        "-avoid_negative_ts", "make_zero",
        str(out),
    ]
    subprocess.run(cmd, check=True)


def _extract_frame(inp: Path, out: Path, timestamp_s: float) -> bool:
    """Extract one portable JPEG frame using CPU decode.

    One FFmpeg process per keyframe: per-process CUDA init costs more than
    decoding a single frame, so this path is CPU-only by design.
    """
    command = [
        "ffmpeg", "-nostdin", "-hide_banner", "-loglevel", "error", "-y",
        "-ss", f"{timestamp_s:.6f}",
        "-i", str(inp),
        "-map", "0:v:0",
        "-frames:v",
        "1",
        "-an",
        "-vf", "scale=w='min(iw,640)':h=-2:flags=area",
        "-threads", "1",
        "-q:v", "3",
        str(out),
    ]
    completed = subprocess.run(command, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    if completed.returncode == 0 and out.is_file() and out.stat().st_size > 0:
        return True
    out.unlink(missing_ok=True)
    return False


def _normalize_image(inp: Path, out: Path) -> None:
    command = [
        "ffmpeg", "-nostdin", "-hide_banner", "-loglevel", "error", "-y",
        "-i", str(inp),
        "-map", "0:v:0",
        "-frames:v", "1",
        "-an",
        "-vf", "scale=w='min(iw,1920)':h=-2:flags=lanczos",
        "-q:v", "2",
        str(out),
    ]
    subprocess.run(command, check=True)

def _extract_scene_keyframes(inp: Path, keyframes_dir: Path, start_s: float, end_s: float, scene_threshold: float, segment_idx: int, file_hash: str):
    """Extract keyframes at scene changes using FFmpeg's scene detection"""
    keyframes_dir.mkdir(exist_ok=True)
    
    # First, detect scene changes and get timestamps
    cmd = [
        "ffmpeg", "-nostdin", "-hide_banner", "-loglevel", "info",
        "-threads", "1", "-filter_threads", "1",
        "-ss", f"{start_s:.6f}",
        "-to", f"{end_s:.6f}",
        "-i", str(inp),
        "-vf", f"select='gt(scene,{scene_threshold})',showinfo",
        "-f", "null", "-"
    ]
    
    result = subprocess.run(cmd, capture_output=True, text=True)
    
    # Parse scene change timestamps from showinfo output
    scene_times = []
    for line in result.stderr.split('\n'):
        if 'pts_time:' in line:
            try:
                # Extract pts_time value
                match = re.search(r'pts_time:(\d+\.?\d*)', line)
                if match:
                    pts_time = float(match.group(1))
                    absolute_time = start_s + pts_time
                    scene_times.append(absolute_time)
            except Exception:
                continue
    
    # Add first frame if no scenes detected or first scene is not at start
    if not scene_times or (scene_times and scene_times[0] > start_s + 0.5):
        scene_times.insert(0, start_s)
    
    # Extract keyframes at detected scene changes
    keyframes = []
    for timestamp in scene_times:
        if timestamp >= end_s:
            break
            
        timestamp_name = f"{segment_idx:03d}_{timestamp:.3f}_scene.jpg"
        final_path = keyframes_dir / timestamp_name
        
        if _extract_frame(inp, final_path, timestamp):
            keyframes.append({
                "type": "keyframe",
                "segment_index": segment_idx,
                "timestamp_s": timestamp,
                "file_hash": file_hash,
                "keyframe_file": _strip_input_prefix(final_path),
                "extraction_method": "scene_change"
            })
    
    return keyframes

def _extract_keyframes_time(inp: Path, keyframes_dir: Path, start_s: float, end_s: float, nth_second: int, segment_idx: int, file_hash: str):
    """Extract keyframes from video segment every nth second"""
    keyframes_dir.mkdir(exist_ok=True)
    
    keyframes = []
    current_time = start_s
    
    # Extract one frame every nth_second
    while current_time < end_s:
        timestamp_name = f"{segment_idx:03d}_{current_time:.3f}_time.jpg"
        final_path = keyframes_dir / timestamp_name
        
        if _extract_frame(inp, final_path, current_time):
            keyframes.append({
                "type": "keyframe",
                "segment_index": segment_idx,
                "timestamp_s": current_time,
                "file_hash": file_hash,
                "keyframe_file": _strip_input_prefix(final_path),
                "extraction_method": "time_based"
            })
        
        current_time += nth_second
    
    return keyframes

def _extract_hybrid_keyframes(inp: Path, keyframes_dir: Path, start_s: float, end_s: float, nth_second: int, scene_threshold: float, segment_idx: int, file_hash: str):
    """Smart hybrid: extract keyframes on scene changes + motion, but debounce by nth_second"""
    keyframes_dir.mkdir(exist_ok=True)
    
    # First pass: detect all scene changes and motion events
    cmd = [
        "ffmpeg", "-nostdin", "-hide_banner", "-loglevel", "info",
        "-threads", "1", "-filter_threads", "1",
        "-ss", f"{start_s:.6f}",
        "-to", f"{end_s:.6f}",
        "-i", str(inp),
        "-vf", f"select='gt(scene,{scene_threshold})+gt(scene,0.1)',showinfo",  # Scene changes + motion
        "-f", "null", "-"
    ]
    
    result = subprocess.run(cmd, capture_output=True, text=True)
    
    # Parse all potential keyframe timestamps
    event_times = []
    for line in result.stderr.split('\n'):
        if 'pts_time:' in line and 'scene:' in line:
            try:
                # Extract pts_time and scene score
                pts_match = re.search(r'pts_time:(\d+\.?\d*)', line)
                scene_match = re.search(r'scene:(\d+\.?\d*)', line)
                
                if pts_match and scene_match:
                    pts_time = float(pts_match.group(1))
                    scene_score = float(scene_match.group(1))
                    absolute_time = start_s + pts_time
                    
                    # Categorize the event
                    if scene_score > scene_threshold:
                        event_type = "scene_change"
                    elif scene_score > 0.1:  # Motion but not major scene change
                        event_type = "motion"
                    else:
                        continue
                        
                    event_times.append((absolute_time, event_type))
            except Exception:
                continue
    
    # Add first frame if no events detected early
    if not event_times or (event_times and event_times[0][0] > start_s + 0.5):
        event_times.insert(0, (start_s, "segment_start"))
    
    # Sort by timestamp
    event_times.sort(key=lambda x: x[0])
    
    # Apply debouncing: only extract keyframes if nth_second has passed since last extraction
    keyframes = []
    last_keyframe_time = None
    
    for timestamp, event_type in event_times:
        if timestamp >= end_s:
            break
            
        # Debounce: skip if less than nth_second since last keyframe
        if last_keyframe_time is not None and (timestamp - last_keyframe_time) < nth_second:
            continue
            
        # Extract keyframe
        if event_type == "scene_change":
            timestamp_name = f"{segment_idx:03d}_{timestamp:.3f}_scene.jpg"
            method = "scene_change"
        elif event_type == "motion":
            timestamp_name = f"{segment_idx:03d}_{timestamp:.3f}_motion.jpg"
            method = "motion"
        else:  # segment_start
            timestamp_name = f"{segment_idx:03d}_{timestamp:.3f}.jpg"
            method = "segment_start"
            
        final_path = keyframes_dir / timestamp_name
        
        if _extract_frame(inp, final_path, timestamp):
            keyframes.append({
                "type": "keyframe",
                "segment_index": segment_idx,
                "timestamp_s": timestamp,
                "file_hash": file_hash,
                "keyframe_file": _strip_input_prefix(final_path),
                "extraction_method": method,
                "event_type": event_type
            })
            last_keyframe_time = timestamp  # Update debounce timer
    
    return keyframes

def _normalize_planned_segments(
    segments: List[Tuple[int, float, float, str]],
    duration: float,
    min_duration: float,
) -> List[Tuple[int, float, float, str]]:
    """Clip, fill, coalesce, and merge short intervals while preserving full coverage."""
    if duration <= 0:
        return []

    ordered = sorted(segments, key=lambda item: (item[1], item[2]))
    covered: list[tuple[float, float, str]] = []
    cursor = 0.0

    for _, raw_start, raw_end, segment_type in ordered:
        start = min(max(float(raw_start), 0.0), duration)
        end = min(max(float(raw_end), 0.0), duration)
        if end <= start:
            continue

        if start > cursor + 1e-6:
            covered.append((cursor, start, "non_speech"))
        start = max(start, cursor)
        if end <= start:
            continue
        covered.append((start, end, segment_type))
        cursor = end

    if cursor < duration - 1e-6:
        covered.append((cursor, duration, "non_speech"))
    if not covered:
        covered = [(0.0, duration, "non_speech")]

    coalesced: list[list[object]] = []
    for start, end, segment_type in covered:
        if coalesced and coalesced[-1][2] == segment_type and abs(float(coalesced[-1][1]) - start) <= 1e-6:
            coalesced[-1][1] = end
        else:
            coalesced.append([start, end, segment_type])

    # Short islands are absorbed into neighbours. For alternating labels, both
    # neighbours normally share a type, so all three can be merged losslessly in time.
    while len(coalesced) > 1:
        short_index = next(
            (
                index
                for index, (start, end, _) in enumerate(coalesced)
                if float(end) - float(start) < min_duration
            ),
            None,
        )
        if short_index is None:
            break

        if short_index == 0:
            coalesced[1][0] = coalesced[0][0]
            del coalesced[0]
        elif short_index == len(coalesced) - 1:
            coalesced[-2][1] = coalesced[-1][1]
            del coalesced[-1]
        else:
            left = coalesced[short_index - 1]
            right = coalesced[short_index + 1]
            if left[2] == right[2]:
                left[1] = right[1]
                del coalesced[short_index:short_index + 2]
            else:
                left_duration = float(left[1]) - float(left[0])
                right_duration = float(right[1]) - float(right[0])
                if left_duration >= right_duration:
                    left[1] = coalesced[short_index][1]
                    del coalesced[short_index]
                else:
                    right[0] = coalesced[short_index][0]
                    del coalesced[short_index]

        # A merge can make adjacent labels equal.
        merged: list[list[object]] = []
        for item in coalesced:
            if merged and merged[-1][2] == item[2] and abs(float(merged[-1][1]) - float(item[0])) <= 1e-6:
                merged[-1][1] = item[1]
            else:
                merged.append(item)
        coalesced = merged

    normalized = [
        (index, float(start), float(end), str(segment_type))
        for index, (start, end, segment_type) in enumerate(coalesced, 1)
    ]

    if abs(normalized[0][1]) > 1e-6 or abs(normalized[-1][2] - duration) > 1e-4:
        raise RuntimeError("Internal segmentation coverage invariant failed")
    for previous, current in zip(normalized, normalized[1:]):
        if abs(previous[2] - current[1]) > 1e-4:
            raise RuntimeError("Internal segmentation continuity invariant failed")
    return normalized


def _create_all_segments(
    speech_intervals: List[Tuple[float, float]],
    duration: float,
    min_duration: float,
    verbose: bool = False,
) -> List[Tuple[int, float, float, str]]:
    """Create complete speech/non-speech coverage from possibly noisy VAD intervals."""
    clipped = sorted(
        (
            max(0.0, float(start)),
            min(duration, float(end)),
        )
        for start, end in speech_intervals
        if float(end) > 0 and float(start) < duration and float(end) > float(start)
    )

    merged_speech: list[list[float]] = []
    for start, end in clipped:
        if merged_speech and start <= merged_speech[-1][1] + 1e-6:
            merged_speech[-1][1] = max(merged_speech[-1][1], end)
        else:
            merged_speech.append([start, end])

    raw: List[Tuple[int, float, float, str]] = []
    cursor = 0.0
    for start, end in merged_speech:
        if start > cursor:
            raw.append((0, cursor, start, "non_speech"))
        raw.append((0, max(cursor, start), end, "speech"))
        cursor = max(cursor, end)
    if cursor < duration:
        raw.append((0, cursor, duration, "non_speech"))

    normalized = _normalize_planned_segments(raw, duration, min_duration)
    if verbose:
        print(f"\nInput: {duration:.1f}-second media", file=sys.stderr)
        print(f"VAD detects speech: {speech_intervals}", file=sys.stderr)
        print("\nPlanned segments:", file=sys.stderr)
        for index, start, end, segment_type in normalized:
            print(f"{index:03d}: {start:.3f} -> {end:.3f} ({segment_type})", file=sys.stderr)
        print("", file=sys.stderr)
    return normalized

def _process_segment_with_type(args):
    """Process a single segment (audio + video + keyframes) with speech type info"""
    # audio_source = ORIGINAL media (best fidelity for VAD + MP3 export, avoids the
    # original->AAC->MP3 double lossy encode); video_source = normalized working copy
    # (fast decode/scene/keyframes). They are identical when preprocessing is disabled.
    (audio_source, segment_idx, start_s, end_s, file_hash, out_dir, is_video,
     keyframes_dir, keyframe_method, keyframe_nth, scene_threshold, segment_type, split_reason, has_audio,
     video_source, export_video) = args

    results = []

    try:
        # Export audio segment with type in filename (skip if no audio stream)
        if has_audio:
            audio_name = f"{segment_idx:03d}_{start_s:.3f}_{end_s:.3f}_{segment_type}_{file_hash}.mp3"
            audio_path = out_dir / audio_name

            _export_audio_segment(audio_source, audio_path, start_s, end_s)
            
            results.append({
                "type": "audio_segment",
                "index": segment_idx,
                "start_s": start_s,
                "end_s": end_s,
                "duration_s": end_s - start_s,
                "file_hash": file_hash,
                "segment_type": segment_type,
                "split_reason": split_reason,
                "audio_file": _strip_input_prefix(audio_path)
            })
        
        # Export video segment and keyframes only for video files. The mp4 export
        # itself is opt-in (--segment-videos, or forced when the source has no
        # audio stream); keyframes are always extracted from the working copy.
        if is_video:
            if export_video:
                video_name = f"{segment_idx:03d}_{start_s:.3f}_{end_s:.3f}_{segment_type}_{file_hash}.mp4"
                video_path = out_dir / video_name

                _export_video_segment(video_source, video_path, start_s, end_s)

                results.append({
                    "type": "video_segment",
                    "index": segment_idx,
                    "start_s": start_s,
                    "end_s": end_s,
                    "duration_s": end_s - start_s,
                    "file_hash": file_hash,
                    "segment_type": segment_type,
                    "split_reason": split_reason,
                    "video_file": _strip_input_prefix(video_path)
                })
            
            # Extract keyframes from the normalized working copy (fast decode).
            if keyframe_method == "time":
                keyframes = _extract_keyframes_time(video_source, keyframes_dir, start_s, end_s, keyframe_nth, segment_idx, file_hash)
            elif keyframe_method == "scene":
                keyframes = _extract_scene_keyframes(video_source, keyframes_dir, start_s, end_s, scene_threshold, segment_idx, file_hash)
            else:  # hybrid
                keyframes = _extract_hybrid_keyframes(video_source, keyframes_dir, start_s, end_s, keyframe_nth, scene_threshold, segment_idx, file_hash)
            
            # Add segment_type and split_reason to keyframes
            for kf in keyframes:
                kf["segment_type"] = segment_type
                kf["split_reason"] = split_reason
                
            results.extend(keyframes)
        
        return results, None  # success
        
    except Exception as e:
        return [], f"Error processing segment {segment_idx}: {str(e)}"

def _analyze_non_speech_segment(y: np.ndarray, sr: int, start_s: float, end_s: float) -> str:
    """Analyze a non-speech segment to classify it as 'silence' or 'music'"""
    librosa = _load_librosa()
    
    # Extract the segment from the audio
    start_sample = int(start_s * sr)
    end_sample = int(end_s * sr)
    segment_audio = y[start_sample:end_sample]
    
    if len(segment_audio) == 0:
        return "silence"
    
    # Method 1: RMS Energy Analysis
    rms_energy = librosa.feature.rms(y=segment_audio)[0]
    avg_energy = np.mean(rms_energy)
    
    # Method 2: Spectral Features
    spectral_centroids = librosa.feature.spectral_centroid(y=segment_audio, sr=sr)[0]
    avg_spectral_centroid = np.mean(spectral_centroids)
    
    # Method 3: Spectral Rolloff
    spectral_rolloff = librosa.feature.spectral_rolloff(y=segment_audio, sr=sr)[0]
    avg_rolloff = np.mean(spectral_rolloff)
    
    # Classification thresholds (tunable)
    silence_energy_threshold = 0.001  # Very low energy = silence
    music_energy_threshold = 0.01     # Higher energy = likely music
    
    # Decision logic
    if avg_energy < silence_energy_threshold:
        return "silence"
    elif (avg_energy > music_energy_threshold and 
          avg_spectral_centroid > 1000 and  # Music tends to have higher spectral centroid
          avg_rolloff > 2000):               # Music has more frequency content
        return "music"
    else:
        # Ambiguous case - could be ambient sound, noise, etc.
        return "ambient"

def _segment_non_speech_with_librosa(y: np.ndarray, sr: int, start_s: float, end_s: float, min_duration: float, verbose: bool = False) -> List[Tuple[float, float, str]]:
    """Use librosa to detect sub-segments within a non-speech segment"""
    librosa = _load_librosa()
    
    # Extract the segment from the audio
    start_sample = int(start_s * sr)
    end_sample = int(end_s * sr)
    segment_audio = y[start_sample:end_sample]
    
    if len(segment_audio) == 0:
        return [(start_s, end_s, "silence")]
    
    # Use librosa's onset detection to find potential segment boundaries
    onset_frames = librosa.onset.onset_detect(
        y=segment_audio, 
        sr=sr, 
        hop_length=512, 
        backtrack=True,
        units='time'
    )
    
    # Convert onset times to absolute timestamps
    onset_times = [start_s + t for t in onset_frames]
    
    # Add segment boundaries
    boundary_times = [start_s] + onset_times + [end_s]
    boundary_times = sorted(list(set(boundary_times)))  # Remove duplicates and sort
    
    # Create sub-segments between boundaries
    sub_segments = []
    for i in range(len(boundary_times) - 1):
        sub_start = boundary_times[i]
        sub_end = boundary_times[i + 1]
        sub_duration = sub_end - sub_start
        
        # Only keep segments that meet minimum duration
        if sub_duration >= min_duration:
            # Classify this sub-segment
            sub_type = _classify_audio_subsegment(y, sr, sub_start, sub_end)
            sub_segments.append((sub_start, sub_end, sub_type))
        elif i == 0 and len(sub_segments) == 0:
            # If first segment is too short, merge with next
            continue
        elif len(sub_segments) > 0:
            # Merge short segment with previous one
            prev_start, _, _ = sub_segments[-1]
            merged_type = _classify_audio_subsegment(y, sr, prev_start, sub_end)
            sub_segments[-1] = (prev_start, sub_end, merged_type)
    
    # If no valid sub-segments found, return the whole segment as one
    if not sub_segments:
        segment_type = _classify_audio_subsegment(y, sr, start_s, end_s)
        sub_segments = [(start_s, end_s, segment_type)]
    
    if verbose:
        print(f"    Librosa sub-segmentation: {len(onset_frames)} onsets -> {len(sub_segments)} sub-segments", file=sys.stderr)
    
    return sub_segments

def _classify_audio_subsegment(y: np.ndarray, sr: int, start_s: float, end_s: float) -> str:
    """Simple classification: silence, noise, harmonic, or ambient - with tone color analysis"""
    librosa = _load_librosa()
    
    # Extract the subsegment
    start_sample = int(start_s * sr)
    end_sample = int(end_s * sr)
    segment_audio = y[start_sample:end_sample]
    
    if len(segment_audio) == 0 or len(segment_audio) < sr * 0.5:  # Less than 0.5 seconds
        return "silence"
    
    # Basic energy analysis
    rms_energy = librosa.feature.rms(y=segment_audio, hop_length=512)[0]
    avg_energy = np.mean(rms_energy)
    
    # Early silence detection
    silence_energy_threshold = 0.001
    if avg_energy < silence_energy_threshold:
        return "silence"
    
    try:
        # Check for harmonic content first
        has_harmonic, tone_color = _analyze_harmonic_and_tone_color(segment_audio, sr)
        
        if has_harmonic:
            # Further classify harmonic content by tone color
            if tone_color == "musical":
                return "harmonic"  # Rich harmonic content with musical characteristics
            elif tone_color == "speech_like":
                return "ambient"  # Speech-like harmonics (could be distant speech, TV, etc.)
            else:
                return "harmonic"  # Generic harmonic content
        else:
            return "noise"  # No harmonic structure = noise
            
    except Exception:
        # If analysis fails, default to noise (conservative)
        return "noise" if avg_energy > 0.001 else "silence"

def _analyze_harmonic_and_tone_color(audio: np.ndarray, sr: int) -> tuple[bool, str]:
    """Analyze harmonic content and classify tone color - lightweight approach"""
    try:
        # 1. Basic harmonic detection (reuse existing logic)
        fft = np.abs(np.fft.rfft(audio))
        freqs = np.fft.rfftfreq(len(audio), 1/sr)
        
        # Find peaks in spectrum
        from scipy.signal import find_peaks
        peaks, _ = find_peaks(fft, height=np.max(fft) * 0.3, distance=10)
        
        if len(peaks) < 3:  # Need at least 3 clear peaks for harmonic content
            return False, "none"
        
        # Check if peaks are in harmonic frequency range
        peak_freqs = freqs[peaks]
        harmonic_peaks = np.sum((peak_freqs >= 80) & (peak_freqs <= 3000))
        
        if harmonic_peaks < 3:
            return False, "none"
        
        # 2. TONE COLOR ANALYSIS - Simple spectral shape characteristics
        
        # Get the strongest peaks for analysis
        peak_powers = fft[peaks]
        sorted_indices = np.argsort(peak_powers)[::-1]
        top_peak_freqs = peak_freqs[sorted_indices[:5]]  # Top 5 peaks
        
        # A) Musical instruments vs speech/vocal characteristics
        fundamental_freq = top_peak_freqs[0]
        
        # B) Spectral centroid - musical instruments vs speech have different distributions
        spectral_centroid = np.sum(freqs * fft) / np.sum(fft)
        
        # C) Spectral bandwidth - how spread out the frequencies are
        spectral_bandwidth = np.sqrt(np.sum(((freqs - spectral_centroid) ** 2) * fft) / np.sum(fft))
        
        # D) High frequency content ratio
        high_freq_energy = np.sum(fft[freqs > 2000])
        total_energy = np.sum(fft)
        high_freq_ratio = high_freq_energy / total_energy if total_energy > 0 else 0
        
        # Musical characteristics:
        # - Clear fundamental in musical range (80-800Hz)
        # - Moderate spectral centroid (not too high, not too low)
        # - Rich harmonic content but not too much high-frequency noise
        
        is_musical_fundamental = 80 <= fundamental_freq <= 800
        is_musical_centroid = 200 <= spectral_centroid <= 2000
        has_balanced_spectrum = 0.1 <= high_freq_ratio <= 0.4  # Not too dull, not too harsh
        has_moderate_bandwidth = spectral_bandwidth < 1000  # Not too spread out
        
        # Speech-like characteristics:
        # - Higher spectral centroid (speech has more high-frequency content)
        # - Wider bandwidth (formants spread across spectrum)
        # - Different fundamental frequency patterns
        
        is_speech_centroid = spectral_centroid > 1500
        has_wide_bandwidth = spectral_bandwidth > 800
        
        # Decision logic for tone color
        musical_score = sum([
            is_musical_fundamental,
            is_musical_centroid, 
            has_balanced_spectrum,
            has_moderate_bandwidth
        ])
        
        speech_score = sum([
            is_speech_centroid,
            has_wide_bandwidth
        ])
        
        if musical_score >= 3:
            tone_color = "musical"
        elif speech_score >= 1 and musical_score < 2:
            tone_color = "speech_like"
        else:
            tone_color = "generic"
            
        return True, tone_color
        
    except Exception:
        return False, "none"

def _consolidate_consecutive_segments(segments: List[Tuple[int, float, float, str]]) -> List[Tuple[int, float, float, str]]:
    """Join consecutive segments with the same label"""
    
    if not segments:
        return segments
    
    consolidated = []
    _, current_start, current_end, current_type = segments[0]
    
    for next_idx, next_start, next_end, next_type in segments[1:]:
        if next_type == current_type and abs(next_start - current_end) < 0.1:  # Same type and consecutive
            # Extend current segment
            current_end = next_end
        else:
            # Different type or gap - finalize current segment
            consolidated.append((len(consolidated) + 1, current_start, current_end, current_type))
            current_start, current_end, current_type = next_start, next_end, next_type
    
    # Add the final segment
    consolidated.append((len(consolidated) + 1, current_start, current_end, current_type))
    
    return consolidated

def _refine_and_split_non_speech_segments(
    segments: List[Tuple[int, float, float, str]], 
    y: np.ndarray, 
    sr: int, 
    min_duration: float,
    verbose: bool = False
) -> List[Tuple[int, float, float, str]]:
    """Refine non-speech segments using librosa segmentation and classification"""
    
    refined_segments = []
    
    if verbose:
        print("Refining non-speech segments with librosa segmentation...", file=sys.stderr)
    
    for segment_idx, start_s, end_s, segment_type in segments:
        if segment_type == "speech":
            # Keep speech segments as-is
            refined_segments.append((segment_idx, start_s, end_s, segment_type))
        else:
            # Analyze and potentially split non-speech segment
            if verbose:
                print(f"  Analyzing segment {segment_idx:03d}: {start_s:.3f} -> {end_s:.3f}", file=sys.stderr)
            
            sub_segments = _segment_non_speech_with_librosa(y, sr, start_s, end_s, min_duration, verbose)
            
            # Add each sub-segment (will be re-indexed after consolidation)
            for sub_start, sub_end, sub_type in sub_segments:
                refined_segments.append((0, sub_start, sub_end, sub_type))  # Temporary index
    
    # Sort by start time
    refined_segments.sort(key=lambda x: x[1])
    
    # Consolidate consecutive segments with same labels
    if verbose:
        print("Consolidating consecutive segments with same labels...", file=sys.stderr)
        pre_consolidation_count = len(refined_segments)
    
    consolidated_segments = _consolidate_consecutive_segments(refined_segments)
    
    if verbose:
        post_consolidation_count = len(consolidated_segments)
        print(f"  Consolidated {pre_consolidation_count} -> {post_consolidation_count} segments", file=sys.stderr)
        
        # Show consolidation results
        for idx, start_s, end_s, seg_type in consolidated_segments:
            print(f"    {idx:03d}: {start_s:.3f} -> {end_s:.3f} ({seg_type})", file=sys.stderr)
    
    return consolidated_segments

def _force_split_segment(seg: Segment, max_len: float) -> List[Segment]:
    """Force-split a non-speech segment into chunks of max_len seconds."""
    if seg.duration <= max_len:
        return [seg]
    
    splits = []
    current = seg.start_s
    
    while current < seg.end_s:
        chunk_end = min(current + max_len, seg.end_s)
        splits.append(Segment(
            index=0,  # Re-indexed later
            start_s=current,
            end_s=chunk_end,
            segment_type=seg.segment_type,
            split_reason="max_len"
        ))
        current = chunk_end
    
    return splits

def _find_silence_gaps(
    speech_intervals: List[Tuple[float, float]], 
    start_s: float, 
    end_s: float
) -> List[Tuple[float, float]]:
    """Find silence gaps (inverse of speech intervals) within a segment."""
    gaps = []
    current = start_s
    
    for speech_start, speech_end in speech_intervals:
        if speech_start > current:
            gaps.append((current, speech_start))
        current = max(current, speech_end)
    
    if current < end_s:
        gaps.append((current, end_s))
    
    return gaps

def _find_best_split_point(
    silence_gaps: List[Tuple[float, float]],
    seg_start: float,
    seg_end: float,
    max_len_speech: float,
    min_duration: float
) -> Optional[float]:
    """
    Find the best split point: silence midpoint closest to start + max_len_speech,
    where both resulting segments >= min_duration.
    """
    target = seg_start + max_len_speech
    best_point = None
    best_distance = float('inf')
    
    for gap_start, gap_end in silence_gaps:
        midpoint = (gap_start + gap_end) / 2
        left_dur = midpoint - seg_start
        right_dur = seg_end - midpoint
        
        # Both sides must meet min_duration
        if left_dur >= min_duration and right_dur >= min_duration:
            distance = abs(midpoint - target)
            if distance < best_distance:
                best_distance = distance
                best_point = midpoint
    
    return best_point

def _force_split_speech_fallback(seg: Segment, max_len: float) -> List[Segment]:
    """Force-split speech when no natural boundaries found."""
    splits = []
    current = seg.start_s
    
    while current < seg.end_s:
        chunk_end = min(current + max_len, seg.end_s)
        splits.append(Segment(0, current, chunk_end, seg.segment_type, "speech_fallback"))
        current = chunk_end
    
    return splits

def _recursive_split_speech(
    y: np.ndarray,
    sr: int,
    seg: Segment,
    max_len_speech: float,
    initial_threshold: float,
    min_duration: float,
    verbose: bool = False
) -> List[Segment]:
    """Recursively split speech using VAD with exponential threshold decay."""
    
    if seg.duration <= max_len_speech:
        return [seg]
    
    # Extract segment audio
    start_sample = int(seg.start_s * sr)
    end_sample = int(seg.end_s * sr)
    segment_audio = y[start_sample:end_sample]
    
    if len(segment_audio) == 0:
        return [seg]
    
    # Try decreasing thresholds to find silence gaps
    max_attempts = 18
    for attempt in range(max_attempts):
        threshold = initial_threshold * (0.8 ** attempt)
        
        if threshold < 0.01:
            break
        
        # Run VAD with current threshold on segment audio
        try:
            vad = _silero_vad_class()(sr=sr, threshold=threshold)
            speech_intervals = vad.segments(segment_audio)
            
            # Convert to absolute timestamps
            speech_intervals_abs = [
                (seg.start_s + s, seg.start_s + e) 
                for s, e in speech_intervals
            ]
            
            # Find silence gaps
            silence_gaps = _find_silence_gaps(speech_intervals_abs, seg.start_s, seg.end_s)
            
            # Find best split point
            split_point = _find_best_split_point(
                silence_gaps, seg.start_s, seg.end_s, max_len_speech, min_duration
            )
            
            if split_point is not None:
                if verbose:
                    print(f"  Found speech split at {split_point:.2f}s (threshold={threshold:.3f}, attempt={attempt+1})", file=sys.stderr)
                
                # Split at this point and recurse
                left = Segment(0, seg.start_s, split_point, seg.segment_type, "speech_pause")
                right = Segment(0, split_point, seg.end_s, seg.segment_type, "speech_pause")
                
                return (
                    _recursive_split_speech(y, sr, left, max_len_speech, initial_threshold, min_duration, verbose) +
                    _recursive_split_speech(y, sr, right, max_len_speech, initial_threshold, min_duration, verbose)
                )
        except Exception as e:
            if verbose:
                print(f"  VAD attempt {attempt+1} failed: {e}", file=sys.stderr)
            continue
    
    # Fallback: force-split at max_len_speech intervals
    if verbose:
        print(f"  No natural split found for {seg.start_s:.2f}-{seg.end_s:.2f}s, force-splitting", file=sys.stderr)
    
    return _force_split_speech_fallback(seg, max_len_speech)

def _apply_max_len_constraints(
    segments: List[Tuple[int, float, float, str]],
    y: np.ndarray,
    sr: int,
    max_len: Optional[float],
    max_len_speech: Optional[float],
    initial_vad_threshold: float,
    min_duration: float,
    verbose: bool = False
) -> List[Segment]:
    """Apply max-len constraints to all segments, returning Segment objects with split_reason."""
    
    result: List[Segment] = []
    
    for idx, start_s, end_s, seg_type in segments:
        seg = Segment(idx, start_s, end_s, seg_type)
        
        if seg.segment_type == "speech" and max_len_speech and seg.duration > max_len_speech:
            if verbose:
                print(f"Splitting speech segment {idx} ({seg.duration:.1f}s > {max_len_speech}s)", file=sys.stderr)
            result.extend(_recursive_split_speech(y, sr, seg, max_len_speech, initial_vad_threshold, min_duration, verbose))
        elif seg.segment_type != "speech" and max_len and seg.duration > max_len:
            if verbose:
                print(f"Force-splitting {seg.segment_type} segment {idx} ({seg.duration:.1f}s > {max_len}s)", file=sys.stderr)
            result.extend(_force_split_segment(seg, max_len))
        else:
            result.append(seg)
    
    # Re-index sequentially
    for i, seg in enumerate(result, 1):
        seg.index = i
    
    return result

def _plan_segments(
    segments: List[Tuple[int, float, float, str]],
    y: np.ndarray,
    sr: int,
    max_len: Optional[float],
    max_len_speech: Optional[float],
    initial_vad_threshold: float,
    min_duration: float,
    duration: float,
    verbose: bool = False
) -> List[Segment]:
    """Build the final segment plan for one modality: apply max-len constraints when
    limits are given, otherwise wrap the raw segments; always keep full coverage."""
    if max_len is not None or max_len_speech is not None:
        planned = _apply_max_len_constraints(
            segments, y, sr, max_len, max_len_speech, initial_vad_threshold, min_duration, verbose
        )
    else:
        planned = [
            Segment(idx, start_s, end_s, seg_type)
            for idx, start_s, end_s, seg_type in segments
        ]
    if not planned and duration > 0:
        planned = [Segment(1, 0.0, duration, "non_speech")]
    return planned

@click.command()
@click.argument("media", type=click.Path(exists=True, dir_okay=False, path_type=Path))
@click.option("--sr", type=click.Choice(["8000", "16000"]), default="16000", show_default=True)
@click.option("--vad-thr", type=click.FloatRange(0.0, 1.0), default=0.5, show_default=True)
@click.option("--min-duration", type=click.FloatRange(min=0.001), default=1.0, show_default=True)
@click.option("--output-dir", type=click.Path(file_okay=False, path_type=Path), default=None)
@click.option("--keyframe-nth", type=click.IntRange(min=1), default=2, show_default=True)
@click.option(
    "--keyframe-method",
    type=click.Choice(["time", "scene", "hybrid"]),
    default="hybrid",
    show_default=True,
)
@click.option("--scene-threshold", type=click.FloatRange(0.0, 1.0), default=0.4, show_default=True)
@click.option("--workers", type=click.IntRange(min=1), default=min(8, cpu_count()), show_default=True)
@click.option("--verbose/--quiet", default=True, show_default=True)
@click.option("--music-detection/--no-music-detection", default=True, show_default=True)
@click.option("--max-len", type=click.FloatRange(min=0.001), default=None)
@click.option("--max-len-speech", type=click.FloatRange(min=0.001), default=None)
@click.option(
    "--max-len-video",
    type=click.FloatRange(min=0.001),
    default=None,
    help="Independent cap for video/VLM clips (speech and non-speech). When set, audio "
    "and video are planned and exported independently; without it both share the "
    "generic --max-len/--max-len-speech plan.",
)
@click.option("--preprocess/--no-preprocess", default=True, show_default=True)
@click.option("--preprocess-width", type=click.IntRange(min=2), default=640, show_default=True)
@click.option("--preprocess-height", type=click.IntRange(min=2), default=448, show_default=True)
@click.option(
    "--preprocess-fps",
    type=click.FloatRange(min=0.0, min_open=True),
    default=1.0,
    show_default=True,
    help="Working-copy frame rate; fractional allowed (0.5 = 1 frame/2s, 0.25 = 1 frame/4s).",
)
@click.option(
    "--preprocess-encoder",
    type=click.Choice(["auto", "cpu", "nvenc"]),
    default="auto",
    show_default=True,
)
@click.option("--keep-preprocessed", is_flag=True, help="Keep the normalized working video in the output directory.")
@click.option(
    "--segment-videos",
    is_flag=True,
    help="Also export per-segment mp4 clips (off by default — audio mp3s and "
    "keyframes are always exported). Videos without an audio stream keep their "
    "mp4 export regardless; it is their only segment output.",
)
def main(
    media: Path,
    sr: str,
    vad_thr: float,
    min_duration: float,
    output_dir: Path | None,
    keyframe_nth: int,
    keyframe_method: str,
    scene_threshold: float,
    workers: int,
    verbose: bool,
    music_detection: bool,
    max_len: float | None,
    max_len_speech: float | None,
    max_len_video: float | None,
    preprocess: bool,
    preprocess_width: int,
    preprocess_height: int,
    preprocess_fps: float,
    preprocess_encoder: str,
    keep_preprocessed: bool,
    segment_videos: bool,
) -> None:
    media_path = media.resolve()
    sr_value = int(sr)

    if max_len_speech is not None and max_len_speech < min_duration:
        if verbose:
            print(
                f"Warning: --max-len-speech ({max_len_speech}) < --min-duration "
                f"({min_duration}); clamping.",
                file=sys.stderr,
            )
        max_len_speech = min_duration

    if max_len_video is not None and max_len_video < min_duration:
        if verbose:
            print(
                f"Warning: --max-len-video ({max_len_video}) < --min-duration "
                f"({min_duration}); clamping.",
                file=sys.stderr,
            )
        max_len_video = min_duration

    try:
        source_info = probe_media(media_path)
    except MediaProbeError as exc:
        raise click.ClickException(str(exc)) from exc

    file_hash = _get_file_hash(media_path)
    base_dir = output_dir.resolve() if output_dir else media_path.parent
    base_dir.mkdir(parents=True, exist_ok=True)
    input_extension = media_path.suffix[1:] if media_path.suffix else "unknown"
    out_dir = base_dir / f"out_{media_path.stem}_{input_extension}_{file_hash}"
    out_dir.mkdir(parents=True, exist_ok=True)

    if source_info.kind == "image":
        normalized_image = out_dir / f"image_{file_hash}.jpg"
        try:
            _normalize_image(media_path, normalized_image)
        except subprocess.CalledProcessError as exc:
            raise click.ClickException(f"Image normalization failed: {exc}") from exc
        print(
            json.dumps(
                {
                    "results": [
                        {
                            "type": "image",
                            "index": 1,
                            "file_hash": file_hash,
                            "image_file": _strip_input_prefix(normalized_image),
                        }
                    ],
                    "file_hash": file_hash,
                    "media_type": "image",
                    "original_file": str(media_path),
                    "input_filename": media_path.name,
                    "total_duration_s": 0.0,
                    "segment_counts": {"image": 1},
                    "preprocessing": {"enabled": False, "reason": "static_image"},
                },
                indent=2,
            )
        )
        return

    processing_path = media_path
    processing_info = source_info
    preprocess_result = None
    work_dir = out_dir / ".work"

    if source_info.kind == "video" and preprocess:
        work_dir.mkdir(parents=True, exist_ok=True)
        processing_path = work_dir / "preprocessed.mp4"
        try:
            preprocess_result = preprocess_video(
                media_path,
                processing_path,
                PreprocessConfig(
                    max_width=preprocess_width,
                    max_height=preprocess_height,
                    output_fps=preprocess_fps,
                    encoder=preprocess_encoder,
                ),
                verbose=verbose,
            )
            processing_info = probe_media(processing_path)
        except (PreprocessError, MediaProbeError, ValueError) as exc:
            if not keep_preprocessed:
                shutil.rmtree(work_dir, ignore_errors=True)
            raise click.ClickException(str(exc)) from exc

    media_type = source_info.kind
    workers = max(1, min(workers, cpu_count()))
    has_audio = processing_info.has_audio
    # Timeline authority is the ORIGINAL container, not the working copy: at very low
    # --preprocess-fps the working copy's last frame can extend its container duration
    # past the source end (0.25 fps: 6.4s -> 8.0s), which would plan empty tail
    # segments whose clips have zero content (undecodable 340-byte MP3 headers).
    duration = source_info.duration_s

    if verbose:
        print(f"Processing {media_path.name} ({media_type}, hash: {file_hash})", file=sys.stderr)
        if preprocess_result is not None:
            ratio = preprocess_result.output_bytes / max(media_path.stat().st_size, 1)
            print(
                f"Normalized working video: {preprocess_result.output_bytes / 1048576:.2f} MiB "
                f"({ratio:.1%} of input), {preprocess_result.mode}",
                file=sys.stderr,
            )
        print("Loading audio...", file=sys.stderr)

    try:
        if has_audio:
            # VAD reads the ORIGINAL audio (not the AAC working copy): identical speech
            # regions, but higher fidelity feeding the MP3 clips used for transcription.
            y, decoded_duration = _read_audio_ffmpeg(media_path, sr_value)
            # Audio sample count is authoritative for VAD; retain container duration for
            # video-only tails that can exceed the audio stream slightly.
            duration = max(duration, decoded_duration)
        else:
            y = np.zeros(0, dtype=np.float32)
            if verbose:
                print(f"No audio stream found — skipping VAD ({duration:.1f}s video-only)", file=sys.stderr)

        if has_audio:
            if verbose:
                print("Running VAD...", file=sys.stderr)
            vad = _silero_vad_class()(sr=sr_value, threshold=vad_thr)
            speech_intervals = vad.segments(y)
        else:
            speech_intervals = []

        if verbose:
            print("Planning segments (sieve approach)...", file=sys.stderr)
        all_segments = _create_all_segments(speech_intervals, duration, min_duration, verbose)

        if music_detection and has_audio:
            all_segments = _refine_and_split_non_speech_segments(
                all_segments,
                y,
                sr_value,
                min_duration,
                verbose,
            )

        # NOTE: no second normalize here (matching the legacy service). _create_all_segments already
        # enforces full coverage; re-normalizing after music-refinement would re-fill gaps
        # with the "non_speech" tag, which the client has no bucket for (it filters
        # _silence_/_harmonic_/_noise_/_speech_). Refinement already reclassified those.
        # Audio/ASR plan uses the generic limits. The video/VLM plan only diverges
        # when --max-len-video is given; identical resolved limits keep one shared
        # plan (byte-identical behavior to the pre---max-len-video code path).
        max_len_video_eff = max_len_video if max_len_video is not None else max_len
        max_len_speech_video_eff = max_len_video if max_len_video is not None else max_len_speech
        dual_plan = source_info.kind == "video" and (
            (max_len_video_eff, max_len_speech_video_eff) != (max_len, max_len_speech)
        )

        all_segments_obj = _plan_segments(
            all_segments, y, sr_value, max_len, max_len_speech, vad_thr, min_duration, duration, verbose
        )
        video_segments_obj = all_segments_obj
        if dual_plan:
            video_segments_obj = _plan_segments(
                all_segments, y, sr_value, max_len_video_eff, max_len_speech_video_eff,
                vad_thr, min_duration, duration, verbose
            )

        # With no audio stream only the video plan is exported, so it drives the counts.
        primary_plan = video_segments_obj if (source_info.kind == "video" and not has_audio) else all_segments_obj
        segment_counts: dict[str, int] = {}
        for segment in primary_plan:
            segment_counts[segment.segment_type] = segment_counts.get(segment.segment_type, 0) + 1
        segment_counts_video: dict[str, int] | None = None
        if dual_plan:
            segment_counts_video = {}
            for segment in video_segments_obj:
                segment_counts_video[segment.segment_type] = segment_counts_video.get(segment.segment_type, 0) + 1

        # Plans are only exported independently when both modalities are produced.
        dual_export = dual_plan and has_audio

        if verbose:
            if dual_plan:
                audio_count_str = ", ".join(f"{count} {kind}" for kind, count in segment_counts.items())
                video_count_str = ", ".join(f"{count} {kind}" for kind, count in (segment_counts_video or {}).items())
                print(f"Final audio segments: {len(all_segments_obj)} total ({audio_count_str})", file=sys.stderr)
                print(f"Final video segments: {len(video_segments_obj)} total ({video_count_str})", file=sys.stderr)
            else:
                count_str = ", ".join(f"{count} {kind}" for kind, count in segment_counts.items())
                print(f"Final segments: {len(primary_plan)} total ({count_str})", file=sys.stderr)

        keyframes_dir = None
        if source_info.kind == "video":
            keyframes_dir = out_dir / f"kf_{file_hash}"
            keyframes_dir.mkdir(exist_ok=True)

        # First element is the audio source (ORIGINAL media -> best fidelity for the MP3
        # clips used in transcription); element 15 is the video source (the
        # normalized working copy -> fast decode/scene/keyframes). The trailing
        # element gates the opt-in per-segment mp4 export: --segment-videos, or
        # forced when the source video has no audio stream (mp4s are then the
        # only segment output).
        export_segment_video = segment_videos or (source_info.kind == "video" and not has_audio)

        def _segment_arg(segment: Segment, is_video: bool, seg_has_audio: bool, seg_keyframes_dir: Path | None) -> tuple:
            return (
                media_path,
                segment.index,
                segment.start_s,
                segment.end_s,
                file_hash,
                out_dir,
                is_video,
                seg_keyframes_dir,
                keyframe_method,
                keyframe_nth,
                scene_threshold,
                segment.segment_type,
                segment.split_reason,
                seg_has_audio,
                processing_path,
                export_segment_video,
            )

        if dual_export:
            # Independent plans: MP3 clips from the audio/ASR plan (speech-capped via
            # --max-len-speech), MP4 clips + keyframes from the video/VLM plan
            # (capped via --max-len-video). Index spaces are per-plan; filenames stay
            # unique because they embed start/end.
            segment_args = [_segment_arg(seg, False, True, None) for seg in all_segments_obj]
            segment_args += [_segment_arg(seg, True, False, keyframes_dir) for seg in video_segments_obj]
        elif source_info.kind == "video" and not has_audio:
            segment_args = [_segment_arg(seg, True, False, keyframes_dir) for seg in video_segments_obj]
        else:
            segment_args = [
                _segment_arg(seg, source_info.kind == "video", has_audio, keyframes_dir)
                for seg in all_segments_obj
            ]

        if verbose:
            print(f"Using {min(workers, max(len(segment_args), 1))} bounded workers", file=sys.stderr)

        all_results: list[dict] = []
        errors: list[str] = []
        effective_workers = min(workers, max(len(segment_args), 1))

        if effective_workers == 1:
            for args in segment_args:
                segment_results, error = _process_segment_with_type(args)
                if error:
                    errors.append(error)
                else:
                    all_results.extend(segment_results)
        else:
            # FFmpeg does the heavy work in child processes. Threads avoid repeatedly
            # importing Torch/Librosa and prevent process-level memory multiplication.
            with ThreadPoolExecutor(max_workers=effective_workers) as executor:
                future_to_segment = {
                    executor.submit(_process_segment_with_type, args): (args[1], args[11])
                    for args in segment_args
                }
                for future in as_completed(future_to_segment):
                    segment_idx, segment_type = future_to_segment[future]
                    try:
                        segment_results, error = future.result()
                    except Exception as exc:  # pragma: no cover - defensive boundary
                        errors.append(f"Segment {segment_idx} ({segment_type}) failed: {exc}")
                        continue
                    if error:
                        errors.append(error)
                    else:
                        all_results.extend(segment_results)
                        if verbose:
                            print(f"Completed segment {segment_idx} ({segment_type})", file=sys.stderr)

        if errors:
            raise click.ClickException("; ".join(errors))

        if dual_export:
            # Two index spaces (audio plan / video plan): order chronologically instead.
            all_results.sort(key=lambda item: (
                item.get("start_s", item.get("timestamp_s", 0.0)),
                item.get("type", ""),
                item.get("index", item.get("segment_index", 0)),
                item.get("timestamp_s", 0.0),
            ))
        else:
            all_results.sort(key=lambda item: (item.get("index", 0), item.get("segment_index", 0), item.get("timestamp_s", 0)))

        # Emit client-compatible output paths: relative to the output base dir. The
        # legacy path returned relative paths (output lived under /input and was
        # stripped); run.sh writes under /output, so without this a client sees absolute
        # "/output/..." paths it cannot resolve (audio segments "disappear"). This keeps
        # the on-disk layout identical to the legacy service:
        # "out_<stem>_<ext>_<hash>/<file>".
        base_resolved = base_dir.resolve()
        for _r in all_results:
            for _key in ("audio_file", "video_file", "keyframe_file", "image_file"):
                _v = _r.get(_key)
                if not _v:
                    continue
                try:
                    _r[_key] = str(Path(_v).resolve().relative_to(base_resolved))
                except ValueError:
                    # Already relative or outside the base dir: leave unchanged.
                    pass

        preprocessing_json = {"enabled": False}
        if preprocess_result is not None:
            # Keep integer rates as ints in the JSON contract (1, not 1.0);
            # fractional rates (0.5/0.25) serialize as floats.
            fps_value = int(preprocess_fps) if float(preprocess_fps).is_integer() else preprocess_fps
            preprocessing_json = {
                "enabled": True,
                "max_width": preprocess_width,
                "max_height": preprocess_height,
                "fps": fps_value,
                "mode": preprocess_result.mode,
                "encoder": preprocess_result.encoder,
                "used_nvdec": preprocess_result.used_nvdec,
                "wall_seconds": round(preprocess_result.wall_seconds, 3),
                "input_bytes": media_path.stat().st_size,
                "output_bytes": preprocess_result.output_bytes,
                "kept": keep_preprocessed,
                "working_file": str(processing_path) if keep_preprocessed else None,
            }

        print(
            json.dumps(
                {
                    "results": all_results,
                    "file_hash": file_hash,
                    "media_type": media_type,
                    "original_file": str(media_path),
                    "input_filename": media_path.name,
                    "source_duration_s": source_info.duration_s,
                    "total_duration_s": duration,
                    "segment_counts": segment_counts,
                    "segment_counts_video": segment_counts_video,
                    "music_detection_enabled": music_detection,
                    "max_len": max_len,
                    "max_len_speech": max_len_speech,
                    "max_len_video": max_len_video,
                    "preprocessing": preprocessing_json,
                },
                indent=2,
            )
        )
    finally:
        if preprocess_result is not None and not keep_preprocessed:
            shutil.rmtree(work_dir, ignore_errors=True)

if __name__ == "__main__":
    main()
