"""Fetch historical photographs to be draped over the scenes they depict.

Separate from fetch_media.py because the selection rule differs: a rephoto is
chosen for its date as well as its subject, so one site can be shown across
several eras.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

import httpx

sys.path.insert(0, str(Path(__file__).resolve().parent))

from relevance import (
    best_match,
    get_bytes_with_retry,
    get_json_with_retry,
    score_title,
)

REPO = Path(__file__).resolve().parents[2]
MEDIA = REPO / "content" / "media"
SOURCE = REPO / "content" / "source" / "stops.json"

UA = "clio-wired-prototype/0.1 (graduates@rrchnm.org)"
LOC_SEARCH = "https://www.loc.gov/photos/"
EXCLUDED_PLACES = ["alexandria", "chantilly", "lorton", "reston", "great falls",
                   "mclean", "philadelphia", "accawmacke"]

CLIENT = httpx.Client(timeout=90.0, headers={"User-Agent": UA}, follow_redirects=True)


def _first(value):
    if isinstance(value, list):
        return value[0] if value else None
    return value


def pick_by_date(items: list[dict], terms: list[str], prefer_date: str) -> dict | None:
    """Prefer an item from the wanted year, falling back to any relevant one."""
    relevant = [
        i for i in items
        if i.get("image_url") and score_title(i.get("title"), terms, EXCLUDED_PLACES)
    ]
    dated = [i for i in relevant if prefer_date in str(_first(i.get("date")) or "")]
    if dated:
        return dated[0]
    return best_match(items, terms, EXCLUDED_PLACES)


def main() -> int:
    MEDIA.mkdir(parents=True, exist_ok=True)
    manifest_path = MEDIA / "manifest.json"
    manifest = json.loads(manifest_path.read_text()) if manifest_path.exists() else {}
    failures = 0

    for stop in json.loads(SOURCE.read_text()):
        for spec in stop.get("rephotos", []):
            payload = get_json_with_retry(
                CLIENT, LOC_SEARCH, {"q": spec["query"], "fo": "json", "c": 25})
            item = pick_by_date(payload.get("results", []), spec["terms"], spec["preferDate"])
            if item is None:
                print(f"  {spec['id']:<14} NO RELEVANT MATCH", file=sys.stderr)
                failures += 1
                continue

            url = item["image_url"][-1].split("#")[0]
            if url.startswith("//"):
                url = "https:" + url
            content = get_bytes_with_retry(CLIENT, url)
            if content is None or content[:2] != b"\xff\xd8":
                print(f"  {spec['id']:<14} DOWNLOAD FAILED", file=sys.stderr)
                failures += 1
                continue

            media_id = f"{spec['id']}.jpg"
            (MEDIA / media_id).write_bytes(content)
            title = _first(item.get("title")) or ""
            date = _first(item.get("date")) or "?"
            manifest[media_id] = {
                "file": media_id,
                "credit": {
                    "source": "Library of Congress",
                    "url": item.get("id") or LOC_SEARCH,
                    "license": "No known restrictions on publication",
                    "creator": f"{title} — {date}",
                },
            }
            print(f"  {spec['id']:<14} [{date}] {title[:46]}")

    manifest_path.write_text(json.dumps(manifest, indent=2))
    return 1 if failures else 0


if __name__ == "__main__":
    raise SystemExit(main())
