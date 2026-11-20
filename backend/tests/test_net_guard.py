"""The address guard in front of the Omeka fetcher.

Resolvers are injected, so no test here touches real DNS or the network.
"""

from __future__ import annotations

import httpcore
import httpx
import pytest

from app.net_guard import (
    BAD_URL,
    GuardedBackend,
    GuardRefused,
    check_public_url,
    is_public_address,
    make_guarded_client,
)
from app.tools import ToolError

PUBLIC = lambda host, port: ["104.21.46.14"]
PRIVATE = lambda host, port: ["10.0.0.5"]
MIXED = lambda host, port: ["104.21.46.14", "127.0.0.1"]


# --- address classification ------------------------------------------------

@pytest.mark.parametrize("ip", [
    "127.0.0.1", "10.1.2.3", "172.16.0.1", "192.168.1.1", "169.254.169.254",
    "100.64.0.1", "0.0.0.0", "224.0.0.1", "::1", "fe80::1", "fc00::1",
    "::ffff:127.0.0.1", "::ffff:10.0.0.1"])
def test_non_public_refused(ip):
    assert not is_public_address(ip)


@pytest.mark.parametrize("ip", ["104.21.46.14", "172.67.222.62", "2606:4700::6810:2e0e"])
def test_public_allowed(ip):
    assert is_public_address(ip)


# --- URL checks before a request -------------------------------------------

@pytest.mark.parametrize("url", [
    "ftp://example.org/", "https://a@example.org/", "https://example.org:8443/",
    "http://example.org:443/", "file:///etc/passwd", "not a url"])
def test_bad_url_shapes_refused(url):
    with pytest.raises(ToolError) as e:
        check_public_url(url, resolve=PUBLIC)
    assert e.value.status == 400
    assert e.value.message == BAD_URL


def test_private_resolution_refused_with_spec_message():
    with pytest.raises(ToolError) as e:
        check_public_url("https://intranet.example/", resolve=PRIVATE)
    assert e.value.status == 400
    assert e.value.message == ("intranet.example points to a private or local network "
                               "address, which the editor will not connect to.")


def test_any_private_address_among_several_refuses():
    with pytest.raises(ToolError) as e:
        check_public_url("https://omeka.example/", resolve=MIXED)
    assert e.value.status == 400


def test_ip_literal_checked_without_resolving():
    def never(host, port):
        raise AssertionError("resolver called for an IP literal")
    with pytest.raises(ToolError) as e:
        check_public_url("http://127.0.0.1/", resolve=never)
    assert e.value.status == 400
    assert check_public_url("http://104.21.46.14/", resolve=never).host == "104.21.46.14"


def test_public_https_and_http_default_ports_pass():
    for url in ("https://omeka.example/api/items", "http://omeka.example:80/api/items"):
        got = check_public_url(url, resolve=PUBLIC)
        assert isinstance(got, httpx.URL)
        assert got.host == "omeka.example"


def test_name_that_does_not_resolve_is_unreachable():
    def nxdomain(host, port):
        raise OSError("nodename nor servname provided")
    with pytest.raises(ToolError) as e:
        check_public_url("https://nowhere.example/", resolve=nxdomain)
    assert e.value.status == 502
    assert e.value.message.startswith(
        "The editor's server could not reach nowhere.example (the name did not resolve).")


# --- the check again at connect time (DNS rebinding) ------------------------

class FakeStream(httpcore.NetworkStream):
    pass


class FakeInner(httpcore.NetworkBackend):
    """Records where the guard told it to connect, instead of connecting."""

    def __init__(self):
        self.connected = []

    def connect_tcp(self, host, port, timeout=None, local_address=None, socket_options=None):
        self.connected.append((host, port))
        return FakeStream()


def test_connects_to_the_address_it_checked():
    inner = FakeInner()
    GuardedBackend(PUBLIC, inner).connect_tcp("omeka.example", 443)
    assert inner.connected == [("104.21.46.14", 443)]


