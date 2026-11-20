"""Omeka fetching: the API calls and the file download, through the address
guard and inside the route's time budget. MockTransport and a fake resolver;
no test touches the network or real DNS."""

from __future__ import annotations

import gzip
import json
import time
from pathlib import Path

import httpx
import pytest

from app.net_guard import BAD_URL, make_guarded_client
from app.omeka import (
    MAX_REDIRECTS,
    OMEKA_REQUEST_TIMEOUT,
    fetch_file,
    get_site,
    list_files,
    search_items,
)
from app.tools import ToolError, make_client

FIX = Path(__file__).parent / "fixtures" / "omeka"
BASE = "https://omeka.example"
JPEG = b"\xff\xd8\xff\xe0" + b"\x00" * 64
MP3 = b"ID3\x03\x00" + b"\x00" * 64


def PUBLIC(host: str, port: int) -> list[str]:
    return ["93.184.216.34"]


def far() -> float:
    return time.monotonic() + 30.0


def fixture(name: str) -> bytes:
    return (FIX / name).read_bytes()


def client_for(handler) -> httpx.Client:
    return make_client(httpx.MockTransport(handler), OMEKA_REQUEST_TIMEOUT)


def counting(handler):
    seen: list[httpx.Request] = []

    def wrapped(request: httpx.Request) -> httpx.Response:
        seen.append(request)
        return handler(request)
    return wrapped, seen


# --- API calls ---------------------------------------------------------------

def test_search_live_shape():
    def handler(request):
        assert request.url.path == "/api/items"
        assert request.headers["accept"] == "application/json"
        return httpx.Response(200, content=fixture("items.json"),
                              headers={"Omeka-Total-Results": "6"})
    with client_for(handler) as c:
        r = search_items(c, BASE, "a", 1, deadline=far(), resolve=PUBLIC)
    assert r["total"] == 6 and r["page"] == 1
    assert [x["itemId"] for x in r["results"]] == [1, 2, 3, 5, 6, 7]


def test_search_drops_items_without_files_and_total_defaults_to_zero():
    items = json.loads(fixture("items.json"))
    items[0]["files"]["count"] = 0
    with client_for(lambda req: httpx.Response(200, json=items)) as c:
        r = search_items(c, BASE, "a", 1, deadline=far(), resolve=PUBLIC)
    assert r["total"] == 0
    assert [x["itemId"] for x in r["results"]] == [2, 3, 5, 6, 7]


def test_search_sends_query_and_page():
    def handler(request):
        assert request.url.params["search"] == "cupola"
        assert request.url.params["page"] == "2"
        return httpx.Response(200, json=[], headers={"Omeka-Total-Results": "0"})
    with client_for(handler) as c:
        r = search_items(c, BASE, "cupola", 2, deadline=far(), resolve=PUBLIC)
    assert r == {"total": 0, "page": 2, "rawCount": 0, "results": []}


def test_get_json_bad_json_is_502():
    html = client_for(lambda req: httpx.Response(200, text="<html>hi</html>"))
    with html as c, pytest.raises(ToolError) as e:
        search_items(c, BASE, "a", 1, deadline=far(), resolve=PUBLIC)
    assert e.value.status == 502
    assert "omeka.example" in e.value.message


def test_search_api_error_status_uses_site_table():
    with client_for(lambda req: httpx.Response(503)) as c, pytest.raises(ToolError) as e:
        search_items(c, BASE, "a", 1, deadline=far(), resolve=PUBLIC)
    assert e.value.status == 502 and "had an error (503)" in e.value.message


def test_get_site_reads_title():
    def handler(request):
        assert request.url == httpx.URL(f"{BASE}/api/site")
        return httpx.Response(200, content=fixture("site.json"))
    with client_for(handler) as c:
        site = get_site(c, BASE, deadline=far(), resolve=PUBLIC)
    assert site == {"base": BASE, "title": "Madelyn's Interests and Exhibits"}


def test_get_site_api_disabled_is_409():
    with client_for(lambda req: httpx.Response(
            403, json={"message": "API is disabled"})) as c, pytest.raises(ToolError) as e:
        get_site(c, BASE, deadline=far(), resolve=PUBLIC)
    assert e.value.status == 409


def test_list_files_returns_raw_records():
    def handler(request):
        assert request.url.path == "/api/files"
        assert request.url.params["item"] == "3"
        return httpx.Response(200, content=fixture("files-3.json"))
    with client_for(handler) as c:
        files = list_files(c, BASE, 3, deadline=far(), resolve=PUBLIC)
    assert files == json.loads(fixture("files-3.json"))


