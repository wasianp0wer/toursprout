"""The acquisition tools.

The three network tools are tested against `httpx.MockTransport` with response
shapes taken from the content scripts' parsing code (provenance is noted at
each fixture). No test here touches the network; narration runs the real
`/usr/bin/say`.
"""

from __future__ import annotations

import shutil

import httpx
import pytest
from fastapi.testclient import TestClient

from app.config import Settings
from app.main import create_app
from app.media_store import sniff

# --- captured shapes -------------------------------------------------------

# Shape implied by content/scripts/probe_coverage.py `probe()`: it reads
# data["data"][*] with id, computed_geometry|geometry {coordinates: [lng, lat]},
# is_pano, captured_at (epoch ms), compass_angle. VERIFIED LIVE (0004):
# `thumb_256_url` is a real field (a 256x128 scontent.xx.fbcdn.net URL) and the
# call returns 200; an unknown field is silently ignored, not a 400. Ids are
# strings. A bad token is HTTP 400 {"error": {"message", "type":
# "OAuthException", "code": 190, "fbtrace_id"}}.
MAPILLARY_LIST = {"data": [
    {"id": "flat1", "computed_geometry": {"type": "Point", "coordinates": [-77.3062, 38.8460]},
     "is_pano": False, "captured_at": 1600000000000, "compass_angle": 10.0,
     "thumb_256_url": "https://scontent.example/flat1.jpg"},
    {"id": "far", "computed_geometry": {"type": "Point", "coordinates": [-77.3065, 38.8463]},
     "is_pano": True, "captured_at": 1650000000000, "compass_angle": 200.5,
     "thumb_256_url": "https://scontent.example/far.jpg"},
    # Fell back to raw `geometry` (no computed_geometry), as probe() allows.
    {"id": "near", "geometry": {"type": "Point", "coordinates": [-77.30618, 38.84602]},
     "is_pano": True, "captured_at": 1700000000000, "compass_angle": 90.0,
     "thumb_256_url": "https://scontent.example/near.jpg"},
    # No position at all: probe() skips these.
    {"id": "nopos", "is_pano": True, "captured_at": 1}]}

# Shape implied by probe_coverage.py `discover_sites()`: elements[*] with
# type, id, lat/lon (nodes) or center.{lat,lon} (ways/relations), tags.name.
# VERIFIED LIVE (0004): that is the real shape, with the envelope keys
# version/generator/osm3s beside `elements` (and `remark` on a runtime error).
OVERPASS = {"elements": [
    {"type": "node", "id": 11, "lat": 38.8460, "lon": -77.3062,
     "tags": {"name": "Old Town Hall", "historic": "building"}},
    {"type": "way", "id": 22, "center": {"lat": 38.8470, "lon": -77.3070},
     "tags": {"name": "Fairfax Museum", "tourism": "museum"}},
    {"type": "node", "id": 33, "lat": 38.8461, "lon": -77.3063,
     "tags": {"name": "Some Church", "amenity": "place_of_worship"}},
    {"type": "node", "id": 44, "lat": 38.8462, "lon": -77.3064, "tags": {"historic": "yes"}},
    {"type": "node", "id": 11, "lat": 38.8460, "lon": -77.3062,
     "tags": {"name": "Old Town Hall", "historic": "building"}}]}

