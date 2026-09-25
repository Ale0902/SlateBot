"""Local bridge between the celta-chat page and the tools/LLM it uses.

A browser can't spawn a stdio MCP server, and Ollama rejects cross-origin
requests from a page opened as a file (Origin: null), so this process does
both jobs for it:

- Starts this project's tool server (server/mcp_server.py) over stdio and
  exposes its tools as two JSON endpoints.
- Proxies /ollama/api/chat to the Ollama server, one request at a time, and
  pre-processes each chat's next request in the background (/ollama/prime).
- Reads link previews (title, description, thumbnail) for the page, which
  can't fetch other sites itself.
- Serves the page itself at http://localhost:8765 (and a 2000s-messenger
  skin of the same page at /retro/). A copy of the page
  served some other way on this machine (e.g. VS Code Live Server on :5500)
  can call it too -- CORS allows any localhost origin, nothing else.

Run from the project root:  npm start   (or: python server/bridge.py)

Before putting it on the internet: it's built to sit behind a reverse proxy
that handles HTTPS (Caddy, nginx, Cloudflare Tunnel...), with BRIDGE_HOST
left at 127.0.0.1 and TRUST_PROXY=1 so rate limits see each visitor's real
address. Every limit below can be changed with an environment variable,
or in a .env file in the project root (see .env.example).
"""
import asyncio
import contextlib
import hashlib
import json
import logging
import logging.handlers
import math
import os
import re
import secrets
import sys
import time
from collections import OrderedDict, deque
from datetime import date
from urllib.parse import urljoin, urlparse

import aiohttp
import requests
import uvicorn
from bs4 import BeautifulSoup
from dotenv import load_dotenv
from mcp import ClientSession, StdioServerParameters
from mcp.client.stdio import stdio_client
from starlette.applications import Starlette
from starlette.middleware import Middleware
from starlette.middleware.cors import CORSMiddleware
from starlette.requests import Request
from starlette.responses import FileResponse, JSONResponse, Response
from starlette.routing import Mount, Route
from starlette.staticfiles import StaticFiles

from safe_fetch import BlockedURL, get_public, is_public_host, read_limited

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
# Settings can also live in a .env file in the project root. Real
# environment variables win over it.
load_dotenv(os.path.join(ROOT, '.env'))

# The Linux VM hosts Ollama and SearXNG, so a local .env is not required for
# the normal setup. Individual service URLs still override this.
SLATEBOT_HOST = os.getenv('SLATEBOT_HOST', '10.7.163.103')
OLLAMA_URL = os.getenv('OLLAMA_URL', f'http://{SLATEBOT_HOST}:11434').rstrip('/')
# Passed on to the tool server, so both always use the same one.
SEARXNG_URL = os.getenv('SEARXNG_URL', f'http://{SLATEBOT_HOST}:8080')
MCP_SERVER_SCRIPT = os.getenv('MCP_SERVER_SCRIPT', os.path.join(ROOT, 'server', 'mcp_server.py'))
HOST = os.getenv('BRIDGE_HOST', '127.0.0.1')
PORT = int(os.getenv('BRIDGE_PORT', '8765'))

OLLAMA_TIMEOUT = 180
TOOL_TIMEOUT = 60


def _env_int(name: str, default: int) -> int:
    try:
        return int(os.getenv(name, default))
    except ValueError:
        return default


# ---- Limits for a public site ----
# Behind a reverse proxy every request comes from the proxy's address, so
# the visitor's is read from X-Forwarded-For -- only when this is set, since
# otherwise anyone could send that header and pose as someone else.
TRUST_PROXY = os.getenv('TRUST_PROXY') == '1'

# The only model and context size the page may use -- a caller can't pick a
# different (or bigger) model, or ask for a huge context, whatever it sends.
OLLAMA_MODEL = os.getenv('OLLAMA_MODEL', 'gemma3-12b-gpu')
OLLAMA_NUM_CTX = _env_int('OLLAMA_NUM_CTX', 8192)
MAX_REPLY_TOKENS = _env_int('MAX_REPLY_TOKENS', 2048)

