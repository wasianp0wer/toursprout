"""Upgrade older tour documents to the current schema version.

One entry point, `migrate`, and one step per version behind it. Callers ask
for "current" and never for a hop: `migrate` looks the document's version up
in `_MIGRATIONS` and applies steps until it arrives, so adding v4 means adding
a function and one dictionary entry and touching no call site.

Every step is pure (dict in, dict out, input never mutated) and total: it
refuses loudly rather than dropping data, because a tour that comes back from
migration quietly shorter is the worst failure this module can have.

This module stays in the tree permanently. Exported bundles in the wild are
v1 and v2, and `tour.json` inside a working directory persists between runs.
"""

from __future__ import annotations

from collections.abc import Callable
from copy import deepcopy
from typing import Any

from .models import SCHEMA_VERSION

# --- v1 -> v2 ---------------------------------------------------------------
#
# v1 welded presentation to content type: `kind: "rephoto"` meant "an image, as
# a plane standing in the world", and every other kind meant "a clickable
# marker". v2 separates those, so this step's whole job is to read the intent
# v1 encoded in `kind` and write it out explicitly in `display`. ADR 0001.

_ICON_BY_KIND = {"text": "note", "image": "photo", "audio": "audio"}

# v1 opened a stop with the first draped photograph at 0.7 and the rest
# hidden, hardcoded in the frontend's TourStore.resetRephotoOpacities().
# v2 authors that per overlay, so writing v1's numbers here means the migrated
# tour opens looking exactly as it did.
_FIRST_IN_WORLD_OPACITY = 0.7
_LATER_IN_WORLD_OPACITY = 0.0


def _v1_to_v2(doc: dict[str, Any]) -> dict[str, Any]:
    out = deepcopy(doc)
    out["schemaVersion"] = 2
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


# --- v2 -> v3 ---------------------------------------------------------------
#
# v3 is three tightenings, none of which could be added later without
# rejecting documents already in the wild. ADR 0005.
#
#   1. Overlay ids must be unique tour-wide. v2 never checked them, so
#      collisions are renamed here rather than refused: a document in the
#      wild must stay openable.
#   2. A cached panorama is a media id, not a path. v2's `cachedPath` baked
#      the directory in (`media/pano/x.jpg`), which put it outside the
#      `mediaId` namespace and so outside the orphan and missing-media
#      checks — which is why the shipped example reported six permanent
#      orphans that were in fact its six panoramas.
#   3. An `Attribution` may have no URL, but never a blank one and never a
#      blank licence.

_MEDIA_PREFIX = "media/"


def _v2_to_v3(doc: dict[str, Any]) -> dict[str, Any]:
    out = deepcopy(doc)
    out["schemaVersion"] = 3
    out["attribution"] = [
        _attribution(a) for a in out.get("attribution", [])
    ]
    for stop in out.get("stops", []):
        pano = stop.get("panorama")
        if isinstance(pano, dict):
            pano["cachedMediaId"] = _cached_media_id(pano.pop("cachedPath", None))
    _rename_colliding_overlay_ids(out)
    return out


def _attribution(a: dict[str, Any]) -> dict[str, Any]:
    out = dict(a)
    text = out.get("text")
    if not isinstance(text, str) or not text.strip():
        raise ValueError(
            f"attribution {text!r} has no text; v3 requires a non-blank one"
        )
    url = out.get("url")
    # Blank means "nobody filled this in", which v3 spells `null`. A real
    # absence is not an error: see Attribution in models.py.
    out["url"] = url.strip() if isinstance(url, str) and url.strip() else None
    license_ = out.get("license")
    if not isinstance(license_, str) or not license_.strip():
        raise ValueError(
            f"attribution {text!r} has no licence; v3 requires one, because "
            "an unlicensed line of credit is the thing the field exists to "
            "prevent"
        )
    return out


def _cached_media_id(cached_path: Any) -> str | None:
    """`media/pano/x.jpg` (a path) becomes `pano/x.jpg` (a media id).

    Anything not under `media/` has no media id to become, and inventing one
    would point the document at a file that is not in the bundle. Refuse and
    name the old field, so the message tells the author which key to look at.
    """
    if cached_path is None:
        return None
    if not isinstance(cached_path, str) or not cached_path.strip():
        raise ValueError(
            f"cachedPath {cached_path!r} is neither a path nor absent"
        )
    path = cached_path.strip()
    if not path.startswith(_MEDIA_PREFIX):
        raise ValueError(
            f"cachedPath {path!r} is not under {_MEDIA_PREFIX!r}, so it cannot "
            "become a media id; a cached panorama has to be inside the bundle"
        )
    media_id = path[len(_MEDIA_PREFIX):]
    if not media_id:
        raise ValueError(f"cachedPath {path!r} names no file")
    return media_id


def _rename_colliding_overlay_ids(doc: dict[str, Any]) -> None:
    """Make every overlay id unique tour-wide, in place.

    Renaming, not refusing: v2 did not check these, so a document in the wild
    may carry duplicates and must still open. Nothing inside the document
    references an overlay id, so a rename loses nothing — only the editor's
    own selection state names them, and that is never saved (ADR 0003).

    Stop ids go into `taken` first, so an overlay is what moves when an
    overlay and a stop share an id. Same `-2`, `-3` suffixing as `uniqueId`
    in the editor's `document-ops.ts`, so a migrated id and an authored one
    are indistinguishable.
    """
    stops = doc.get("stops", [])
    taken = {s["id"] for s in stops if isinstance(s, dict) and "id" in s}
    for stop in stops:
        for ov in stop.get("overlays", []) if isinstance(stop, dict) else []:
            current = ov.get("id")
            if not isinstance(current, str):
                continue
            if current not in taken:
                taken.add(current)
                continue
            n = 2
            while f"{current}-{n}" in taken:
                n += 1
            ov["id"] = f"{current}-{n}"
            taken.add(ov["id"])


# --- the chain --------------------------------------------------------------

_MIGRATIONS: dict[int, Callable[[dict[str, Any]], dict[str, Any]]] = {
    1: _v1_to_v2,
    2: _v2_to_v3,
}


def migrate(doc: dict[str, Any]) -> dict[str, Any]:
    """Return a copy of `doc` at `SCHEMA_VERSION`. A current document is
    returned unchanged. Anything this build has no step for is refused."""
    version = doc.get("schemaVersion")
    if version == SCHEMA_VERSION:
        return deepcopy(doc)
    # `isinstance(True, int)` is True, so booleans are excluded by hand.
    if isinstance(version, bool) or version not in _MIGRATIONS:
        known = ", ".join(str(v) for v in sorted(_MIGRATIONS))
        raise ValueError(
            f"unsupported schemaVersion {version!r}: this build understands "
            f"{known} and {SCHEMA_VERSION}"
        )

    out = deepcopy(doc)
    while out.get("schemaVersion") != SCHEMA_VERSION:
        before = out.get("schemaVersion")
        step = _MIGRATIONS.get(before)
        if step is None:
            raise ValueError(
                f"no migration step from schemaVersion {before!r} to "
                f"{SCHEMA_VERSION}"
            )
        out = step(out)
        # A step that does not advance the version would loop here forever.
        if out.get("schemaVersion") == before:
            raise ValueError(
                f"migration step from schemaVersion {before!r} did not "
                "advance the version"
            )
    return out