# Shape OBSERVED from the live loc.gov /photos/ API (docs/decisions/0004):
# results[*] have `url` (https) and `id` (the same address over http), a str
# `title` and `date`, `image_url` as a LIST (index 0 is a 150px JPEG, then a GIF
# thumbnail, ~640px, ~1024px; some items have one IIIF entry; `#h=..&w=..`
# fragments), a lowercased `contributor` list, and NO top-level `creator` or
# `rights`: the photographer is `item.creators[].title` and the rights text is
# `item.rights_advisory`. The scripts also tolerate protocol-relative URLs and
# list-valued titles, so those variants are kept below.
LOC = {"results": [
    {"title": "Fairfax Court House, Virginia", "date": "1863",
     "id": "http://www.loc.gov/item/1/", "url": "https://www.loc.gov/item/1/",
     "contributor": ["o'sullivan, timothy h.", "gardner, alexander"],
     "image_url": ["https://tile.loc.gov/t/1_150px.jpg#h=114&w=150",
                   "https://tile.loc.gov/t/1t.gif#h=114&w=150",
                   "https://tile.loc.gov/t/1r.jpg#h=488&w=640",
                   "https://tile.loc.gov/t/1v.jpg#h=780&w=1024"],
     "item": {"creators": [{"link": "https://www.loc.gov/pictures/related/?fi=name",
                            "role": "photographer", "title": "O'Sullivan, Timothy H., 1840-1882"},
                           {"role": "photographer", "title": "Gardner, Alexander, 1821-1882"}],
              "contributors": ["O'Sullivan, Timothy H., 1840-1882, photographer."],
              "rights_advisory": "No known restrictions on publication.",
              "rights_information": "No known restrictions on publication."}},
    {"title": ["Alexandria Court House"], "date": ["1900"], "id": "http://www.loc.gov/item/2/",
     "image_url": ["https://tile.loc.gov/t/2.jpg"]},
    {"title": "Fairfax Court House, no image", "date": "1910", "id": "http://www.loc.gov/item/3/"},
    {"title": "Fairfax Court House interior", "date": "1920",
     "id": "http://www.loc.gov/item/4/", "url": "https://www.loc.gov/item/4/",
     "image_url": ["//tile.loc.gov/t/4.jpg"], "item": {"rights_advisory": None}}]}


@pytest.fixture
def client(tmp_path):
    cfg = Settings(content_dir=tmp_path, frontend_dist=tmp_path / "nodist",
                   mapillary_token="test-token")
    with TestClient(create_app(cfg)) as c:
        yield c


def mock(client, handler):
    client.app.state.http_transport = httpx.MockTransport(handler)


def open_tour(client):
    assert client.post("/api/session/new", json={"title": "t"}).status_code == 200


# --- shared ---------------------------------------------------------------

TOOLS = {
    "panoramas": {"lng": -77.3062, "lat": 38.846},
    "places": {"lng": -77.3062, "lat": 38.846},
    "archive-search": {"query": "fairfax court house"},
    "narrate": {"text": "Hello."},
    "archive-fetch": {"imageUrl": "https://tile.loc.gov/t/1.jpg"},
}


@pytest.mark.parametrize("tool", TOOLS)
def test_cross_site_refused(client, tool):
    r = client.post(f"/api/tools/{tool}", json=TOOLS[tool],
                    headers={"Sec-Fetch-Site": "cross-site"})
    assert r.status_code == 403


@pytest.mark.parametrize("tool", ["panoramas", "places", "archive-search"])
def test_timeout_is_502_with_message(client, tool):
    def handler(request):
        raise httpx.ReadTimeout("slow", request=request)
    mock(client, handler)
    r = client.post(f"/api/tools/{tool}", json=TOOLS[tool])
    assert r.status_code == 502
    assert "timed out" in r.json()["detail"]


@pytest.mark.parametrize("tool", ["panoramas", "places", "archive-search"])
def test_garbage_body_is_502(client, tool):
    mock(client, lambda request: httpx.Response(200, text="<html>not json"))
    r = client.post(f"/api/tools/{tool}", json=TOOLS[tool])
    assert r.status_code == 502


@pytest.mark.parametrize("tool", ["panoramas", "places", "archive-search"])
def test_upstream_5xx_is_502(client, tool):
    mock(client, lambda request: httpx.Response(503, text="down"))
    r = client.post(f"/api/tools/{tool}", json=TOOLS[tool])
    assert r.status_code == 502
    assert "503" in r.json()["detail"]


def test_bad_input_is_422(client):
    assert client.post("/api/tools/panoramas", json={"lng": 500, "lat": 0}).status_code == 422
    assert client.post("/api/tools/archive-search", json={"query": " "}).status_code == 422


# --- panoramas ------------------------------------------------------------