# What one chat request may contain. The page's biggest real request -- the
# system prompt, 16 earlier messages, and a few tool rounds with a fetched
# page -- is well inside these.
MAX_CHAT_BODY_BYTES = _env_int('MAX_CHAT_BODY_BYTES', 3_000_000)
MAX_MESSAGES = _env_int('MAX_MESSAGES', 40)
MAX_TOTAL_CHARS = _env_int('MAX_TOTAL_CHARS', 150_000)
MAX_IMAGES = _env_int('MAX_IMAGES', 1)
MAX_IMAGE_BASE64 = _env_int('MAX_IMAGE_BASE64', 1_500_000)  # the page sends ~150KB
MAX_TOOL_BODY_BYTES = 10_000
MAX_TOOL_ARG_CHARS = 2000

# Per visitor. One question is several chat requests (the model's tool
# rounds), so these allow a brisk conversation but not a script.
CHAT_PER_MINUTE = _env_int('CHAT_PER_MINUTE', 30)
CHAT_PER_HOUR = _env_int('CHAT_PER_HOUR', 300)
TOOLS_PER_MINUTE = _env_int('TOOLS_PER_MINUTE', 30)
PREVIEWS_PER_MINUTE = _env_int('PREVIEWS_PER_MINUTE', 60)
PRIMES_PER_MINUTE = _env_int('PRIMES_PER_MINUTE', 20)
# Replies one visitor can be waiting on at once -- 2, not 1, so a household
# or school sharing one address can still both use it.
MAX_PENDING_PER_VISITOR = _env_int('MAX_PENDING_PER_VISITOR', 2)

# The GPUs answer one request at a time. A new one is turned away up front
# (rather than left to time out in the page) when the line ahead of it would
# take longer than MAX_QUEUE_WAIT at the recent pace, or is simply this long.
MAX_QUEUED_CHATS = _env_int('MAX_QUEUED_CHATS', 20)
MAX_QUEUE_WAIT = _env_int('MAX_QUEUE_WAIT', 120)

# Daily caps for the whole site (0 = none): generations, which cost GPU time
# and power, and web searches, which can fall back to Brave's API and its
# 2,000-a-month free quota. They reset at midnight, server time.
DAILY_CHAT_CAP = _env_int('DAILY_CHAT_CAP', 5000)
DAILY_SEARCH_CAP = _env_int('DAILY_SEARCH_CAP', 1000)
SEARCH_TOOLS = {'web_search', 'image_search'}

# Repeat tool calls are answered from memory for a while: the same search or
# page within 10 minutes, the same stock chart within 5.
TOOL_CACHE_SECONDS = {
    'web_search': 600,
    'image_search': 600,
    'wikipedia_summary': 600,
    'fetch_page': 600,
    'compare_stock_performance': 300,
    'stock_price_history': 300,
}
TOOL_CACHE_SIZE = 500

LOG_DIR = os.getenv('BRIDGE_LOG_DIR', os.path.join(ROOT, 'logs'))

# Link previews: the page's own metadata (og:title, og:image, ...) is read
# from at most this much of the HTML, which is where <head> lives.
UNFURL_TIMEOUT = 8
UNFURL_MAX_BYTES = 1_000_000
UNFURL_CACHE_SIZE = 500
# A browser-like UA -- plenty of sites serve an empty page or a block page
# (with no preview tags) to anything that looks like a script.
UNFURL_USER_AGENT = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/126.0 Safari/537.36"
)

CHART_PATH_RE = re.compile(r'^CHART_PATH:\s*(.+?)\s*$', re.MULTILINE)

# Chart PNGs a tool actually rendered, by the name they're served under.
# Only these are ever served, so /charts/ can't be used to read other files.
# Past MAX_CHARTS the oldest are deleted, so a busy public site doesn't fill
# the disk (the rest go when the bridge stops).
_charts: dict[str, str] = {}
MAX_CHARTS = 200


# ---- Logging ----
# To the console and to logs/bridge.log (rotated at 1MB, 5 kept). Errors,
# restarts and turned-away requests only -- never what anyone wrote, and
# visitors appear as a scrambled tag rather than their address. The tag's
# salt is new every run, so tags can't be matched across restarts either.
log = logging.getLogger('bridge')
log.setLevel(logging.INFO)
_console = logging.StreamHandler(sys.stderr)
_console.setFormatter(logging.Formatter('[bridge] %(message)s'))
log.addHandler(_console)
try:
    os.makedirs(LOG_DIR, exist_ok=True)
    _file = logging.handlers.RotatingFileHandler(
        os.path.join(LOG_DIR, 'bridge.log'), maxBytes=1_000_000, backupCount=5, encoding='utf-8'
    )
    _file.setFormatter(logging.Formatter('%(asctime)s %(levelname)s %(message)s'))
    log.addHandler(_file)
