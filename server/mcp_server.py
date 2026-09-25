"""Slate Bot's tools, as an MCP server: web and image search, reading a
page, Wikipedia, stock charts, other charts, math, and the date. bridge.py
starts it over stdio and relays the page's tool calls to it -- it's never
run standalone in production.

Started from DJ Shinx's mcp_web_server.py and now kept here, so this
project runs on its own. The tool names, inputs and descriptions are what
src/agent.ts and the model rely on -- change them there too if you change
them here.

IMPORTANT: stdout is the MCP protocol channel. Never print() to it -- log to
stderr (see _log), which shows up in the bridge's console.

Search tries a self-hosted SearXNG instance first (SEARXNG_URL -- the
bridge passes its own setting) -- it's free, has no query quota, and already
aggregates Brave/Google/Wikipedia results itself -- falling back to the
Brave Search API directly (free tier: 2,000 queries/month, needs
BRAVE_API_KEY in the project's .env) only if SearXNG is down or
unreachable. DuckDuckGo's endpoints were tried first but actively block
non-browser clients with a JS anomaly challenge, so they aren't an option.
"""
import ast
import datetime
import logging
import math
import operator
import os
import re
import sys
import uuid
from urllib.parse import quote
from zoneinfo import ZoneInfo

import requests
from bs4 import BeautifulSoup
from dotenv import load_dotenv
from mcp.server.mcpserver import MCPServer

from safe_fetch import BlockedURL, get_public, read_limited

# Charts are drawn with Figure directly, not pyplot: pyplot keeps global
# state and isn't thread-safe, and each tool call runs in its own thread so
# several visitors can be served at once. Needs no display either.
from matplotlib.figure import Figure

# Bar labels like "2023" are drawn as labels, which is right -- but
# matplotlib says so on the console every time.
logging.getLogger('matplotlib.category').setLevel(logging.ERROR)

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
# Settings the bridge didn't already pass along (BRAVE_API_KEY, ...).
load_dotenv(os.path.join(ROOT, '.env'))

mcp = MCPServer("slate-bot-tools")

# Wikipedia asks API clients to say who they are and how to reach them --
# put a contact URL or email in TOOLS_USER_AGENT when this goes public.
USER_AGENT = os.getenv('TOOLS_USER_AGENT', 'SlateBot/1.0 (self-hosted chat assistant)')
MAX_FETCH_CHARS = 4000
# A page is cut off here before it's even parsed; plenty for any article.
MAX_FETCH_BYTES = 2_000_000
BRAVE_SEARCH_URL = "https://api.search.brave.com/res/v1/web/search"
BRAVE_IMAGE_SEARCH_URL = "https://api.search.brave.com/res/v1/images/search"
SLATEBOT_HOST = os.getenv('SLATEBOT_HOST', '100.113.193.53')
SEARXNG_URL = os.getenv('SEARXNG_URL', f'http://{SLATEBOT_HOST}:8080').rstrip('/')
WIKIPEDIA_SUMMARY_URL = "https://en.wikipedia.org/api/rest_v1/page/summary/{}"
YAHOO_CHART_URL = "https://query1.finance.yahoo.com/v8/finance/chart/{}"
EASTERN = ZoneInfo("America/New_York")
HTML_TAG_RE = re.compile(r"<[^<]+?>")

# Charts are rendered here and handed to the bridge as a CHART_PATH line in
# the result; the bridge serves them to the page and deletes them later.
CHARTS_DIR = os.getenv('CHARTS_DIR', os.path.join(ROOT, 'charts'))
MAX_CHART_PERIODS = 6
# The modern theme's colors, so a chart sits naturally in the chat.
CHART_BG = '#0d131a'
CHART_TEXT = '#edf5ff'
CHART_ACCENT = '#4a9bd9'
CHART_EDGE = '#2a4258'
CHART_ZERO_LINE = '#5a6b7d'

