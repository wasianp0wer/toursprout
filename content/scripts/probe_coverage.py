"""Probe Mapillary street-level imagery coverage for candidate tour stops.

Runs before any content work: the tour's stop list is chosen from what
actually has usable imagery, not from a wishlist.

Two phases:
  1. Discover named historic features in a bbox via OSM Overpass, so stop
     coordinates come from OSM entities rather than free-text geocoding
     (which silently resolves e.g. the historic courthouse to the modern one).
  2. Ask the Mapillary Graph API what imagery exists near each, preferring
     true 360 panoramas over flat perspective shots.

Usage:  python3 content/scripts/probe_coverage.py [--radius-m 50]
"""

from __future__ import annotations

import argparse
import json
import math
import os
import sys
import time
from pathlib import Path

import httpx

REPO = Path(__file__).resolve().parents[2]
ENV_FILE = REPO / "backend" / ".env"
OUT_FILE = REPO / "content" / "coverage-report.json"

UA = "clio-wired-prototype/0.1 (graduates@rrchnm.org)"
MAPILLARY = "https://graph.mapillary.com/images"

# Old Town Fairfax and immediate surrounds.
BBOX = (38.8400, -77.3180, 38.8560, -77.2950)  # south, west, north, east

OVERPASS_MIRRORS = [
    "https://overpass-api.de/api/interpreter",
    "https://overpass.kumi.systems/api/interpreter",
    "https://overpass.private.coffee/api/interpreter",
    "https://overpass.osm.jp/api/interpreter",
]

OVERPASS_QUERY = """
[out:json][timeout:90];
(
  nwr["historic"]({bbox});
  nwr["tourism"~"museum|attraction"]({bbox});
  nwr["amenity"~"townhall|courthouse"]({bbox});
);
out center tags;
"""

# Sites worth probing that OSM does not tag as historic/tourism/amenity.
EXTRA_SITES = [
    {"name": "Old Town Hall", "kind": "manual", "lat": 38.84604, "lng": -77.30617},
    {"name": "Marr Monument", "kind": "manual", "lat": 38.84566, "lng": -77.30716},
]

# Churches dominate the Overpass result but are not this tour's subject.
EXCLUDE_KINDS = {"place_of_worship"}


def read_token() -> str:
    tok = os.environ.get("MAPILLARY_TOKEN")
    if not tok and ENV_FILE.exists():
        for line in ENV_FILE.read_text().splitlines():
            if line.strip().startswith("MAPILLARY_TOKEN="):
                tok = line.split("=", 1)[1].strip().strip("\"'")
    if not tok:
        sys.exit(f"No MAPILLARY_TOKEN in env or {ENV_FILE}")
    return tok


# The local egress proxy truncates stdlib-urllib response bodies mid-read
# (IncompleteRead), reproducibly and across every Accept-Encoding. httpx is
# reliable through the same proxy, so all network access here goes through it.
CLIENT = httpx.Client(timeout=60.0, headers={"User-Agent": UA}, follow_redirects=True)


def get_json(url: str, params: dict, attempts: int = 4) -> dict:
    """GET JSON with backoff on transient failures."""
    last = None
    for attempt in range(attempts):
        try:
            resp = CLIENT.get(url, params=params)
            if resp.status_code >= 400:
                body = resp.text[:300]
                if resp.status_code < 500:  # auth/quota will not improve on retry
                    raise RuntimeError(f"HTTP {resp.status_code} from {url}: {body}")
                last = f"HTTP {resp.status_code}: {body}"
            else:
                return resp.json()
        except RuntimeError:
            raise
        except Exception as e:  # noqa: BLE001 - retry on any transport failure
            last = f"{type(e).__name__}: {e}"
        if attempt < attempts - 1:
            time.sleep(2 ** attempt)
    raise RuntimeError(f"{url} failed after {attempts} attempts: {last}")