except OSError as e:
    log.warning(f"can't write logs to {LOG_DIR} ({e}) -- console only")

_LOG_SALT = secrets.token_bytes(16)


def _log(message: str) -> None:
    log.info(message)


def _describe_exception(e: BaseException) -> str:
    """Unwraps the ExceptionGroups anyio's TaskGroup (inside the MCP client)
    wraps failures in, which otherwise just say "unhandled errors in a
    TaskGroup" with no detail."""
    if isinstance(e, BaseExceptionGroup):
        return "; ".join(_describe_exception(sub) for sub in e.exceptions)
    return f"{type(e).__name__}: {e}"


def _describe_tool(tool) -> dict:
    """{name, param, description} -- every tool on this server takes exactly
    one string argument, so its name is read off the JSON schema. The
    description is the docstring's first full sentence, not its first
    source line (the docstrings are hand-wrapped mid-sentence)."""
    props = (tool.input_schema or {}).get('properties', {})
    joined = ' '.join(line.strip() for line in (tool.description or '').strip().splitlines())
    first_sentence = joined.split('. ')[0].rstrip('.')
    return {
        'name': tool.name,
        'param': next(iter(props), ''),
        'description': f"{first_sentence}." if first_sentence else '',
    }


def _publish_charts(text: str) -> str:
    """Swaps each CHART_PATH's local file path for the URL it's served at.
    The page pulls the marker out of the result as a side channel -- the
    path never goes through the model's reply."""
    def swap(match: re.Match) -> str:
        path = match.group(1)
        name = os.path.basename(path)
        _charts.pop(name, None)  # re-added below as the newest
        _charts[name] = path
        while len(_charts) > MAX_CHARTS:
            with contextlib.suppress(OSError):
                os.remove(_charts.pop(next(iter(_charts))))
        return f"CHART_PATH: /charts/{name}"
    return CHART_PATH_RE.sub(swap, text)


_previews: dict[str, dict | None] = {}


def _fetch_preview(url: str) -> dict | None:
    """{url, title, description, image, siteName} from a page's Open Graph /
    Twitter card / <title> tags, or None if it can't be previewed. Only
    pages on the public internet -- never this machine or the LAN, even via
    a redirect (see safe_fetch.py)."""
    try:
        response = get_public(
            url,
            headers={'User-Agent': UNFURL_USER_AGENT, 'Accept': 'text/html,*/*;q=0.8'},
            timeout=UNFURL_TIMEOUT,
        )
    except BlockedURL:
        return None

    with response:
        page_url = response.url  # where any redirects ended up
        if not response.ok:
            return None
        content_type = response.headers.get('content-type', '').lower()
        host = (urlparse(page_url).hostname or '').removeprefix('www.')
        if content_type.startswith('image/'):
            return {'url': url, 'title': '', 'description': '', 'image': page_url, 'siteName': host}
        if 'html' not in content_type:
            return None
        body = read_limited(response, UNFURL_MAX_BYTES)

    soup = BeautifulSoup(body, 'html.parser', from_encoding=response.encoding if 'charset' in content_type else None)

    def meta(*keys: str) -> str:
        for key in keys:
            tag = soup.find('meta', attrs={'property': key}) or soup.find('meta', attrs={'name': key})
            if tag and tag.get('content', '').strip():
                return ' '.join(tag['content'].split())
        return ''

    title = meta('og:title', 'twitter:title')
    if not title and soup.title and soup.title.string:
        title = ' '.join(soup.title.string.split())
    image = meta('og:image:secure_url', 'og:image', 'og:image:url', 'twitter:image', 'twitter:image:src')
    image = urljoin(page_url, image) if image else ''
    if urlparse(image).scheme not in ('http', 'https'):
        image = ''

    if not title and not image:
        return None
    return {
        'url': url,
        'title': title[:200],
        'description': meta('og:description', 'twitter:description', 'description')[:300],
        'image': image,
        'siteName': meta('og:site_name')[:80] or host,
    }


# ---- Visitors, limits and request checks ----

