#!/usr/bin/env python3
"""Small Docker orchestrator. All subprocess arguments are passed without a shell."""
from __future__ import annotations

import json
import math
import os
from pathlib import Path, PurePosixPath
import re
import shlex
import subprocess
import sys
import time
import urllib.error
import urllib.request

ROOT = Path(__file__).resolve().parents[1]


class ConfigError(ValueError):
    pass


def atomic_json(path: Path, value: object) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(path.name + f'.{os.getpid()}.tmp')
    try:
        temporary.write_text(json.dumps(value, indent=2) + '\n')
        temporary.replace(path)
    finally:
        temporary.unlink(missing_ok=True)


def parse_bytes(value: str) -> int:
    """Match vLLM's decimal lowercase / binary uppercase size convention."""
    match = re.fullmatch(r'(\d+(?:\.\d+)?)([kKmMgGtT]?)', value.strip())
    if not match:
        raise ConfigError('KV_CACHE_BYTES must be bytes or a size such as 8G; empty means auto')
    number, suffix = match.groups()
    power = 'kmgt'.index(suffix.lower()) + 1 if suffix else 0
    base = 1024 if suffix.isupper() else 1000
    result = float(number) * base ** power
    if not math.isfinite(result) or result <= 0 or result != int(result):
        raise ConfigError('KV_CACHE_BYTES must resolve to a positive whole number of bytes')
    return int(result)


