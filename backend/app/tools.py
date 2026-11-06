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
from pydantic import BaseModel, Field, field_validator

from .media_store import MAX_FILE_BYTES, MediaError, sniff

UA = "clio-wired-prototype/0.1 (graduates@rrchnm.org)"

MAPILLARY_IMAGES = "https://graph.mapillary.com/images"
LOC_SEARCH = "https://www.loc.gov/photos/"
OVERPASS_MIRRORS = [
    "https://overpass-api.de/api/interpreter",
    "https://overpass.kumi.systems/api/interpreter",
    "https://overpass.private.coffee/api/interpreter",
    "https://overpass.osm.jp/api/interpreter",
]

# Per-request timeouts, seconds. Overpass is per mirror, with a total budget.
MAPILLARY_TIMEOUT = 15.0
LOC_TIMEOUT = 30.0  # loc.gov returns large payloads
# The 45 s figures come from ONE observation: the live run measured Overpass
# at 34-42 s per query (and one 502). A too-generous timeout costs a slower
# failure; a too-tight one costs the feature outright, so these err long.
# Adjust against your own network.
OVERPASS_TIMEOUT = 45.0
OVERPASS_BUDGET = 45.0

RETRY_PAUSE = 0.3

# Churches dominate the Overpass result but are not this tour's subject.
EXCLUDE_KINDS = {"place_of_worship"}

# Archive search is fuzzy; these places surfaced as false matches for Fairfax.
DEFAULT_EXCLUDED_PLACES = ["alexandria", "chantilly", "lorton", "reston", "great falls",
                           "mclean", "philadelphia", "accawmacke"]

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
    # Following redirects is right for the trusted-host tools, but _get_capped
    # overrides it per request: archive fetches must re-check each hop.
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


# --- archive search (relevance.py, fetch_rephotos.py) -----------------------

def _first(value):
    if isinstance(value, list):
        return value[0] if value else None
    return value


def _as_text(value: object) -> str:
    if isinstance(value, list):
        return " ".join(str(v) for v in value)
    return str(value or "")


def score_title(title: object, required: list[str], excluded: list[str]) -> float:
    """relevance.score_title: 0.0 if rejected, else positive; shorter titles
    (more specific) score higher among full matches."""
    text = _as_text(title).lower()
    if not text.strip():
        return 0.0
    if any(term.lower() in text for term in excluded):
        return 0.0
    hits = sum(1 for term in required if term.lower() in text)
    if hits != len(required):
        return 0.0
    return hits + 1.0 / (1.0 + len(text))


def _text_field(value: object) -> str | None:
    """A non-blank string, or the non-blank strings of a list joined with '; '."""
    if isinstance(value, str):
        return value.strip() or None
    if isinstance(value, list):
        parts = [v.strip() for v in value if isinstance(v, str) and v.strip()]
        return "; ".join(parts) or None
    return None


def _creator(result: dict) -> str | None:
    """Observed against the live API: search results have NO top-level `creator`.
    The photographer is `item.creators[].title` (display case, dated), else
    `item.contributors[]` (strings), else the top-level `contributor` list,
    which is lowercased and so the last resort."""
    item = result.get("item") if isinstance(result.get("item"), dict) else {}
    titles = [c.get("title") for c in item.get("creators") or [] if isinstance(c, dict)]
    return (_text_field(titles) or _text_field(item.get("contributors"))
            or _text_field(result.get("creator")) or _text_field(result.get("contributor")))


def _rights(result: dict) -> str | None:
    """Observed: results carry no top-level `rights`; the statement is
    `item.rights_advisory` (and an identical `item.rights_information`)."""
    item = result.get("item") if isinstance(result.get("item"), dict) else {}
    return (_text_field(item.get("rights_advisory")) or _text_field(item.get("rights_information"))
            or _text_field(result.get("rights")))


def _image_url(raw: str) -> str:
    url = raw.split("#")[0]
    return "https:" + url if url.startswith("//") else url


def search_archive(client: httpx.Client, query: str, terms: list[str],
                   excluded_places: list[str], limit: int = 25) -> list[dict]:
    """Library of Congress photographs. Items must name every required term
    and none of the excluded places: attaching an Alexandria photograph to a
    Fairfax stop under a confident LoC credit is a provenance error."""
    payload = _get_json(client, "the Library of Congress", LOC_SEARCH,
                        {"q": query, "fo": "json", "c": limit})
    scored = []
    for item in payload.get("results") or []:
        images = item.get("image_url")
        if isinstance(images, str):
            images = [images]
        if not images:
            continue
        score = score_title(item.get("title"), terms, excluded_places)
        if score <= 0:
            continue
        scored.append((score, {
            "title": _first(item.get("title")) or "",
            "date": _first(item.get("date")),
            "creator": _creator(item),
            "thumbUrl": _image_url(images[0]),
            # fetch_rephotos.py: the last entry is the largest rendition.
            "imageUrl": _image_url(images[-1]),
            # `url` is https; `id` is the same address over http.
            "itemUrl": item.get("url") or item.get("id"),
            # Not read by any script (they hardcode a licence string). Reported
            # only when the item carries one, so the editor never shows an
            # invented rights statement.
            "rights": _rights(item),
        }))
    scored.sort(key=lambda s: -s[0])
    return [r for _, r in scored]


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


