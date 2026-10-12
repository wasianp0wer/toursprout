"""The open tour: an unpacked working directory, not a zip held in memory.

The editor needs somewhere to put an uploaded photograph before the tour is
saved anywhere, so the working directory IS the open document and every edit
writes through to it immediately. The zip is only its portable form.
"""

from __future__ import annotations

import json
import shutil
from pathlib import Path

from pydantic import ValidationError

from .bundle import BUNDLE_VERSION, read_bundle
from .migration import migrate_v1_to_v2
from .models import Tour


def skeleton(title: str) -> dict:
    """The smallest document that validates, so a new tour opens in the editor
    rather than in an error state. The panorama is a placeholder the author
    replaces; `Stop` requires one and there is nothing honest to put there yet.
    """
    slug = "-".join(title.lower().split()) or "untitled"
    return {
        "id": slug,
        "schemaVersion": 2,
        "title": title,
        "description": "",
        "attribution": [],
        "stops": [{
            "id": "stop-1",
            "order": 1,
            "title": "First stop",
            "summary": "Describe this place.",
            "location": {"lng": 0.0, "lat": 0.0},
            "osmRef": None,
            "panorama": {"provider": "mapillary", "imageId": "0",
                         "bearing": 0.0, "cachedPath": None},
            "overlays": [],
        }],
    }


class Session:
    """One open document, rooted at a working directory."""

    def __init__(self, path: Path) -> None:
        self.path = Path(path)

    @property
    def is_open(self) -> bool:
        return (self.path / "tour.json").is_file()

    def tour(self) -> Tour:
        raw = json.loads((self.path / "tour.json").read_text())
        return Tour.model_validate(migrate_v1_to_v2(raw))

    def new(self, title: str) -> Tour:
        doc = skeleton(title)
        if self.path.exists():
            shutil.rmtree(self.path)
        (self.path / "media").mkdir(parents=True)
        self._write_bundle_json(doc["id"])
        return self.write_tour(doc)

    def write_tour(self, doc: dict) -> Tour:
        """Validate, then persist. Validation first means tour.json on disk
        always parses — the editor can crash mid-edit without corrupting it."""
        try:
            tour = Tour.model_validate(doc)
        except ValidationError as exc:
            raise ValueError(str(exc)) from exc
        self.path.mkdir(parents=True, exist_ok=True)
        (self.path / "tour.json").write_text(json.dumps(doc, indent=2) + "\n")
        return tour

    def replace_from(self, zip_path: Path) -> list[str]:
        """Import a bundle. read_bundle validates into staging and only then
        swaps, so a failure here leaves the open document exactly as it was."""
        return read_bundle(zip_path, self.path)

    def write_config(self, cfg: dict) -> None:
        (self.path / "config.json").write_text(json.dumps(cfg, indent=2) + "\n")

    def summary(self) -> dict:
        if not self.is_open:
            return {"open": False}
        tour = self.tour()
        media_dir = self.path / "media"
        count = len(list(media_dir.iterdir())) if media_dir.is_dir() else 0
        return {
            "open": True,
            "tourId": tour.id,
            "title": tour.title,
            "stopCount": len(tour.stops),
            "mediaCount": count,
        }

    def _write_bundle_json(self, tour_id: str) -> None:
        (self.path / "bundle.json").write_text(json.dumps(
            {"bundleVersion": BUNDLE_VERSION, "tourId": tour_id}, indent=2) + "\n")