# A few common names for major indices -- anything else is assumed to
# already be a plain ticker symbol (e.g. AAPL, TSLA) and used as-is,
# uppercased, which is exactly the symbol Yahoo Finance expects.
STOCK_ALIASES = {
    's&p 500': '^GSPC', 's&p500': '^GSPC', 'sp500': '^GSPC', 's&p': '^GSPC',
    'smp': '^GSPC', 'smp500': '^GSPC',
    'dow': '^DJI', 'dow jones': '^DJI', 'dow jones industrial average': '^DJI',
    'nasdaq': '^IXIC', 'nasdaq composite': '^IXIC',
}
# A date field may be the literal word "today" instead of YYYY-MM-DD, for
# an ongoing period's end -- the model has repeatedly picked a wrong,
# stale "current" date on its own (e.g. defaulting to a date near its
# training cutoff instead of the real one), so this lets it defer to
# Python's own clock instead of guessing.
PERIOD_SPEC_RE = re.compile(r'^([^:|]+):(\d{4}-\d{2}-\d{2}|today):(\d{4}-\d{2}-\d{2}|today)$', re.IGNORECASE)
DEFAULT_HISTORY_DAYS = 365


def _log(message: str) -> None:
    print(f"[tools] {message}", file=sys.stderr, flush=True)


def _brief(e: Exception) -> str:
    """An error, without the URL requests puts in its message -- that URL
    can carry someone's search words, which never go in a log."""
    if isinstance(e, requests.exceptions.HTTPError) and e.response is not None:
        return f"HTTP {e.response.status_code}"
    return type(e).__name__


def _searxng_search(query: str) -> list[dict] | None:
    """Returns [{title, url, description}, ...] from the self-hosted
    SearXNG instance, or None if it's unreachable (container down, not set
    up, etc.) so the caller can fall back to the Brave API directly."""
    try:
        response = requests.get(
            f'{SEARXNG_URL}/search',
            params={'q': query, 'format': 'json'},
            timeout=10,
        )
        response.raise_for_status()
        results = response.json().get('results', [])
    except Exception as e:
        _log(f"web_search: SearXNG unreachable ({_brief(e)}), falling back to Brave")
        return None

    return [
        {'title': r.get('title', ''), 'url': r.get('url', ''), 'description': r.get('content', '')}
        for r in results[:5]
    ]


def _brave_search(query: str) -> list[dict] | None:
    """Returns [{title, url, description}, ...] from the Brave Search API
    directly, or None if it's unconfigured or the request failed for any
    reason (missing key, rate limited, network error)."""
    api_key = os.getenv('BRAVE_API_KEY')
    if not api_key:
        return None

    try:
        response = requests.get(
            BRAVE_SEARCH_URL,
            params={'q': query, 'count': 5},
            headers={'Accept': 'application/json', 'X-Subscription-Token': api_key},
            timeout=10,
        )
        response.raise_for_status()
        results = response.json().get('web', {}).get('results', [])
    except Exception as e:
        _log(f"web_search: Brave fallback also failed ({_brief(e)})")
        return None

    return [
        {
            'title': r.get('title', ''),
            'url': r.get('url', ''),
            # Brave highlights matched terms with <strong> tags in the snippet.
            'description': HTML_TAG_RE.sub('', r.get('description', '')),
        }
        for r in results[:5]
    ]


@mcp.tool()
def web_search(query: str) -> str:
    """Searches the web and returns the top results as title/url/snippet
    entries. Use this to look up current events, facts, or anything you're
    not confident about before answering."""
    results = _searxng_search(query)
    source = "the local SearXNG instance"
    if results is None:
        results = _brave_search(query)
        source = "the Brave Search API (SearXNG was unreachable)"
    if results is None:
        return "Web search is currently unavailable -- both SearXNG and the Brave fallback failed."
    if not results:
        return f"No results found via {source}."

    lines = [f"{r['title']}\n{r['url']}\n{r['description']}" for r in results]
    return f"[Results via {source}]\n\n" + "\n\n".join(lines)


def _searxng_image_search(query: str) -> list[dict] | None:
    """Returns [{title, url, image_url}, ...] from the self-hosted SearXNG
    instance's image category, or None if it's unreachable."""
    try:
        response = requests.get(
            f'{SEARXNG_URL}/search',
            params={'q': query, 'format': 'json', 'categories': 'images'},
            timeout=10,
        )
        response.raise_for_status()
        results = response.json().get('results', [])
    except Exception as e:
        _log(f"image_search: SearXNG unreachable ({_brief(e)}), falling back to Brave")
        return None

    return [
        {'title': r.get('title', ''), 'url': r.get('url', ''), 'image_url': r.get('img_src', '')}
        for r in results
        if r.get('img_src')
    ][:5]