def discover_sites() -> list[dict]:
    """Find named historic features in the bbox via Overpass, with mirror fallback."""
    bbox = ",".join(str(c) for c in BBOX)
    query = OVERPASS_QUERY.format(bbox=bbox)
    data = None
    for mirror in OVERPASS_MIRRORS:
        try:
            resp = CLIENT.post(mirror, data={"data": query}, timeout=120.0)
            resp.raise_for_status()
            data = resp.json()
            print(f"Overpass: {mirror.split('/')[2]}")
            break
        except Exception as e:  # noqa: BLE001 - try the next mirror whatever failed
            print(f"  mirror {mirror.split('/')[2]} failed: {type(e).__name__}", file=sys.stderr)
            time.sleep(2)

    if data is None:
        sys.exit("all Overpass mirrors failed")

    sites, seen = [], set()
    for el in data.get("elements", []):
        tags = el.get("tags", {})
        name = tags.get("name")
        if not name:
            continue
        kind = tags.get("historic") or tags.get("tourism") or tags.get("amenity")
        if kind in EXCLUDE_KINDS:
            continue
        lat = el.get("lat") or el.get("center", {}).get("lat")
        lng = el.get("lon") or el.get("center", {}).get("lon")
        if lat is None or lng is None:
            continue
        key = (name, round(lat, 4), round(lng, 4))
        if key in seen:
            continue
        seen.add(key)
        sites.append({
            "name": name, "kind": kind, "lat": lat, "lng": lng,
            "osm": f"{el['type']}/{el['id']}",
            "start_date": tags.get("start_date"),
            "nrhp": tags.get("ref:nrhp"),
            "wikidata": tags.get("wikidata"),
        })
    return sites + EXTRA_SITES


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


def probe(token: str, lng: float, lat: float, radius_m: float) -> list[dict]:
    data = get_json(MAPILLARY, {
        "access_token": token,
        "bbox": bbox_around(lng, lat, radius_m),
        "fields": "id,computed_geometry,geometry,is_pano,captured_at,compass_angle",
        "limit": 500,
    })
    images = []
    for img in data.get("data", []):
        geom = img.get("computed_geometry") or img.get("geometry")
        if not geom:
            continue
        ilng, ilat = geom["coordinates"]
        images.append({
            "id": img["id"], "lng": ilng, "lat": ilat,
            "is_pano": bool(img.get("is_pano")),
            "captured_at": img.get("captured_at"),
            "compass_angle": img.get("compass_angle"),
            "distance_m": round(haversine_m(lng, lat, ilng, ilat), 1),
        })
    images.sort(key=lambda i: (not i["is_pano"], i["distance_m"]))
    return images


def ms_to_ym(ms: int | None) -> str:
    return time.strftime("%Y-%m", time.gmtime(ms / 1000)) if ms else "?"


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--radius-m", type=float, default=50.0)
    args = ap.parse_args()

    token = read_token()
    sites = discover_sites()
    print(f"Probing {len(sites)} sites, {args.radius_m:.0f}m radius\n")
    print(f"{'site':<40} {'imgs':>5} {'pano':>5} {'near':>7}  {'newest':<8} verdict")
    print("-" * 88)

    report = {"bbox": BBOX, "radius_m": args.radius_m, "stops": []}
    for site in sites:
        images = probe(token, site["lng"], site["lat"], args.radius_m)
        panos = [i for i in images if i["is_pano"]]
        nearest = images[0]["distance_m"] if images else None
        newest = max((i["captured_at"] or 0) for i in images) if images else None
        verdict = "PANO" if panos else ("flat only" if images else "NO IMAGERY")

        print(f"{site['name'][:40]:<40} {len(images):>5} {len(panos):>5} "
              f"{(f'{nearest:.0f}m' if nearest is not None else '-'):>7}  "
              f"{ms_to_ym(newest):<8} {verdict}")

        report["stops"].append({**site,
                                "image_count": len(images), "pano_count": len(panos),
                                "nearest_m": nearest, "newest": ms_to_ym(newest),
                                "verdict": verdict,
                                "best_pano": panos[0] if panos else None,
                                "sample": images[:5]})

    OUT_FILE.parent.mkdir(parents=True, exist_ok=True)
    OUT_FILE.write_text(json.dumps(report, indent=2))

    strong = [s for s in report["stops"] if s["pano_count"] >= 3 and (s["nearest_m"] or 999) <= 40]
    print("-" * 88)
    print(f"{sum(1 for s in report['stops'] if s['image_count'])}/{len(sites)} sites have imagery; "
          f"{sum(1 for s in report['stops'] if s['pano_count'])} have panoramas; "
          f"{len(strong)} are strong candidates (>=3 panos within 40m)")
    for s in strong:
        print(f"    * {s['name']}")
    print(f"\nreport -> {OUT_FILE.relative_to(REPO)}")
    return 0 if len(strong) >= 4 else 1


if __name__ == "__main__":
    raise SystemExit(main())
