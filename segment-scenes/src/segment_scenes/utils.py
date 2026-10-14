from __future__ import annotations
import hashlib
from pathlib import Path

VIDEO_EXTS = {".mp4", ".mkv", ".mov", ".m4v", ".avi", ".webm", ".flv", ".mpg", ".mpeg", ".ts", ".m2ts"}

def get_file_hash(path: Path) -> str:
    """Generate a short hash from the file name, size, and mtime"""
    stat = path.stat()
    data = f"{path.name}_{stat.st_size}_{stat.st_mtime}".encode()
    return hashlib.sha256(data).hexdigest()[:8]

def is_video_file(p: Path) -> bool:
    return p.suffix.lower() in VIDEO_EXTS
