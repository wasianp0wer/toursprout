from __future__ import annotations

import json
from copy import deepcopy
from pathlib import Path

import pytest

from app.migration import migrate
from app.models import SCHEMA_VERSION, Tour

REPO = Path(__file__).resolve().parents[2]
REAL_TOUR = REPO / "content" / "tours" / "fairfax-old-town.json"

# A frozen v1 snapshot of the repository's real tour, taken before it was
# migrated in place (git show fc7f758:content/tours/fairfax-old-town.json).
# Do NOT refresh this file when the live tour changes: its whole purpose is
# to stay v1 forever, so these tests keep exercising the migration against
# real content instead of comparing an already-v2 document to itself.
V1_FIXTURE = Path(__file__).parent / "fixtures" / "fairfax-old-town-v1.json"

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
    out = migrate(_v1_doc([_v1_text()]))
    ov = out["stops"][0]["overlays"][0]
    assert ov["kind"] == "text"
    assert ov["display"] == {"mode": "marker", "icon": "note"}
    assert ov["anchor"] == {"type": "geo", "lng": -77.3, "lat": 38.84, "altitudeM": 3.0}


def test_rephoto_becomes_an_in_world_image():
    out = migrate(_v1_doc([_v1_rephoto("r1")]))
    ov = out["stops"][0]["overlays"][0]
    assert ov["kind"] == "image"
    assert ov["anchor"] == {"type": "geo", "lng": -77.3, "lat": 38.84, "altitudeM": 4.0}
    assert ov["display"] == {"mode": "inWorld", "opacity": 0.7,
                             "headingDeg": 284.4, "widthM": 18.0, "heightM": 12.0}


def test_first_in_world_photo_opens_visible_and_the_rest_hidden():
    """v1 hardcoded 0.7 for the first and 0 for the rest in the frontend store.
    v2 authors it, so the migrated tour must open looking identical."""
    out = migrate(_v1_doc([_v1_rephoto("r1"), _v1_rephoto("r2")]))
    opacities = [o["display"]["opacity"] for o in out["stops"][0]["overlays"]]
    assert opacities == [0.7, 0.0]


def test_audio_becomes_a_marker_not_ambient():
    """Nothing autoplays in v1. Migrating to ambient would start six
    narrations playing by themselves."""
    audio = {"id": "a1", "kind": "audio",
             "anchor": {"type": "geo", "lng": -77.3, "lat": 38.84, "altitude": 2.0},
             "title": "Narration", "body": None, "mediaId": "n.m4a",
             "credit": V1_CREDIT}
    out = migrate(_v1_doc([audio]))
    assert out["stops"][0]["overlays"][0]["display"] == {"mode": "marker", "icon": "audio"}


def test_credit_becomes_sourced():
    out = migrate(_v1_doc([_v1_text()]))
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
    migrate(doc)
    assert doc == before


def test_rephoto_with_a_plain_geo_anchor_is_refused_loudly():
    """A v1 rephoto's anchor should always be a geoQuad carrying headingDeg,
    widthM and heightM, but the migration must not trust that unconditionally:
    a plain `geo` anchor on a rephoto must raise a clear error naming the
    overlay, not a bare KeyError."""
    bad = {"id": "r-bad", "kind": "rephoto",
           "anchor": {"type": "geo", "lng": -77.3, "lat": 38.84, "altitude": 4.0},
           "title": "Photo", "body": None, "mediaId": "r-bad.jpg", "credit": V1_CREDIT}
    with pytest.raises(ValueError, match="r-bad"):
        migrate(_v1_doc([bad]))


def test_unknown_kind_is_refused_loudly():
    bad = {"id": "x", "kind": "hologram",
           "anchor": {"type": "geo", "lng": 0.0, "lat": 0.0, "altitude": 0.0},
           "title": "T", "credit": V1_CREDIT}
    with pytest.raises(ValueError, match="x"):
        migrate(_v1_doc([bad]))


@pytest.mark.parametrize("version", [None, SCHEMA_VERSION + 1, "1", 0])
def test_unsupported_schema_version_is_refused(version):
    doc = _v1_doc([_v1_text()])
    if version is None:
        del doc["schemaVersion"]
    else:
        doc["schemaVersion"] = version
    with pytest.raises(ValueError, match="schemaVersion"):
        migrate(doc)


def test_a_stop_with_no_overlays_survives():
    doc = _v1_doc([])
    assert migrate(doc)["stops"][0]["overlays"] == []


def test_the_real_tour_migrates_and_validates():
    """Exercises migrate_v1_to_v2 against real content, permanently: the
    fixture is frozen v1 regardless of what the live tour later becomes."""
    raw = json.loads(V1_FIXTURE.read_text())
    migrated = migrate(raw)
    tour = Tour.model_validate(migrated)
    assert len(tour.stops) == 6
    assert sum(len(s.overlays) for s in tour.stops) == 15


