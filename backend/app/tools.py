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
import re
import subprocess
import tempfile
import time
from pathlib import Path

import httpx
from pydantic import BaseModel, Field, field_validator

from .media_store import MediaError, sniff

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
OVERPASS_TIMEOUT = 15.0
OVERPASS_BUDGET = 40.0
SAY_TIMEOUT = 60.0
FFMPEG_TIMEOUT = 60.0

RETRY_PAUSE = 0.3

# Churches dominate the Overpass result but are not this tour's subject.
EXCLUDE_KINDS = {"place_of_worship"}

# Archive search is fuzzy; these places surfaced as false matches for Fairfax.
DEFAULT_EXCLUDED_PLACES = ["alexandria", "chantilly", "lorton", "reston", "great falls",
                           "mclean", "philadelphia", "accawmacke"]

SAY = "say"
VOICE = "Samantha"
FFMPEG = "ffmpeg"
NARRATION_CREDIT = {
    "source": "Synthesized narration, generated for this tour",
    "license": "Generated for this tour; not an archival recording",
    "creator": f"macOS speech synthesis, voice {VOICE}",
}

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
        ilng, ilat = geom["coordinates"]
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


# --- narration (make_narration.py: synth) ------------------------------------

def _run(cmd: list[str], what: str, timeout: float, text: str | None = None) -> None:
    try:
        done = subprocess.run(cmd, input=text, capture_output=True, text=True,
                              timeout=timeout, check=False)
    except FileNotFoundError as exc:
        raise ToolError(502, f"{what} is not available on this machine ({cmd[0]})") from exc
    except subprocess.TimeoutExpired as exc:
        raise ToolError(502, f"{what} timed out") from exc
    if done.returncode != 0:
        raise ToolError(502, f"{what} failed: {(done.stderr or '').strip()[:200] or done.returncode}")


def synthesize(text: str) -> bytes:
    """Speak `text` with macOS `say` and return audio bytes the media store
    accepts: AAC in an M4A (as make_narration.py does, via ffmpeg), or WAV
    straight from `say` when ffmpeg is missing or fails.

    The text goes in on stdin: as an argument, text beginning with `-` would
    be read by `say` as an option.
    """
    with tempfile.TemporaryDirectory(prefix="narrate-") as tmp:
        work = Path(tmp)
        aiff, m4a, wav = work / "n.aiff", work / "n.m4a", work / "n.wav"
        _run([SAY, "-v", VOICE, "-f", "-", "-o", str(aiff)], "speech synthesis (say)",
             SAY_TIMEOUT, text)
        try:
            _run([FFMPEG, "-y", "-loglevel", "error", "-i", str(aiff),
                  "-c:a", "aac", "-b:a", "96k", str(m4a)], "audio conversion", FFMPEG_TIMEOUT)
            data = m4a.read_bytes()
        except ToolError:
            data = b""
        if not data:
            _run([SAY, "-v", VOICE, "--data-format=LEI16@22050", "-f", "-", "-o", str(wav)],
                 "speech synthesis (say)", SAY_TIMEOUT, text)
            data = wav.read_bytes()
        if not data:
            raise ToolError(502, "speech synthesis produced no audio")
        return data


def clean_text(text: str) -> str:
    return re.sub(r"\s+", " ", text).strip()


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


class NarrateRequest(BaseModel):
    text: str = Field(max_length=20000)

    @field_validator("text")
    @classmethod
    def _text_not_blank(cls, v: str) -> str:
        v = clean_text(v)
        if not v:
            raise ValueError("text must not be blank")
        return v


# --- archive image download (relevance.py: get_bytes_with_retry) -------------

FETCH_ATTEMPTS = 5
FETCH_TIMEOUT = 30.0
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


def fetch_archive_image(client: httpx.Client, url: str) -> bytes:
    """Download an archive image. Lifted from relevance.get_bytes_with_retry:
    transport failures and 5xx retry; 4xx means unavailable and does not.
    Redirects are followed by hand so each hop is re-checked against the
    allowlist. The body must be an image by its magic bytes, not by its
    Content-Type."""
    current = check_archive_url(url)
    last = "no response"
    for attempt in range(FETCH_ATTEMPTS):
        try:
            hops = 0
            while True:
                resp = client.get(current, follow_redirects=False)
                if resp.status_code in (301, 302, 303, 307, 308) and resp.headers.get("location"):
                    hops += 1
                    if hops > MAX_REDIRECTS:
                        raise ToolError(502, "the archive redirected too many times")
                    current = check_archive_url(str(httpx.URL(current).join(resp.headers["location"])))
                    continue
                break
            if resp.status_code == 200:
                try:
                    kind, _ext = sniff(resp.content)
                except MediaError:
                    kind = ""
                if not kind.startswith("image/"):
                    raise ToolError(502, "the archive returned something that is not an image")
                return resp.content
            if resp.status_code < 500:
                raise ToolError(
                    502, f"the archive has no image at that address (HTTP {resp.status_code})")
            last = f"HTTP {resp.status_code}"
        except ToolError:
            raise
        except httpx.HTTPError as exc:
            last = _describe(exc)
        if attempt < FETCH_ATTEMPTS - 1:
            time.sleep(RETRY_PAUSE)
    raise ToolError(502, f"could not download the image after {FETCH_ATTEMPTS} attempts ({last})")
