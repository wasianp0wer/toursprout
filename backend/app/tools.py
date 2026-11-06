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

MAPILLARY_IMAGES = "https://graph.mapillary.com/images"
OVERPASS_MIRRORS = [
    "https://overpass-api.de/api/interpreter",
    "https://overpass.kumi.systems/api/interpreter",
    "https://overpass.private.coffee/api/interpreter",
    "https://overpass.osm.jp/api/interpreter",
]

# Per-request timeouts, seconds. Overpass is per mirror, with a total budget.
MAPILLARY_TIMEOUT = 15.0
# The 45 s figures come from ONE observation: the live run measured Overpass
# at 34-42 s per query (and one 502). A too-generous timeout costs a slower
# failure; a too-tight one costs the feature outright, so these err long.
# Adjust against your own network.
OVERPASS_TIMEOUT = 45.0
OVERPASS_BUDGET = 45.0

RETRY_PAUSE = 0.3

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


def _error_text(resp: httpx.Response) -> str:
    """Mapillary reports {"error": {"message": ...}}; fall back to the body."""
    try:
        msg = resp.json()["error"]["message"]
    except (ValueError, KeyError, TypeError):
        msg = None
    if isinstance(msg, str) and msg:
        return msg
    return resp.text[:200].strip() or "no detail"


def _get_json(client: httpx.Client, service: str, url: str, params: dict,
              attempts: int = 2) -> dict:
    """GET JSON. A dropped connection or 5xx is retried once (the egress proxy
    drops connections now and then); a timeout is not, since retrying would
    double the wait; a 4xx never improves on retry. Every failure becomes a
    502 naming the service."""
    last = ""
    for attempt in range(attempts):
        try:
            resp = client.get(url, params=params)
        except httpx.TimeoutException as exc:
            raise ToolError(502, f"{service} timed out") from exc
        except httpx.HTTPError as exc:
            last = _describe(exc)
        else:
            if resp.status_code < 400:
                try:
                    data = resp.json()
                except ValueError as exc:
                    raise ToolError(502, f"{service} returned something that is not JSON") from exc
                if not isinstance(data, dict):
                    raise ToolError(502, f"{service} returned an unexpected response")
                return data
            last = f"HTTP {resp.status_code}: {_error_text(resp)}"
            if resp.status_code < 500:
                break
        if attempt < attempts - 1:
            time.sleep(RETRY_PAUSE)
    raise ToolError(502, f"{service} failed ({last})")


# --- panoramas (probe_coverage.py: bbox_around, haversine_m, probe) ---------

def bbox_around(lng: float, lat: float, radius_m: float) -> str:
    dlat = radius_m / 111_320.0
    dlng = radius_m / (111_320.0 * math.cos(math.radians(lat)))
    return f"{lng - dlng},{lat - dlat},{lng + dlng},{lat + dlat}"


def haversine_m(lng1: float, lat1: float, lng2: float, lat2: float) -> float:
    r = 6_371_000.0
    p1, p2 = math.radians(lat1), math.radians(lat2)
    a = (math.sin((p2 - p1) / 2) ** 2
         + math.cos(p1) * math.cos(p2) * math.sin(math.radians(lng2 - lng1) / 2) ** 2)
    return 2 * r * math.asin(math.sqrt(a))


def find_panoramas(client: httpx.Client, token: str, lng: float, lat: float,
                   radius_m: float, pano_only: bool = True, limit: int = 20) -> list[dict]:
    """Imagery near a point, true 360 panoramas first, nearest first.

    `lng`/`lat` on each candidate are where the CAMERA stood (Mapillary's
    `computed_geometry`, else `geometry`) -- never the query point. The
    editor derives a stop's view bearing from that position; deriving it from
    the stop itself faces the photograph 178 degrees backwards on the real
    tour, because the stop is the building and the camera was on the street.
    """
    if not token:
        raise ToolError(400, "no Mapillary token is configured (set MAPILLARY_TOKEN in backend/.env)")
    data = _get_json(client, "Mapillary", MAPILLARY_IMAGES, {
        "access_token": token,
        "bbox": bbox_around(lng, lat, radius_m),
        "fields": "id,computed_geometry,geometry,is_pano,captured_at,compass_angle,thumb_256_url",
        "limit": 500,
    })
    candidates = []
    for img in data.get("data") or []:
        geom = img.get("computed_geometry") or img.get("geometry")
        if not geom or not img.get("id"):
            continue
        try:
            ilng, ilat = (float(v) for v in geom["coordinates"])
        except (KeyError, TypeError, ValueError):
            continue  # a malformed geometry is skipped, never a 500
        is_pano = bool(img.get("is_pano"))
        if pano_only and not is_pano:
            continue
        candidates.append({
            "imageId": str(img["id"]), "lng": ilng, "lat": ilat, "isPano": is_pano,
            "capturedAt": img.get("captured_at"),
            "compassAngle": img.get("compass_angle"),
            "thumbUrl": img.get("thumb_256_url"),
            "distanceM": round(haversine_m(lng, lat, ilng, ilat), 1),
        })
    candidates.sort(key=lambda c: (not c["isPano"], c["distanceM"]))
    return candidates[:limit]


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


class PanoramaRequest(_Point):
    radiusM: float = Field(default=50, gt=0, le=500)
    panoOnly: bool = True
    limit: int = Field(default=20, ge=1, le=100)


class PlacesRequest(_Point):
    radiusM: float = Field(default=400, gt=0, le=3000)
    name: str | None = Field(default=None, max_length=200)