def _brave_image_search(query: str) -> list[dict] | None:
    """Returns [{title, url, image_url}, ...] from the Brave Image Search
    API directly, or None if it's unconfigured or the request failed."""
    api_key = os.getenv('BRAVE_API_KEY')
    if not api_key:
        return None

    try:
        response = requests.get(
            BRAVE_IMAGE_SEARCH_URL,
            params={'q': query, 'count': 5},
            headers={'Accept': 'application/json', 'X-Subscription-Token': api_key},
            timeout=10,
        )
        response.raise_for_status()
        results = response.json().get('results', [])
    except Exception as e:
        _log(f"image_search: Brave fallback also failed ({_brief(e)})")
        return None

    return [
        {
            'title': r.get('title', ''),
            'url': r.get('url', ''),
            'image_url': (r.get('properties') or {}).get('url', ''),
        }
        for r in results
        if (r.get('properties') or {}).get('url')
    ][:5]


@mcp.tool()
def image_search(query: str) -> str:
    """Searches for images matching a description and returns direct
    image links (not just pages that mention the topic). Use this,
    instead of web_search, when asked for a picture, photo, image, or
    video thumbnail of something."""
    results = _searxng_image_search(query)
    source = "the local SearXNG instance"
    if not results:
        results = _brave_image_search(query)
        source = "the Brave Image Search API (SearXNG had no image results)"
    if not results:
        return "No images found for that."

    lines = [f"{r['title']}\nImage: {r['image_url']}\nPage: {r['url']}" for r in results]
    return f"[Image results via {source}]\n\n" + "\n\n".join(lines)


def _is_readable(content_type: str) -> bool:
    """Web pages and plain text -- not images, video, PDFs or downloads,
    which come out as garbage when read as text."""
    content_type = content_type.lower()
    return not content_type or content_type.startswith('text/') or any(
        kind in content_type for kind in ('html', 'xml', 'json')
    )


@mcp.tool()
def fetch_page(url: str) -> str:
    """Fetches a web page, such as one returned by web_search, and
    returns its readable text content, truncated to a few thousand
    characters."""
    try:
        response = get_public(url, headers={"User-Agent": USER_AGENT}, timeout=10)
    except BlockedURL as blocked:
        if blocked.args[0] != url:
            return f"Can't open {url} -- it redirects somewhere that isn't a public website."
        return f"Can't open {url} -- only public websites can be read."
    except Exception as e:
        return f"Couldn't fetch {url}: {e}"

    with response:
        if not response.ok:
            return f"Couldn't fetch {url}: the site answered {response.status_code} {response.reason}."
        content_type = response.headers.get('content-type', '')
        if not _is_readable(content_type):
            return f"Couldn't read {url} -- it isn't a web page ({content_type.split(';')[0]})."
        try:
            body = read_limited(response, MAX_FETCH_BYTES)
        except Exception as e:
            return f"Couldn't fetch {url}: {e}"

    # The header's charset if it gave one; otherwise the page's own <meta>.
    encoding = response.encoding if 'charset' in content_type.lower() else None
    soup = BeautifulSoup(body, "html.parser", from_encoding=encoding)
    for tag in soup(["script", "style", "nav", "footer", "header"]):
        tag.decompose()

    text = re.sub(r"\n{3,}", "\n\n", soup.get_text("\n", strip=True))
    if len(text) > MAX_FETCH_CHARS:
        text = text[:MAX_FETCH_CHARS] + "... [truncated]"
    return text


@mcp.tool()
def current_datetime() -> str:
    """Returns the current real-world date and time (US Eastern). Use
    this whenever you need to know what "today", "now", "recent", or
    "current" actually means -- your training data has a fixed cutoff and
    doesn't know how much time has passed since, which has caused you to
    describe outdated things as current before."""
    now = datetime.datetime.now(EASTERN)
    return now.strftime("%A, %B %d, %Y, %I:%M %p ET").replace(" 0", " ")


@mcp.tool()
def wikipedia_summary(topic: str) -> str:
    """Returns a short factual summary of the Wikipedia article for a
    person, place, or thing, with its source link. Faster and more
    reliable than web_search for straightforward "who/what is X"
    questions. If the topic doesn't match an article title closely, this
    may come back empty -- fall back to web_search in that case."""
    try:
        response = requests.get(
            WIKIPEDIA_SUMMARY_URL.format(quote(topic.replace(' ', '_'))),
            headers={"User-Agent": USER_AGENT},
            timeout=10,
        )
        if response.status_code == 404:
            return f"No Wikipedia article found for '{topic}'. Try web_search instead."
        response.raise_for_status()
        data = response.json()
    except Exception as e:
        return f"Wikipedia lookup failed: {e}"

    extract = data.get('extract', '')
    if not extract:
        return f"No summary available for '{topic}'. Try web_search instead."

    url = data.get('content_urls', {}).get('desktop', {}).get('page', '')
    return f"{extract}\n\nSource: {url}" if url else extract


