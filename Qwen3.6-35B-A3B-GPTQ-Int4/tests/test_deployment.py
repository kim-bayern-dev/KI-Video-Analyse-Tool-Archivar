from __future__ import annotations

import io
import json
import os
import re
from pathlib import Path
import shlex
import subprocess
import sys
import tempfile
import threading
import unittest
from contextlib import redirect_stdout
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from types import SimpleNamespace
from unittest.mock import Mock, patch

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'scripts'))
import deploy
import download_models
import check_runtime
import smoke_test


def make_env(*assignments: str) -> dict[str, str]:
    rule = '__test_env: ; @python3 -c "import os,json; print(json.dumps(dict(os.environ)))"'
    exported = set()
    for line in (ROOT / 'Makefile').read_text().splitlines():
        if line.startswith('export '):
            exported.update(line.split()[1:])
    exported.update({'MAKEFLAGS', 'MFLAGS', 'MAKEOVERRIDES', 'MAKELEVEL'})
    clean_env = {k: v for k, v in os.environ.items() if k not in exported}
    result = subprocess.run(['make', '-s', '--no-print-directory', 'ENV_FILE=/dev/null',
                             *assignments, '--eval', rule, '__test_env'], cwd=ROOT,
                            text=True, capture_output=True, check=True, env=clean_env)
    return json.loads(result.stdout)


BASE_ENV = make_env()


class SettingsTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.env = BASE_ENV.copy()
        for key in ('STATE_DIR', 'HF_HOME', 'HF_XET_CACHE_DIR', 'VLLM_CACHE_ROOT',
                    'TRITON_CACHE_DIR', 'TORCHINDUCTOR_CACHE_DIR', 'CUDA_CACHE_DIR',
                    'DATA_DIR', 'OUTPUT_DIR', 'LOGS_DIR', 'MOE_CONFIG_DIR'):
            self.env[key] = str(self.root / key.lower())
        self.cfg = deploy.Settings(self.env)

    def args(self, **changes):
        return deploy.Settings(self.env | changes).server_args(require_lock=False)

    def spec(self, **changes):
        args = self.args(**changes)
        return json.loads(args[args.index('--speculative-config') + 1])

    def write_lock(self, which='model', snapshot='hub/models--palmfuture--test/snapshots/' + 'a' * 40):
        repo = 'MODEL' if which == 'model' else 'DRAFT_MODEL'
        rev = 'MODEL_REVISION' if which == 'model' else 'DRAFT_REVISION'
        current = json.loads(self.cfg.lock_file.read_text()) if self.cfg.lock_file.exists() else {}
        current[which] = {'repo_id': self.env[repo], 'requested_revision': self.env[rev],
                          'revision': 'a' * 40, 'snapshot_rel': snapshot}
        deploy.atomic_json(self.cfg.lock_file, current)

    def test_default_target_retained(self):
        self.assertIn('palmfuture/Qwen3.6-35B-A3B-GPTQ-Int4', self.args())

    def test_default_quantization_is_omitted_not_empty(self):
        self.assertNotIn('--quantization', self.args())
        self.assertNotIn('', self.args())

    def test_blank_backends_are_omitted(self):
        self.assertNotIn('--attention-backend', self.args(ATTN_BACKEND=''))
        self.assertNotIn('attention_backend', self.spec(DRAFT_ATTN_BACKEND=''))

    def test_explicit_quantization_retained(self):
        self.assertIn('gptq_marlin', self.args(QUANTIZATION='gptq_marlin'))

    def test_moe_wna16_is_rejected(self):
        with self.assertRaisesRegex(deploy.ConfigError, 'auto-detection'):
            self.args(QUANTIZATION='moe_wna16')

    def test_dflash_separate_bf16_drafter(self):
        spec = self.spec()
        self.assertEqual(spec['method'], 'dflash')
        self.assertEqual(spec['model'], 'z-lab/Qwen3.6-35B-A3B-DFlash')
        self.assertIsNone(spec['quantization'])
        self.assertEqual(spec['draft_tensor_parallel_size'], 1)
        self.assertEqual(spec['kv_cache_dtype'], 'bfloat16')

    def test_draft_does_not_inherit_target_kv(self):
        spec = self.spec(KV_QUANT='fp8_e4m3', ATTN_BACKEND='TRITON_ATTN')
        self.assertEqual(spec['kv_cache_dtype'], 'bfloat16')
        self.assertEqual(spec['attention_backend'], 'FLASH_ATTN')

    def test_speculation_can_be_disabled(self):
        self.assertNotIn('--speculative-config', self.args(SPEC_DECODE='0'))

    def test_mtp_remains_explicit_option(self):
        self.assertEqual(self.spec(SPEC_METHOD='mtp'), {'method': 'mtp', 'num_speculative_tokens': 3})

    def test_v2_required(self):
        with self.assertRaisesRegex(deploy.ConfigError, 'requires V2'):
            self.args(VLLM_USE_V2_MODEL_RUNNER='0')

    def test_no_reasoning_controls_chat_template(self):
        args = self.args(NO_REASONING='1')
        self.assertEqual(json.loads(args[args.index('--default-chat-template-kwargs') + 1]),
                         {'enable_thinking': False})
        self.assertIn('--reasoning-parser', args)

    def test_original_thinking_default_retained(self):
        self.assertNotIn('--default-chat-template-kwargs', self.args())

    def test_context_and_scheduler_preserved(self):
        args = self.args()
        for flag, value in [('--max-model-len', '65536'), ('--max-num-seqs', '4'),
                            ('--max-num-batched-tokens', '8192')]:
            self.assertEqual(args[args.index(flag) + 1], value)

    def test_multimodal_options_preserved(self):
        args = self.args()
        limits = json.loads(args[args.index('--limit-mm-per-prompt') + 1])
        self.assertEqual(limits['video'], {'count': 1, 'num_frames': 32, 'width': 608, 'height': 448})
        self.assertEqual(limits['image']['count'], 1)

    def test_llm_only_excludes_media_allowance(self):
        args = self.args(LLM_ONLY='1')
        self.assertIn('--language-model-only', args)
        self.assertNotIn('--limit-mm-per-prompt', args)
        self.assertNotIn('--allowed-local-media-path', args)

    def test_empty_data_mount_disables_local_media(self):
        args = self.args(DATA_DIR='')
        self.assertNotIn('--allowed-local-media-path', args)
        self.assertFalse(any(x[0] == 'DATA_DIR' for x in deploy.Settings(self.env | {'DATA_DIR': ''}).storage()))

    def test_yarn_off_by_default(self):
        self.assertNotIn('--hf-overrides', self.args())

    def test_yarn_override_is_valid_json(self):
        args = self.args(ROPE_ENABLED='1')
        value = json.loads(args[args.index('--hf-overrides') + 1])
        self.assertEqual(value['text_config']['rope_parameters']['factor'], 2.0)

    def test_target_only_yarn_does_not_extend_dflash(self):
        with self.assertRaisesRegex(deploy.ConfigError, 'does not extend'):
            self.args(MAX_LEN='524288', ROPE_ENABLED='1')

    def test_tp_two_is_rejected(self):
        with self.assertRaisesRegex(deploy.ConfigError, 'TP must be 1'):
            self.args(TP='2')

    def test_ada_fp8_flashattention_conflict(self):
        with self.assertRaisesRegex(deploy.ConfigError, 'Ada'):
            self.args(PROFILE='ada', KV_QUANT='fp8_e4m3')
        self.args(PROFILE='ada', KV_QUANT='fp8_e4m3', ATTN_BACKEND='TRITON_ATTN')

    def test_obsolete_scale_flag_not_emitted(self):
        self.assertNotIn('--calculate-kv-scales', self.args())
        self.assertNotIn('--calculate-kv-scales', self.args(KV_QUANT='fp8_e4m3', ATTN_BACKEND='TRITON_ATTN'))

    def test_bytes_binary_and_decimal(self):
        self.assertEqual(deploy.parse_bytes('8G'), 8 * 2**30)
        self.assertEqual(deploy.parse_bytes('8g'), 8 * 10**9)
        self.assertEqual(deploy.parse_bytes('25.6k'), 25600)
        self.assertEqual(deploy.parse_bytes('1024'), 1024)
        for invalid in ['-1', '0', '8GiB', 'nan', '8G; true']:
            with self.assertRaises(deploy.ConfigError):
                deploy.parse_bytes(invalid)

    def test_empty_kv_budget_uses_fraction_sizing(self):
        self.assertNotIn('--kv-cache-memory-bytes', self.args(KV_CACHE_BYTES=''))

    def test_fraction_is_not_an_artificial_weight_budget(self):
        self.args(GPU_MEM_UTIL='0.13', KV_CACHE_BYTES='8G')

    def test_inline_make_comment_whitespace_is_stripped(self):
        args = self.args(MAX_LEN='65536 ', NUM_SPEC_TOKENS='3 ')
        self.assertEqual(args[args.index('--max-model-len') + 1], '65536')

    def test_invalid_numbers_fail(self):
        for changes in [{'MAX_LEN': '0'}, {'GPU_MEM_UTIL': 'nan'}, {'VIDEO_FPS': '-2'},
                        {'NO_REASONING': 'yes'}, {'PORT': '65536'}, {'READY_TIMEOUT': 'oops'}]:
            with self.subTest(changes=changes), self.assertRaises(deploy.ConfigError):
                self.args(**changes)

    def test_secret_is_redacted(self):
        cfg = deploy.Settings(self.env | {'API_KEY': "a very 'secret' key"})
        args = cfg.server_args(require_lock=False, redact=True)
        self.assertNotIn("a very 'secret' key", args)
        self.assertIn('<redacted>', args)

    def test_spaces_and_apostrophes_stay_single_arguments(self):
        cfg = deploy.Settings(self.env | {'HF_HOME': str(self.root / "disk with owner's space")})
        argv = cfg.runtime_mounts_env()
        self.assertIn(str(self.root / "disk with owner's space") + ':/hf', argv)

    def test_custom_container_hf_path_consistent(self):
        cfg = deploy.Settings(self.env | {'HF_HOME_IN_CONTAINER': '/models/hf'})
        args = cfg.runtime_mounts_env()
        self.assertIn('HF_HOME=/models/hf', args)
        self.assertIn('HF_HUB_CACHE=/models/hf/hub', args)
        self.assertIn(str(self.cfg.path('HF_HOME')) + ':/models/hf', args)

    def test_each_cache_has_env_and_volume(self):
        args = self.cfg.runtime_mounts_env()
        for host_key, internal, env_key in [
            ('HF_XET_CACHE_DIR', '/hf_xet_cache', 'HF_XET_CACHE'),
            ('TRITON_CACHE_DIR', '/triton_cache', 'TRITON_CACHE_DIR'),
            ('TORCHINDUCTOR_CACHE_DIR', '/torchinductor_cache', 'TORCHINDUCTOR_CACHE_DIR'),
            ('CUDA_CACHE_DIR', '/cuda_cache', 'CUDA_CACHE_PATH')]:
            self.assertIn(f'{self.env[host_key]}:{internal}', args)
            self.assertIn(f'{env_key}={internal}', args)

    def test_moe_override_does_not_shadow_bundled_configs(self):
        self.cfg.path('MOE_CONFIG_DIR').mkdir()
        args = self.cfg.runtime_mounts_env()
        self.assertIn('VLLM_TUNED_CONFIG_FOLDER=/moe_configs', args)
        self.assertFalse(any('python3.12' in arg for arg in args))

    def test_no_parse_time_nvidia_smi(self):
        result = subprocess.run(['make', '-s', 'ENV_FILE=/dev/null', 'print-config'],
                                cwd=ROOT, capture_output=True, text=True)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertNotIn('nvidia-smi', result.stderr)

    def test_gpu_uuid_is_resolved_lazily(self):
        with patch.object(deploy, 'command', return_value='GPU-01234567-abcd') as call:
            self.assertEqual(deploy.gpu_device(self.cfg), 'device=GPU-01234567-abcd')
            self.assertIn('1', call.call_args.args[0])

    def test_explicit_gpu_device_no_lookup(self):
        cfg = deploy.Settings(self.env | {'GPU_DEVICE': '"device=1"'})
        with patch.object(deploy, 'command') as call:
            self.assertEqual(deploy.gpu_device(cfg), 'device=1')
            call.assert_not_called()

    def test_multiple_gpu_selectors_rejected(self):
        for selection in ['all', 'device=0,1', 'device=all', 'device=']:
            with self.subTest(selection=selection), self.assertRaises(deploy.ConfigError):
                deploy.gpu_device(deploy.Settings(self.env | {'GPU_DEVICE': selection}))

    def test_start_requires_lock(self):
        with self.assertRaisesRegex(deploy.ConfigError, 'make download'):
            self.cfg.server_args()

    def test_portable_lock_uses_container_cache_root(self):
        self.write_lock()
        source, revision = self.cfg.source('model')
        self.assertTrue(source.startswith('/hf/hub/'))
        self.assertIsNone(revision)

    def test_lock_repository_mismatch_fails(self):
        self.write_lock()
        cfg = deploy.Settings(self.env | {'MODEL': 'other/model'})
        with self.assertRaisesRegex(deploy.ConfigError, 'differ from the lock'):
            cfg.source('model')

    def test_lock_traversal_rejected(self):
        self.write_lock(snapshot='../etc')
        with self.assertRaisesRegex(deploy.ConfigError, 'Unsafe'):
            self.cfg.source('model')

    def test_local_target_and_draft_no_lock_needed(self):
        args = deploy.Settings(self.env | {'MODEL_PATH': '/data/target',
                                          'DRAFT_MODEL_PATH': '/data/draft'}).server_args()
        self.assertEqual(args[2], '/model')
        self.assertEqual(json.loads(args[args.index('--speculative-config') + 1])['model'], '/draft_model')

    def test_restart_does_not_stop_on_failed_preflight(self):
        with patch.object(deploy, 'preflight', side_effect=deploy.ConfigError('bad GPU')), \
             patch.object(deploy, 'remove_container') as remove:
            with self.assertRaises(deploy.ConfigError):
                deploy.start(self.cfg, restart=True)
            remove.assert_not_called()

    def test_restart_orders_preflight_before_remove_and_launch(self):
        cfg = deploy.Settings(self.env | {'MODEL_PATH': '/data/target', 'DRAFT_MODEL_PATH': '/data/draft'})
        events = []
        with patch.object(deploy, 'preflight', side_effect=lambda c: (events.append('preflight') or ('sha256:' + 'a'*64, 'device=1'))), \
             patch.object(deploy, 'remove_container', side_effect=lambda c: events.append('remove')), \
             patch.object(deploy, 'command', side_effect=lambda *a, **k: events.append('launch') or ''), \
             patch.object(deploy, 'wait_ready', side_effect=lambda c: events.append('ready')):
            deploy.start(cfg, restart=True)
        self.assertEqual(events, ['preflight', 'remove', 'launch', 'ready'])
        self.assertEqual(len(list(cfg.path('OUTPUT_DIR').glob('launch-*.json'))), 1)

    def test_start_refuses_existing_name(self):
        with patch.object(deploy, 'container_exists', return_value=True), \
             patch.object(deploy, 'preflight') as preflight:
            with self.assertRaisesRegex(deploy.ConfigError, 'already exists'):
                deploy.start(self.cfg)
            preflight.assert_not_called()

    def test_download_no_draft_when_spec_off(self):
        cfg = deploy.Settings(self.env | {'SPEC_DECODE': '0'})
        with patch.object(deploy, 'image_id', return_value='sha256:' + 'a'*64), \
             patch.object(deploy, 'command') as call:
            deploy.download(cfg)
        self.assertIn('--skip-draft', call.call_args.args[0])

    def test_download_refresh_is_explicit(self):
        cfg = deploy.Settings(self.env | {'REFRESH_MODELS': '1'})
        with patch.object(deploy, 'image_id', return_value='sha256:' + 'a'*64), \
             patch.object(deploy, 'command') as call:
            deploy.download(cfg)
        self.assertIn('--refresh', call.call_args.args[0])

    def test_build_pulls_canonical_tag_then_checks_version_without_gpu(self):
        calls = []
        def run(args, cfg, capture=False):
            calls.append(args)
            return 'sha256:' + 'c' * 64 if 'inspect' in args else ''
        with patch.object(deploy, 'command', side_effect=run):
            deploy.build(self.cfg)
        self.assertEqual(calls[0], ['docker', 'pull', 'vllm/vllm-openai:v0.29.0'])
        self.assertIn('--version-only', calls[-1])
        self.assertFalse(any('--gpus' in args for args in calls))
        record = json.loads((self.cfg.path('STATE_DIR') / 'runtime-image.json').read_text())
        self.assertEqual(record['image_id'], 'sha256:' + 'c' * 64)

    def test_invalid_image_id_rejected(self):
        with patch.object(deploy, 'command', return_value='not an image'):
            with self.assertRaisesRegex(deploy.ConfigError, 'Invalid Docker image ID'):
                deploy.image_id(self.cfg)

    def test_bad_volume_container_collision_rejected(self):
        cfg = deploy.Settings(self.env | {'HF_HOME_IN_CONTAINER': '/state'})
        with self.assertRaisesRegex(deploy.ConfigError, 'distinct'):
            cfg.runtime_mounts_env()