def _client_ip(request: Request) -> str:
    if TRUST_PROXY:
        # The proxy appends the address it saw, so the last entry is the one
        # to trust -- anything before it came from the visitor's own request.
        forwarded = request.headers.get('x-forwarded-for', '')
        if forwarded:
            return forwarded.split(',')[-1].strip()
    return request.client.host if request.client else 'unknown'


def _client_tag(ip: str) -> str:
    return hashlib.sha256(_LOG_SALT + ip.encode()).hexdigest()[:10]


class RateLimiter:
    """Requests per visitor over sliding windows, kept in memory."""

    def __init__(self, name: str, limits: list[tuple[int, int]]) -> None:
        self.name = name
        self.limits = [(count, window) for count, window in limits if count > 0]
        self.longest = max((window for _, window in self.limits), default=0)
        self.hits: dict[str, deque[float]] = {}

    def check(self, key: str) -> float:
        """Records the request and returns 0, or returns how many seconds
        until it would be allowed (and records nothing)."""
        now = time.monotonic()
        hits = self.hits.setdefault(key, deque())
        while hits and now - hits[0] > self.longest:
            hits.popleft()
        for count, window in self.limits:
            recent = [t for t in hits if now - t <= window]
            if len(recent) >= count:
                return window - (now - recent[len(recent) - count])
        hits.append(now)
        if len(self.hits) > 10_000:  # forget visitors who've gone quiet
            for stale in [k for k, h in self.hits.items() if not h or now - h[-1] > self.longest]:
                del self.hits[stale]
        return 0


class DailyCap:
    def __init__(self, limit: int) -> None:
        self.limit = limit
        self.day: date | None = None
        self.count = 0

    def take(self) -> bool:
        today = date.today()
        if today != self.day:
            self.day, self.count = today, 0
        if self.limit and self.count >= self.limit:
            return False
        self.count += 1
        return True


chat_limiter = RateLimiter('chat', [(CHAT_PER_MINUTE, 60), (CHAT_PER_HOUR, 3600)])
tool_limiter = RateLimiter('tools', [(TOOLS_PER_MINUTE, 60)])
preview_limiter = RateLimiter('previews', [(PREVIEWS_PER_MINUTE, 60)])
prime_limiter = RateLimiter('prime', [(PRIMES_PER_MINUTE, 60)])
daily_chats = DailyCap(DAILY_CHAT_CAP)
daily_searches = DailyCap(DAILY_SEARCH_CAP)


def _refuse(message: str, status: int, retry_after: float | None = None) -> JSONResponse:
    headers = {'Retry-After': str(max(1, math.ceil(retry_after)))} if retry_after else None
    return JSONResponse({'error': message}, status_code=status, headers=headers)


def _limited(limiter: RateLimiter, request: Request) -> JSONResponse | None:
    """A 429 if this visitor is over the limit, else None."""
    ip = _client_ip(request)
    wait = limiter.check(ip)
    if not wait:
        return None
    log.warning(f"rate limited: {limiter.name}, visitor {_client_tag(ip)}")
    seconds = max(1, math.ceil(wait))
    return _refuse(
        f"You're going a bit fast -- try again in {seconds} second{'s' if seconds != 1 else ''}.",
        429,
        seconds,
    )


async def _read_body(request: Request, limit: int) -> bytes | None:
    """The request body, or None if it's over `limit` bytes -- stops reading
    as soon as it is, rather than taking in whatever was sent."""
    declared = request.headers.get('content-length', '')
    if declared.isdigit() and int(declared) > limit:
        return None
    body = bytearray()
    async for chunk in request.stream():
        body += chunk
        if len(body) > limit:
            return None
    return bytes(body)