def _resolve_symbol(name: str) -> str:
    key = name.strip().lower()
    return STOCK_ALIASES.get(key, name.strip().upper())


def _parse_date_field(value: str) -> datetime.date:
    if value.strip().lower() == 'today':
        return datetime.datetime.now(EASTERN).date()
    return datetime.date.fromisoformat(value)


def _parse_periods(spec: str) -> list[tuple[str, datetime.date, datetime.date]]:
    """Parses 'Label:start:end | Label:start:end | ...' into
    [(label, start_date, end_date), ...], raising ValueError with a
    message the model can act on if a segment doesn't match."""
    periods = []
    for segment in spec.split('|'):
        segment = segment.strip()
        match = PERIOD_SPEC_RE.match(segment)
        if not match:
            raise ValueError(
                f"Couldn't parse period '{segment}' -- expected "
                "Label:YYYY-MM-DD:YYYY-MM-DD (or 'today' in place of a date)."
            )
        label, start, end = match.groups()
        periods.append((label.strip(), _parse_date_field(start), _parse_date_field(end)))
    return periods


def _fetch_daily_closes(symbol: str, start_ts: int, end_ts: int) -> list[tuple[datetime.date, float]] | None:
    """Returns [(date, close), ...] sorted ascending from Yahoo Finance's
    public chart API, or None if the request failed or the symbol doesn't
    exist. No API key needed -- unlike Stooq's download endpoint (which
    now sits behind a JS browser-verification challenge, the same kind of
    block that ruled out DuckDuckGo for search), this JSON endpoint has
    stayed reliably scriptable."""
    try:
        response = requests.get(
            YAHOO_CHART_URL.format(quote(symbol)),
            params={'period1': start_ts, 'period2': end_ts, 'interval': '1d'},
            headers={"User-Agent": USER_AGENT},
            timeout=10,
        )
        response.raise_for_status()
        result = response.json().get('chart', {}).get('result')
    except Exception as e:
        _log(f"stock data: fetch failed for {symbol} ({_brief(e)})")
        return None
    if not result:
        return None

    timestamps = result[0].get('timestamp') or []
    quote_block = (result[0].get('indicators', {}).get('quote') or [{}])[0] or {}
    closes = quote_block.get('close') or []
    points = [
        (datetime.datetime.fromtimestamp(ts, tz=datetime.timezone.utc).date(), close)
        for ts, close in zip(timestamps, closes)
        if close is not None
    ]
    return points or None


def _new_chart(title: str, y_label: str):
    """A figure and axes in the site's colors -- a solid background (not
    transparent), so the text stays legible in either theme."""
    fig = Figure(figsize=(7, 4.5), dpi=120, facecolor=CHART_BG)
    ax = fig.subplots()
    ax.set_facecolor(CHART_BG)
    ax.set_ylabel(y_label, color=CHART_TEXT)
    ax.set_title(title, color=CHART_TEXT)
    ax.tick_params(colors=CHART_TEXT)
    for spine in ax.spines.values():
        spine.set_color(CHART_EDGE)
    return fig, ax


def _save_chart(fig) -> str:
    """Saves the figure as a PNG under CHARTS_DIR and returns its path."""
    os.makedirs(CHARTS_DIR, exist_ok=True)
    path = os.path.join(CHARTS_DIR, f"{uuid.uuid4().hex}.png")
    fig.savefig(path, facecolor=fig.get_facecolor(), bbox_inches='tight')
    return path


def _render_bar_chart(title: str, data: list[tuple[str, float]]) -> str:
    """A labeled bar chart of percent changes, with a 0-line and a signed
    label on each bar. Returns the PNG's path."""
    fig, ax = _new_chart(title, '% change')
    bars = ax.bar([d[0] for d in data], [d[1] for d in data], color=CHART_ACCENT)
    ax.axhline(0, color=CHART_ZERO_LINE, linewidth=0.8)
    for bar, (_, value) in zip(bars, data):
        ax.annotate(
            f'{value:+.1f}%',
            (bar.get_x() + bar.get_width() / 2, bar.get_height()),
            textcoords="offset points", xytext=(0, 4 if value >= 0 else -14),
            ha='center', color=CHART_TEXT, fontsize=9,
        )
    return _save_chart(fig)


