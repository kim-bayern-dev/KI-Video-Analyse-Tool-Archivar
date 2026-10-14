from __future__ import annotations

from pathlib import Path
from urllib.parse import unquote, urlsplit


class FileURIError(ValueError):
    pass


def resolve_file_uri(
    uri: str,
    allowed_roots: tuple[Path, ...],
    *,
    require_file: bool,
) -> Path:
    """Resolve a local file:// URI and keep it inside a mounted allow-list."""
    parsed = urlsplit(uri)
    if parsed.scheme != "file":
        raise FileURIError("Only file:// URIs are accepted; media bytes are not uploaded over HTTP")
    if parsed.netloc not in {"", "localhost"}:
        raise FileURIError("Remote file:// authorities are not supported")
    if parsed.query or parsed.fragment:
        raise FileURIError("file:// URIs must not contain query strings or fragments")

    raw_path = unquote(parsed.path)
    candidate = Path(raw_path)
    if not candidate.is_absolute():
        raise FileURIError("file:// URI path must be absolute")
    resolved = candidate.resolve(strict=False)
    roots = tuple(root.resolve(strict=False) for root in allowed_roots)
    if not any(resolved == root or resolved.is_relative_to(root) for root in roots):
        allowed = ", ".join(str(root) for root in roots)
        raise FileURIError(f"Path is outside ALLOWED_FILE_ROOTS ({allowed})")
    if require_file and not resolved.is_file():
        raise FileURIError(f"Input file does not exist: {resolved}")
    if not require_file and resolved.exists() and not resolved.is_dir():
        raise FileURIError(f"Output path exists and is not a directory: {resolved}")
    return resolved