class Settings:
    def __init__(self, values: dict[str, str] | None = None):
        self.env = dict(os.environ if values is None else values)
        if 'IMAGE' not in self.env:
            raise ConfigError('Run this helper through make so .env and defaults are loaded')

    def text(self, key: str) -> str:
        return self.env.get(key, '').strip()

    def number(self, key: str, minimum: int = 1) -> int:
        try:
            value = int(self.text(key))
        except ValueError as exc:
            raise ConfigError(f'{key} must be an integer') from exc
        if value < minimum:
            raise ConfigError(f'{key} must be >= {minimum}')
        return value

    def flag(self, key: str) -> bool:
        value = self.text(key)
        if value not in {'0', '1'}:
            raise ConfigError(f'{key} must be 0 or 1')
        return value == '1'

    def path(self, key: str) -> Path:
        value = self.text(key)
        if not value:
            raise ConfigError(f'{key} cannot be empty')
        # Docker's volume syntax cannot unambiguously represent colon-containing
        # Linux source paths. Spaces and apostrophes are supported.
        if any(char in value for char in (':', '\n', '\r', '\x00')):
            raise ConfigError(f'{key}: colon/newline/NUL is not supported in volume paths')
        return Path(value).expanduser().absolute()

    def container_path(self, key: str) -> str:
        value = self.text(key)
        if not value.startswith('/') or '..' in PurePosixPath(value).parts:
            raise ConfigError(f'{key} must be an absolute container path without ..')
        if value == '/' or any(c in value for c in (':', '\n', '\r', '\x00')):
            raise ConfigError(f'{key}: unsafe container path')
        return value.rstrip('/')

    def validate(self) -> None:
        if self.text('PROFILE') not in {'ada', 'h100', 'h200'}:
            raise ConfigError('PROFILE must be ada, h100, or h200')
        if self.number('TP') != 1:
            raise ConfigError('This package exposes exactly one GPU; TP must be 1')
        self.number('GPU_NO', 0)
        for key in ('MAX_LEN', 'MAX_SEQS', 'BATCH_TOKS', 'NUM_SPEC_TOKENS',
                    'READY_TIMEOUT', 'REQUEST_TIMEOUT', 'PORT'):
            self.number(key)
        if self.number('PORT') > 65535:
            raise ConfigError('PORT must be <= 65535')
        for key in ('SPEC_DECODE', 'VLLM_USE_V2_MODEL_RUNNER', 'NO_REASONING',
                    'PREFIX_CACHING', 'EAGER_ENABLED', 'LLM_ONLY', 'ROPE_ENABLED',
                    'TRUST_REMOTE_CODE'):
            self.flag(key)
        if self.flag('SPEC_DECODE') and self.text('SPEC_METHOD') not in {'dflash', 'mtp'}:
            raise ConfigError('SPEC_METHOD must be dflash or mtp')
        if self.flag('SPEC_DECODE') and self.text('SPEC_METHOD') == 'dflash':
            if not self.flag('VLLM_USE_V2_MODEL_RUNNER'):
                raise ConfigError('The current mixed-attention DFlash checkpoint requires V2')
            if self.number('MAX_LEN') > 262144:
                raise ConfigError('This DFlash recipe is limited to native 262144 context; '
                                  'target-only YaRN does not extend the drafter')
        if self.text('QUANTIZATION') == 'moe_wna16':
            raise ConfigError('Do not force moe_wna16 for this GPTQ checkpoint; '
                              'leave QUANTIZATION empty for auto-detection')
        if self.text('DTYPE') not in {'bfloat16', 'float16', 'auto'}:
            raise ConfigError('DTYPE must be bfloat16, float16, or auto')
        for key in ('KV_QUANT', 'DRAFT_KV_QUANT'):
            if self.text(key) not in {'', 'auto', 'bfloat16', 'float16', 'fp8', 'fp8_e4m3'}:
                raise ConfigError(f'{key}: this recipe exposes BF16/FP16/FP8 caches only')
        for key in ('ATTN_BACKEND', 'DRAFT_ATTN_BACKEND'):
            if self.text(key) not in {'', 'FLASH_ATTN', 'TRITON_ATTN', 'FLASHINFER'}:
                raise ConfigError(f'{key}: use empty, FLASH_ATTN, TRITON_ATTN, or FLASHINFER')
        if self.text('PROFILE') == 'ada':
            for kv, backend in (('KV_QUANT', 'ATTN_BACKEND'),
                                ('DRAFT_KV_QUANT', 'DRAFT_ATTN_BACKEND')):
                if self.text(kv).startswith('fp8') and self.text(backend) == 'FLASH_ATTN':
                    raise ConfigError(f'Ada: use {backend}=TRITON_ATTN or empty with {kv}=FP8')
        if self.flag('SPEC_DECODE') and self.text('SPEC_METHOD') == 'dflash':
            if self.text('DRAFT_ATTN_BACKEND') == 'FLASHINFER':
                raise ConfigError('This DFlash recipe needs a non-causal draft backend; '
                                  'use FLASH_ATTN or TRITON_ATTN')
        try:
            fraction = float(self.text('GPU_MEM_UTIL'))
        except ValueError as exc:
            raise ConfigError('GPU_MEM_UTIL must be numeric') from exc
        if not 0 < fraction < 1:
            raise ConfigError('GPU_MEM_UTIL must be between 0 and 1')
        if self.text('KV_CACHE_BYTES'):
            parse_bytes(self.text('KV_CACHE_BYTES'))
        if self.number('MAX_SEQS') > self.number('BATCH_TOKS'):
            raise ConfigError('BATCH_TOKS must be >= MAX_SEQS')
        if self.text('IPC_MODE') not in {'host', 'private'}:
            raise ConfigError('IPC_MODE must be host or private')
        if not self.env.get('API_KEY', ''):
            raise ConfigError('API_KEY cannot be empty')
        if not re.fullmatch(r'[a-zA-Z0-9][a-zA-Z0-9_.-]*', self.text('CONTAINER')):
            raise ConfigError('Invalid Docker CONTAINER name')
        if self.flag('ROPE_ENABLED'):
            try:
                factor = float(self.text('ROPE_SCALING_FACTOR'))
            except ValueError as exc:
                raise ConfigError('ROPE_SCALING_FACTOR must be numeric') from exc
            if not math.isfinite(factor) or factor < 1:
                raise ConfigError('ROPE_SCALING_FACTOR must be finite and >= 1')
        for key in ('LIMIT_MM_IMAGE', 'LIMIT_MM_VIDEO'):
            self.number(key, 0)
        for key in ('VIDEO_PROFILE_FRAMES', 'VIDEO_PROFILE_WIDTH', 'VIDEO_PROFILE_HEIGHT'):
            self.number(key)
        try:
            fps = float(self.text('VIDEO_FPS'))
        except ValueError as exc:
            raise ConfigError('VIDEO_FPS must be numeric') from exc
        if not math.isfinite(fps) or fps <= 0:
            raise ConfigError('VIDEO_FPS must be finite and > 0')

    @property
    def lock_file(self) -> Path:
        return self.path('STATE_DIR') / 'model-lock.json'

    def source(self, which: str, require_lock: bool = True) -> tuple[str, str | None]:
        local_key, repo_key, revision_key, container = (
            ('MODEL_PATH', 'MODEL', 'MODEL_REVISION', '/model') if which == 'model' else
            ('DRAFT_MODEL_PATH', 'DRAFT_MODEL', 'DRAFT_REVISION', '/draft_model'))
        if self.text(local_key):
            return container, None
        if not self.lock_file.exists():
            if require_lock:
                raise ConfigError('No model lock. Run make download before start/doctor')
            return self.text(repo_key), self.text(revision_key)
        entry = json.loads(self.lock_file.read_text()).get(which, {})
        if (entry.get('repo_id') != self.text(repo_key) or
                entry.get('requested_revision') != self.text(revision_key)):
            if require_lock:
                raise ConfigError(f'{which} settings differ from the lock; run make download')
            return self.text(repo_key), self.text(revision_key)
        rel = PurePosixPath(entry.get('snapshot_rel', ''))
        if (not rel.parts or rel.is_absolute() or '..' in rel.parts or
                rel.parts[0] != 'hub' or 'snapshots' not in rel.parts):
            raise ConfigError(f'Unsafe {which} snapshot path in model lock')
        return str(PurePosixPath(self.container_path('HF_HOME_IN_CONTAINER')) / rel), None

    def server_args(self, require_lock: bool = True, redact: bool = False) -> list[str]:
        self.validate()
        src, revision = self.source('model', require_lock)
        args = ['vllm', 'serve', src, '--served-model-name', self.text('SERVED_NAME'),
                '--host', '0.0.0.0', '--port', '8000', '--api-key',
                '<redacted>' if redact else self.env['API_KEY'],
                '--dtype', self.text('DTYPE'), '--gpu-memory-utilization', self.text('GPU_MEM_UTIL'),
                '--max-model-len', self.text('MAX_LEN'), '--enable-chunked-prefill',
                '--max-num-seqs', self.text('MAX_SEQS'),
                '--max-num-batched-tokens', self.text('BATCH_TOKS'),
                '--tensor-parallel-size', '1', '--seed', str(self.number('SEED', 0)),
                '--enable-auto-tool-choice', '--tool-call-parser', 'qwen3_coder',
                '--reasoning-parser', 'qwen3',
                '--structured-outputs-config', compact({'backend': 'xgrammar', 'disable_any_whitespace': True})]
        if revision:
            args += ['--revision', revision]
        for key, option in (('QUANTIZATION', '--quantization'), ('KV_QUANT', '--kv-cache-dtype'),
                            ('ATTN_BACKEND', '--attention-backend'), ('MOE_BACKEND', '--moe-backend')):
            if self.text(key):
                args += [option, self.text(key)]
        if self.text('KV_CACHE_BYTES'):
            args += ['--kv-cache-memory-bytes', str(parse_bytes(self.text('KV_CACHE_BYTES')))]
        args.append('--enable-prefix-caching' if self.flag('PREFIX_CACHING') else '--no-enable-prefix-caching')
        if self.flag('NO_REASONING'):
            args += ['--default-chat-template-kwargs', compact({'enable_thinking': False})]
        if self.flag('TRUST_REMOTE_CODE'):
            args.append('--trust-remote-code')
        if self.flag('EAGER_ENABLED'):
            args.append('--enforce-eager')
        if self.flag('LLM_ONLY'):
            args.append('--language-model-only')
        else:
            args += ['--limit-mm-per-prompt', compact({
                'image': {'count': self.number('LIMIT_MM_IMAGE', 0)},
                'video': {'count': self.number('LIMIT_MM_VIDEO', 0),
                          'num_frames': self.number('VIDEO_PROFILE_FRAMES'),
                          'width': self.number('VIDEO_PROFILE_WIDTH'),
                          'height': self.number('VIDEO_PROFILE_HEIGHT')}}),
                     '--media-io-kwargs', compact({'video': {'fps': float(self.text('VIDEO_FPS'))}})]
            if self.text('DATA_DIR'):
                args += ['--allowed-local-media-path', self.container_path('DATA_DIR_IN_CONTAINER')]
        if self.flag('SPEC_DECODE'):
            spec: dict[str, object] = {'method': self.text('SPEC_METHOD'),
                                     'num_speculative_tokens': self.number('NUM_SPEC_TOKENS')}
            if self.text('SPEC_METHOD') == 'dflash':
                draft, draft_revision = self.source('draft', require_lock)
                spec.update(model=draft, draft_tensor_parallel_size=1, quantization=None)
                if draft_revision:
                    spec['revision'] = draft_revision
                if self.text('DRAFT_KV_QUANT'):
                    spec['kv_cache_dtype'] = self.text('DRAFT_KV_QUANT')
                if self.text('DRAFT_ATTN_BACKEND'):
                    spec['attention_backend'] = self.text('DRAFT_ATTN_BACKEND')
            args += ['--speculative-config', compact(spec)]
        if self.flag('ROPE_ENABLED'):
            args += ['--hf-overrides', compact({'text_config': {'rope_parameters': {
                'mrope_interleaved': True, 'mrope_section': [11, 11, 10], 'rope_type': 'yarn',
                'rope_theta': 10000000, 'partial_rotary_factor': 0.25,
                'factor': float(self.text('ROPE_SCALING_FACTOR')),
                'original_max_position_embeddings': 262144}}})]
        return args

    def storage(self) -> list[tuple[str, Path, str, bool]]:
        entries = [
            ('HF_HOME', self.container_path('HF_HOME_IN_CONTAINER')),
            ('HF_XET_CACHE_DIR', '/hf_xet_cache'),
            ('VLLM_CACHE_ROOT', self.container_path('VLLM_CACHE_ROOT_IN_CONTAINER')),
            ('TRITON_CACHE_DIR', '/triton_cache'),
            ('TORCHINDUCTOR_CACHE_DIR', '/torchinductor_cache'),
            ('CUDA_CACHE_DIR', '/cuda_cache'), ('STATE_DIR', '/state')]
        result = [(key, self.path(key), target, False) for key, target in entries]
        if self.text('DATA_DIR'):
            result.append(('DATA_DIR', self.path('DATA_DIR'), self.container_path('DATA_DIR_IN_CONTAINER'), True))
        for key, target in (('MODEL_PATH', '/model'), ('DRAFT_MODEL_PATH', '/draft_model')):
            if self.text(key):
                result.append((key, self.path(key), target, True))
        if self.text('MOE_CONFIG_DIR') and self.path('MOE_CONFIG_DIR').is_dir():
            result.append(('MOE_CONFIG_DIR', self.path('MOE_CONFIG_DIR'), '/moe_configs', True))
        destinations = [entry[2] for entry in result] + ['/deploy']
        if len(destinations) != len(set(destinations)):
            raise ConfigError('Container volume destinations must be distinct')
        return result

    def runtime_mounts_env(self) -> list[str]:
        args = []
        for _, source, target, readonly in self.storage():
            if source.exists() and not source.is_dir():
                raise ConfigError(f'Volume source is not a directory: {source}')
            args += ['-v', f'{source}:{target}' + (':ro' if readonly else '')]
        args += ['-v', f'{ROOT / "scripts"}:/deploy:ro']
        hf = self.container_path('HF_HOME_IN_CONTAINER')
        cache = self.container_path('VLLM_CACHE_ROOT_IN_CONTAINER')
        env = {'HF_HOME': hf, 'HF_HUB_CACHE': hf + '/hub', 'HF_XET_CACHE': '/hf_xet_cache',
               'VLLM_CACHE_ROOT': cache, 'TRITON_CACHE_DIR': '/triton_cache',
               'TORCHINDUCTOR_CACHE_DIR': '/torchinductor_cache', 'CUDA_CACHE_PATH': '/cuda_cache',
               'XDG_CACHE_HOME': cache + '/xdg', 'TORCH_HOME': cache + '/torch',
               'VLLM_USE_V2_MODEL_RUNNER': self.text('VLLM_USE_V2_MODEL_RUNNER'),
               'TORCH_ALLOW_TF32_CUBLAS_OVERRIDE': '1'}
        if self.text('ROPE_ENABLED') == '1':
            env['VLLM_ALLOW_LONG_MAX_MODEL_LEN'] = '1'
        if any(entry[0] == 'MOE_CONFIG_DIR' for entry in self.storage()):
            env['VLLM_TUNED_CONFIG_FOLDER'] = '/moe_configs'
        for key, value in env.items():
            args += ['-e', f'{key}={value}']
        args += ['-e', 'HF_TOKEN']
        return args