@mcp.tool()
def compare_stock_performance(query: str) -> str:
    """Looks up real historical closing prices for a stock or index and
    charts the percent change across one or more labeled date ranges.
    Use this for a comparison across specific NAMED periods (e.g. two
    presidential terms, two different years) -- for a single ongoing
    trend ("how's X doing currently/lately/this year"), use
    stock_price_history instead, which draws a line graph over time
    rather than one bar per period. Never estimate or invent a
    percentage yourself, always get it from this tool. Format: "SYMBOL |
    Label:YYYY-MM-DD:YYYY-MM-DD | Label:YYYY-MM-DD:YYYY-MM-DD", for
    example "S&P 500 | Trump Term 1:2017-01-20:2021-01-19 | Biden
    Term:2021-01-20:2025-01-19". For an ongoing period, use the literal
    word "today" instead of guessing a date, e.g. "Trump Term
    2:2025-01-20:today". Avoid apostrophes in labels -- write "Biden
    Term", not "Biden's Term"."""
    parts = query.split('|', 1)
    if len(parts) != 2:
        return "Couldn't parse that -- format is 'SYMBOL | Label:YYYY-MM-DD:YYYY-MM-DD | ...'."
    symbol_name, period_spec = parts[0].strip(), parts[1]

    try:
        periods = _parse_periods(period_spec)
    except ValueError as e:
        return str(e)
    if not periods:
        return "No periods given -- format is 'SYMBOL | Label:YYYY-MM-DD:YYYY-MM-DD | ...'."
    if len(periods) > MAX_CHART_PERIODS:
        return f"Too many periods (max {MAX_CHART_PERIODS}) -- try comparing fewer at once."

    symbol = _resolve_symbol(symbol_name)
    overall_start = min(p[1] for p in periods)
    overall_end = max(p[2] for p in periods)
    points = _fetch_daily_closes(
        symbol,
        int(datetime.datetime.combine(overall_start, datetime.time.min, tzinfo=datetime.timezone.utc).timestamp()),
        int(datetime.datetime.combine(overall_end + datetime.timedelta(days=1), datetime.time.min, tzinfo=datetime.timezone.utc).timestamp()),
    )
    if not points:
        return f"Couldn't fetch historical data for '{symbol_name}' ({symbol}) -- make sure you used its real ticker symbol (e.g. ACN for Accenture, AAPL for Apple), not the company name, and try again."

    lines = [f"{symbol_name} ({symbol}) performance by period:"]
    chart_data = []
    for label, start, end in periods:
        start_point = next((p for p in points if p[0] >= start), None)
        end_point = next((p for p in reversed(points) if p[0] <= end), None)
        if not start_point or not end_point or start_point[0] > end_point[0]:
            lines.append(f"- {label}: no trading data available in that range.")
            continue
        pct_change = (end_point[1] - start_point[1]) / start_point[1] * 100
        lines.append(
            f"- {label} ({start_point[0]} to {end_point[0]}): "
            f"{start_point[1]:.2f} -> {end_point[1]:.2f} ({pct_change:+.1f}%)"
        )
        chart_data.append((label, pct_change))

    if not chart_data:
        return "\n".join(lines) + "\n\nNo valid data available to chart."

    chart_path = _render_bar_chart(f"{symbol_name} % change by period", chart_data)
    lines.append(f"\nCHART_PATH: {chart_path}")
    return "\n".join(lines)


def _render_line_chart(title: str, points: list[tuple[datetime.date, float]]) -> str:
    """A closing-price line chart over time. Returns the PNG's path."""
    fig, ax = _new_chart(title, 'Price')
    ax.plot([p[0] for p in points], [p[1] for p in points], color=CHART_ACCENT, linewidth=1.6)
    fig.autofmt_xdate()
    return _save_chart(fig)


