"""The address guard: the Omeka fetcher never connects to a private address.

The author may type any URL, so a fetch of it could otherwise reach the
server's own loopback, the private network or the cloud metadata address.
`check_public_url` refuses those before a request, with the message the
author sees. The resolver is a parameter, so tests answer DNS themselves.
"""

from __future__ import annotations

import ipaddress
import socket
from collections.abc import Callable

import httpx

from app.tools import ToolError

Resolver = Callable[[str, int], list[str]]

BAD_URL = ("that is not a web address the editor can fetch "
           "(only http and https on the usual ports)")
PRIVATE = ("{host} points to a private or local network address, "
           "which the editor will not connect to.")
# The spec's unreachable message; DNS failure is one of its reasons.
UNREACHABLE = ("The editor's server could not reach {host} ({reason}). The site may be "
               "down, or this server may not be allowed to connect to it. Check the "
               "address opens in your browser; if it does, the server's network is "
               "blocking it.")


def resolve(host: str, port: int) -> list[str]:
    infos = socket.getaddrinfo(host, port, type=socket.SOCK_STREAM)
    return list(dict.fromkeys(str(info[4][0]) for info in infos))


def is_public_address(ip: str) -> bool:
    addr = ipaddress.ip_address(ip)
    # ::ffff:10.0.0.1 is 10.0.0.1 on the wire; judge it as that.
    if isinstance(addr, ipaddress.IPv6Address) and addr.ipv4_mapped is not None:
        addr = addr.ipv4_mapped
    return addr.is_global and not addr.is_multicast


def _is_ip_literal(host: str) -> bool:
    try:
        ipaddress.ip_address(host)
    except ValueError:
        return False
    return True


def check_public_url(url: str | httpx.URL, *, resolve: Resolver = resolve) -> httpx.URL:
    try:
        parsed = httpx.URL(url)
    except httpx.InvalidURL as exc:
        raise ToolError(400, BAD_URL) from exc
    # httpx drops a port that is the scheme default, so any port left is odd.
    if (parsed.scheme not in ("http", "https") or not parsed.host
            or parsed.userinfo or parsed.port is not None):
        raise ToolError(400, BAD_URL)
    host = parsed.host
    if _is_ip_literal(host):
        addresses = [host]
    else:
        try:
            addresses = resolve(host, 443 if parsed.scheme == "https" else 80)
        except OSError as exc:
            raise ToolError(502, UNREACHABLE.format(
                host=host, reason="the name did not resolve")) from exc
    if not addresses or not all(is_public_address(ip) for ip in addresses):
        raise ToolError(400, PRIVATE.format(host=host))
    return parsed
