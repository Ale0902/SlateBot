"""Fetching web pages on a visitor's behalf without ever reaching anything
private -- this machine, the model server, SearXNG, the router, or anything
else on the LAN. Shared by bridge.py (link previews, tool-call checks) and
mcp_server.py (fetch_page), so there's one copy of these checks.

Redirects are followed by hand so every hop is checked: otherwise a public
page could simply redirect the request to a private address.
"""
import ipaddress
import socket
from urllib.parse import urljoin, urlparse

import requests

MAX_REDIRECTS = 5


class BlockedURL(Exception):
    """The address -- or one it redirected to -- isn't a public website."""


def is_public_host(host: str) -> bool:
    """True only if every address the name resolves to is on the public
    internet (not loopback, private, link-local, shared or reserved)."""
    try:
        addresses = {info[4][0] for info in socket.getaddrinfo(host, None)}
    except OSError:
        return False
    return bool(addresses) and all(ipaddress.ip_address(a.split('%')[0]).is_global for a in addresses)


def check_url(url: str) -> None:
    parsed = urlparse(url)
    if parsed.scheme not in ('http', 'https') or not parsed.hostname or not is_public_host(parsed.hostname):
        raise BlockedURL(url)


def get_public(url: str, *, headers: dict, timeout: float) -> requests.Response:
    """GETs a public http(s) URL, checking it and every redirect along the
    way. Returns the final response unread (streamed) -- read what you need
    with read_limited(), then close it. Raises BlockedURL, or requests' own
    exceptions (TooManyRedirects past MAX_REDIRECTS)."""
    for _ in range(MAX_REDIRECTS + 1):
        check_url(url)
        response = requests.get(url, headers=headers, timeout=timeout, stream=True, allow_redirects=False)
        if response.is_redirect and response.headers.get('location'):
            url = urljoin(url, response.headers['location'])
            response.close()
            continue
        return response
    raise requests.exceptions.TooManyRedirects(f"more than {MAX_REDIRECTS} redirects")


def read_limited(response: requests.Response, limit: int) -> bytes:
    """At most `limit` bytes of the body -- a huge page is cut off rather
    than read into memory whole."""
    body = bytearray()
    for chunk in response.iter_content(65536):
        body += chunk
        if len(body) >= limit:
            break
    return bytes(body[:limit])
