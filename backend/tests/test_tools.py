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
    "geocode": {"query": "Fairfax Courthouse"},
}


@pytest.mark.parametrize("tool", TOOLS)
def test_cross_site_refused(client, tool):
    r = client.post(f"/api/tools/{tool}", json=TOOLS[tool],
                    headers={"Sec-Fetch-Site": "cross-site"})
    assert r.status_code == 403


@pytest.mark.parametrize("tool", TOOLS)
def test_timeout_is_502_with_message(client, tool):
    def handler(request):
        raise httpx.ReadTimeout("slow", request=request)
    mock(client, handler)
    r = client.post(f"/api/tools/{tool}", json=TOOLS[tool])
    assert r.status_code == 502
    assert "timed out" in r.json()["detail"]


@pytest.mark.parametrize("tool", TOOLS)
def test_garbage_body_is_502(client, tool):
    mock(client, lambda request: httpx.Response(200, text="<html>not json"))
    r = client.post(f"/api/tools/{tool}", json=TOOLS[tool])
    assert r.status_code == 502


@pytest.mark.parametrize("tool", TOOLS)
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


# --- geocode ---------------------------------------------------------------

# Shape of Nominatim's /search?format=jsonv2: a JSON array, best match first,
# with lat/lon as STRINGS and osm_type already a word (node/way/relation).
NOMINATIM = [
    {"place_id": 1, "osm_type": "way", "osm_id": 123, "lat": "38.8462", "lon": "-77.3064",
     "display_name": "Fairfax County Courthouse, Chain Bridge Road, Fairfax, Virginia"},
    {"place_id": 2, "osm_type": "node", "osm_id": 456, "lat": "38.8470", "lon": "-77.3070",
     "display_name": "Old Fairfax Courthouse, Fairfax, Virginia"},
]


def test_geocode_parses_results_in_order(client):
    seen = {}

    def handler(request):
        seen["req"] = request
        return httpx.Response(200, json=NOMINATIM)
    mock(client, handler)
    r = client.post("/api/tools/geocode", json={"query": "  Fairfax Courthouse "})
    assert r.status_code == 200
    assert r.json() == {"results": [
        {"name": "Fairfax County Courthouse, Chain Bridge Road, Fairfax, Virginia",
         "lng": -77.3064, "lat": 38.8462, "osmRef": "way/123"},
        {"name": "Old Fairfax Courthouse, Fairfax, Virginia",
         "lng": -77.3070, "lat": 38.8470, "osmRef": "node/456"},
    ]}
    req = seen["req"]
    assert req.method == "GET"
    assert req.url.host == "nominatim.openstreetmap.org" and req.url.path == "/search"
    assert dict(req.url.params) == {"q": "Fairfax Courthouse", "format": "jsonv2", "limit": "5"}


def test_geocode_sends_the_identifying_user_agent(client):
    # Nominatim's usage policy refuses anonymous clients.
    from app import tools
    seen = {}

    def handler(request):
        seen["ua"] = request.headers.get("user-agent")
        return httpx.Response(200, json=[])
    mock(client, handler)
    client.post("/api/tools/geocode", json=TOOLS["geocode"])
    assert seen["ua"] == tools.UA


def test_geocode_drops_unusable_coordinates(client):
    rows = [
        {"osm_type": "node", "osm_id": 1, "lat": "abc", "lon": "-77.3", "display_name": "Bad"},
        {"osm_type": "node", "osm_id": 2, "lat": "95", "lon": "-77.3", "display_name": "Far"},
        {"lat": "38.8", "lon": "-77.3", "display_name": "No ref"},
        {"osm_type": "node", "osm_id": 3, "lat": "38.9", "lon": "-77.4", "display_name": "Good"},
    ]
    mock(client, lambda request: httpx.Response(200, json=rows))
    r = client.post("/api/tools/geocode", json=TOOLS["geocode"])
    assert r.json()["results"] == [
        {"name": "No ref", "lng": -77.3, "lat": 38.8, "osmRef": None},
        {"name": "Good", "lng": -77.4, "lat": 38.9, "osmRef": "node/3"},
    ]


