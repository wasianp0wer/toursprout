"""Acquisition tools: the content scripts' hard-won knowledge as functions.

Each function here is lifted from a script under `content/scripts/` (named at
each one) rather than redesigned, because those scripts encode which queries
actually return usable results. What changed is the shape: they return data
instead of writing `content/media/`, take an `httpx.Client` so tests can swap
the transport, and raise `ToolError` (with the HTTP status the route should
use) instead of calling `sys.exit`.

All outbound HTTP is httpx, never urllib: urllib truncates bodies through the
sandbox egress proxy (docs/ENVIRONMENT.md). Every call has an explicit
timeout, so a hung upstream cannot hang the editor.
"""

from __future__ import annotations

import math
import time

import httpx
from pydantic import BaseModel, Field

UA = "clio-wired-prototype/0.1 (graduates@rrchnm.org)"

OVERPASS_MIRRORS = [
    "https://overpass-api.de/api/interpreter",
    "https://overpass.kumi.systems/api/interpreter",
    "https://overpass.private.coffee/api/interpreter",
    "https://overpass.osm.jp/api/interpreter",
]

# Reachability probes for /api/diagnostics/egress. Short on purpose: a
# diagnostic that hangs is useless, and a silently dropped SYN is the failure
# being looked for.
MAPILLARY_PROBE_URL = "https://graph.mapillary.com/"
LOC_PROBE_URL = "https://www.loc.gov/"
EGRESS_TIMEOUT = 8.0

# Per-request timeouts, seconds. Overpass is per mirror, with a total budget.
# The 45 s figures come from ONE observation: the live run measured Overpass
# at 34-42 s per query (and one 502). A too-generous timeout costs a slower
# failure; a too-tight one costs the feature outright, so these err long.
# Adjust against your own network.
OVERPASS_TIMEOUT = 45.0
OVERPASS_BUDGET = 45.0

# Churches dominate the Overpass result but are not this tour's subject.
EXCLUDE_KINDS = {"place_of_worship"}

OVERPASS_QUERY = """
[out:json][timeout:12];
(
  nwr["historic"]({bbox});
  nwr["tourism"~"museum|attraction"]({bbox});
  nwr["amenity"~"townhall|courthouse"]({bbox});
);
out center tags;
"""


class ToolError(Exception):
    """A tool failed in a way the author should be told about."""

    def __init__(self, status: int, message: str):
        super().__init__(message)
        self.status = status
        self.message = message


def make_client(transport: httpx.BaseTransport | None, timeout: float) -> httpx.Client:
    # Every tool talks to a fixed, trusted host, so following redirects is safe.
    return httpx.Client(transport=transport, timeout=timeout,
                        headers={"User-Agent": UA}, follow_redirects=True)


def _describe(exc: Exception) -> str:
    if isinstance(exc, httpx.TimeoutException):
        return "timed out"
    return f"{type(exc).__name__}: {exc}"


# --- places (probe_coverage.py: discover_sites) -----------------------------

def find_places(client: httpx.Client, lng: float, lat: float, radius_m: float,
                name: str | None = None) -> list[dict]:
    """Named historic features near a point via OSM Overpass, trying each
    mirror in turn: any one of them is routinely down."""
    dlat = radius_m / 111_320.0
    dlng = radius_m / (111_320.0 * math.cos(math.radians(lat)))
    bbox = f"{lat - dlat},{lng - dlng},{lat + dlat},{lng + dlng}"  # south,west,north,east
    query = OVERPASS_QUERY.format(bbox=bbox)

    data, last, started = None, "", time.monotonic()
    for mirror in OVERPASS_MIRRORS:
        if time.monotonic() - started > OVERPASS_BUDGET:
            break
        try:
            resp = client.post(mirror, data={"data": query}, timeout=OVERPASS_TIMEOUT)
            if resp.status_code >= 400:
                last = f"HTTP {resp.status_code}"
                continue
            data = resp.json()
            if not isinstance(data, dict):
                data, last = None, "unexpected response"
                continue
            break
        except ValueError:
            last = "not JSON"
        except httpx.HTTPError as exc:
            last = _describe(exc)
    if data is None:
        raise ToolError(502, f"every Overpass mirror failed (last: {last or 'out of time'})")

    wanted = (name or "").strip().lower()
    places, seen = [], set()
    for el in data.get("elements") or []:
        tags = el.get("tags") or {}
        pname = tags.get("name")
        if not pname:
            continue
        kind = tags.get("historic") or tags.get("tourism") or tags.get("amenity")
        if kind in EXCLUDE_KINDS:
            continue
        plat = el.get("lat") if el.get("lat") is not None else (el.get("center") or {}).get("lat")
        plng = el.get("lon") if el.get("lon") is not None else (el.get("center") or {}).get("lon")
        if plat is None or plng is None:
            continue
        key = (pname, round(plat, 4), round(plng, 4))
        if key in seen:
            continue
        seen.add(key)
        if wanted and wanted not in pname.lower():
            continue
        places.append({"name": pname, "osmRef": f"{el['type']}/{el['id']}", "kind": kind,
                       "lng": plng, "lat": plat})
    return places


# --- request bodies ------------------------------------------------------------

class _Point(BaseModel):
    lng: float = Field(ge=-180, le=180)
    lat: float = Field(ge=-90, le=90)


class PlacesRequest(_Point):
    radiusM: float = Field(default=400, gt=0, le=3000)
    name: str | None = Field(default=None, max_length=200)