class MakeTests(unittest.TestCase):
    def test_profile_fractions(self):
        for profile, fraction in [('ada', '0.90'), ('h100', '0.55'), ('h200', '0.30')]:
            self.assertEqual(make_env('PROFILE=' + profile)['GPU_MEM_UTIL'], fraction)

    def test_explicit_memory_override_wins_over_profile(self):
        env = make_env('PROFILE=ada', 'GPU_MEM_UTIL=0.75')
        self.assertEqual(env['GPU_MEM_UTIL'], '0.75')

    def test_custom_env_file_and_command_precedence(self):
        with tempfile.TemporaryDirectory() as tmp:
            file = Path(tmp) / 'selected.env'
            file.write_text('PROFILE=ada\nPORT=9123\nAPI_KEY=not-to-be-printed\n')
            env = make_env('ENV_FILE=' + str(file), 'PORT=9345')
        self.assertEqual(env['PROFILE'], 'ada')
        self.assertEqual(env['PORT'], '9345')
        self.assertEqual(env['API_KEY'], 'not-to-be-printed')

    def test_variant_does_not_overwrite_env(self):
        result = subprocess.run(['make', '-s', 'ENV_FILE=/dev/null', 'variant-h200'], cwd=ROOT,
                                text=True, capture_output=True, check=True)
        self.assertIn('has not been changed', result.stdout)


