"""The address guard in front of the Omeka fetcher.

Resolvers are injected, so no test here touches real DNS or the network.
"""

from __future__ import annotations

import httpx
import pytest

from app.net_guard import check_public_url, is_public_address
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