class FlakyInner(FakeInner):
    """Fails to connect to the addresses in `down`, recording every attempt
    and the timeout it was given."""

    def __init__(self, down, error=httpcore.ConnectError):
        super().__init__()
        self.down, self.error, self.timeouts = set(down), error, []

    def connect_tcp(self, host, port, timeout=None, local_address=None, socket_options=None):
        self.timeouts.append(timeout)
        if host in self.down:
            self.connected.append((host, port))
            raise self.error(f"{host} unreachable")
        return super().connect_tcp(host, port, timeout)


def test_bad_url_message_is_a_sentence():
    assert BAD_URL == ("That is not an address the editor can fetch: only http and https "
                       "web addresses on the usual ports (80 and 443) are allowed.")


def test_ipv4_addresses_are_tried_first():
    inner = FakeInner()
    GuardedBackend(lambda h, p: ["2606:4700::6810:2e0e", "104.21.46.14"],
                   inner).connect_tcp("omeka.example", 443)
    assert inner.connected == [("104.21.46.14", 443)]


@pytest.mark.parametrize("error", [httpcore.ConnectError, httpcore.ConnectTimeout])
def test_next_address_tried_when_one_fails(error):
    inner = FlakyInner({"104.21.46.14"}, error)
    stream = GuardedBackend(lambda h, p: ["104.21.46.14", "172.67.222.62"],
                            inner).connect_tcp("omeka.example", 443, timeout=10.0)
    assert isinstance(stream, FakeStream)
    assert inner.connected == [("104.21.46.14", 443), ("172.67.222.62", 443)]
    assert inner.timeouts[0] == 5.0 and sum(inner.timeouts) <= 10.0


def test_every_address_failing_raises_the_connect_error():
    addresses = ["104.21.46.14", "172.67.222.62", "2606:4700::6810:2e0e"]
    inner = FlakyInner(set(addresses))
    with pytest.raises(httpcore.ConnectError) as e:
        GuardedBackend(lambda h, p: addresses, inner).connect_tcp(
            "omeka.example", 443, timeout=10.0)
    assert not isinstance(e.value, GuardRefused)
    assert [h for h, _ in inner.connected] == addresses
    # Each attempt has a share of the timeout, at least 3 s, never past it in total.
    assert all(t >= 3.0 for t in inner.timeouts) and sum(inner.timeouts) <= 10.0


def test_any_private_address_refuses_the_host_at_connect():
    inner = FlakyInner(set())
    with pytest.raises(GuardRefused):
        GuardedBackend(MIXED, inner).connect_tcp("omeka.example", 443)
    assert inner.connected == [] and inner.timeouts == []


def test_rebinding_refused_at_connect():
    answers = iter([["104.21.46.14"], ["127.0.0.1"]])
    resolver = lambda h, p: next(answers)
    check_public_url("https://omeka.example/", resolve=resolver)  # first lookup passes
    inner = FakeInner()
    with pytest.raises(GuardRefused, match="private or local network address"):
        GuardedBackend(resolver, inner).connect_tcp("omeka.example", 443)
    assert inner.connected == []


def test_guard_refusal_is_a_connect_error_others_are_not_refusals():
    assert issubclass(GuardRefused, httpcore.ConnectError)
    with pytest.raises(httpcore.ConnectError) as e:
        GuardedBackend(lambda h, p: (_ for _ in ()).throw(OSError("nx")),
                       FakeInner()).connect_tcp("omeka.example", 443)
    assert not isinstance(e.value, GuardRefused)


def test_unix_sockets_refused():
    with pytest.raises(httpcore.ConnectError):
        GuardedBackend(PUBLIC, FakeInner()).connect_unix_socket("/var/run/docker.sock")


def test_production_client_uses_guarded_backend():
    c = make_guarded_client(5.0)
    assert isinstance(c._transport._pool._network_backend, GuardedBackend)
    assert c.follow_redirects is False and c._trust_env is False
    assert c.headers["User-Agent"].startswith("clio-wired")


def test_guarded_client_refuses_a_private_name_end_to_end():
    """A request through the real client stops at connect, before any socket."""
    with (make_guarded_client(5.0, resolve=PRIVATE) as c,
          pytest.raises(httpx.ConnectError, match="private or local") as e):
        c.get("http://intranet.example/")
    assert isinstance(e.value.__cause__, GuardRefused)