def compact(value: object) -> str:
    return json.dumps(value, separators=(',', ':'))


def command(args: list[str], cfg: Settings, capture: bool = False) -> str:
    try:
        result = subprocess.run(args, env=cfg.env, check=True, text=True,
                                stdout=subprocess.PIPE if capture else None)
    except FileNotFoundError as exc:
        raise ConfigError(f'Required executable not found: {args[0]}') from exc
    except subprocess.CalledProcessError as exc:
        raise ConfigError(f'{args[0]} command failed (exit {exc.returncode}); see diagnostic above') from exc
    return result.stdout.strip() if capture else ''


def image_id(cfg: Settings) -> str:
    value = command(['docker', 'image', 'inspect', '--format', '{{.Id}}', cfg.text('IMAGE')], cfg, True)
    if not re.fullmatch(r'sha256:[0-9a-f]{64}', value):
        raise ConfigError('Invalid Docker image ID; run make build')
    return value


def gpu_device(cfg: Settings) -> str:
    selector = cfg.text('GPU_DEVICE').strip('"\'')
    if selector:
        if not selector.startswith('device='):
            raise ConfigError('GPU_DEVICE must select ONE GPU using device=...; not all')
        target = selector.removeprefix('device=')
        if not target or ',' in target or target == 'all':
            raise ConfigError('GPU_DEVICE must select exactly one physical GPU')
        return selector
    uuid = cfg.text('GPU_UUID')
    if not uuid:
        uuid = command(['nvidia-smi', '--query-gpu=uuid', '--format=csv,noheader,nounits',
                        '-i', str(cfg.number('GPU_NO', 0))], cfg, True)
    if not re.fullmatch(r'GPU-[0-9a-fA-F-]+', uuid):
        raise ConfigError(f'GPU_NO={cfg.text("GPU_NO")} did not resolve to one GPU UUID')
    return 'device=' + uuid


