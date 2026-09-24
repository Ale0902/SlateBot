"""Local bridge between the celta-chat page and the tools/LLM it uses.

A browser can't spawn a stdio MCP server, and Ollama rejects cross-origin
requests from a page opened as a file (Origin: null), so this process does
both jobs for it:

- Starts DJ Shinx's mcp_web_server.py over stdio (the same way llmask.py
  does) and exposes its tools as two JSON endpoints.
- Proxies /ollama/api/chat to the Ollama server, one request at a time, and
  pre-processes each chat's next request in the background (/ollama/prime).
- Reads link previews (title, description, thumbnail) for the page, which
  can't fetch other sites itself.
- Serves the page itself at http://localhost:8765 (and a 2000s-messenger
  skin of the same page at /retro/). A copy of the page
  served some other way on this machine (e.g. VS Code Live Server on :5500)
  can call it too -- CORS allows any localhost origin, nothing else.

Run from the project root:  npm start   (or: python server/bridge.py)
"""
import asyncio
import contextlib
import ipaddress
import os
import re
import socket
import sys
from urllib.parse import urljoin, urlparse

import aiohttp
import requests
import uvicorn
from bs4 import BeautifulSoup
from mcp import ClientSession, StdioServerParameters
from mcp.client.stdio import stdio_client
from starlette.applications import Starlette
from starlette.middleware import Middleware
from starlette.middleware.cors import CORSMiddleware
from starlette.requests import Request
from starlette.responses import FileResponse, JSONResponse, Response
from starlette.routing import Mount, Route
from starlette.staticfiles import StaticFiles

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

OLLAMA_URL = os.getenv('OLLAMA_URL', 'http://10.7.163.103:11434').rstrip('/')
# mcp_web_server.py defaults to a SearXNG on its own machine (127.0.0.1),
# which only exists on the VM -- point it there instead. Its load_dotenv()
# doesn't override variables that are already set, so this wins.
SEARXNG_URL = os.getenv('SEARXNG_URL', 'http://10.7.163.103:8080')
MCP_SERVER_SCRIPT = os.getenv('MCP_SERVER_SCRIPT', r'F:\DJ-Shinx-main\mcp_web_server.py')
HOST = os.getenv('BRIDGE_HOST', '127.0.0.1')
PORT = int(os.getenv('BRIDGE_PORT', '8765'))

OLLAMA_TIMEOUT = 180
TOOL_TIMEOUT = 60

# Link previews: the page's own metadata (og:title, og:image, ...) is read
# from at most this much of the HTML, which is where <head> lives.
UNFURL_TIMEOUT = 8
UNFURL_MAX_BYTES = 1_000_000
UNFURL_MAX_REDIRECTS = 5
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
_charts: dict[str, str] = {}


def _log(message: str) -> None:
    print(f"[bridge] {message}", file=sys.stderr, flush=True)


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
        _charts[name] = path
        return f"CHART_PATH: /charts/{name}"
    return CHART_PATH_RE.sub(swap, text)


_previews: dict[str, dict | None] = {}


def _is_public_host(host: str) -> bool:
    """Only unfurl pages on the public internet -- never this machine or the
    LAN (the VM, the router's admin page, ...), even via a redirect."""
    try:
        addresses = {info[4][0] for info in socket.getaddrinfo(host, None)}
    except OSError:
        return False
    return bool(addresses) and all(ipaddress.ip_address(a.split('%')[0]).is_global for a in addresses)