def _clean_chat_request(body: bytes) -> dict | str:
    """Rebuilds the one kind of /api/chat request the page makes from what
    was sent, or returns why it can't. Only the messages come from the
    caller: the model, context size, reply length and streaming are fixed
    here, and anything else is dropped rather than passed on to Ollama."""
    try:
        data = json.loads(body)
    except ValueError:
        return "Expected a JSON request."
    messages = data.get('messages') if isinstance(data, dict) else None
    if not isinstance(messages, list) or not messages:
        return "There's no message to send."
    if len(messages) > MAX_MESSAGES:
        return "That conversation is too long to send -- start a new chat."

    clean, total_chars, images = [], 0, 0
    for message in messages:
        if (
            not isinstance(message, dict)
            or message.get('role') not in ('system', 'user', 'assistant')
            or not isinstance(message.get('content'), str)
        ):
            return "Every message needs a role and text."
        item = {'role': message['role'], 'content': message['content']}
        total_chars += len(message['content'])
        attached = message.get('images')
        if attached is not None:
            if not isinstance(attached, list) or not all(isinstance(i, str) for i in attached):
                return "Images must be sent as base64 text."
            if any(len(i) > MAX_IMAGE_BASE64 for i in attached):
                return "That image is too large."
            images += len(attached)
            item['images'] = attached
        clean.append(item)

    if total_chars > MAX_TOTAL_CHARS:
        return "That conversation is too long to send -- start a new chat."
    if images > MAX_IMAGES:
        return f"Only {MAX_IMAGES} image{'s' if MAX_IMAGES != 1 else ''} can be sent at a time."
    return {
        'model': OLLAMA_MODEL,
        'messages': clean,
        'stream': False,
        'options': {'num_ctx': OLLAMA_NUM_CTX, 'num_predict': MAX_REPLY_TOKENS},
    }


# Tool results by (tool, arguments): (when stored, text), oldest first.
_tool_cache: OrderedDict[tuple, tuple[float, str]] = OrderedDict()


def _cached_tool_result(key: tuple, max_age: int) -> str | None:
    hit = _tool_cache.get(key)
    if not hit or time.monotonic() - hit[0] > max_age:
        return None
    _tool_cache.move_to_end(key)
    return hit[1]


def _cache_tool_result(key: tuple, text: str) -> None:
    # Failures are worded as text by the tools themselves; don't keep them.
    if re.search(r"unavailable|failed|couldn't|error", text[:300], re.IGNORECASE):
        return
    _tool_cache[key] = (time.monotonic(), text)
    _tool_cache.move_to_end(key)
    while len(_tool_cache) > TOOL_CACHE_SIZE:
        _tool_cache.popitem(last=False)


class McpTools:
    """Owns one long-lived stdio session with the MCP server. The session
    lives entirely inside run()'s task (anyio requires a context to be
    exited by the task that entered it), so calls reach it through a queue,
    and a crashed server is restarted there rather than by whichever
    request happened to notice.

    Calls run side by side, each in its own task: the tool server runs every
    call in its own thread, so one visitor's slow page read doesn't hold up
    everyone else's searches."""

    def __init__(self) -> None:
        self.tools: list[dict] = []
        self.ready = asyncio.Event()
        self._calls: asyncio.Queue = asyncio.Queue()
        self._stopping = False

    async def run(self) -> None:
        env = dict(os.environ, SEARXNG_URL=SEARXNG_URL)
        params = StdioServerParameters(command=sys.executable, args=[MCP_SERVER_SCRIPT], env=env)
        while not self._stopping:
            try:
                async with stdio_client(params) as (read, write), ClientSession(read, write) as session:
                    await session.initialize()
                    self.tools = [_describe_tool(t) for t in (await session.list_tools()).tools]
                    self.ready.set()
                    _log(f"MCP server ready: {', '.join(t['name'] for t in self.tools)}")
                    # A call that fails at the protocol level means the server
                    # is gone: that ends this group (and the calls still running
                    # in it), and the loop below starts a fresh server.
                    async with asyncio.TaskGroup() as calls:
                        while True:
                            name, args, future = await self._calls.get()
                            calls.create_task(self._call(session, name, args, future))
            except asyncio.CancelledError:
                raise
            except Exception as e:
                self.ready.clear()
                if self._stopping:
                    return
                _log(f"MCP server stopped ({_describe_exception(e)}) -- restarting in 3s")
                await asyncio.sleep(3)

    @staticmethod
    async def _call(session: ClientSession, name: str, args: dict, future: asyncio.Future) -> None:
        try:
            result = await session.call_tool(name, args)
        except BaseException as e:
            if not future.done():
                # Cancelled because another call brought the server down.
                future.set_exception(e if isinstance(e, Exception) else ConnectionError("the tool server restarted"))
            raise
        if not future.done():
            future.set_result(result)

    def stop(self) -> None:
        self._stopping = True

    async def call(self, name: str, args: dict) -> str:
        await asyncio.wait_for(self.ready.wait(), timeout=TOOL_TIMEOUT)
        future = asyncio.get_running_loop().create_future()
        await self._calls.put((name, args, future))
        result = await asyncio.wait_for(future, timeout=TOOL_TIMEOUT)
        return "\n".join(part.text for part in result.content if hasattr(part, 'text'))


