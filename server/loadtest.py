"""Many visitors at once against the bridge -- without using the GPUs.

  1. A stand-in for Ollama that answers every chat after a short delay:
       python server/loadtest.py stub --port 11600 --delay 1.5

  2. The bridge, pointed at it and trusting X-Forwarded-For so each
     simulated visitor gets its own address. (Only for this test: never set
     TRUST_PROXY=1 on a bridge that isn't behind a proxy.)
       OLLAMA_URL=http://127.0.0.1:11600 TRUST_PROXY=1 BRIDGE_PORT=8799 python server/bridge.py

  3. The visitors:
       python server/loadtest.py run --url http://127.0.0.1:8799 --users 12 --messages 3

It checks that the defenses hold: ordinary visitors get answers or a polite
"busy" (never a hang), one visitor flooding requests gets rate limited, and
oversized requests, a request for a different model, and a tool call aimed
at the local network are all refused. Exits non-zero if any check fails.
"""
import argparse
import asyncio
import random
import statistics
import sys
import time
from collections import Counter

import aiohttp
from aiohttp import web


# ---- The stand-in for Ollama ----

def run_stub(port: int, delay: float) -> None:
    lock = asyncio.Lock()  # like the real GPUs: one answer at a time

    async def chat(request: web.Request) -> web.Response:
        body = await request.json()
        async with lock:
            await asyncio.sleep(delay)
        # Echo the model it was asked for, so the test can check the bridge's choice.
        return web.json_response({'message': {'role': 'assistant', 'content': f"model={body.get('model')}"}, 'done': True})

    async def tags(request: web.Request) -> web.Response:
        return web.json_response({'models': []})

    app = web.Application(client_max_size=64 * 1024 * 1024)
    app.add_routes([web.post('/api/chat', chat), web.get('/api/tags', tags)])
    print(f"stand-in Ollama on http://127.0.0.1:{port}, {delay}s per answer")
    web.run_app(app, host='127.0.0.1', port=port, print=None)


# ---- The visitors ----

def chat_body(text: str, model: str = 'gemma3-12b-gpu') -> dict:
    return {
        'model': model,
        'messages': [{'role': 'system', 'content': 'You are a test.'}, {'role': 'user', 'content': text}],
        'stream': False,
        'options': {'num_ctx': 8192},
    }


async def post(session: aiohttp.ClientSession, url: str, body, visitor: str) -> tuple[int, float, dict]:
    started = time.monotonic()
    headers = {'X-Forwarded-For': visitor}
    try:
        async with session.post(url, json=body, headers=headers) as response:
            data = await response.json(content_type=None)
            return response.status, time.monotonic() - started, data or {}
    except (aiohttp.ClientError, asyncio.TimeoutError) as e:
        return 0, time.monotonic() - started, {'error': f"{type(e).__name__}: {e}"}


async def ordinary_visitor(session, base: str, n: int, messages: int, results: list) -> None:
    visitor = f'203.0.113.{n}'
    for i in range(messages):
        await asyncio.sleep(random.uniform(0, 0.5))  # people don't all type at once
        results.append(await post(session, f'{base}/ollama/api/chat', chat_body(f'visitor {n} message {i}'), visitor))


async def run_test(base: str, users: int, messages: int) -> bool:
    timeout = aiohttp.ClientTimeout(total=200)
    ok = True

    def check(passed: bool, label: str, detail: str) -> None:
        nonlocal ok
        ok &= passed
        print(f"  [{'PASS' if passed else 'FAIL'}] {label}: {detail}")

    async with aiohttp.ClientSession(timeout=timeout) as session:
        print(f"\n{users} visitors x {messages} messages at once, plus one flooding visitor...")
        started = time.monotonic()
        normal: list = []
        flood_visitor = '198.51.100.7'
        flood = asyncio.gather(*[
            post(session, f'{base}/ollama/api/chat', chat_body(f'flood {i}'), flood_visitor) for i in range(60)
        ])
        await asyncio.gather(*[ordinary_visitor(session, base, n, messages, normal) for n in range(1, users + 1)])
        flood_results = await flood
        took = time.monotonic() - started

        statuses = Counter(status for status, _, _ in normal)
        answered = [latency for status, latency, _ in normal if status == 200]
        print(f"  ordinary visitors: {dict(statuses)} in {took:.1f}s")
        if answered:
            print(f"  answered in {statistics.mean(answered):.1f}s on average, {max(answered):.1f}s at worst")
        for status, _, data in normal:
            if status not in (200, 503):
                print(f"  unexpected {status}: {data.get('error')}")
        check(set(statuses) <= {200, 503}, "ordinary visitors", "every request answered or told the bot is busy -- no errors")
        check(bool(answered), "ordinary visitors", f"{len(answered)} of {len(normal)} got answers")
        flood_statuses = Counter(status for status, _, _ in flood_results)
        check(flood_statuses.get(429, 0) > 0, "flooding visitor", f"rate limited: {dict(flood_statuses)}")

        print("\nRequests that should be refused...")
        status, _, data = await post(session, f'{base}/ollama/api/chat', chat_body('x' * 4_000_000), '192.0.2.1')
        check(status == 413, "4MB message", f"{status} {data.get('error', '')}")
        status, _, data = await post(session, f'{base}/ollama/api/chat', {'messages': []}, '192.0.2.2')
        check(status == 400, "empty conversation", f"{status} {data.get('error', '')}")
        status, _, data = await post(session, f'{base}/ollama/api/chat', chat_body('hi', model='llama3:70b'), '192.0.2.3')
        answer = (data.get('message') or {}).get('content', '')
        check(status in (200, 503) and 'llama3' not in answer, "asking for another model", f"{status}, model used: {answer or data.get('error')}")
        status, _, data = await post(session, f'{base}/api/tools/call', {'name': 'fetch_page', 'args': {'url': 'http://10.7.163.103:11434/api/tags'}}, '192.0.2.4')
        check("only public websites" in data.get('text', ''), "reading a LAN address", data.get('text') or data.get('error', ''))
        status, _, data = await post(session, f'{base}/api/tools/call', {'name': 'fetch_page', 'args': {'url': 'http://localhost:8765/'}}, '192.0.2.5')
        check("only public websites" in data.get('text', ''), "reading this machine", data.get('text') or data.get('error', ''))

        async with session.get(f'{base}/healthz') as response:
            health = await response.json()
        check(response.status in (200, 503) and 'model_server' in health, "health check", f"{response.status} {health}")

    print("\nAll checks passed." if ok else "\nSome checks failed.")
    return ok


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = parser.add_subparsers(dest='command', required=True)
    stub = sub.add_parser('stub', help='run the stand-in Ollama')
    stub.add_argument('--port', type=int, default=11600)
    stub.add_argument('--delay', type=float, default=1.5, help='seconds per answer')
    run = sub.add_parser('run', help='send the visitors')
    run.add_argument('--url', default='http://127.0.0.1:8799')
    run.add_argument('--users', type=int, default=12)
    run.add_argument('--messages', type=int, default=3)
    args = parser.parse_args()

    if args.command == 'stub':
        run_stub(args.port, args.delay)
    else:
        sys.exit(0 if asyncio.run(run_test(args.url.rstrip('/'), args.users, args.messages)) else 1)


if __name__ == '__main__':
    main()
