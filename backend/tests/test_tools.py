"""The acquisition tools.

The network tools are tested against `httpx.MockTransport` with response
shapes taken from the content scripts' parsing code (provenance is noted at
each fixture). No test here touches the network.
"""

from __future__ import annotations

import httpx
import pytest
from fastapi.testclient import TestClient

from app.config import Settings
from app.main import create_app

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

@pytest.fixture
def client(tmp_path):
    cfg = Settings(content_dir=tmp_path, frontend_dist=tmp_path / "nodist",
                   mapillary_token="test-token")
    with TestClient(create_app(cfg)) as c:
        yield c


def mock(client, handler):
    client.app.state.http_transport = httpx.MockTransport(handler)


# --- shared ---------------------------------------------------------------

TOOLS = {
    "panoramas": {"lng": -77.3062, "lat": 38.846},
    "places": {"lng": -77.3062, "lat": 38.846},
}


@pytest.mark.parametrize("tool", TOOLS)
def test_cross_site_refused(client, tool):
    r = client.post(f"/api/tools/{tool}", json=TOOLS[tool],
                    headers={"Sec-Fetch-Site": "cross-site"})
    assert r.status_code == 403


@pytest.mark.parametrize("tool", ["panoramas", "places"])
def test_timeout_is_502_with_message(client, tool):
    def handler(request):
        raise httpx.ReadTimeout("slow", request=request)
    mock(client, handler)
    r = client.post(f"/api/tools/{tool}", json=TOOLS[tool])
    assert r.status_code == 502
    assert "timed out" in r.json()["detail"]


@pytest.mark.parametrize("tool", ["panoramas", "places"])
def test_garbage_body_is_502(client, tool):
    mock(client, lambda request: httpx.Response(200, text="<html>not json"))
    r = client.post(f"/api/tools/{tool}", json=TOOLS[tool])
    assert r.status_code == 502


@pytest.mark.parametrize("tool", ["panoramas", "places"])
def test_upstream_5xx_is_502(client, tool):
    mock(client, lambda request: httpx.Response(503, text="down"))
    r = client.post(f"/api/tools/{tool}", json=TOOLS[tool])
    assert r.status_code == 502
    assert "503" in r.json()["detail"]


def test_bad_input_is_422(client):
    assert client.post("/api/tools/panoramas", json={"lng": 500, "lat": 0}).status_code == 422


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


@pytest.mark.parametrize("tool", ["archive-search", "archive-fetch"])
def test_archive_routes_are_gone(client, tool):
    assert client.post(f"/api/tools/{tool}", json={}).status_code == 404


def test_narrate_route_is_gone(client):
    assert client.post("/api/tools/narrate", json={"text": "hello"}).status_code == 404


def test_tools_module_does_not_use_urllib():
    from pathlib import Path

    from app import tools
    source = Path(tools.__file__).read_text()
    assert "import urllib" not in source and "from urllib" not in source


@pytest.mark.parametrize("geometry", [
    {"type": "Point"},                              # no coordinates
    {"type": "Point", "coordinates": [-77.3]},      # too short
    {"type": "Point", "coordinates": "nowhere"},    # wrong type
    {"type": "Point", "coordinates": [None, 1]},
])
def test_panoramas_skip_a_malformed_geometry_instead_of_500ing(client, geometry):
    body = {"data": [
        {"id": "bad", "computed_geometry": geometry, "is_pano": True},
        MAPILLARY_LIST["data"][2]]}
    mock(client, lambda request: httpx.Response(200, json=body))
    r = client.post("/api/tools/panoramas", json={"lng": -77.3062, "lat": 38.846})
    assert r.status_code == 200
    assert [c["imageId"] for c in r.json()["candidates"]] == ["near"]


def test_overpass_timeouts_cover_the_only_measurement_we_have():
    """The live run saw Overpass take 34-42 s. A timeout below that makes the
    places tool fail every time, so pin the floor."""
    from app import tools
    assert tools.OVERPASS_TIMEOUT >= 42
    assert tools.OVERPASS_BUDGET >= tools.OVERPASS_TIMEOUT