def test_redirect_rechecked_each_hop():
    handler, seen = counting(lambda req: httpx.Response(
        302, headers={"Location": "http://10.0.0.1/api/site"}))
    with client_for(handler) as c, pytest.raises(ToolError) as e:
        get_site(c, BASE, deadline=far(), resolve=PUBLIC)
    assert e.value.status == 400
    assert len(seen) == 1


def test_redirect_followed_to_public_host():
    def handler(request):
        if request.url.host == "omeka.example":
            return httpx.Response(301, headers={"Location": "https://www.omeka.example/api/site"})
        return httpx.Response(200, content=fixture("site.json"))
    handler, seen = counting(handler)
    with client_for(handler) as c:
        site = get_site(c, BASE, deadline=far(), resolve=PUBLIC)
    assert site["title"] == "Madelyn's Interests and Exhibits"
    assert [r.url.host for r in seen] == ["omeka.example", "www.omeka.example"]


def test_too_many_redirects():
    def handler(request):
        n = int(request.url.params.get("n", "0"))
        return httpx.Response(302, headers={"Location": f"{BASE}/api/site?n={n + 1}"})
    handler, seen = counting(handler)
    with client_for(handler) as c, pytest.raises(ToolError) as e:
        get_site(c, BASE, deadline=far(), resolve=PUBLIC)
    assert e.value.status == 502
    assert len(seen) == MAX_REDIRECTS + 1


def test_unreachable_message():
    def handler(request):
        raise httpx.ConnectError("connection refused", request=request)
    with client_for(handler) as c, pytest.raises(ToolError) as e:
        get_site(c, BASE, deadline=far(), resolve=PUBLIC)
    assert e.value.status == 502
    assert e.value.message.startswith("The editor's server could not reach omeka.example (")


def test_deadline_spent_is_504():
    handler, seen = counting(lambda req: httpx.Response(200, content=fixture("site.json")))
    with client_for(handler) as c, pytest.raises(ToolError) as e:
        get_site(c, BASE, deadline=time.monotonic() - 1, resolve=PUBLIC)
    assert e.value.status == 504
    assert e.value.message == ("The Omeka site at omeka.example took too long to answer. "
                               "Try again, or try a smaller file.")
    assert seen == []


def test_timeout_at_the_budget_edge_is_504():
    def handler(request):
        raise httpx.ReadTimeout("timed out", request=request)
    with client_for(handler) as c, pytest.raises(ToolError) as e:
        get_site(c, BASE, deadline=time.monotonic() + 2, resolve=PUBLIC)
    assert e.value.status == 504


def test_per_request_timeout_never_exceeds_remaining_budget():
    timeouts: list[dict] = []

    def handler(request):
        timeouts.append(request.extensions["timeout"])
        if request.url.path == "/api/site":
            return httpx.Response(302, headers={"Location": f"{BASE}/api/site2"})
        return httpx.Response(200, content=fixture("site.json"))
    with client_for(handler) as c:
        get_site(c, BASE, deadline=time.monotonic() + 3, resolve=PUBLIC)
        get_site(c, BASE, deadline=far(), resolve=PUBLIC)
    assert len(timeouts) == 4
    for t in timeouts[:2]:
        assert all(v is not None and 0 < v <= 3 for v in t.values())
    for t in timeouts:
        assert all(v is not None and v <= OMEKA_REQUEST_TIMEOUT for v in t.values())


# --- the file download -------------------------------------------------------

def test_fetch_file_image_ok():
    with client_for(lambda req: httpx.Response(200, content=JPEG)) as c:
        body = fetch_file(c, f"{BASE}/files/fullsize/a.jpg", "image",
                          deadline=far(), resolve=PUBLIC, max_bytes=1000)
    assert body == JPEG


def test_fetch_file_audio_ok():
    with client_for(lambda req: httpx.Response(200, content=MP3)) as c:
        body = fetch_file(c, f"{BASE}/files/original/a.mp3", "audio",
                          deadline=far(), resolve=PUBLIC, max_bytes=1000)
    assert body == MP3


def test_fetch_file_wrong_kind():
    mp3 = client_for(lambda req: httpx.Response(200, content=MP3))
    with mp3 as c, pytest.raises(ToolError) as e:
        fetch_file(c, f"{BASE}/files/fullsize/a.jpg", "image",
                   deadline=far(), resolve=PUBLIC, max_bytes=1000)
    assert e.value.status == 502


