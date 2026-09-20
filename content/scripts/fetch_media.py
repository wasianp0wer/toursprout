"""Fetch panoramas and historical images, recording provenance for each.

Every downloaded file gets a credit block. Media without provenance is not
written, because an overlay without a credit fails schema validation anyway.

All HTTP goes through httpx: stdlib urllib truncates bodies through the local
egress proxy. See docs/ENVIRONMENT.md.
"""

from __future__ import annotations

import json
import math
import sys
from pathlib import Path

import httpx

sys.path.insert(0, str(Path(__file__).resolve().parent))

from relevance import best_match, get_bytes_with_retry, get_json_with_retry

REPO = Path(__file__).resolve().parents[2]
MEDIA = REPO / "content" / "media"
SOURCE = REPO / "content" / "source" / "stops.json"
COVERAGE = REPO / "content" / "coverage-report.json"
ENV = REPO / "backend" / ".env"

UA = "clio-wired-prototype/0.1 (graduates@rrchnm.org)"
LOC_SEARCH = "https://www.loc.gov/photos/"
GRAPH = "https://graph.mapillary.com"

EXCLUDED_PLACES = ["alexandria", "chantilly", "lorton", "reston", "great falls",
                   "mclean", "philadelphia", "accawmacke"]

CLIENT = httpx.Client(timeout=90.0, headers={"User-Agent": UA}, follow_redirects=True)


def read_token() -> str:
    for line in ENV.read_text().splitlines():
        if line.strip().startswith("MAPILLARY_TOKEN="):
            return line.split("=", 1)[1].strip().strip("\"'")
    sys.exit("MAPILLARY_TOKEN not found in backend/.env")


def best_pano_for(coverage: dict, location: dict) -> dict | None:
    """Match a stop to its probed panorama by proximity, not by name.

    Editorial titles and OSM names drift apart ("Visitor Center" versus
    "Visitors Center"), so position is the reliable key.
    """
    best, best_distance = None, float("inf")
    for entry in coverage["stops"]:
        if not entry.get("best_pano"):
            continue
        d = math.hypot(entry["lat"] - location["lat"], entry["lng"] - location["lng"])
        if d < best_distance:
            best, best_distance = entry["best_pano"], d
    # ~0.0005 degrees is roughly 50 m: close enough to be the same site.
    return best if best_distance < 0.0005 else None


def fetch_panorama(token: str, image_id: str, dest: Path) -> dict:
    meta = CLIENT.get(f"{GRAPH}/{image_id}", params={
        "access_token": token,
        "fields": "id,thumb_2048_url,captured_at,creator,is_pano",
    }).json()
    content = get_bytes_with_retry(CLIENT, meta["thumb_2048_url"])
    if content is None:
        raise RuntimeError(f"could not download panorama {image_id}")
    dest.write_bytes(content)
    return {
        "source": "Mapillary",
        "url": f"https://www.mapillary.com/app/?pKey={image_id}",
        "license": "CC-BY-SA-4.0",
        "creator": (meta.get("creator") or {}).get("username", "Mapillary contributor"),
    }


def fetch_loc_image(query: str, required: list[str], dest: Path) -> dict | None:
    """Download the best genuinely relevant Library of Congress match.

    Taking the first result that happens to carry an image was a provenance
    bug: it would attach an Alexandria photograph to a Fairfax stop under a
    confident Library of Congress credit.
    """
    payload = get_json_with_retry(CLIENT, LOC_SEARCH, {"q": query, "fo": "json", "c": 25})
    item = best_match(payload.get("results", []), required, EXCLUDED_PLACES)
    if item is None:
        return None

    img_url = item["image_url"][-1].split("#")[0]
    if img_url.startswith("//"):
        img_url = "https:" + img_url
    if not img_url.startswith("http"):
        return None
    content = get_bytes_with_retry(CLIENT, img_url)
    if content is None or content[:2] != b"\xff\xd8":
        return None

    dest.write_bytes(content)
    return {
        "source": "Library of Congress",
        "url": item.get("id") or item.get("url") or LOC_SEARCH,
        "license": "No known restrictions on publication",
        # The matched archive title is recorded so a wrong match shows up in
        # the interface rather than staying buried in a manifest.
        "creator": _as_credit_creator(item),
    }


def _as_credit_creator(item: dict) -> str:
    creator = _first(item.get("creator")) or "Unknown"
    title = _first(item.get("title")) or ""
    date = _first(item.get("date")) or ""
    return " — ".join(p for p in (creator, title, date) if p)


def _first(value) -> str | None:
    if isinstance(value, list):
        return value[0] if value else None
    return value


def main() -> int:
    MEDIA.mkdir(parents=True, exist_ok=True)
    (MEDIA / "pano").mkdir(exist_ok=True)
    token = read_token()
    coverage = json.loads(COVERAGE.read_text())
    stops = json.loads(SOURCE.read_text())
    # Merge rather than replace: narration and rephoto entries are written by
    # sibling scripts, and clobbering them silently strips content from the tour.
    manifest_path = MEDIA / "manifest.json"
    manifest: dict[str, dict] = (
        json.loads(manifest_path.read_text()) if manifest_path.exists() else {}
    )
    failures = 0

    for stop in stops:
        pano = best_pano_for(coverage, stop["location"])
        if pano:
            media_id = f"pano-{stop['id']}.jpg"
            credit = fetch_panorama(token, pano["id"], MEDIA / "pano" / media_id)
            manifest[media_id] = {"file": f"pano/{media_id}", "credit": credit,
                                  "imageId": pano["id"]}
            print(f"  pano   {stop['id']:<32} {pano['id']}")
        else:
            print(f"  pano   {stop['id']:<32} NOT FOUND", file=sys.stderr)
            failures += 1

        for ov in stop["overlays"]:
            if ov["kind"] != "image":
                continue
            media_id = f"{ov['id']}.jpg"
            credit = fetch_loc_image(ov["imageQuery"], ov.get("imageTerms", []), MEDIA / media_id)
            if credit:
                manifest[media_id] = {"file": media_id, "credit": credit}
                print(f"  image  {ov['id']:<32} {credit['source']}")
            else:
                print(f"  image  {ov['id']:<32} NOT FOUND", file=sys.stderr)
                failures += 1

    manifest_path.write_text(json.dumps(manifest, indent=2))
    print(f"\n{len(manifest)} media files -> content/media/manifest.json")
    return 1 if failures else 0


if __name__ == "__main__":
    raise SystemExit(main())