def test_geocode_caps_at_five(client):
    rows = [{"osm_type": "node", "osm_id": i, "lat": "38.8", "lon": "-77.3",
             "display_name": f"Place {i}"} for i in range(8)]
    mock(client, lambda request: httpx.Response(200, json=rows))
    r = client.post("/api/tools/geocode", json=TOOLS["geocode"])
    assert [x["osmRef"] for x in r.json()["results"]] == [f"node/{i}" for i in range(5)]


def test_geocode_no_match_is_200_and_empty(client):
    mock(client, lambda request: httpx.Response(200, json=[]))
    r = client.post("/api/tools/geocode", json=TOOLS["geocode"])
    assert r.status_code == 200
    assert r.json() == {"results": []}


@pytest.mark.parametrize("failure", ["500", "timeout"])
def test_geocode_failure_names_the_lookup(client, failure):
    def handler(request):
        if failure == "timeout":
            raise httpx.ConnectTimeout("slow", request=request)
        return httpx.Response(500, text="boom")
    mock(client, handler)
    r = client.post("/api/tools/geocode", json=TOOLS["geocode"])
    assert r.status_code == 502
    assert r.json()["detail"].startswith("the address lookup failed")


@pytest.mark.parametrize("query", ["", "   ", "x" * 201])
def test_geocode_bad_query_is_422(client, query):
    assert client.post("/api/tools/geocode", json={"query": query}).status_code == 422


def _geocode_with_clock(tmp_path, monkeypatch, stamp_age):
    """Run one lookup with the clock at 1000 and the stamp `stamp_age` old,
    returning what was slept and when the upstream was called."""
    import os

    from app import tools
    clock = {"t": 1000.0}
    slept, called_at = [], []

    def fake_sleep(seconds):
        slept.append(seconds)
        clock["t"] += seconds
    monkeypatch.setattr(tools, "_now", lambda: clock["t"])
    monkeypatch.setattr(tools, "_sleep", fake_sleep)
    if stamp_age is not None:
        stamp = tmp_path / tools.NOMINATIM_STAMP
        stamp.touch()
        os.utime(stamp, (1000.0 - stamp_age, 1000.0 - stamp_age))

    def handler(request):
        called_at.append(clock["t"])
        return httpx.Response(200, json=[])
    with tools.make_client(httpx.MockTransport(handler), tools.NOMINATIM_TIMEOUT) as c:
        tools.geocode(c, "Fairfax", stamp_dir=tmp_path)
    return slept, called_at


def test_geocode_throttle_waits_out_the_rest_of_the_second(tmp_path, monkeypatch):
    slept, called_at = _geocode_with_clock(tmp_path, monkeypatch, stamp_age=0.3)
    assert slept == [pytest.approx(0.7)]
    assert called_at == [pytest.approx(1000.7)]


@pytest.mark.parametrize("age", [2.0, None])
def test_geocode_throttle_does_not_wait_when_idle(tmp_path, monkeypatch, age):
    slept, called_at = _geocode_with_clock(tmp_path, monkeypatch, stamp_age=age)
    assert slept == []
    assert called_at == [1000.0]


def test_geocode_throttle_stamps_the_call(tmp_path, monkeypatch):
    # The next process must see this call, or the throttle throttles nothing.
    from app import tools
    _geocode_with_clock(tmp_path, monkeypatch, stamp_age=0.3)
    assert (tmp_path / tools.NOMINATIM_STAMP).stat().st_mtime == pytest.approx(1000.7)


def test_geocode_throttle_ignores_a_stamp_from_the_future(tmp_path, monkeypatch):
    # A clock that stepped back must not stall every lookup for the skew.
    slept, _ = _geocode_with_clock(tmp_path, monkeypatch, stamp_age=-30.0)
    assert slept == []


def test_geocode_route_stamps_the_sessions_dir(client):
    from app import tools
    mock(client, lambda request: httpx.Response(200, json=[]))
    client.post("/api/tools/geocode", json=TOOLS["geocode"])
    assert (client.app.state.cfg.sessions_dir / tools.NOMINATIM_STAMP).exists()


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
