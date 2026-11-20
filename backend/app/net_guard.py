"""The address guard: the Omeka fetcher never connects to a private address.

The author may type any URL, so a fetch of it could otherwise reach the
server's own loopback, the private network or the cloud metadata address.
`check_public_url` refuses those before a request, with the message the
author sees. A name can answer differently when httpx resolves it again
(DNS rebinding), so `make_guarded_client` also checks at connect time and
connects to the address it checked. The resolver is a parameter, so tests
answer DNS themselves.
"""

from __future__ import annotations

import ipaddress
import socket
import time
from collections.abc import Callable, Iterable

import httpcore
import httpx

from app.tools import UA, ToolError

Resolver = Callable[[str, int], list[str]]

BAD_URL = ("That is not an address the editor can fetch: only http and https "
           "web addresses on the usual ports (80 and 443) are allowed.")
PRIVATE = ("{host} points to a private or local network address, "
           "which the editor will not connect to.")
# Each address a name resolves to gets a share of the connect timeout, but
# never less than this, so one dead address cannot starve the next.
MIN_CONNECT_SHARE = 3.0
# The spec's unreachable message; DNS failure is one of its reasons.
UNREACHABLE = ("The editor's server could not reach {host} ({reason}). The site may be "
               "down, or this server may not be allowed to connect to it. Check the "
               "address opens in your browser; if it does, the server's network is "
               "blocking it.")


class GuardRefused(httpcore.ConnectError):
    """The connect-time check refused the address: the author's 400, not a
    network failure, and not worth a retry."""


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


class GuardedBackend(httpcore.NetworkBackend):
    """Resolves, refuses non-public addresses, connects to an address checked.

    Every address is checked before any connect. They are then tried in turn,
    IPv4 first (a host whose IPv6 egress is broken still reaches a name that
    publishes AAAA), each with a share of the timeout.

    Only the TCP connect gets the IP; httpcore still passes the request's
    hostname to `start_tls`, so SNI and the certificate check use the name.
    """

    def __init__(self, resolve: Resolver = resolve,
                 inner: httpcore.NetworkBackend | None = None):
        self._resolve = resolve
        self._inner = inner or httpcore.SyncBackend()

    def connect_tcp(self, host: str, port: int, timeout: float | None = None,
                    local_address: str | None = None,
                    socket_options: Iterable[httpcore.SOCKET_OPTION] | None = None,
                    ) -> httpcore.NetworkStream:
        if _is_ip_literal(host):
            addresses = [host]
        else:
            try:
                addresses = self._resolve(host, port)
            except OSError as exc:
                raise httpcore.ConnectError(f"{host}: the name did not resolve") from exc
        if not addresses or not all(is_public_address(ip) for ip in addresses):
            raise GuardRefused(PRIVATE.format(host=host))
        addresses = sorted(addresses, key=lambda ip: ":" in ip)
        deadline = None if timeout is None else time.monotonic() + timeout
        share = None if timeout is None else max(timeout / len(addresses), MIN_CONNECT_SHARE)
        failure: Exception | None = None
        for ip in addresses:
            attempt = share
            if deadline is not None:
                left = deadline - time.monotonic()
                if left <= 0:
                    break
                attempt = min(share, left)
            try:
                return self._inner.connect_tcp(ip, port, timeout=attempt,
                                               local_address=local_address,
                                               socket_options=socket_options)
            except (httpcore.ConnectError, httpcore.ConnectTimeout) as exc:
                failure = exc
        assert failure is not None
        raise failure

    def connect_unix_socket(self, path: str, timeout: float | None = None,
                            socket_options: Iterable[httpcore.SOCKET_OPTION] | None = None,
                            ) -> httpcore.NetworkStream:
        raise httpcore.ConnectError("the editor does not connect to local sockets")

    def sleep(self, seconds: float) -> None:
        self._inner.sleep(seconds)


def make_guarded_client(timeout: float, *, resolve: Resolver = resolve) -> httpx.Client:
    # Unlike tools.make_client, the host is the author's: no redirects (each
    # hop must pass check_public_url) and no proxy from the environment.
    transport = httpx.HTTPTransport()
    # httpx has no public hook for the network backend, so swap its pool.
    transport._pool = httpcore.ConnectionPool(
        ssl_context=httpx.create_ssl_context(),
        network_backend=GuardedBackend(resolve))
    return httpx.Client(transport=transport, timeout=timeout,
                        headers={"User-Agent": UA},
                        follow_redirects=False, trust_env=False)