mcp_tools = McpTools()

# Serializes Ollama requests across every open tab -- two generations at
# once on the same GPUs don't run in parallel, they just both get slower
# and risk timing out.
_ollama_lock = asyncio.Lock()

# Cache priming: after each reply the page sends the conversation so far,
# and Ollama processes it in the background so the next question only has
# to read itself and its search results. (gemma3's sliding-window attention
# otherwise stops Ollama reusing the previous request's work in most cases.)
# The next real question always cancels a priming run that's still going --
# closing the connection makes Ollama stop at its next batch.
_prime_task: asyncio.Task | None = None


async def _cancel_priming() -> None:
    global _prime_task
    task, _prime_task = _prime_task, None
    if task and not task.done():
        task.cancel()
        with contextlib.suppress(asyncio.CancelledError, Exception):
            await task


async def _prime(body: dict) -> None:
    async with _ollama_lock:
        try:
            timeout = aiohttp.ClientTimeout(total=OLLAMA_TIMEOUT)
            async with aiohttp.ClientSession(timeout=timeout) as session:
                async with session.post(f'{OLLAMA_URL}/api/chat', json=body) as response:
                    await response.read()
        except asyncio.CancelledError:
            raise
        except Exception as e:
            _log(f"cache priming failed: {_describe_exception(e)}")


async def list_tools(request: Request) -> Response:
    try:
        await asyncio.wait_for(mcp_tools.ready.wait(), timeout=TOOL_TIMEOUT)
    except asyncio.TimeoutError:
        return JSONResponse(
            {'error': "The MCP tool server isn't running -- check the bridge's console output."},
            status_code=503,
        )
    return JSONResponse({'tools': mcp_tools.tools})


async def call_tool(request: Request) -> Response:
    if refused := _limited(tool_limiter, request):
        return refused
    raw = await _read_body(request, MAX_TOOL_BODY_BYTES)
    if raw is None:
        return _refuse("That request is too large.", 413)
    try:
        body = json.loads(raw)
    except ValueError:
        return _refuse("Expected a JSON request.", 400)
    name = body.get('name') if isinstance(body, dict) else None
    args = body.get('args') if isinstance(body, dict) else None
    if name not in {t['name'] for t in mcp_tools.tools}:
        return _refuse(f"Unknown tool: {name}", 404)
    if not isinstance(args, dict) or not all(isinstance(v, str) for v in args.values()):
        return _refuse("args must be an object of strings", 400)
    if any(len(v) > MAX_TOOL_ARG_CHARS for v in args.values()):
        return _refuse("That tool input is too long.", 400)

    # Anything the tools fetch by address must be on the public internet --
    # never this machine, the model server, SearXNG or anything else on the
    # LAN. Turned away here with a plain answer; fetch_page also checks every
    # redirect itself (safe_fetch.py), which this can't see.
    url = args.get('url')
    if url is not None:
        host = urlparse(url).hostname
        if urlparse(url).scheme not in ('http', 'https') or not host or not await asyncio.to_thread(is_public_host, host):
            log.warning(f"blocked {name} to a non-public address, visitor {_client_tag(_client_ip(request))}")
            return JSONResponse({'text': f"Can't open {url} -- only public websites can be read."})

    key = (name, tuple(sorted(args.items())))
    max_age = TOOL_CACHE_SECONDS.get(name)
    if max_age and (cached := _cached_tool_result(key, max_age)) is not None:
        return JSONResponse({'text': _publish_charts(cached)})

    if name in SEARCH_TOOLS and not daily_searches.take():
        log.warning("daily search cap reached")
        return JSONResponse({'text': "Web search has reached its limit for today -- answer from what you know, and say it couldn't be checked."})

    try:
        text = await mcp_tools.call(name, args)
    except asyncio.TimeoutError:
        log.warning(f"tool {name} timed out")
        return _refuse(f"{name} timed out", 504)
    except Exception as e:
        log.error(f"tool {name} failed: {_describe_exception(e)}")
        return _refuse(f"{name} failed", 502)
    if max_age:
        _cache_tool_result(key, text)
    return JSONResponse({'text': _publish_charts(text)})