class SnapshotTests(unittest.TestCase):
    def test_cached_commit_reused_not_resolved_again(self):
        api = Mock()
        old = {'repo_id': 'owner/model', 'requested_revision': 'main', 'revision': 'a'*40}
        downloader = Mock(return_value='/hf/hub/models--owner--model/snapshots/' + 'a'*40)
        result = download_models.download_entry('owner/model', 'main', old, Path('/hf'), False, api, downloader)
        api.model_info.assert_not_called()
        self.assertEqual(result['revision'], 'a'*40)
        self.assertEqual(downloader.call_args.kwargs['revision'], 'a'*40)

    def test_refresh_resolves_new_commit(self):
        api = Mock()
        api.model_info.return_value.sha = 'b'*40
        downloader = Mock(return_value='/hf/hub/models--owner--model/snapshots/' + 'b'*40)
        old = {'repo_id': 'owner/model', 'requested_revision': 'main', 'revision': 'a'*40}
        result = download_models.download_entry('owner/model', 'main', old, Path('/hf'), True, api, downloader)
        self.assertEqual(result['revision'], 'b'*40)
        api.model_info.assert_called_once()

    def test_mutable_noncommit_api_result_rejected(self):
        api = Mock()
        api.model_info.return_value.sha = 'main'
        with self.assertRaises(ValueError):
            download_models.download_entry('owner/model', 'main', {}, Path('/hf'), False, api, Mock())

    def test_snapshot_checks_index_references(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            (root / 'config.json').write_text('{}')
            (root / 'model.safetensors.index.json').write_text(json.dumps({'weight_map': {'x': 'missing.safetensors'}}))
            with self.assertRaisesRegex(ValueError, 'Missing/empty'):
                check_runtime.inspect_snapshot(root)

    def test_snapshot_recognizes_complete_symlink_cache(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp) / 'snapshot'
            root.mkdir()
            (root / 'config.json').write_text('{}')
            blob = Path(tmp) / 'blob'
            blob.write_bytes(b'nonempty test data; not real model weights')
            (root / 'model.safetensors').symlink_to(blob)
            self.assertEqual(check_runtime.inspect_snapshot(root), {})

    def test_draft_metadata_checks(self):
        target = {'text_config': {'hidden_size': 2048, 'vocab_size': 248320, 'num_hidden_layers': 40}}
        draft = {'hidden_size': 2048, 'vocab_size': 248320, 'num_target_layers': 40,
                 'dflash_config': {'block_size': 16, 'target_layer_ids': [1, 6, 37]}}
        check_runtime.validate_pair(target, draft, 15)
        with self.assertRaisesRegex(ValueError, 'between 1 and 15'):
            check_runtime.validate_pair(target, draft, 16)
        with self.assertRaisesRegex(ValueError, 'mismatch'):
            check_runtime.validate_pair(target, draft | {'hidden_size': 3072}, 3)

    def test_quantized_draft_rejected_for_this_recipe(self):
        target = {'hidden_size': 2048, 'vocab_size': 248320, 'num_hidden_layers': 40}
        draft = target | {'dflash_config': {}, 'quantization_config': {'bits': 4}}
        with self.assertRaisesRegex(ValueError, 'unquantized BF16'):
            check_runtime.validate_pair(target, draft, 3)


class StreamTests(unittest.TestCase):
    def test_stream_with_usage_chunk(self):
        lines = [b'data: {"choices":[{"delta":{"content":"OK"}}]}\n',
                 b'data: {"choices":[],"usage":{"completion_tokens":1}}\n', b'data: [DONE]\n']
        self.assertEqual(smoke_test.streaming_content(lines), 'OK')

    def test_stream_reasoning_only_fails(self):
        with self.assertRaisesRegex(ValueError, 'content'):
            smoke_test.streaming_content([b'data: {"choices":[{"delta":{"reasoning":"OK"}}]}\n', b'data: [DONE]\n'])

    def test_incomplete_stream_fails(self):
        with self.assertRaisesRegex(ValueError, 'Incomplete'):
            smoke_test.streaming_content([b'data: {"choices":[{"delta":{"content":"OK"}}]}\n'])

    def test_live_local_http_fixture_exercises_all_smoke_paths(self):
        received = []
        class Handler(BaseHTTPRequestHandler):
            def do_POST(self):
                body = json.loads(self.rfile.read(int(self.headers['Content-Length'])))
                received.append((body, self.headers.get('Authorization')))
                self.send_response(200)
                self.end_headers()
                if body.get('stream'):
                    self.wfile.write(b'data: {"choices":[{"delta":{"content":"OK"}}]}\n\ndata: [DONE]\n\n')
                    return
                message = {'content': 'OK'}
                if 'response_format' in body:
                    message = {'content': '{"ok":true}'}
                if 'tools' in body:
                    message = {'tool_calls': [{'function': {'name': 'report_status', 'arguments': '{"ok":true}'}}]}
                self.wfile.write(json.dumps({'choices': [{'message': message}]}).encode())
            def log_message(self, *_):
                pass
        server = ThreadingHTTPServer(('127.0.0.1', 0), Handler)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        try:
            with tempfile.TemporaryDirectory() as tmp:
                env = BASE_ENV | {'BIND_ADDR': '127.0.0.1', 'PORT': str(server.server_port),
                                  'OUTPUT_DIR': tmp, 'API_KEY': 'fixture-secret'}
                with patch.dict(os.environ, env, clear=True), redirect_stdout(io.StringIO()):
                    smoke_test.main()
                reports = list(Path(tmp).glob('smoke-*.json'))
                self.assertEqual(len(reports), 1)
                self.assertEqual(len(json.loads(reports[0].read_text())), 4)
            self.assertEqual(len(received), 4)
            self.assertTrue(all(auth == 'Bearer fixture-secret' for _, auth in received))
        finally:
            server.shutdown()
            server.server_close()
            thread.join()


if __name__ == '__main__':
    unittest.main()