def _fetch_preview(url: str) -> dict | None:
    """{url, title, description, image, siteName} from a page's Open Graph /
    Twitter card / <title> tags, or None if it can't be previewed."""
    page_url = url
    for _ in range(UNFURL_MAX_REDIRECTS + 1):
        parsed = urlparse(page_url)
        if parsed.scheme not in ('http', 'https') or not parsed.hostname or not _is_public_host(parsed.hostname):
            return None
        response = requests.get(
            page_url,
            headers={'User-Agent': UNFURL_USER_AGENT, 'Accept': 'text/html,*/*;q=0.8'},
            timeout=UNFURL_TIMEOUT,
            stream=True,
            allow_redirects=False,  # followed by hand so each hop is checked above
        )
        if response.is_redirect and response.headers.get('location'):
            page_url = urljoin(page_url, response.headers['location'])
            response.close()
            continue
        break
    else:
        return None

    with response:
        if not response.ok:
            return None
        content_type = response.headers.get('content-type', '').lower()
        host = (urlparse(page_url).hostname or '').removeprefix('www.')
        if content_type.startswith('image/'):
            return {'url': url, 'title': '', 'description': '', 'image': page_url, 'siteName': host}
        if 'html' not in content_type:
            return None
        body = b''
        for chunk in response.iter_content(65536):
            body += chunk
            if len(body) >= UNFURL_MAX_BYTES:
                break

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


class McpTools:
    """Owns one long-lived stdio session with the MCP server. The session
    lives entirely inside run()'s task (anyio requires a context to be
    exited by the task that entered it), so calls reach it through a queue,
    and a crashed server is restarted there rather than by whichever
    request happened to notice."""

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
                    while True:
                        name, args, future = await self._calls.get()
                        try:
                            result = await session.call_tool(name, args)
                        except Exception as e:
                            if not future.done():
                                future.set_exception(e)
                            raise
                        if not future.done():
                            future.set_result(result)
            except asyncio.CancelledError:
                raise
            except Exception as e:
                self.ready.clear()
                if self._stopping:
                    return
                _log(f"MCP server stopped ({_describe_exception(e)}) -- restarting in 3s")
                await asyncio.sleep(3)

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
    body = await request.json()
    name = body.get('name')
    args = body.get('args')
    if name not in {t['name'] for t in mcp_tools.tools}:
        return JSONResponse({'error': f"Unknown tool: {name}"}, status_code=404)
    if not isinstance(args, dict) or not all(isinstance(v, str) for v in args.values()):
        return JSONResponse({'error': "args must be an object of strings"}, status_code=400)

    try:
        text = await mcp_tools.call(name, args)
    except asyncio.TimeoutError:
        return JSONResponse({'error': f"{name} timed out"}, status_code=504)
    except Exception as e:
        return JSONResponse({'error': _describe_exception(e)}, status_code=502)
    return JSONResponse({'text': _publish_charts(text)})


async def ollama_prime(request: Request) -> Response:
    global _prime_task
    body = await request.json()
    if not isinstance(body, dict) or not isinstance(body.get('messages'), list):
        return JSONResponse({'error': "expected an /api/chat request body"}, status_code=400)
    # Only the prompt matters -- generate a single token and stop.
    body['stream'] = False
    body['options'] = {**(body.get('options') or {}), 'num_predict': 1}

    await _cancel_priming()  # a newer conversation state replaces an older one
    _prime_task = asyncio.create_task(_prime(body))
    return JSONResponse({'status': 'priming'}, status_code=202)


async def ollama_chat(request: Request) -> Response:
    body = await request.body()
    await _cancel_priming()  # a real question never waits on cache warming
    async with _ollama_lock:
        try:
            response = await asyncio.to_thread(
                requests.post,
                f'{OLLAMA_URL}/api/chat',
                data=body,
                headers={'Content-Type': 'application/json'},
                timeout=OLLAMA_TIMEOUT,
            )
        except requests.exceptions.Timeout:
            return JSONResponse({'error': f"Ollama took longer than {OLLAMA_TIMEOUT}s to respond."}, status_code=504)
        except requests.exceptions.RequestException as e:
            return JSONResponse({'error': f"Couldn't reach Ollama at {OLLAMA_URL}: {e}"}, status_code=502)
    return Response(response.content, status_code=response.status_code, media_type='application/json')


async def unfurl(request: Request) -> Response:
    url = request.query_params.get('url', '')
    if urlparse(url).scheme not in ('http', 'https'):
        return JSONResponse({'error': "url must be an http(s) link"}, status_code=400)

    if url not in _previews:
        try:
            preview = await asyncio.to_thread(_fetch_preview, url)
        except requests.exceptions.RequestException as e:
            _log(f"unfurl failed for {url}: {e}")
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
    ],
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