async def ollama_prime(request: Request) -> Response:
    global _prime_task
    if refused := _limited(prime_limiter, request):
        return refused
    raw = await _read_body(request, MAX_CHAT_BODY_BYTES)
    if raw is None:
        return _refuse("That request is too large.", 413)
    body = _clean_chat_request(raw)
    if isinstance(body, str):
        return _refuse(body, 400)
    # Warming only uses idle time: skip it while anyone is waiting for a reply.
    if _queued_chats:
        return JSONResponse({'status': 'skipped'}, status_code=202)
    # Only the prompt matters -- generate a single token and stop.
    body['options']['num_predict'] = 1

    await _cancel_priming()  # a newer conversation state replaces an older one
    _prime_task = asyncio.create_task(_prime(body))
    return JSONResponse({'status': 'priming'}, status_code=202)


# Chat requests waiting for (or holding) the model, in total and per visitor.
_queued_chats = 0
_pending_by_visitor: dict[str, int] = {}
# How long one answer takes lately, in seconds (a running average), to judge
# how long the line is. Starts at a typical answer on the VM's GPUs.
_answer_seconds = 10.0


async def ollama_chat(request: Request) -> Response:
    global _queued_chats, _answer_seconds
    if refused := _limited(chat_limiter, request):
        return refused
    ip = _client_ip(request)
    if _pending_by_visitor.get(ip, 0) >= MAX_PENDING_PER_VISITOR:
        return _refuse("Still working on your last message -- wait for that reply first.", 429, 5)
    expected_wait = _queued_chats * _answer_seconds
    if _queued_chats >= MAX_QUEUED_CHATS or expected_wait > MAX_QUEUE_WAIT:
        log.warning(f"line too long ({_queued_chats} waiting, ~{expected_wait:.0f}s), turned away visitor {_client_tag(ip)}")
        return _refuse("Slate Bot is busy with other people right now -- try again in a moment.", 503, 15)

    raw = await _read_body(request, MAX_CHAT_BODY_BYTES)
    if raw is None:
        return _refuse("That message is too large to send.", 413)
    body = _clean_chat_request(raw)
    if isinstance(body, str):
        return _refuse(body, 400)
    if not daily_chats.take():
        log.warning("daily chat cap reached")
        return _refuse("Slate Bot has reached its limit for today -- please come back tomorrow.", 503)

    _queued_chats += 1
    _pending_by_visitor[ip] = _pending_by_visitor.get(ip, 0) + 1
    try:
        await _cancel_priming()  # a real question never waits on cache warming
        try:
            await asyncio.wait_for(_ollama_lock.acquire(), timeout=MAX_QUEUE_WAIT)
        except asyncio.TimeoutError:
            log.warning(f"gave up waiting for the model after {MAX_QUEUE_WAIT}s, visitor {_client_tag(ip)}")
            return _refuse("Slate Bot is busy with other people right now -- try again in a moment.", 503, 15)
        try:
            # Nobody's waiting for this one any more -- don't spend GPU time on it.
            if await request.is_disconnected():
                return Response(status_code=499)
            answer_started = time.monotonic()
            response = await asyncio.to_thread(
                requests.post, f'{OLLAMA_URL}/api/chat', json=body, timeout=OLLAMA_TIMEOUT
            )
            _answer_seconds = 0.8 * _answer_seconds + 0.2 * (time.monotonic() - answer_started)
        except requests.exceptions.Timeout:
            log.error(f"the model took longer than {OLLAMA_TIMEOUT}s")
            return _refuse(f"The model took longer than {OLLAMA_TIMEOUT} seconds to answer -- try again.", 504)
        except requests.exceptions.RequestException as e:
            log.error(f"couldn't reach Ollama at {OLLAMA_URL}: {e}")
            return _refuse("Couldn't reach the model server -- try again in a moment.", 502)
        finally:
            _ollama_lock.release()
    finally:
        _queued_chats -= 1
        _pending_by_visitor[ip] -= 1
        if not _pending_by_visitor[ip]:
            del _pending_by_visitor[ip]

    if not response.ok:
        log.error(f"Ollama answered {response.status_code}: {response.text[:200]}")
        return _refuse("The model server had a problem answering -- try again.", 502)
    return Response(response.content, media_type='application/json')


