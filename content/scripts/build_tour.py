"""Assemble the tour document from editorial source, coverage and media manifest.

Validates the result against app.models.Tour before writing, so a broken tour
never reaches the database.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(REPO / "backend"))
sys.path.insert(0, str(Path(__file__).resolve().parent))

from geo import offset_to_lnglat

from app.models import Tour

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
TEXT_CREDIT = {
    "source": "Written for this prototype",
    "url": "https://www.openstreetmap.org/copyright",
    "license": "Draft text, not peer-reviewed",
    "creator": "Project author",
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

        for ov in src["overlays"]:
            off = ov["anchorOffset"]
            lng, lat = offset_to_lnglat(origin["lng"], origin["lat"], off["east"], off["north"])
            entry = {
                "id": ov["id"],
                "kind": ov["kind"],
                "anchor": {"type": "geo", "lng": lng, "lat": lat, "altitude": off["altitude"]},
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
                entry["credit"] = manifest[media_id]["credit"]
            overlays.append(entry)

        narration_id = f"narration-{src['id']}.m4a"
        if narration_id in manifest:
            lng, lat = offset_to_lnglat(origin["lng"], origin["lat"], 0, 2)
            overlays.append({
                "id": f"narration-{src['id']}",
                "kind": "audio",
                "anchor": {"type": "geo", "lng": lng, "lat": lat, "altitude": 2.0},
                "title": f"Narration: {src['title']}",
                "mediaId": narration_id,
                "credit": manifest[narration_id]["credit"],
            })

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
                "bearing": float(src["bearing"]),
                "cachedPath": f"media/{pano_entry['file']}",
            },
            "overlays": overlays,
        })

    doc = {
        "id": "fairfax-old-town",
        "schemaVersion": 1,
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