def test_fetch_file_declared_too_big():
    def stream():
        raise AssertionError("body was read")
        yield b""  # pragma: no cover

    class Unread(httpx.SyncByteStream):
        def __iter__(self):
            return stream()

    def handler(request):
        return httpx.Response(200, headers={"Content-Length": "1001"}, stream=Unread())
    with client_for(handler) as c, pytest.raises(ToolError) as e:
        fetch_file(c, f"{BASE}/a.jpg", "image", deadline=far(), resolve=PUBLIC,
                   max_bytes=1000)
    assert e.value.status == 502 and "larger" in e.value.message


def test_fetch_file_streamed_too_big():
    class Chunks(httpx.SyncByteStream):
        def __iter__(self):
            yield JPEG
            for _ in range(100):
                yield b"\x00" * 100

    chunked = client_for(lambda req: httpx.Response(200, stream=Chunks()))
    with chunked as c, pytest.raises(ToolError) as e:
        fetch_file(c, f"{BASE}/a.jpg", "image", deadline=far(), resolve=PUBLIC,
                   max_bytes=1000)
    assert e.value.status == 502 and "larger" in e.value.message


def test_fetch_file_retries_once_on_5xx():
    replies = iter([httpx.Response(503), httpx.Response(200, content=JPEG)])
    handler, seen = counting(lambda req: next(replies))
    with client_for(handler) as c:
        assert fetch_file(c, f"{BASE}/a.jpg", "image", deadline=far(), resolve=PUBLIC,
                          max_bytes=1000) == JPEG
    assert len(seen) == 2

    handler, seen = counting(lambda req: httpx.Response(503))
    with client_for(handler) as c, pytest.raises(ToolError) as e:
        fetch_file(c, f"{BASE}/a.jpg", "image", deadline=far(), resolve=PUBLIC,
                   max_bytes=1000)
    assert e.value.status == 502
    assert len(seen) == 2


def test_fetch_file_retries_once_on_connect_error():
    calls = []

    def handler(request):
        calls.append(request)
        if len(calls) == 1:
            raise httpx.ConnectError("reset", request=request)
        return httpx.Response(200, content=JPEG)
    with client_for(handler) as c:
        assert fetch_file(c, f"{BASE}/a.jpg", "image", deadline=far(), resolve=PUBLIC,
                          max_bytes=1000) == JPEG
    assert len(calls) == 2


def test_fetch_file_4xx_no_retry():
    handler, seen = counting(lambda req: httpx.Response(404))
    with client_for(handler) as c, pytest.raises(ToolError) as e:
        fetch_file(c, f"{BASE}/a.jpg", "image", deadline=far(), resolve=PUBLIC,
                   max_bytes=1000)
    assert e.value.status == 502
    assert len(seen) == 1


def test_fetch_file_redirect_to_private_is_400():
    handler, seen = counting(lambda req: httpx.Response(
        302, headers={"Location": "http://127.0.0.1/a.jpg"}))
    with client_for(handler) as c, pytest.raises(ToolError) as e:
        fetch_file(c, f"{BASE}/a.jpg", "image", deadline=far(), resolve=PUBLIC,
                   max_bytes=1000)
    assert e.value.status == 400
    assert len(seen) == 1


def test_fetch_file_uses_the_download_budget():
    timeouts = []

    def handler(request):
        timeouts.append(request.extensions["timeout"]["read"])
        return httpx.Response(200, content=JPEG)
    with client_for(handler) as c:
        fetch_file(c, f"{BASE}/a.jpg", "image", deadline=time.monotonic() + 4,
                   resolve=PUBLIC, max_bytes=1000)
    assert 0 < timeouts[0] <= 4


def test_fetch_file_read_timeout_mid_body():
    def chunks(request):
        yield JPEG
        raise httpx.ReadTimeout("timed out", request=request)

    class Body(httpx.SyncByteStream):
        def __init__(self, request):
            self.request = request

        def __iter__(self):
            return chunks(self.request)

    handler, seen = counting(lambda req: httpx.Response(200, stream=Body(req)))
    # Plenty of budget: a stalled read is a transport failure, retried once.
    with client_for(handler) as c, pytest.raises(ToolError) as e:
        fetch_file(c, f"{BASE}/a.jpg", "image", deadline=far(), resolve=PUBLIC,
                   max_bytes=1000)
    assert e.value.status == 502 and len(seen) == 2
    # Budget nearly spent: the read timeout was the budget, so it is the 504.
    handler, seen = counting(lambda req: httpx.Response(200, stream=Body(req)))
    with client_for(handler) as c, pytest.raises(ToolError) as e:
        fetch_file(c, f"{BASE}/a.jpg", "image", deadline=time.monotonic() + 2,
                   resolve=PUBLIC, max_bytes=1000)
    assert e.value.status == 504 and len(seen) == 1