def test_panoramas_return_the_cameras_own_position(client):
    seen = {}

    def handler(request):
        seen["url"] = request.url
        return httpx.Response(200, json=MAPILLARY_LIST)
    mock(client, handler)
    r = client.post("/api/tools/panoramas", json={"lng": -77.3062, "lat": 38.846})
    assert r.status_code == 200
    got = r.json()["candidates"]
    # Panoramas only, nearest first; position-less images dropped.
    assert [c["imageId"] for c in got] == ["near", "far"]
    near = got[0]
    assert (near["lng"], near["lat"]) == (-77.30618, 38.84602)
    assert near["capturedAt"] == 1700000000000
    assert near["thumbUrl"] == "https://scontent.example/near.jpg"
    assert near["distanceM"] < got[1]["distanceM"]
    q = seen["url"].params
    assert seen["url"].host == "graph.mapillary.com"
    assert q["access_token"] == "test-token"
    assert "computed_geometry" in q["fields"] and "thumb_256_url" in q["fields"]
    assert len(q["bbox"].split(",")) == 4


def test_panoramas_can_include_flat_images(client):
    mock(client, lambda request: httpx.Response(200, json=MAPILLARY_LIST))
    r = client.post("/api/tools/panoramas",
                    json={"lng": -77.3062, "lat": 38.846, "panoOnly": False})
    ids = [c["imageId"] for c in r.json()["candidates"]]
    assert set(ids) == {"flat1", "far", "near"}


def test_panoramas_without_a_token_is_a_clear_4xx(tmp_path):
    cfg = Settings(content_dir=tmp_path, frontend_dist=tmp_path / "nodist", mapillary_token="")
    with TestClient(create_app(cfg)) as c:
        r = c.post("/api/tools/panoramas", json={"lng": -77.3, "lat": 38.8})
    assert r.status_code == 400
    assert "mapillary" in r.json()["detail"].lower()


def test_panoramas_rejected_token_is_502_not_500(client):
    mock(client, lambda request: httpx.Response(
        400, json={"error": {"message": "Invalid OAuth access token."}}))
    r = client.post("/api/tools/panoramas", json=TOOLS["panoramas"])
    assert r.status_code == 502
    assert "Invalid OAuth" in r.json()["detail"]


def test_panoramas_retry_a_transient_failure(client):
    calls = []

    def handler(request):
        calls.append(1)
        if len(calls) == 1:
            raise httpx.RemoteProtocolError("closed", request=request)
        return httpx.Response(200, json=MAPILLARY_LIST)
    mock(client, handler)
    r = client.post("/api/tools/panoramas", json=TOOLS["panoramas"])
    assert r.status_code == 200 and len(calls) == 2


# --- places ---------------------------------------------------------------

def test_places_parse_names_refs_and_centres(client):
    seen = {}

    def handler(request):
        seen["req"] = request
        return httpx.Response(200, json=OVERPASS)
    mock(client, handler)
    r = client.post("/api/tools/places", json={"lng": -77.3062, "lat": 38.846})
    assert r.status_code == 200
    places = r.json()["places"]
    # Unnamed, place_of_worship and duplicate elements are dropped.
    assert [p["osmRef"] for p in places] == ["node/11", "way/22"]
    assert places[1] == {"name": "Fairfax Museum", "osmRef": "way/22", "kind": "museum",
                         "lng": -77.3070, "lat": 38.8470}
    from urllib.parse import parse_qs
    query = parse_qs(seen["req"].content.decode())["data"][0]
    assert 'nwr["historic"]' in query and "out center tags" in query
    assert seen["req"].method == "POST"


def test_places_fall_back_to_the_next_mirror(client):
    hosts = []

    def handler(request):
        hosts.append(request.url.host)
        if len(hosts) == 1:
            return httpx.Response(504, text="gateway timeout")
        return httpx.Response(200, json=OVERPASS)
    mock(client, handler)
    r = client.post("/api/tools/places", json=TOOLS["places"])
    assert r.status_code == 200
    assert hosts[0] == "overpass-api.de" and hosts[1] != "overpass-api.de"


def test_places_all_mirrors_down_is_502(client):
    mock(client, lambda request: httpx.Response(504, text="no"))
    r = client.post("/api/tools/places", json=TOOLS["places"])
    assert r.status_code == 502
    assert "mirror" in r.json()["detail"]


def test_places_name_filter(client):
    mock(client, lambda request: httpx.Response(200, json=OVERPASS))
    r = client.post("/api/tools/places", json={**TOOLS["places"], "name": "museum"})
    assert [p["osmRef"] for p in r.json()["places"]] == ["way/22"]


# --- archive search -------------------------------------------------------

