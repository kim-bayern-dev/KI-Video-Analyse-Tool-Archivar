#!/usr/bin/env python3
"""Runtime preflight. No model weights are loaded into GPU memory."""
from __future__ import annotations

import argparse
from importlib.metadata import distribution, version
import json
from pathlib import Path
import sys


def inspect_snapshot(root: Path) -> dict:
    if not (root / 'config.json').is_file():
        raise ValueError(f'Missing config.json: {root}. Run make download or fix the local mount')
    config = json.loads((root / 'config.json').read_text())
    indices = list(root.glob('*.safetensors.index.json'))
    weight_files: set[Path] = set()
    for index in indices:
        data = json.loads(index.read_text())
        for name in data.get('weight_map', {}).values():
            if not isinstance(name, str) or Path(name).name != name:
                raise ValueError(f'Unsafe shard path in {index}: {name}')
            weight_files.add(root / name)
    if not indices:
        weight_files.update(root.glob('*.safetensors'))
    if not weight_files:
        raise ValueError(f'No safetensors weights found in {root}')
    for path in weight_files:
        if not path.is_file() or path.stat().st_size == 0:
            raise ValueError(f'Missing/empty shard or dangling cache symlink: {path}')
    for path in root.rglob('*'):
        if path.is_symlink() and not path.exists():
            raise ValueError(f'Dangling cache symlink: {path}. Mount the entire HF cache tree')
    size = sum(path.stat().st_size for path in weight_files)
    print(f'{root}: {len(weight_files)} weight files, {size / 2**30:.3f} GiB on disk')
    return config


def validate_pair(target: dict, draft: dict, speculative_tokens: int) -> None:
    text = target.get('text_config', target)
    for field in ('hidden_size', 'vocab_size'):
        if text.get(field) != draft.get(field):
            raise ValueError(f'Target/draft {field} mismatch: {text.get(field)} vs {draft.get(field)}')
    if draft.get('num_target_layers') not in (None, text.get('num_hidden_layers')):
        raise ValueError('DFlash target layer count does not match the target checkpoint')
    dflash = draft.get('dflash_config')
    if not isinstance(dflash, dict):
        raise ValueError('The selected draft has no dflash_config')
    if draft.get('quantization_config'):
        raise ValueError('This recipe uses an unquantized BF16 DFlash drafter, not a quantized DFlash2 drafter')
    block_size = dflash.get('block_size')
    if block_size is not None and not 1 <= speculative_tokens < block_size:
        raise ValueError(f'NUM_SPEC_TOKENS must be between 1 and {block_size - 1} for this drafter')
    layers = dflash.get('target_layer_ids', [])
    if any(not isinstance(i, int) or i < 0 or i >= text.get('num_hidden_layers', 0) for i in layers):
        raise ValueError('DFlash auxiliary layer index is outside the target layer range')


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument('--version', required=True)
    parser.add_argument('--version-only', action='store_true')
    parser.add_argument('--profile', choices=['ada', 'h100', 'h200'])
    parser.add_argument('--model', default='')
    parser.add_argument('--draft', default='')
    parser.add_argument('--spec-tokens', type=int, default=3)
    options = parser.parse_args()
    installed = version('vllm')
    if installed.split('+', 1)[0] != options.version:
        raise ValueError(f'Expected vLLM {options.version}; image contains {installed}. '
                         'Check IMAGE in .env; do not silently reuse the old v0.26 image')
    print('vLLM version:', installed)
    if options.version_only:
        return
    target = inspect_snapshot(Path(options.model))
    quant = target.get('quantization_config', {})
    if quant.get('bits', quant.get('weight_bits')) != 4:
        raise ValueError('Expected a 4-bit target checkpoint; inspect config.json/QUANTIZATION')
    if options.draft:
        draft = inspect_snapshot(Path(options.draft))
        validate_pair(target, draft, options.spec_tokens)
        source = Path(distribution('vllm').locate_file('vllm/model_executor/models/qwen3_dflash.py'))
        text = source.read_text()
        if 'sliding_attention' not in text or 'use_v2_model_runner' not in text:
            raise ValueError('Installed vLLM source lacks the mixed-attention DFlash implementation')
    import torch
    if not torch.cuda.is_available():
        raise ValueError('CUDA is unavailable. Check the host driver and NVIDIA Container Toolkit')
    if torch.cuda.device_count() != 1:
        raise ValueError('Exactly one GPU must be visible to this TP=1 container')
    capability = torch.cuda.get_device_capability(0)
    expected = (8, 9) if options.profile == 'ada' else (9, 0)
    if capability != expected:
        raise ValueError(f'PROFILE={options.profile} expects SM{expected[0]}{expected[1]}, '
                         f'but selected GPU has capability {capability}')
    free, total = torch.cuda.mem_get_info(0)
    print(f'GPU: {torch.cuda.get_device_name(0)}, SM{capability[0]}{capability[1]}, '
          f'free={free / 2**30:.2f} GiB, total={total / 2**30:.2f} GiB')
    print('Preflight passed. GPU model loading, cache capacity, and generation are NOT tested by this command.')


if __name__ == '__main__':
    try:
        main()
    except (ValueError, OSError) as exc:
        print(f'ERROR: {exc}', file=sys.stderr)
        raise SystemExit(1)