def test_the_real_tour_loses_nothing():
    """Compares the frozen v1 fixture against its own migration, so `raw`
    and `migrated` are never the same object and this can actually fail."""
    raw = json.loads(V1_FIXTURE.read_text())
    migrated = migrate(raw)

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
            assert a["anchor"]["altitude"] == b["anchor"]["altitudeM"]


def test_the_shipped_tour_is_valid_at_the_current_version():
    """Keeps the live document honest now that the fixture tests above no
    longer look at it: it must already be current and must validate as such."""
    raw = json.loads(REAL_TOUR.read_text())
    assert raw["schemaVersion"] == SCHEMA_VERSION
    tour = Tour.model_validate(raw)
    assert len(tour.stops) == 6
    assert sum(len(s.overlays) for s in tour.stops) == 15


# --- v3: the chain, and the v2 -> v3 step -----------------------------------
#
# A frozen v2 snapshot of the repository's real tour, taken before it was
# migrated in place. Same rule as V1_FIXTURE above: do NOT refresh it. Between
# the two, the chain is exercised end to end against real content.
V2_FIXTURE = Path(__file__).parent / "fixtures" / "fairfax-old-town-v2.json"


def _v2_doc(**over):
    base = {
        "id": "t", "schemaVersion": 2, "title": "T", "description": "d",
        "attribution": [{"text": "a", "url": "https://e.org", "license": "ODbL"}],
        "stops": [{
            "id": "s1", "order": 1, "title": "S", "summary": "sum",
            "location": {"lng": -77.3, "lat": 38.84}, "osmRef": None,
            "panorama": {"provider": "mapillary", "imageId": "1",
                         "bearing": 90.0, "cachedPath": None},
            "overlays": [],
        }],
    }
    base.update(over)
    return base


def _v2_text(oid="t1"):
    return {"id": oid, "kind": "text",
            "anchor": {"type": "geo", "lng": -77.3, "lat": 38.84, "altitudeM": 3.0},
            "display": {"mode": "marker", "icon": "note"},
            "title": "Title", "body": "Body", "mediaId": None,
            "credit": {"type": "sourced", "source": "s", "url": "https://e.org",
                       "license": "l", "creator": None}}


def test_a_v1_document_reaches_the_current_version_in_one_call():
    """The point of the registry: callers ask for "current", not for a hop."""
    out = migrate(_v1_doc([_v1_text()]))
    assert out["schemaVersion"] == SCHEMA_VERSION == 5


def test_a_v2_document_reaches_the_current_version():
    assert migrate(_v2_doc())["schemaVersion"] == SCHEMA_VERSION


def test_migrating_a_current_document_is_a_no_op():
    doc = migrate(_v2_doc(stops=_v2_doc()["stops"]))
    assert migrate(doc) == doc


def test_a_version_newer_than_this_build_is_refused():
    with pytest.raises(ValueError, match="schemaVersion"):
        migrate(_v2_doc(schemaVersion=SCHEMA_VERSION + 1))


def test_a_cached_panorama_path_becomes_a_media_id():
    """v2 stored `media/pano/x.jpg` — a path with the directory baked in,
    outside the `mediaId` namespace and invisible to the orphan check."""
    doc = _v2_doc()
    doc["stops"][0]["panorama"]["cachedPath"] = "media/pano/x.jpg"
    out = migrate(doc)
    assert out["stops"][0]["panorama"]["cachedMediaId"] == "pano/x.jpg"
    assert "cachedPath" not in out["stops"][0]["panorama"]


def test_an_absent_cached_panorama_stays_absent():
    out = migrate(_v2_doc())
    assert out["stops"][0]["panorama"]["cachedMediaId"] is None


def test_a_cached_path_outside_the_media_directory_is_refused_loudly():
    doc = _v2_doc()
    doc["stops"][0]["panorama"]["cachedPath"] = "/etc/passwd"
    with pytest.raises(ValueError, match="cachedPath"):
        migrate(doc)


def test_duplicate_overlay_ids_are_renamed_rather_than_refused():
    """v3 requires unique overlay ids, and v2 did not check them. Refusing
    would make a document in the wild unopenable; renaming keeps it."""
    doc = _v2_doc()
    doc["stops"][0]["overlays"] = [_v2_text("dup"), _v2_text("dup")]
    out = migrate(doc)
    assert [o["id"] for o in out["stops"][0]["overlays"]] == ["dup", "dup-2"]