@mcp.tool()
def stock_price_history(query: str) -> str:
    """Looks up a stock or index's real closing-price history and charts
    it as a line graph over time. Use this for a single ongoing trend --
    "how's X doing currently, lately, or this year" -- not a comparison
    across specific named periods (use compare_stock_performance for
    that instead). Format: just "SYMBOL" for the trailing year up to
    today (use this for almost everything -- it already covers
    "lately"/"currently"/"this year"), "SYMBOL:YYYY-MM-DD" (or
    "SYMBOL:today") for the trailing year up to a specific end date, or
    "SYMBOL:YYYY-MM-DD:YYYY-MM-DD" for an explicit start and end.
    Never estimate the price or trend yourself -- this always reflects
    today's actual date and real market data, which you're often wrong
    about on your own."""
    parts = [p.strip() for p in query.split(':')]
    symbol_name = parts[0]
    if not symbol_name:
        return "Couldn't parse that -- format is 'SYMBOL' or 'SYMBOL:YYYY-MM-DD:YYYY-MM-DD'."
    symbol = _resolve_symbol(symbol_name)

    try:
        if len(parts) == 1:
            end = datetime.datetime.now(EASTERN).date()
            start = end - datetime.timedelta(days=DEFAULT_HISTORY_DAYS)
        elif len(parts) == 2:
            # Shorthand for "the trailing year up to this end date" --
            # accepted because the model has been observed trying to
            # write exactly this (e.g. "S&P 500:today") when it only
            # wants a different end point, not a specific start too.
            end = _parse_date_field(parts[1])
            start = end - datetime.timedelta(days=DEFAULT_HISTORY_DAYS)
        elif len(parts) == 3:
            start = _parse_date_field(parts[1])
            end = _parse_date_field(parts[2])
        else:
            return "Couldn't parse that -- format is 'SYMBOL' or 'SYMBOL:YYYY-MM-DD:YYYY-MM-DD'."
    except ValueError:
        return "Couldn't parse those dates -- format is 'SYMBOL' or 'SYMBOL:YYYY-MM-DD:YYYY-MM-DD'."

    if start > end:
        return "Start date is after the end date -- swap them and try again."

    points = _fetch_daily_closes(
        symbol,
        int(datetime.datetime.combine(start, datetime.time.min, tzinfo=datetime.timezone.utc).timestamp()),
        int(datetime.datetime.combine(end + datetime.timedelta(days=1), datetime.time.min, tzinfo=datetime.timezone.utc).timestamp()),
    )
    if not points:
        return f"Couldn't fetch historical data for '{symbol_name}' ({symbol}) -- make sure you used its real ticker symbol (e.g. ACN for Accenture, AAPL for Apple), not the company name, and try again."

    first_date, first_close = points[0]
    last_date, last_close = points[-1]
    pct_change = (last_close - first_close) / first_close * 100
    high = max(p[1] for p in points)
    low = min(p[1] for p in points)

    chart_path = _render_line_chart(f"{symbol_name} ({symbol}) closing price", points)
    return (
        f"{symbol_name} ({symbol}) from {first_date} to {last_date}: "
        f"{first_close:.2f} -> {last_close:.2f} ({pct_change:+.1f}%). "
        f"Range over that span: {low:.2f} to {high:.2f}.\n"
        f"\nCHART_PATH: {chart_path}"
    )


def _render_generic_bar_chart(title: str, y_label: str, data: list[tuple[str, float]]) -> str:
    """A labeled bar chart of any values, with a caller-supplied y-axis
    label -- no forced +/- sign or 0-line, which only make sense for a %
    change comparison. Returns the PNG's path."""
    fig, ax = _new_chart(title, y_label)
    bars = ax.bar([d[0] for d in data], [d[1] for d in data], color=CHART_ACCENT)
    for bar, (_, value) in zip(bars, data):
        ax.annotate(
            f'{value:g}',
            (bar.get_x() + bar.get_width() / 2, bar.get_height()),
            textcoords="offset points", xytext=(0, 4),
            ha='center', color=CHART_TEXT, fontsize=9,
        )
    return _save_chart(fig)


