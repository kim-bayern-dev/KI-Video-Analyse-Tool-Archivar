from __future__ import annotations

import pytest

from segment_scenes.file_uri import FileURIError, resolve_file_uri


def test_resolves_percent_encoded_file_uri_inside_mount(tmp_path):
    media = tmp_path / "demo file.mp4"
    media.write_bytes(b"video")

    resolved = resolve_file_uri(
        f"file://{str(media).replace(' ', '%20')}",
        (tmp_path,),
        require_file=True,
    )

    assert resolved == media


@pytest.mark.parametrize("uri", ["https://example.test/demo.mp4", "/data/demo.mp4", "file://remote/data/demo.mp4"])
def test_rejects_non_local_file_uris(tmp_path, uri):
    with pytest.raises(FileURIError):
        resolve_file_uri(uri, (tmp_path,), require_file=True)


def test_rejects_traversal_outside_mount(tmp_path):
    allowed = tmp_path / "data"
    allowed.mkdir()
    outside = tmp_path / "outside.mp4"
    outside.write_bytes(b"video")

    with pytest.raises(FileURIError, match="outside ALLOWED_FILE_ROOTS"):
        resolve_file_uri(outside.as_uri(), (allowed,), require_file=True)
