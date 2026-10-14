#!/usr/bin/env python3
"""Live HTTP smoke tests. These are NOT throughput measurements or quality proofs."""
from __future__ import annotations

import json
import sys
import time
import urllib.request
from deploy import Settings, atomic_json, base_url


def payload(cfg: Settings, prompt: str) -> dict:
    return {'model': cfg.text('SERVED_NAME'), 'messages': [{'role': 'user', 'content': prompt}],
            'temperature': 0, 'max_tokens': 256,
            'chat_template_kwargs': {'enable_thinking': False}}


def request(cfg: Settings, data: dict):
    return urllib.request.urlopen(urllib.request.Request(
        base_url(cfg) + '/v1/chat/completions', data=json.dumps(data).encode(),
        headers={'Content-Type': 'application/json', 'Authorization': 'Bearer ' + cfg.env['API_KEY']}),
        timeout=cfg.number('REQUEST_TIMEOUT'))


def call(cfg: Settings, data: dict) -> dict:
    with request(cfg, data) as response:
        result = json.load(response)
    if not result.get('choices'):
        raise ValueError('Response has no choices: ' + json.dumps(result))
    return result


def streaming_content(lines) -> str:
    content = []
    done = False
    for raw in lines:
        line = raw.decode().strip()
        if not line.startswith('data:'):
            continue
        data = line[5:].strip()
        if data == '[DONE]':
            done = True
            break
        chunk = json.loads(data)
        if 'error' in chunk:
            raise ValueError('Stream error: ' + json.dumps(chunk['error']))
        for choice in chunk.get('choices', []):
            piece = choice.get('delta', {}).get('content')
            if piece:
                content.append(piece)
    if not done or not ''.join(content).strip():
        raise ValueError('Incomplete stream or no final content; inspect reasoning/content routing')
    return ''.join(content)


def main() -> None:
    cfg = Settings()
    results = []
    destination = cfg.path('OUTPUT_DIR') / f'smoke-{time.time_ns()}.json'
    try:
        result = call(cfg, payload(cfg, 'Reply with the word OK.'))
        content = result['choices'][0]['message'].get('content')
        if not isinstance(content, str) or not content.strip():
            raise ValueError('Text test returned empty content')
        results.append({'test': 'text', 'passed': True, 'response': result})

        data = payload(cfg, 'Reply with the word OK.')
        data['stream'] = True
        with request(cfg, data) as response:
            content = streaming_content(response)
        results.append({'test': 'streaming', 'passed': True, 'content': content})

        data = payload(cfg, 'Return a JSON object indicating success: ok is true.')
        schema = {'type': 'object', 'properties': {'ok': {'type': 'boolean', 'const': True}},
                  'required': ['ok'], 'additionalProperties': False}
        data['response_format'] = {'type': 'json_schema', 'json_schema': {
            'name': 'status', 'strict': True, 'schema': schema}}
        result = call(cfg, data)
        if json.loads(result['choices'][0]['message']['content']) != {'ok': True}:
            raise ValueError('JSON-schema test failed')
        results.append({'test': 'json_schema', 'passed': True, 'response': result})

        data = payload(cfg, 'Call report_status with ok=true. Do not reply in prose.')
        data['tools'] = [{'type': 'function', 'function': {'name': 'report_status',
                         'description': 'Report success.', 'parameters': schema}}]
        # Exercise the server's automatic tool-call parser.
        data['tool_choice'] = 'auto'
        result = call(cfg, data)
        calls = result['choices'][0]['message'].get('tool_calls', [])
        if not any(item.get('function', {}).get('name') == 'report_status' and
                   json.loads(item['function']['arguments']) == {'ok': True} for item in calls):
            raise ValueError('Automatic tool-call test failed (model behavior or parser)')
        results.append({'test': 'automatic_tool_call', 'passed': True, 'response': result})
    except Exception as exc:
        results.append({'test': 'failed', 'passed': False, 'error': str(exc)})
        atomic_json(destination, results)
        print(f'SMOKE FAIL: {exc}\nReport: {destination}', file=sys.stderr)
        raise SystemExit(1)
    atomic_json(destination, results)
    print(f'4 live smoke checks passed. Report: {destination}')
    print('These checks do not establish long-context capacity, exact output equivalence, '
          'multimodal correctness, or tokens/s.')


if __name__ == '__main__':
    main()
