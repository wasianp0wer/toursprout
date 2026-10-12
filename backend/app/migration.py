"""Upgrade v1 tour documents to v2.

v1 welded presentation to content type: `kind: "rephoto"` meant "an image, as
a plane standing in the world", and every other kind meant "a clickable
marker". v2 separates those, so the migration's whole job is to read the
intent v1 encoded in `kind` and write it out explicitly in `display`.

Pure: dict in, dict out, input never mutated. This module stays in the tree
after the repository's own tour is converted, because exported bundles in the
wild will still be v1.
"""

from __future__ import annotations

from copy import deepcopy
from typing import Any

from .models import SCHEMA_VERSION

_ICON_BY_KIND = {"text": "note", "image": "photo", "audio": "audio"}

# v1 opened a stop with the first draped photograph at 0.7 and the rest
# hidden, hardcoded in the frontend's TourStore.resetRephotoOpacities().
# v2 authors that per overlay, so writing v1's numbers here means the migrated
# tour opens looking exactly as it did.
_FIRST_IN_WORLD_OPACITY = 0.7
_LATER_IN_WORLD_OPACITY = 0.0


def migrate_v1_to_v2(doc: dict[str, Any]) -> dict[str, Any]:
    """Return a v2 copy of `doc`. A v2 document is returned unchanged."""
    version = doc.get("schemaVersion")
    if version == SCHEMA_VERSION:
        return deepcopy(doc)
    if version != 1:
        raise ValueError(
            f"unsupported schemaVersion {version!r}: this build understands "
            f"1 and {SCHEMA_VERSION}"
        )

    out = deepcopy(doc)
    out["schemaVersion"] = SCHEMA_VERSION
    for stop in out.get("stops", []):
        stop["overlays"] = _migrate_overlays(stop.get("overlays", []))
    return out


def _migrate_overlays(overlays: list[dict[str, Any]]) -> list[dict[str, Any]]:
    in_world_seen = 0
    migrated = []
    for ov in overlays:
        kind = ov.get("kind")
        if kind == "rephoto":
            migrated.append(_rephoto_to_in_world(ov, in_world_seen))
            in_world_seen += 1
        elif kind in _ICON_BY_KIND:
            migrated.append(_to_marker(ov))
        else:
            # Silently dropping an overlay is invisible data loss; a tour
            # would come back from migration quietly shorter.
            raise ValueError(
                f"overlay {ov.get('id')!r} has unknown kind {kind!r}"
            )
    return migrated


def _rephoto_to_in_world(ov: dict[str, Any], index: int) -> dict[str, Any]:
    anchor = ov["anchor"]
    for field in ("headingDeg", "widthM", "heightM"):
        if field not in anchor:
            raise ValueError(
                f"overlay {ov.get('id')!r} is a rephoto but its anchor has no "
                f"{field!r}; a plain geo anchor cannot migrate to an inWorld display"
            )
    return {
        "id": ov["id"],
        "kind": "image",
        "anchor": _geo_anchor(anchor),
        "display": {
            "mode": "inWorld",
            "opacity": (
                _FIRST_IN_WORLD_OPACITY if index == 0 else _LATER_IN_WORLD_OPACITY
            ),
            "headingDeg": anchor["headingDeg"],
            "widthM": anchor["widthM"],
            "heightM": anchor["heightM"],
        },
        "title": ov["title"],
        "body": ov.get("body"),
        "mediaId": ov.get("mediaId"),
        "credit": _sourced(ov["credit"]),
    }


def _to_marker(ov: dict[str, Any]) -> dict[str, Any]:
    return {
        "id": ov["id"],
        "kind": ov["kind"],
        "anchor": _geo_anchor(ov["anchor"]),
        "display": {"mode": "marker", "icon": _ICON_BY_KIND[ov["kind"]]},
        "title": ov["title"],
        "body": ov.get("body"),
        "mediaId": ov.get("mediaId"),
        "credit": _sourced(ov["credit"]),
    }


def _geo_anchor(anchor: dict[str, Any]) -> dict[str, Any]:
    """Geometry (heading, width, height) belongs to `display` in v2; only
    position survives here. `altitude` is renamed to make its unit and datum
    explicit, and carries the same value."""
    return {
        "type": "geo",
        "lng": anchor["lng"],
        "lat": anchor["lat"],
        "altitudeM": anchor.get("altitude", 0.0),
    }


def _sourced(credit: dict[str, Any]) -> dict[str, Any]:
    """Every v1 credit named an external source, so all of them are `sourced`.
    `original` only becomes reachable once the editor can create media."""
    return {
        "type": "sourced",
        "source": credit["source"],
        "url": credit["url"],
        "license": credit["license"],
        "creator": credit.get("creator"),
    }