class Drip(httpx.SyncByteStream):
    """A body that never ends, one small chunk at a time."""

    def __init__(self, pause: float = 0.0):
        self.pause = pause

    def __iter__(self):
        yield b"["
        while True:
            time.sleep(self.pause)
            yield b"1," * 1024


def test_api_body_is_bounded_by_the_deadline():
    # Each chunk arrives well within the per-read timeout, so only the
    # deadline stops a slow, endless answer.
    drip = client_for(lambda req: httpx.Response(200, stream=Drip(pause=0.05)))
    with drip as c, pytest.raises(ToolError) as e:
        search_items(c, BASE, "a", 1, deadline=time.monotonic() + 0.3, resolve=PUBLIC)
    assert e.value.status == 504


def test_api_body_is_capped():
    drip = client_for(lambda req: httpx.Response(200, stream=Drip()))
    with drip as c, pytest.raises(ToolError) as e:
        search_items(c, BASE, "a", 1, deadline=far(), resolve=PUBLIC)
    assert e.value.status == 502 and "too large" in e.value.message


# --- review fixes: the body's read timeout, and the connect-time guard -------

class FakeClock:
    def __init__(self):
        self.now = 1000.0

    def __call__(self) -> float:
        return self.now


class Stall(httpx.SyncByteStream):
    """One chunk, then a read that stalls for its whole read timeout (on the
    fake clock) and times out. Records the read timeout it was given."""

    def __init__(self, request, clock, seen):
        self.request, self.clock, self.seen = request, clock, seen

    def __iter__(self):
        read = self.request.extensions["timeout"]["read"]
        self.seen.append(read)
        yield JPEG
        self.clock.now += read
        raise httpx.ReadTimeout("timed out", request=self.request)


def test_body_read_timeout_past_the_deadline_is_504(monkeypatch):
    clock = FakeClock()
    monkeypatch.setattr("app.omeka.time.monotonic", clock)
    reads: list[float] = []

    def handler(request):
        clock.now += 5  # the headers take 5 s; 7 s of a 12 s budget remain
        return httpx.Response(200, stream=Stall(request, clock, reads))
    handler, seen = counting(handler)
    with client_for(handler) as c, pytest.raises(ToolError) as e:
        fetch_file(c, f"{BASE}/a.jpg", "image", deadline=clock.now + 12,
                   resolve=PUBLIC, max_bytes=1000)
    assert e.value.status == 504
    assert reads == [pytest.approx(7.0)] and len(seen) == 1
    assert clock.now == pytest.approx(1012.0)  # stopped at the deadline, not past it

    # The API path has no retry to hide the overrun behind: still the 504.
    reads.clear()
    with client_for(handler) as c, pytest.raises(ToolError) as e:
        get_site(c, BASE, deadline=clock.now + 12, resolve=PUBLIC)
    assert e.value.status == 504
    assert reads == [pytest.approx(7.0)]


def test_body_read_timeout_is_capped_to_the_remaining_budget(monkeypatch):
    clock = FakeClock()
    monkeypatch.setattr("app.omeka.time.monotonic", clock)
    reads: list[float] = []

    class Once(httpx.SyncByteStream):
        def __init__(self, request):
            self.request = request

        def __iter__(self):
            reads.append(self.request.extensions["timeout"]["read"])
            yield JPEG

    def handler(request):
        clock.now += 7  # the headers took 7 s of a 10 s budget
        return httpx.Response(200, stream=Once(request))
    with client_for(handler) as c:
        fetch_file(c, f"{BASE}/a.jpg", "image", deadline=clock.now + 10,
                   resolve=PUBLIC, max_bytes=1000)
    assert reads == [pytest.approx(3.0)]