async def unfurl(request: Request) -> Response:
    if refused := _limited(preview_limiter, request):
        return refused
    url = request.query_params.get('url', '')
    if urlparse(url).scheme not in ('http', 'https') or len(url) > MAX_TOOL_ARG_CHARS:
        return JSONResponse({'error': "url must be an http(s) link"}, status_code=400)

    if url not in _previews:
        try:
            preview = await asyncio.to_thread(_fetch_preview, url)
        except requests.exceptions.RequestException as e:
            _log(f"link preview failed for {urlparse(url).hostname}: {type(e).__name__}")
            preview = None
        if len(_previews) >= UNFURL_CACHE_SIZE:
            _previews.pop(next(iter(_previews)))  # oldest first
        _previews[url] = preview
    return JSONResponse({'preview': _previews[url]})


async def chart(request: Request) -> Response:
    path = _charts.get(request.path_params['name'])
    if not path or not os.path.isfile(path):
        return Response(status_code=404)
    return FileResponse(path, media_type='image/png')


# The model server's last health check: (when, reachable).
_ollama_health = (0.0, False)


async def healthz(request: Request) -> Response:
    """For an uptime monitor: 200 when the page, its tools and the model are
    all reachable, 503 (with which part is down) when not. The model check
    is repeated at most every 30 seconds, however often this is polled."""
    global _ollama_health
    checked, reachable = _ollama_health
    if time.monotonic() - checked > 30:
        try:
            reachable = (await asyncio.to_thread(requests.get, f'{OLLAMA_URL}/api/tags', timeout=3)).ok
        except requests.exceptions.RequestException:
            reachable = False
        _ollama_health = (time.monotonic(), reachable)
    status = {
        'tools': mcp_tools.ready.is_set(),
        'model_server': reachable,
        'queued_chats': _queued_chats,
    }
    healthy = status['tools'] and status['model_server']
    return JSONResponse({'status': 'ok' if healthy else 'degraded', **status}, status_code=200 if healthy else 503)


async def server_error(request: Request, exc: Exception) -> Response:
    # Logged in full here; the visitor only gets a plain message.
    log.error(f"unhandled error on {request.method} {request.url.path}", exc_info=exc)
    return _refuse("Something went wrong on the server -- try again.", 500)


async def index(request: Request) -> Response:
    return FileResponse(os.path.join(ROOT, 'index.html'))


async def styles(request: Request) -> Response:
    return FileResponse(os.path.join(ROOT, 'styles.css'))


@contextlib.asynccontextmanager
async def lifespan(app: Starlette):
    task = asyncio.create_task(mcp_tools.run())
    _log(f"Serving http://localhost:{PORT} -- Ollama at {OLLAMA_URL}, SearXNG at {SEARXNG_URL}")
    try:
        yield
    finally:
        await _cancel_priming()
        mcp_tools.stop()
        task.cancel()
        with contextlib.suppress(asyncio.CancelledError):
            await task
        # These charts were rendered for this bridge's pages only.
        for path in _charts.values():
            with contextlib.suppress(OSError):
                os.remove(path)


app = Starlette(
    routes=[
        Route('/', index),
        Route('/index.html', index),
        Route('/styles.css', styles),
        Mount('/dist', StaticFiles(directory=os.path.join(ROOT, 'dist'), check_dir=False)),
        Mount('/retro', StaticFiles(directory=os.path.join(ROOT, 'retro'), html=True, check_dir=False)),
        Route('/api/tools', list_tools, methods=['GET']),
        Route('/api/tools/call', call_tool, methods=['POST']),
        Route('/ollama/api/chat', ollama_chat, methods=['POST']),
        Route('/ollama/prime', ollama_prime, methods=['POST']),
        Route('/api/unfurl', unfurl, methods=['GET']),
        Route('/charts/{name}', chart, methods=['GET']),
        Route('/healthz', healthz, methods=['GET']),
    ],
    exception_handlers={Exception: server_error},
    middleware=[
        # Pages on this machine only (any port). Not "null" -- that's also
        # the origin of sandboxed iframes on any website.
        Middleware(
            CORSMiddleware,
            allow_origin_regex=r'https?://(localhost|127\.0\.0\.1)(:\d+)?',
            allow_methods=['GET', 'POST'],
            allow_headers=['Content-Type'],
        ),
    ],
    lifespan=lifespan,
)


if __name__ == '__main__':
    uvicorn.run(app, host=HOST, port=PORT, log_level='warning')