def validate_local_paths(cfg: Settings) -> None:
    for key in ('MODEL_PATH', 'DRAFT_MODEL_PATH'):
        if cfg.text(key) and not (cfg.path(key) / 'config.json').is_file():
            raise ConfigError(f'{key} must contain config.json; received {cfg.path(key)}')
    if cfg.text('MOE_CONFIG_DIR') and cfg.path('MOE_CONFIG_DIR').is_dir():
        for path in cfg.path('MOE_CONFIG_DIR').glob('*.json'):
            if not isinstance(json.loads(path.read_text()), dict):
                raise ConfigError(f'MoE configuration must be a JSON object: {path}')


def preflight(cfg: Settings) -> tuple[str, str]:
    cfg.validate()
    validate_local_paths(cfg)
    model, _ = cfg.source('model')
    draft = ''
    if cfg.flag('SPEC_DECODE') and cfg.text('SPEC_METHOD') == 'dflash':
        draft, _ = cfg.source('draft')
    cfg.path('STATE_DIR').mkdir(parents=True, exist_ok=True)
    iid, device = image_id(cfg), gpu_device(cfg)
    command(['docker', 'run', '--rm', '--pull=never', '--gpus', device,
             *cfg.runtime_mounts_env(), '--entrypoint', 'python3', iid,
             '/deploy/check_runtime.py', '--version', cfg.text('EXPECTED_VLLM_VERSION'),
             '--profile', cfg.text('PROFILE'), '--model', model, '--draft', draft,
             '--spec-tokens', str(cfg.number('NUM_SPEC_TOKENS'))], cfg)
    if cfg.flag('ROPE_ENABLED'):
        print('WARNING: YaRN changes target positions; DFlash acceptance/quality must be requalified.', file=sys.stderr)
    return iid, device