@mcp.tool()
def plot_data(query: str) -> str:
    """Renders a labeled bar chart from data points you already have in
    hand from a tool result this conversation -- never a number you
    estimated, interpolated, or invented to fill a gap or make a fuller-
    looking trend. Use this for a "show me a graph/chart of X" request
    that ISN'T a stock/index (use compare_stock_performance or
    stock_price_history for those, which pull real market data
    directly). If you only actually found one real data point, it's
    fine -- and correct -- to plot just that single bar rather than
    inventing others. If you don't have any real numeric data point at
    all, don't call this -- say plainly that you couldn't find the
    numbers to chart it instead. Format: "Title | Y-axis label |
    Label1:Value1 | Label2:Value2 | ...", for example "US CS Bachelor's
    Degrees Awarded | Degrees (thousands) | 2018:79.6 | 2022:104.5"."""
    parts = query.split('|')
    if len(parts) < 3:
        return "Couldn't parse that -- format is 'Title | Y-axis label | Label1:Value1 | Label2:Value2 | ...'."
    title, y_label = parts[0].strip(), parts[1].strip()

    data = []
    for segment in parts[2:]:
        segment = segment.strip()
        if ':' not in segment:
            return f"Couldn't parse data point '{segment}' -- expected Label:Value."
        label, value_str = segment.rsplit(':', 1)
        try:
            value = float(value_str.strip())
        except ValueError:
            return f"Couldn't parse the number in '{segment}' -- the value must be numeric."
        data.append((label.strip(), value))

    if not data:
        return "No data points given -- format is 'Title | Y-axis label | Label1:Value1 | ...'."
    if len(data) > MAX_CHART_PERIODS:
        return f"Too many data points (max {MAX_CHART_PERIODS}) -- try plotting fewer at once."

    chart_path = _render_generic_bar_chart(title, y_label, data)
    point_word = 'point' if len(data) == 1 else 'points'
    return f"Chart rendered with {len(data)} data {point_word}.\nCHART_PATH: {chart_path}"


# A restricted arithmetic evaluator for the calculate() tool -- walks the
# expression's AST and only permits numbers, basic operators, and a
# whitelisted set of math functions/constants, rather than using eval()
# (which would let an LLM-generated string run arbitrary Python).

# Python can't print a whole number longer than this anyway.
MAX_RESULT_DIGITS = 4000


def _power(base, exponent):
    # Refused up front: something like 9**9**9 has hundreds of millions of
    # digits and would tie this server up -- and every visitor's tool calls
    # with it -- for minutes.
    if isinstance(base, int) and isinstance(exponent, int) and abs(base) > 1 and exponent > 0:
        if exponent * math.log10(abs(base)) > MAX_RESULT_DIGITS:
            raise ValueError("the result would be too large to calculate")
    return operator.pow(base, exponent)


_BINOPS = {
    ast.Add: operator.add, ast.Sub: operator.sub, ast.Mult: operator.mul,
    ast.Div: operator.truediv, ast.FloorDiv: operator.floordiv,
    ast.Mod: operator.mod, ast.Pow: _power,
}
_UNARYOPS = {ast.UAdd: operator.pos, ast.USub: operator.neg}
_FUNCS = {
    'abs': abs, 'round': round, 'min': min, 'max': max,
    'sqrt': math.sqrt, 'sin': math.sin, 'cos': math.cos, 'tan': math.tan,
    'log': math.log, 'log10': math.log10, 'exp': math.exp,
    'floor': math.floor, 'ceil': math.ceil,
}
_CONSTANTS = {'pi': math.pi, 'e': math.e}


def _safe_eval(node):
    if isinstance(node, ast.Expression):
        return _safe_eval(node.body)
    if isinstance(node, ast.Constant) and isinstance(node.value, (int, float)):
        return node.value
    if isinstance(node, ast.BinOp) and type(node.op) in _BINOPS:
        return _BINOPS[type(node.op)](_safe_eval(node.left), _safe_eval(node.right))
    if isinstance(node, ast.UnaryOp) and type(node.op) in _UNARYOPS:
        return _UNARYOPS[type(node.op)](_safe_eval(node.operand))
    if isinstance(node, ast.Call) and isinstance(node.func, ast.Name) and node.func.id in _FUNCS:
        return _FUNCS[node.func.id](*(_safe_eval(a) for a in node.args))
    if isinstance(node, ast.Name) and node.id in _CONSTANTS:
        return _CONSTANTS[node.id]
    raise ValueError("unsupported expression")


@mcp.tool()
def calculate(expression: str) -> str:
    """Evaluates a math expression (+, -, *, /, //, %, **, and functions
    like sqrt/sin/cos/log/round) and returns the result. Use this for any
    calculation instead of doing the arithmetic yourself -- you're
    unreliable at multi-digit math."""
    try:
        result = _safe_eval(ast.parse(expression, mode='eval'))
    except Exception as e:
        return f"Couldn't evaluate '{expression}': {e}"
    return str(result)


if __name__ == "__main__":
    mcp.run()