def test_connect_time_refusal_is_400_on_the_api_path():
    private = lambda host, port: ["10.0.0.5"]
    # The pre-check sees a public answer; the connect-time lookup (rebinding)
    # sees a private one.
    with make_guarded_client(OMEKA_REQUEST_TIMEOUT, resolve=private) as c, \
            pytest.raises(ToolError) as e:
        get_site(c, BASE, deadline=far(), resolve=PUBLIC)
    assert e.value.status == 400
    assert e.value.message == ("omeka.example points to a private or local network "
                               "address, which the editor will not connect to.")


def test_connect_time_refusal_is_400_on_download_and_not_retried():
    lookups = []

    def private(host, port):
        lookups.append(host)
        return ["10.0.0.5"]
    with make_guarded_client(OMEKA_REQUEST_TIMEOUT, resolve=private) as c, \
            pytest.raises(ToolError) as e:
        fetch_file(c, f"{BASE}/a.jpg", "image", deadline=far(), resolve=PUBLIC,
                   max_bytes=1000)
    assert e.value.status == 400
    assert lookups == ["omeka.example"]


# --- compressed answers, Cloudflare challenges, malformed redirects ------------

def gzipped(body: bytes, **headers) -> httpx.Response:
    return httpx.Response(200, content=gzip.compress(body),
                          headers={"Content-Encoding": "gzip", **headers})


def test_gzipped_api_answers_are_decoded_once():
    def handler(request):
        if request.url.path == "/api/site":
            return gzipped(fixture("site.json"))
        return gzipped(fixture("items.json"), **{"Omeka-Total-Results": "6"})
    with client_for(handler) as c:
        site = get_site(c, BASE, deadline=far(), resolve=PUBLIC)
        r = search_items(c, BASE, "a", 1, deadline=far(), resolve=PUBLIC)
    assert site["title"] == "Madelyn's Interests and Exhibits"
    assert [x["itemId"] for x in r["results"]] == [1, 2, 3, 5, 6, 7]


def test_gzipped_file_is_decoded_once():
    with client_for(lambda req: gzipped(JPEG)) as c:
        assert fetch_file(c, f"{BASE}/a.jpg", "image", deadline=far(), resolve=PUBLIC,
                          max_bytes=1000) == JPEG


def test_search_raw_count_is_items_before_filtering():
    items = json.loads(fixture("items.json"))
    items[0]["files"]["count"] = 0
    with client_for(lambda req: httpx.Response(
            200, json=items, headers={"Omeka-Total-Results": "6"})) as c:
        r = search_items(c, BASE, "a", 1, deadline=far(), resolve=PUBLIC)
    assert r["rawCount"] == 6 and len(r["results"]) == 5


def test_search_live_raw_count():
    with client_for(lambda req: httpx.Response(
            200, content=fixture("items.json"),
            headers={"Omeka-Total-Results": "6"})) as c:
        r = search_items(c, BASE, "a", 1, deadline=far(), resolve=PUBLIC)
    assert r["rawCount"] == 6


CHALLENGE = {"cf-mitigated": "challenge", "server": "cloudflare",
             "content-type": "text/html; charset=UTF-8"}


def test_cloudflare_challenge_on_the_api_list_is_409():
    with client_for(lambda req: httpx.Response(
            403, text="<html>Just a moment...</html>", headers=CHALLENGE)) as c, \
            pytest.raises(ToolError) as e:
        search_items(c, BASE, "a", 1, deadline=far(), resolve=PUBLIC)
    assert e.value.status == 409 and "behind Cloudflare" in e.value.message


@pytest.mark.parametrize("status", [403, 503])
def test_cloudflare_challenge_on_download_is_409_and_not_retried(status):
    handler, seen = counting(lambda req: httpx.Response(
        status, text="<html>Just a moment...</html>", headers=CHALLENGE))
    with client_for(handler) as c, pytest.raises(ToolError) as e:
        fetch_file(c, f"{BASE}/a.jpg", "image", deadline=far(), resolve=PUBLIC,
                   max_bytes=1000)
    assert e.value.status == 409
    assert e.value.message.startswith(
        "The Omeka site at omeka.example is behind Cloudflare, which challenged")
    assert len(seen) == 1


def test_malformed_redirect_location_is_400():
    handler, seen = counting(lambda req: httpx.Response(
        302, headers={"Location": "http://[::1"}))
    with client_for(handler) as c, pytest.raises(ToolError) as e:
        get_site(c, BASE, deadline=far(), resolve=PUBLIC)
    assert e.value.status == 400 and e.value.message == BAD_URL
    assert len(seen) == 1