def build(cfg: Settings) -> None:
    command(['docker', 'pull', cfg.text('IMAGE')], cfg)
    iid = image_id(cfg)
    command(['docker', 'run', '--rm', '--pull=never', '-v', f'{ROOT / "scripts"}:/deploy:ro',
             '--entrypoint', 'python3', iid, '/deploy/check_runtime.py',
             '--version', cfg.text('EXPECTED_VLLM_VERSION'), '--version-only'], cfg)
    atomic_json(cfg.path('STATE_DIR') / 'runtime-image.json',
                {'image': cfg.text('IMAGE'), 'image_id': iid,
                 'expected_vllm_version': cfg.text('EXPECTED_VLLM_VERSION')})


def download(cfg: Settings) -> None:
    cfg.validate()
    validate_local_paths(cfg)
    cfg.path('STATE_DIR').mkdir(parents=True, exist_ok=True)
    iid = image_id(cfg)
    arguments = ['--model', cfg.text('MODEL'), '--model-revision', cfg.text('MODEL_REVISION'),
                 '--draft', cfg.text('DRAFT_MODEL'), '--draft-revision', cfg.text('DRAFT_REVISION')]
    if cfg.text('MODEL_PATH'):
        arguments += ['--skip-model']
    if (cfg.text('DRAFT_MODEL_PATH') or not cfg.flag('SPEC_DECODE') or
            cfg.text('SPEC_METHOD') != 'dflash'):
        arguments += ['--skip-draft']
    if cfg.text('REFRESH_MODELS') == '1':
        arguments += ['--refresh']
    command(['docker', 'run', '--rm', '--pull=never', *cfg.runtime_mounts_env(),
             '--entrypoint', 'python3', iid, '/deploy/download_models.py', *arguments], cfg)