class ArchiveRequest(BaseModel):
    query: str = Field(max_length=300)
    terms: list[str] = Field(default_factory=list, max_length=10)
    excludePlaces: list[str] = Field(default_factory=lambda: list(DEFAULT_EXCLUDED_PLACES),
                                     max_length=30)

    @field_validator("query")
    @classmethod
    def _query_not_blank(cls, v: str) -> str:
        if not v.strip():
            raise ValueError("query must not be blank")
        return v.strip()


class ArchiveFetchRequest(BaseModel):
    imageUrl: str = Field(max_length=2000)
    title: str = Field(default="", max_length=300)


# --- archive image download (relevance.py: get_bytes_with_retry) -------------

FETCH_ATTEMPTS = 5
FETCH_TIMEOUT = 30.0
# Total, across every attempt and redirect hop: 5 x 30 s would be minutes.
FETCH_DEADLINE = 90.0
MAX_REDIRECTS = 5


def check_archive_url(url: str) -> str:
    """The URL if it is plain https on loc.gov or a subdomain; else ToolError(400).

    This endpoint fetches a URL the client names, so the allowlist is the
    whole defence against it being used to reach anything else. Checked on
    every redirect hop too. Userinfo and ports are refused: `https://a.loc.gov@evil/`
    and `https://loc.gov:8443/` are how an allowlist gets walked around.
    """
    try:
        parts = httpx.URL(url.strip())
        host = parts.host.lower()
        port = parts.port
    except (httpx.InvalidURL, ValueError):
        raise ToolError(400, "that is not a valid image address") from None
    ok = (
        parts.scheme == "https" and not parts.userinfo
        and port in (None, 443)
        and (host == "loc.gov" or host.endswith(".loc.gov"))
    )
    if not ok:
        raise ToolError(400, "only https images hosted on loc.gov can be fetched")
    return url.strip()


def _too_big() -> ToolError:
    return ToolError(502, f"the archive image is larger than the {MAX_FILE_BYTES // (1024 * 1024)} MB limit")


def _get_capped(client: httpx.Client, url: str, deadline: float) -> tuple[int, str | None, bytes]:
    """One GET, streamed, returning (status, location, body). The body is
    abandoned as soon as it passes MAX_FILE_BYTES, so a huge rendition never
    sits whole in memory before the media store's own cap sees it; a declared
    Content-Length over the cap is refused before a byte is read. The
    per-request timeout only bounds each read, so `deadline` bounds the whole."""
    # Passed per request to override make_client's `follow_redirects=True`
    # default, which every other tool relies on. If httpx followed redirects
    # here it would do so inside the transport, where check_archive_url never
    # sees the next hop, and an allowlisted loc.gov URL could redirect to any
    # host. fetch_archive_image follows by hand so the allowlist re-runs on
    # every hop; the check there is not redundant with the one on entry.
    with client.stream("GET", url, follow_redirects=False) as resp:
        if resp.status_code != 200:
            return resp.status_code, resp.headers.get("location"), b""
        declared = resp.headers.get("content-length", "")
        if declared.isdigit() and int(declared) > MAX_FILE_BYTES:
            raise _too_big()
        body = bytearray()
        for chunk in resp.iter_bytes():
            body += chunk
            if len(body) > MAX_FILE_BYTES:
                raise _too_big()
            if time.monotonic() > deadline:
                raise ToolError(502, "downloading the image took too long")
        return 200, None, bytes(body)


def fetch_archive_image(client: httpx.Client, url: str) -> bytes:
    """Download an archive image. Lifted from relevance.get_bytes_with_retry:
    transport failures and 5xx retry; 4xx means unavailable and does not.
    Redirects are followed by hand so each hop is re-checked against the
    allowlist. The body must be an image by its magic bytes, not by its
    Content-Type. Streamed and size-capped, and bounded by FETCH_DEADLINE in
    total across every attempt and hop."""
    current = check_archive_url(url)
    last = "no response"
    deadline = time.monotonic() + FETCH_DEADLINE
    for attempt in range(FETCH_ATTEMPTS):
        if time.monotonic() > deadline:
            break
        try:
            hops = 0
            while True:
                status, location, body = _get_capped(client, current, deadline)
                if status in (301, 302, 303, 307, 308) and location:
                    hops += 1
                    if hops > MAX_REDIRECTS:
                        raise ToolError(502, "the archive redirected too many times")
                    current = check_archive_url(str(httpx.URL(current).join(location)))
                    continue
                break
            if status == 200:
                try:
                    kind, _ext = sniff(body)
                except MediaError:
                    kind = ""
                if not kind.startswith("image/"):
                    raise ToolError(502, "the archive returned something that is not an image")
                return body
            if status < 500:
                raise ToolError(
                    502, f"the archive has no image at that address (HTTP {status})")
            last = f"HTTP {status}"
        except ToolError:
            raise
        except httpx.HTTPError as exc:
            last = _describe(exc)
        if attempt < FETCH_ATTEMPTS - 1:
            time.sleep(RETRY_PAUSE)
    raise ToolError(502, f"could not download the image ({last}; gave up after {FETCH_ATTEMPTS} attempts or {int(FETCH_DEADLINE)} s)")