def test_an_overlay_id_colliding_with_a_stop_id_is_renamed():
    doc = _v2_doc()
    doc["stops"][0]["overlays"] = [_v2_text("s1")]
    out = migrate(doc)
    assert out["stops"][0]["overlays"][0]["id"] == "s1-2"
    Tour.model_validate(out)


def test_a_blank_attribution_url_becomes_null():
    out = migrate(_v2_doc(
        attribution=[{"text": "a", "url": "   ", "license": "ODbL"}]))
    assert out["attribution"][0]["url"] is None


def test_a_blank_attribution_license_is_refused_loudly():
    with pytest.raises(ValueError, match="licen"):
        migrate(_v2_doc(attribution=[{"text": "a", "url": "https://e.org",
                                      "license": ""}]))


def test_the_real_v2_tour_migrates_and_validates():
    raw = json.loads(V2_FIXTURE.read_text())
    assert raw["schemaVersion"] == 2
    tour = Tour.model_validate(migrate(raw))
    assert len(tour.stops) == 6
    assert sum(len(s.overlays) for s in tour.stops) == 15
    assert [s.panorama.cached_media_id for s in tour.stops] == [
        f"pano/pano-{slug}.jpg" for slug in (
            "historic-courthouse", "marr-monument", "old-town-hall",
            "ratcliffe-allison-pozer-house", "fairfax-museum", "fairfax-city-hall")
    ]


def test_the_v1_fixture_migrates_through_four_steps_to_the_current_version():
    """The chain, against real content: v1 -> v2 -> v3 -> v4 -> v5 in one call, with
    the v1-only shapes (rephoto, geoQuad) and the v3-only ones (cachedMediaId)
    both landing correctly."""
    raw = json.loads(V1_FIXTURE.read_text())
    tour = Tour.model_validate(migrate(raw))
    assert len(tour.stops) == 6
    assert sum(len(s.overlays) for s in tour.stops) == 15
    assert tour.stops[0].panorama.cached_media_id == "pano/pano-historic-courthouse.jpg"
    in_world = [o for s in tour.stops for o in s.overlays
                if o.display.mode == "inWorld"]
    assert len(in_world) == 2


def test_a_blank_attribution_text_is_refused_loudly():
    """v2's `min_length=1` let a whitespace-only line through; v3's NonBlank
    does not, so the step must refuse rather than hand on a document that
    fails validation one layer later."""
    with pytest.raises(ValueError, match="attribution"):
        migrate(_v2_doc(attribution=[{"text": "   ", "url": None,
                                      "license": "ODbL"}]))


# --- v4: the theme step ------------------------------------------------------
#
# A frozen v3 snapshot of the repository's real tour, taken before it was
# bumped to v4 by hand. Same rule as V1_FIXTURE and V2_FIXTURE: do NOT refresh
# it. Its whole purpose is to stay v3 forever, so these tests keep exercising
# the chain against real content instead of an already-current document.
V3_FIXTURE = Path(__file__).parent / "fixtures" / "fairfax-old-town-v3.json"


def test_v3_to_v4_is_a_version_bump_and_changes_nothing_else():
    doc = json.loads(V3_FIXTURE.read_text())
    assert doc["schemaVersion"] == 3
    before = deepcopy(doc)
    out = migrate(doc)
    assert doc == before  # pure: the input is never mutated
    assert out["schemaVersion"] == SCHEMA_VERSION == 5
    assert {k: v for k, v in out.items() if k != "schemaVersion"} == \
           {k: v for k, v in doc.items() if k != "schemaVersion"}


def test_the_v3_fixture_migrates_and_validates():
    tour = Tour.model_validate(migrate(json.loads(V3_FIXTURE.read_text())))
    assert tour.theme is None


# --- v5: the tour icon step --------------------------------------------------


# A frozen v4 snapshot of the repository's real tour (aec65c1), taken before it
# was bumped to v5 by hand. Same rule as the fixtures above: do NOT refresh it.
V4_FIXTURE = Path(__file__).parent / "fixtures" / "fairfax-old-town-v4.json"


def test_v4_to_v5_is_a_version_bump_and_changes_nothing_else():
    doc = json.loads(V4_FIXTURE.read_text())
    assert doc["schemaVersion"] == 4
    before = deepcopy(doc)
    out = migrate(doc)
    assert doc == before  # pure: the input is never mutated
    assert out["schemaVersion"] == SCHEMA_VERSION == 5
    assert "icon" not in out
    assert {k: v for k, v in out.items() if k != "schemaVersion"} == \
           {k: v for k, v in doc.items() if k != "schemaVersion"}


def test_the_v4_fixture_migrates_and_validates():
    tour = Tour.model_validate(migrate(json.loads(V4_FIXTURE.read_text())))
    assert tour.icon is None