def container_exists(cfg: Settings) -> bool:
    result = command(['docker', 'ps', '-a', '--filter', 'name=^/' + cfg.text('CONTAINER') + '$',
                      '--format', '{{.Names}}'], cfg, True)
    return cfg.text('CONTAINER') in result.splitlines()


def remove_container(cfg: Settings) -> None:
    if container_exists(cfg):
        command(['docker', 'rm', '-f', cfg.text('CONTAINER')], cfg)


def base_url(cfg: Settings) -> str:
    host = cfg.text('BIND_ADDR')
    if host in {'0.0.0.0', '::', '[::]'}:
        host = '127.0.0.1'
    if ':' in host and not host.startswith('['):
        host = '[' + host + ']'
    return f'http://{host}:{cfg.number("PORT")}'


def get_http(cfg: Settings, endpoint: str, timeout: float = 5) -> bytes:
    req = urllib.request.Request(base_url(cfg) + endpoint,
                                 headers={'Authorization': 'Bearer ' + cfg.env['API_KEY']})
    with urllib.request.urlopen(req, timeout=timeout) as response:
        return response.read()


def wait_ready(cfg: Settings) -> None:
    deadline = time.monotonic() + cfg.number('READY_TIMEOUT')
    last_error = ''
    while time.monotonic() < deadline:
        state = json.loads(command(['docker', 'inspect', '--format', '{{json .State}}',
                                    cfg.text('CONTAINER')], cfg, True))
        if not state.get('Running') or state.get('Restarting'):
            raise ConfigError('Container exited or is restarting; run make log-once')
        try:
            get_http(cfg, '/health')
            models = json.loads(get_http(cfg, '/v1/models'))
            if any(m.get('id') == cfg.text('SERVED_NAME') for m in models.get('data', [])):
                print(f'Ready: {base_url(cfg)}/v1 ({cfg.text("SERVED_NAME")})')
                return
        except (OSError, ValueError) as exc:
            last_error = str(exc)
        time.sleep(2)
    raise ConfigError('Readiness deadline exceeded; inspect make logs. ' + last_error)


