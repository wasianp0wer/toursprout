"""Assemble the tour document from editorial source, coverage and media manifest.

Validates the result against app.models.Tour before writing, so a broken tour
never reaches the database.

This script REGENERATES content/tours/fairfax-old-town.json from
content/source/stops.json (plus the media manifest). Hand-edits made
directly to the output document are not read back and will be silently
overwritten the next time this runs. KNOWN DIVERGENCE: commit de48b0d
("adjustment") hand-tuned the rephoto anchors in the output document to
improve on-screen alignment; stops.json was never updated to match, so the
next `make content` will revert that alignment work. See the schema-v2 task
2 fix report for details before touching either file.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(REPO / "backend"))
sys.path.insert(0, str(Path(__file__).resolve().parent))

from geo import bearing_between, offset_to_lnglat

from app.models import SCHEMA_VERSION, Tour

SOURCE = REPO / "content" / "source" / "stops.json"
MANIFEST = REPO / "content" / "media" / "manifest.json"
OUT = REPO / "content" / "tours" / "fairfax-old-town.json"

ATTRIBUTION = [
    {"text": "Map data (c) OpenStreetMap contributors",
     "url": "https://www.openstreetmap.org/copyright", "license": "ODbL"},
    {"text": "Street-level imagery (c) Mapillary contributors",
     "url": "https://www.mapillary.com", "license": "CC-BY-SA-4.0"},
]

# Editorial prose is ours, and is labelled as draft rather than scholarship.
# Already in the `sourced` credit shape, so it is used directly below.
TEXT_CREDIT = {
    "type": "sourced",
    "source": "Written for this prototype",
    "url": "https://www.openstreetmap.org/copyright",
    "license": "Draft text, not peer-reviewed",
    "creator": "Project author",
}

# Which marker icon represents each content kind.
_ICON_BY_KIND = {"text": "note", "image": "photo", "audio": "audio"}


def _sourced(credit: dict) -> dict:
    """Manifest credits all name an external source."""
    return {"type": "sourced", "source": credit["source"], "url": credit["url"],
            "license": credit["license"], "creator": credit.get("creator")}


def in_world_overlay(spec: dict, media_id: str, credit: dict,
                      pano_lng: float, pano_lat: float, index: int) -> dict:
    """Build one draped-photograph overlay.

    Pure and filesystem/network-free, so tests can call it directly to pin
    the one invariant that matters most here: the heading is DERIVED from
    where the panorama actually stands, never taken from spec["anchor"].
    Every hand-authored bearing in this project was wrong, one by 138
    degrees, which put the subject behind the viewer.
    """
    anchor = spec["anchor"]
    heading = round(
        bearing_between(anchor["lng"], anchor["lat"], pano_lng, pano_lat), 1)
    return {
        "id": spec["id"],
        "kind": "image",
        "anchor": {"type": "geo", "lng": anchor["lng"], "lat": anchor["lat"],
                   "altitudeM": anchor["altitude"]},
        "display": {
            "mode": "inWorld",
            # One legible comparison at a time: several semi-transparent
            # photographs over one building overlap into a muddle.
            "opacity": 0.7 if index == 0 else 0.0,
            "headingDeg": heading,
            "widthM": anchor["widthM"],
            "heightM": anchor["heightM"],
        },
        "title": spec["title"],
        "mediaId": media_id,
        "credit": credit,
    }


def main() -> int:
    stops_src = json.loads(SOURCE.read_text())
    manifest = json.loads(MANIFEST.read_text())
    stops = []

    for src in stops_src:
        pano_entry = manifest.get(f"pano-{src['id']}.jpg")
        if not pano_entry:
            sys.exit(f"no cached panorama for {src['id']}; run fetch_media.py first")

        origin = src["location"]
        overlays = []

        # Face the subject. Authoring this by eye produced six wrong values,
        # one of them 138 degrees out, which put the stop's subject behind the
        # viewer. Derive it from where the panorama actually stands.
        pano_lng, pano_lat = pano_entry.get("lng"), pano_entry.get("lat")
        if pano_lng is None or pano_lat is None:
            sys.exit(f"panorama position missing for {src['id']}; re-run fetch_media.py")
        view_bearing = bearing_between(pano_lng, pano_lat, origin["lng"], origin["lat"])

        for ov in src["overlays"]:
            off = ov["anchorOffset"]
            lng, lat = offset_to_lnglat(origin["lng"], origin["lat"], off["east"], off["north"])
            entry = {
                "id": ov["id"],
                "kind": ov["kind"],
                "anchor": {"type": "geo", "lng": lng, "lat": lat,
                           "altitudeM": off["altitude"]},
                "display": {"mode": "marker", "icon": _ICON_BY_KIND[ov["kind"]]},
                "title": ov["title"],
            }
            if ov["kind"] == "text":
                entry["body"] = ov["body"]
                entry["credit"] = TEXT_CREDIT
            else:
                media_id = f"{ov['id']}.jpg"
                if media_id not in manifest:
                    sys.exit(f"missing media {media_id}; run fetch_media.py first")
                entry["mediaId"] = media_id
                entry["credit"] = _sourced(manifest[media_id]["credit"])
            overlays.append(entry)

        narration_id = f"narration-{src['id']}.m4a"
        if narration_id in manifest:
            lng, lat = offset_to_lnglat(origin["lng"], origin["lat"], 0, 2)
            overlays.append({
                "id": f"narration-{src['id']}",
                "kind": "audio",
                "anchor": {"type": "geo", "lng": lng, "lat": lat, "altitudeM": 2.0},
                "display": {"mode": "marker", "icon": "audio"},
                "title": f"Narration: {src['title']}",
                "mediaId": narration_id,
                "credit": _sourced(manifest[narration_id]["credit"]),
            })

        for index, spec in enumerate(src.get("rephotos", [])):
            media_id = f"{spec['id']}.jpg"
            if media_id not in manifest:
                sys.exit(f"missing rephoto {media_id}; run fetch_rephotos.py first")
            overlays.append(in_world_overlay(
                spec, media_id, _sourced(manifest[media_id]["credit"]),
                pano_lng, pano_lat, index))

        stops.append({
            "id": src["id"],
            "order": src["order"],
            "title": src["title"],
            "summary": src["summary"],
            "location": origin,
            "osmRef": src["osmRef"],
            "panorama": {
                "provider": "mapillary",
                "imageId": pano_entry["imageId"],
                "bearing": round(view_bearing, 1),
                "cachedPath": f"media/{pano_entry['file']}",
            },
            "overlays": overlays,
        })

    doc = {
        "id": "fairfax-old-town",
        "schemaVersion": SCHEMA_VERSION,
        "title": "Old Town Fairfax",
        "description": "Six historic sites in the City of Fairfax, Virginia, "
                       "told through street-level panoramas.",
        "attribution": ATTRIBUTION,
        "stops": stops,
    }

    Tour.model_validate(doc)  # fail here rather than at runtime
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps(doc, indent=2))
    print(f"wrote {OUT.relative_to(REPO)} - {len(stops)} stops, "
          f"{sum(len(s['overlays']) for s in stops)} overlays")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
