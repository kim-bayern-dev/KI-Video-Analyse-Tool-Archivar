#!/usr/bin/env python3
"""Executed inside the selected vLLM image; Hugging Face supplies file integrity checks."""
from __future__ import annotations

import argparse
import fcntl
import json
import os
from pathlib import Path
import re

from deploy import atomic_json


def download_entry(repo: str, requested: str, old: dict, hf_home: Path,
                   refresh: bool, api, snapshot_download) -> dict:
    reuse = (not refresh and old.get('repo_id') == repo and
             old.get('requested_revision') == requested and
             re.fullmatch(r'[0-9a-f]{40}', old.get('revision', '')))
    revision = old['revision'] if reuse else api.model_info(repo, revision=requested).sha
    if not revision or not re.fullmatch(r'[0-9a-f]{40}', revision):
        raise ValueError(f'Could not resolve {repo}@{requested} to an immutable HF commit')
    # Always invoke snapshot_download: reuse complete cached blobs, repair missing
    # files, and download by commit rather than following a moving main branch.
    snapshot = Path(snapshot_download(repo_id=repo, revision=revision,
                                     cache_dir=str(hf_home / 'hub')))
    relative = snapshot.relative_to(hf_home).as_posix()
    print(f'{repo}@{revision} -> {snapshot}', flush=True)
    return {'repo_id': repo, 'requested_revision': requested,
            'revision': revision, 'snapshot_rel': relative}


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument('--model', required=True)
    parser.add_argument('--model-revision', required=True)
    parser.add_argument('--draft', required=True)
    parser.add_argument('--draft-revision', required=True)
    parser.add_argument('--skip-model', action='store_true')
    parser.add_argument('--skip-draft', action='store_true')
    parser.add_argument('--refresh', action='store_true')
    options = parser.parse_args()
    from huggingface_hub import HfApi, snapshot_download
    hf_home = Path(os.environ['HF_HOME'])
    state = Path('/state')
    state.mkdir(parents=True, exist_ok=True)
    path = state / 'model-lock.json'
    api = HfApi(token=os.environ.get('HF_TOKEN') or None)
    with (state / 'download.lock').open('a') as guard:
        fcntl.flock(guard, fcntl.LOCK_EX)
        lock = json.loads(path.read_text()) if path.exists() else {'schema_version': 1}
        for which in ('model', 'draft'):
            if getattr(options, 'skip_' + which):
                continue
            lock[which] = download_entry(
                getattr(options, which), getattr(options, which + '_revision'),
                lock.get(which, {}), hf_home, options.refresh, api, snapshot_download)
            # A successfully downloaded target remains recorded if the draft
            # download later fails. Start still requires BOTH valid entries.
            atomic_json(path, lock)
        if not path.exists():
            atomic_json(path, lock)
        # Make only this non-secret manifest readable by the host; do not
        # chown/chmod the shared model tree.
        path.chmod(0o644)


if __name__ == '__main__':
    main()