def start(cfg: Settings, restart: bool = False) -> None:
    if not restart and container_exists(cfg):
        raise ConfigError('CONTAINER already exists. Use make restart to replace only that container')
    # Resolve files, image version and selected GPU BEFORE disturbing the server.
    iid, device = preflight(cfg)
    args = cfg.server_args()
    cfg.path('OUTPUT_DIR').mkdir(parents=True, exist_ok=True)
    if restart:
        remove_container(cfg)
    bind = cfg.text('BIND_ADDR')
    if ':' in bind and not bind.startswith('['):
        bind = '[' + bind + ']'
    run_args = ['docker', 'run', '-d', '--pull=never', '--name', cfg.text('CONTAINER'),
                '--label', 'host.pwd=' + str(Path.cwd()), '--label', 'deployment=qwen36-dflash',
                '--gpus', device, '--ipc=' + cfg.text('IPC_MODE'),
                '--ulimit', 'memlock=-1', '--ulimit', 'stack=67108864',
                '--restart', cfg.text('RESTART_POLICY'),
                '--log-driver', 'json-file', '--log-opt', 'max-size=20m', '--log-opt', 'max-file=3',
                '-p', f'{bind}:{cfg.number("PORT")}:8000', *cfg.runtime_mounts_env(),
                '--entrypoint', 'vllm']
    if cfg.text('IPC_MODE') == 'private':
        run_args += ['--shm-size', cfg.text('SHM_SIZE')]
    command(run_args + [iid] + args[1:], cfg)
    atomic_json(cfg.path('OUTPUT_DIR') / f'launch-{time.time_ns()}.json', {
        'image': cfg.text('IMAGE'), 'image_id': iid, 'gpu': device,
        'profile': cfg.text('PROFILE'), 'server_argv': cfg.server_args(redact=True)})
    wait_ready(cfg)


