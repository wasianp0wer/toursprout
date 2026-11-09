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
    cfg = Settings(content_dir=tmp_path, sessions_dir=tmp_path / "sessions",
                   frontend_dist=tmp_path / "nodist",
                   mapillary_token="test-token")
    with TestClient(create_app(cfg)) as c:
        yield c


def mock(client, handler):
    client.app.state.http_transport = httpx.MockTransport(handler)


# --- shared ---------------------------------------------------------------

TOOLS = {
    "places": {"lng": -77.3062, "lat": 38.846},
}


@pytest.mark.parametrize("tool", TOOLS)
def test_cross_site_refused(client, tool):
    r = client.post(f"/api/tools/{tool}", json=TOOLS[tool],
                    headers={"Sec-Fetch-Site": "cross-site"})
    assert r.status_code == 403


@pytest.mark.parametrize("tool", ["places"])
def test_timeout_is_502_with_message(client, tool):
    def handler(request):
        raise httpx.ReadTimeout("slow", request=request)
    mock(client, handler)
    r = client.post(f"/api/tools/{tool}", json=TOOLS[tool])
    assert r.status_code == 502
    assert "timed out" in r.json()["detail"]


@pytest.mark.parametrize("tool", ["places"])
def test_garbage_body_is_502(client, tool):
    mock(client, lambda request: httpx.Response(200, text="<html>not json"))
    r = client.post(f"/api/tools/{tool}", json=TOOLS[tool])
    assert r.status_code == 502


@pytest.mark.parametrize("tool", ["places"])
def test_upstream_5xx_is_502(client, tool):
    mock(client, lambda request: httpx.Response(503, text="down"))
    r = client.post(f"/api/tools/{tool}", json=TOOLS[tool])
    assert r.status_code == 502
    assert "503" in r.json()["detail"]


def test_bad_input_is_422(client):
    assert client.post("/api/tools/places", json={"lng": 500, "lat": 0}).status_code == 422


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


def test_panoramas_route_is_gone(client):
    assert client.post("/api/tools/panoramas", json={"lng": 0, "lat": 0}).status_code == 404


def test_narrate_route_is_gone(client):
    assert client.post("/api/tools/narrate", json={"text": "hello"}).status_code == 404


def test_tools_module_does_not_use_urllib():
    from pathlib import Path

    from app import tools
    source = Path(tools.__file__).read_text()
    assert "import urllib" not in source and "from urllib" not in source


def test_overpass_timeouts_cover_the_only_measurement_we_have():
    """The live run saw Overpass take 34-42 s. A timeout below that makes the
    places tool fail every time, so pin the floor."""
    from app import tools
    assert tools.OVERPASS_TIMEOUT >= 42
    assert tools.OVERPASS_BUDGET >= tools.OVERPASS_TIMEOUT
