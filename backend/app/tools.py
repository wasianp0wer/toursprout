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
import os
import time
from pathlib import Path
from typing import Annotated

import httpx
from pydantic import BaseModel, Field, StringConstraints

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

# Nominatim's usage policy: an identifying User-Agent (UA above) and at most
# one request per second. A lookup is one author pressing a button, so 10 s
# is generous; it only bounds a hung upstream.
NOMINATIM_URL = "https://nominatim.openstreetmap.org/search"
NOMINATIM_TIMEOUT = 10.0
NOMINATIM_INTERVAL = 1.0
NOMINATIM_LIMIT = 5
NOMINATIM_STAMP = ".last-nominatim"

# Seams, so tests move a fake clock instead of sleeping. Wall clock, not
# monotonic: the stamp outlives the process (see `_wait_for_nominatim`).
_now = time.time
_sleep = time.sleep

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


# --- geocode (Nominatim) -----------------------------------------------------

def _wait_for_nominatim(stamp_dir: Path) -> None:
    """Keep this deployment to one Nominatim request per second.

    On a FILE, not in memory, for the reason `sessions.sweep_due` gives:
    under CGI each request is a fresh process, so an in-memory timestamp is
    always unset and would throttle nothing. The stamp's mtime is the time
    of the last call. A stamp dated in the future (a clock that stepped)
    reads as idle rather than stalling every lookup for the skew, and an
    unreadable or unwritable stamp does not block the lookup: the author
    pressed a button, and the policy limit is about sustained load.

    Two processes landing in the same instant can both read an old stamp.
    That is accepted: it takes two authors in the same second, and the
    alternative is a lock that a killed CGI process could leave held.
    """
    stamp = stamp_dir / NOMINATIM_STAMP
    now = _now()
    try:
        age = now - stamp.stat().st_mtime
    except OSError:
        age = None
    if age is not None and 0 <= age < NOMINATIM_INTERVAL:
        wait = NOMINATIM_INTERVAL - age
        _sleep(wait)
        now += wait
    try:
        stamp_dir.mkdir(parents=True, exist_ok=True)
        stamp.touch(exist_ok=True)
        os.utime(stamp, (now, now))
    except OSError:
        pass


def _coordinate(value, limit: float) -> float | None:
    try:
        number = float(value)
    except (TypeError, ValueError):
        return None
    return number if math.isfinite(number) and -limit <= number <= limit else None


def geocode(client: httpx.Client, query: str, *, stamp_dir: Path) -> list[dict]:
    """Up to five places matching an address or place name, best first, via
    OSM Nominatim. Entries without usable coordinates are dropped rather
    than failing the lookup: the rest are still worth offering."""
    _wait_for_nominatim(stamp_dir)
    try:
        resp = client.get(NOMINATIM_URL, timeout=NOMINATIM_TIMEOUT, params={
            "q": query, "format": "jsonv2", "limit": NOMINATIM_LIMIT})
        if resp.status_code >= 400:
            raise ToolError(502, f"the address lookup failed: HTTP {resp.status_code}")
        data = resp.json()
    except ValueError:
        raise ToolError(502, "the address lookup failed: not JSON") from None
    except httpx.HTTPError as exc:
        raise ToolError(502, f"the address lookup failed: {_describe(exc)}") from exc
    if not isinstance(data, list):
        raise ToolError(502, "the address lookup failed: unexpected response")

    results = []
    for row in data:
        if not isinstance(row, dict):
            continue
        lat = _coordinate(row.get("lat"), 90)
        lng = _coordinate(row.get("lon"), 180)
        if lat is None or lng is None:
            continue
        osm_type, osm_id = row.get("osm_type"), row.get("osm_id")
        results.append({
            "name": str(row.get("display_name") or row.get("name") or query),
            "lng": lng, "lat": lat,
            "osmRef": f"{osm_type}/{osm_id}" if osm_type and osm_id is not None else None,
        })
    return results[:NOMINATIM_LIMIT]


# --- request bodies ------------------------------------------------------------

class _Point(BaseModel):
    lng: float = Field(ge=-180, le=180)
    lat: float = Field(ge=-90, le=90)


class PlacesRequest(_Point):
    radiusM: float = Field(default=400, gt=0, le=3000)
    name: str | None = Field(default=None, max_length=200)


class GeocodeRequest(BaseModel):
    query: Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=200)]
