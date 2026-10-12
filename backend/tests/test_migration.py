from __future__ import annotations

import json
from copy import deepcopy
from pathlib import Path

import pytest

from app.migration import migrate_v1_to_v2
from app.models import Tour

REPO = Path(__file__).resolve().parents[2]
REAL_TOUR = REPO / "content" / "tours" / "fairfax-old-town.json"

V1_CREDIT = {
    "source": "Library of Congress",
    "url": "http://www.loc.gov/item/2006685364/",
    "license": "No known restrictions",
    "creator": None,
}


def _v1_doc(overlays):
    return {
        "id": "t", "schemaVersion": 1, "title": "T", "description": "d",
        "attribution": [],
        "stops": [{
            "id": "s1", "order": 1, "title": "S", "summary": "sum",
            "location": {"lng": -77.3, "lat": 38.84}, "osmRef": None,
            "panorama": {"provider": "mapillary", "imageId": "1",
                         "bearing": 90.0, "cachedPath": None},
            "overlays": overlays,
        }],
    }


def _v1_text():
    return {"id": "t1", "kind": "text",
            "anchor": {"type": "geo", "lng": -77.3, "lat": 38.84, "altitude": 3.0},
            "title": "Title", "body": "Body", "mediaId": None, "credit": V1_CREDIT}


def _v1_rephoto(oid, heading=284.4):
    return {"id": oid, "kind": "rephoto",
            "anchor": {"type": "geoQuad", "lng": -77.3, "lat": 38.84,
                       "altitude": 4.0, "headingDeg": heading,
                       "widthM": 18.0, "heightM": 12.0},
            "title": "Photo", "body": None, "mediaId": f"{oid}.jpg",
            "credit": V1_CREDIT}


def test_text_overlay_becomes_a_marker():
    out = migrate_v1_to_v2(_v1_doc([_v1_text()]))
    ov = out["stops"][0]["overlays"][0]
    assert ov["kind"] == "text"
    assert ov["display"] == {"mode": "marker", "icon": "note"}
    assert ov["anchor"] == {"type": "geo", "lng": -77.3, "lat": 38.84, "altitudeM": 3.0}


def test_rephoto_becomes_an_in_world_image():
    out = migrate_v1_to_v2(_v1_doc([_v1_rephoto("r1")]))
    ov = out["stops"][0]["overlays"][0]
    assert ov["kind"] == "image"
    assert ov["anchor"] == {"type": "geo", "lng": -77.3, "lat": 38.84, "altitudeM": 4.0}
    assert ov["display"] == {"mode": "inWorld", "opacity": 0.7,
                             "headingDeg": 284.4, "widthM": 18.0, "heightM": 12.0}


def test_first_in_world_photo_opens_visible_and_the_rest_hidden():
    """v1 hardcoded 0.7 for the first and 0 for the rest in the frontend store.
    v2 authors it, so the migrated tour must open looking identical."""
    out = migrate_v1_to_v2(_v1_doc([_v1_rephoto("r1"), _v1_rephoto("r2")]))
    opacities = [o["display"]["opacity"] for o in out["stops"][0]["overlays"]]
    assert opacities == [0.7, 0.0]


def test_audio_becomes_a_marker_not_ambient():
    """Nothing autoplays in v1. Migrating to ambient would start six
    narrations playing by themselves."""
    audio = {"id": "a1", "kind": "audio",
             "anchor": {"type": "geo", "lng": -77.3, "lat": 38.84, "altitude": 2.0},
             "title": "Narration", "body": None, "mediaId": "n.m4a",
             "credit": V1_CREDIT}
    out = migrate_v1_to_v2(_v1_doc([audio]))
    assert out["stops"][0]["overlays"][0]["display"] == {"mode": "marker", "icon": "audio"}


def test_credit_becomes_sourced():
    out = migrate_v1_to_v2(_v1_doc([_v1_text()]))
    assert out["stops"][0]["overlays"][0]["credit"] == {
        "type": "sourced",
        "source": "Library of Congress",
        "url": "http://www.loc.gov/item/2006685364/",
        "license": "No known restrictions",
        "creator": None,
    }


def test_migration_does_not_mutate_its_input():
    doc = _v1_doc([_v1_rephoto("r1")])
    before = deepcopy(doc)
    migrate_v1_to_v2(doc)
    assert doc == before


def test_migrating_a_v2_document_is_a_no_op():
    once = migrate_v1_to_v2(_v1_doc([_v1_rephoto("r1"), _v1_text()]))
    twice = migrate_v1_to_v2(once)
    assert twice == once


def test_unknown_kind_is_refused_loudly():
    bad = {"id": "x", "kind": "hologram",
           "anchor": {"type": "geo", "lng": 0.0, "lat": 0.0, "altitude": 0.0},
           "title": "T", "credit": V1_CREDIT}
    with pytest.raises(ValueError, match="x"):
        migrate_v1_to_v2(_v1_doc([bad]))


@pytest.mark.parametrize("version", [None, 3, "1", 0])
def test_unsupported_schema_version_is_refused(version):
    doc = _v1_doc([_v1_text()])
    if version is None:
        del doc["schemaVersion"]
    else:
        doc["schemaVersion"] = version
    with pytest.raises(ValueError, match="schemaVersion"):
        migrate_v1_to_v2(doc)


def test_a_stop_with_no_overlays_survives():
    doc = _v1_doc([])
    assert migrate_v1_to_v2(doc)["stops"][0]["overlays"] == []


def test_the_real_tour_migrates_and_validates():
    raw = json.loads(REAL_TOUR.read_text())
    migrated = migrate_v1_to_v2(raw) if raw["schemaVersion"] == 1 else raw
    tour = Tour.model_validate(migrated)
    assert len(tour.stops) == 6
    assert sum(len(s.overlays) for s in tour.stops) == 15


def test_the_real_tour_loses_nothing():
    raw = json.loads(REAL_TOUR.read_text())
    migrated = migrate_v1_to_v2(raw) if raw["schemaVersion"] == 1 else raw

    def ids(d):
        return [o["id"] for s in d["stops"] for o in s["overlays"]]

    def titles(d):
        return [o["title"] for s in d["stops"] for o in s["overlays"]]

    assert ids(migrated) == ids(raw)
    assert titles(migrated) == titles(raw)
    for s_before, s_after in zip(raw["stops"], migrated["stops"]):
        for a, b in zip(s_before["overlays"], s_after["overlays"]):
            assert a.get("mediaId") == b.get("mediaId")
            assert a.get("body") == b.get("body")
            assert a["anchor"]["lng"] == b["anchor"]["lng"]
            assert a["anchor"]["lat"] == b["anchor"]["lat"]
            # `altitude` was renamed to `altitudeM`. The on-disk tour is
            # migrated in place by this task, so `a` may already be v2 (no
            # `altitude` key) if this suite runs after that conversion;
            # either way its altitude value must match `b`'s.
            before_altitude = a["anchor"].get("altitude", a["anchor"].get("altitudeM"))
            assert before_altitude == b["anchor"]["altitudeM"]