def test_archive_search_parses_and_filters(client):
    seen = {}

    def handler(request):
        seen["url"] = request.url
        return httpx.Response(200, json=LOC)
    mock(client, handler)
    r = client.post("/api/tools/archive-search", json={
        "query": "fairfax court house", "terms": ["fairfax", "court"]})
    assert r.status_code == 200
    res = r.json()["results"]
    # Alexandria excluded, imageless dropped; shortest title first.
    assert [x["title"] for x in res] == [
        "Fairfax Court House interior", "Fairfax Court House, Virginia"]
    first = res[1]  # the 1863 item
    assert first["date"] == "1863"
    assert first["thumbUrl"] == "https://tile.loc.gov/t/1_150px.jpg"
    assert first["imageUrl"] == "https://tile.loc.gov/t/1v.jpg"
    assert first["itemUrl"] == "https://www.loc.gov/item/1/"
    assert first["rights"] == "No known restrictions on publication."
    assert first["creator"] == ("O'Sullivan, Timothy H., 1840-1882; "
                                "Gardner, Alexander, 1821-1882")
    # Absent rights are reported as such, not invented.
    assert res[0]["rights"] is None  # the interior item carries none
    u = seen["url"]
    assert u.host == "www.loc.gov" and u.path == "/photos/"
    assert u.params["fo"] == "json" and u.params["q"] == "fairfax court house"


def test_archive_search_no_match_is_empty_not_an_error(client):
    mock(client, lambda request: httpx.Response(200, json={"results": []}))
    r = client.post("/api/tools/archive-search", json=TOOLS["archive-search"])
    assert r.status_code == 200 and r.json()["results"] == []


# --- narrate (real `say`) ---------------------------------------------------

def test_narrate_stores_real_audio(client):
    open_tour(client)
    r = client.post("/api/tools/narrate", json={"text": "Welcome to Old Town Fairfax."})
    assert r.status_code == 200, r.text
    body = r.json()
    media_id = body["mediaId"]
    assert media_id.endswith((".m4a", ".wav"))
    path = client.app.state.session.path / "media" / media_id
    data = path.read_bytes()
    assert len(data) > 2000
    kind, _ext = sniff(data)
    assert kind in ("audio/mp4", "audio/wav")
    if shutil.which("ffmpeg"):
        assert media_id.endswith(".m4a")
    # No scratch files left behind next to the stored audio.
    assert [p.name for p in path.parent.iterdir()] == [media_id]


def test_narrate_text_that_looks_like_a_flag(client):
    open_tour(client)
    r = client.post("/api/tools/narrate", json={"text": "--voice=? is not an option"})
    assert r.status_code == 200, r.text


def test_narrate_needs_an_open_tour(client):
    r = client.post("/api/tools/narrate", json={"text": "Hello."})
    assert r.status_code == 409


def test_narrate_validates_text(client):
    open_tour(client)
    assert client.post("/api/tools/narrate", json={"text": "  "}).status_code == 422
    assert client.post("/api/tools/narrate",
                       json={"text": "x" * 20001}).status_code == 422


def test_narrate_missing_say_is_502(client, monkeypatch):
    open_tour(client)
    from app import tools
    monkeypatch.setattr(tools, "SAY", "/nonexistent/say")
    r = client.post("/api/tools/narrate", json={"text": "Hello."})
    assert r.status_code == 502
    assert "say" in r.json()["detail"]


def test_tools_module_does_not_use_urllib():
    from pathlib import Path

    from app import tools
    source = Path(tools.__file__).read_text()
    assert "import urllib" not in source and "from urllib" not in source


# --- archive-fetch ----------------------------------------------------------

JPEG = b"\xff\xd8\xff\xe0" + b"\x00" * 64 + b"\xff\xd9"
FETCH = "/api/tools/archive-fetch"


@pytest.fixture(autouse=False)
def fast_retry(monkeypatch):
    monkeypatch.setattr("app.tools.RETRY_PAUSE", 0)


def test_archive_fetch_stores_the_image(client):
    open_tour(client)
    seen = []

    def handler(request):
        seen.append(request.headers["user-agent"])
        return httpx.Response(200, content=JPEG)
    mock(client, handler)
    r = client.post(FETCH, json={"imageUrl": "https://tile.loc.gov/t/1.jpg", "title": "Court House"})
    assert r.status_code == 200, r.text
    media_id = r.json()["mediaId"]
    assert media_id.endswith(".jpg")
    assert (client.app.state.session.path / "media" / media_id).read_bytes() == JPEG
    assert "clio-wired" in seen[0]