def logs(cfg: Settings, follow: bool) -> None:
    directory = cfg.path('LOGS_DIR')
    directory.mkdir(parents=True, exist_ok=True)
    destination = directory / f'{cfg.text("CONTAINER")}-{time.time_ns()}.log'
    args = ['docker', 'logs'] + (['--follow'] if follow else []) + [cfg.text('CONTAINER')]
    print(f'Log copy: {destination}', file=sys.stderr)
    with destination.open('wb') as output:
        proc = subprocess.Popen(args, env=cfg.env, stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
        try:
            assert proc.stdout is not None
            for line in iter(proc.stdout.readline, b''):
                output.write(line)
                output.flush()
                sys.stdout.buffer.write(line)
                sys.stdout.buffer.flush()
            if proc.wait() != 0:
                raise ConfigError('docker logs failed')
        except KeyboardInterrupt:
            proc.terminate()
            proc.wait()


def main() -> None:
    cfg = Settings()
    action = sys.argv[1] if len(sys.argv) > 1 else 'print-config'
    if action == 'build':
        build(cfg)
    elif action == 'download':
        download(cfg)
    elif action in {'start', 'restart'}:
        start(cfg, restart=action == 'restart')
    elif action == 'deploy':
        build(cfg)
        download(cfg)
        start(cfg)
        command([sys.executable, str(ROOT / 'scripts' / 'smoke_test.py')], cfg)
    elif action == 'doctor':
        preflight(cfg)
    elif action == 'stop':
        remove_container(cfg)
    elif action == 'paths':
        for key, source, target, readonly in cfg.storage():
            print(f'{key}: {source} -> {target}' + (' [read-only]' if readonly else ''))
        print(f'OUTPUT_DIR: {cfg.path("OUTPUT_DIR")} [host reports]')
        print(f'LOGS_DIR: {cfg.path("LOGS_DIR")} [host log copies]')
    elif action == 'mkdirs':
        cfg.path('STATE_DIR').mkdir(parents=True, exist_ok=True)
        cfg.path('OUTPUT_DIR').mkdir(parents=True, exist_ok=True)
        cfg.path('LOGS_DIR').mkdir(parents=True, exist_ok=True)
        # Docker creates missing bind-source directories with the daemon's UID.
        command(['docker', 'run', '--rm', '--pull=never', *cfg.runtime_mounts_env(),
                 '--entrypoint', 'python3', image_id(cfg), '-c', 'print("Storage mounts ready")'], cfg)
    elif action == 'print-config':
        print(shlex.join(cfg.server_args(require_lock=False, redact=True)))
        print('VLLM_USE_V2_MODEL_RUNNER=' + cfg.text('VLLM_USE_V2_MODEL_RUNNER'))
    elif action in {'logs', 'log-once'}:
        logs(cfg, follow=action == 'logs')
    elif action == 'status':
        command(['docker', 'ps', '-a', '--filter', 'name=^/' + cfg.text('CONTAINER') + '$'], cfg)
        print(json.dumps(json.loads(get_http(cfg, '/v1/models')), indent=2))
    elif action == 'metrics':
        print(get_http(cfg, '/metrics').decode())
    elif action == 'flatten':
        which = cfg.text('FLAT_WHICH')
        if which not in {'model', 'draft'}:
            raise ConfigError('FLAT_WHICH must be model or draft')
        if cfg.text('MODEL_PATH' if which == 'model' else 'DRAFT_MODEL_PATH'):
            raise ConfigError('flatten expects an HF snapshot; unset the corresponding local path')
        source, _ = cfg.source(which)
        destination = cfg.path('FLAT_DIR')
        if destination.exists():
            raise ConfigError('FLAT_DIR already exists; choose a new destination (no overwrite)')
        command(['docker', 'run', '--rm', '--pull=never', *cfg.runtime_mounts_env(),
                 '-v', f'{destination.parent}:/flat_parent', '--entrypoint', 'python3', image_id(cfg),
                 '-c', 'import shutil,sys; shutil.copytree(sys.argv[1],sys.argv[2],symlinks=False)',
                 source, '/flat_parent/' + destination.name], cfg)
        print(f'Resolved copy: {destination}')
    else:
        raise ConfigError(f'Unknown action: {action}')


if __name__ == '__main__':
    try:
        main()
    except (ConfigError, OSError, ValueError, KeyError) as exc:
        print(f'ERROR: {exc}', file=sys.stderr)
        raise SystemExit(1)