@pytest.mark.parametrize("url", [
    "http://tile.loc.gov/t/1.jpg",             # not https
    "https://evil.example/t/1.jpg",            # wrong host
    "https://loc.gov.evil.example/1.jpg",      # suffix trick
    "https://notloc.gov/1.jpg",                # not a subdomain
    "https://tile.loc.gov@evil.example/1.jpg", # userinfo trick
    "https://tile.loc.gov:8443/1.jpg",         # odd port
    "https://127.0.0.1/1.jpg",
    "file:///etc/passwd",
])
def test_archive_fetch_rejects_hosts_outside_the_allowlist(client, url):
    open_tour(client)
    called = []
    mock(client, lambda request: called.append(request) or httpx.Response(200, content=JPEG))
    r = client.post(FETCH, json={"imageUrl": url})
    assert r.status_code == 400
    assert called == []


def test_archive_fetch_does_not_follow_a_redirect_off_the_allowlist(client):
    open_tour(client)
    hits = []

    def handler(request):
        hits.append(str(request.url))
        return httpx.Response(302, headers={"Location": "https://evil.example/x.jpg"})
    mock(client, handler)
    r = client.post(FETCH, json={"imageUrl": "https://tile.loc.gov/t/1.jpg"})
    assert r.status_code == 400
    assert hits == ["https://tile.loc.gov/t/1.jpg"]


def test_archive_fetch_follows_a_redirect_within_loc_gov(client):
    open_tour(client)

    def handler(request):
        if request.url.host == "tile.loc.gov":
            return httpx.Response(301, headers={"Location": "https://www.loc.gov/img/1.jpg"})
        return httpx.Response(200, content=JPEG)
    mock(client, handler)
    assert client.post(FETCH, json={"imageUrl": "https://tile.loc.gov/t/1.jpg"}).status_code == 200


def test_archive_fetch_4xx_is_unavailable_and_not_retried(client, fast_retry):
    open_tour(client)
    calls = []
    mock(client, lambda request: calls.append(1) or httpx.Response(404))
    r = client.post(FETCH, json={"imageUrl": "https://tile.loc.gov/t/1.jpg"})
    assert r.status_code == 502
    assert "404" in r.json()["detail"]
    assert len(calls) == 1


def test_archive_fetch_retries_5xx_then_succeeds(client, fast_retry):
    open_tour(client)
    codes = iter([503, 500, 200])

    def handler(request):
        code = next(codes)
        return httpx.Response(code, content=JPEG if code == 200 else b"")
    mock(client, handler)
    assert client.post(FETCH, json={"imageUrl": "https://tile.loc.gov/t/1.jpg"}).status_code == 200


def test_archive_fetch_retries_transport_failures_then_gives_up(client, fast_retry):
    open_tour(client)
    calls = []

    def handler(request):
        calls.append(1)
        raise httpx.ConnectError("down", request=request)
    mock(client, handler)
    r = client.post(FETCH, json={"imageUrl": "https://tile.loc.gov/t/1.jpg"})
    assert r.status_code == 502
    assert len(calls) > 1


def test_archive_fetch_refuses_a_non_image_body(client):
    open_tour(client)
    mock(client, lambda request: httpx.Response(200, content=b"<html>sign in</html>"))
    r = client.post(FETCH, json={"imageUrl": "https://tile.loc.gov/t/1.jpg"})
    assert r.status_code == 502
    assert "image" in r.json()["detail"]
    assert not list((client.app.state.session.path / "media").glob("*"))


def test_archive_fetch_refuses_audio_bytes(client):
    open_tour(client)
    mock(client, lambda request: httpx.Response(200, content=b"RIFF\x00\x00\x00\x00WAVEfmt " + b"\x00" * 40))
    assert client.post(FETCH, json={"imageUrl": "https://tile.loc.gov/t/1.jpg"}).status_code == 502


def test_archive_fetch_needs_an_open_tour(client):
    r = client.post(FETCH, json={"imageUrl": "https://tile.loc.gov/t/1.jpg"})
    assert r.status_code == 409
