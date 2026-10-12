from __future__ import annotations

import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "content" / "scripts"))

from build_tour import in_world_overlay
from geo import bearing_between

CONTENT = Path(__file__).resolve().parents[2] / "content" / "source" / "stops.json"


def _stops():
    return json.loads(CONTENT.read_text())


def test_six_stops_in_contiguous_order():
    stops = _stops()
    assert len(stops) == 6
    assert [s["order"] for s in stops] == [1, 2, 3, 4, 5, 6]


def test_stop_ids_are_unique():
    assert len({s["id"] for s in _stops()}) == 6


def test_every_stop_has_narration_and_an_overlay():
    for stop in _stops():
        assert stop["narration"].strip()
        assert stop["overlays"]


def test_overlay_ids_are_globally_unique():
    ids = [o["id"] for s in _stops() for o in s["overlays"]]
    assert len(ids) == len(set(ids))


def test_text_overlays_have_bodies_and_image_overlays_have_queries():
    for stop in _stops():
        for ov in stop["overlays"]:
            if ov["kind"] == "text":
                assert ov["body"].strip()
            if ov["kind"] == "image":
                assert ov["imageQuery"].strip()


def test_bearings_are_valid_compass_degrees():
    for stop in _stops():
        assert 0 <= stop["bearing"] < 360


def test_locations_are_inside_the_fairfax_bounding_box():
    for stop in _stops():
        assert 38.840 <= stop["location"]["lat"] <= 38.856
        assert -77.318 <= stop["location"]["lng"] <= -77.295


def test_anchor_offsets_are_small_enough_to_stay_at_the_stop():
    """Overlays belong at their stop, not halfway down the street."""
    for stop in _stops():
        for ov in stop["overlays"]:
            off = ov["anchorOffset"]
            assert abs(off["east"]) <= 25
            assert abs(off["north"]) <= 25
            assert 0 <= off["altitude"] <= 20


def test_build_tour_emits_schema_version_two():
    """A cheap source-text backstop against the v1 shapes this module used to
    emit. That the OUTPUT is valid is already proven by the migration suite
    against the real on-disk document; behavioural coverage of the one
    highest-stakes invariant (derived, not authored, heading) lives in
    test_rephoto_heading_is_derived_not_authored below."""
    src = Path(__file__).resolve().parents[2] / "content" / "scripts" / "build_tour.py"
    text = src.read_text()
    assert '"schemaVersion": SCHEMA_VERSION' in text
    assert '"kind": "rephoto"' not in text
    assert '"type": "geoQuad"' not in text
    assert '"altitude":' not in text


def test_rephoto_heading_is_derived_not_authored():
    """The spec's authored headingDeg must never reach the output. The display
    heading is derived from where the panorama actually stands, computed
    independently here with the same bearing_between the generator uses."""
    spec = {
        "id": "test-rephoto",
        "title": "Test rephoto",
        "anchor": {
            "type": "geoQuad",
            "lng": -77.307,
            "lat": 38.846,  # north of the panorama, so the photo must face south (~180)
            "altitude": 8.0,
            "headingDeg": 200,  # deliberately wrong authored value
            "widthM": 30,
            "heightM": 24,
        },
    }
    pano_lng, pano_lat = -77.307, 38.845
    credit = {"type": "sourced", "source": "s", "url": "u", "license": "l", "creator": None}

    overlay = in_world_overlay(spec, "test-rephoto.jpg", credit, pano_lng, pano_lat, 0)

    expected = round(
        bearing_between(spec["anchor"]["lng"], spec["anchor"]["lat"], pano_lng, pano_lat), 1)
    assert overlay["display"]["headingDeg"] == expected
    assert overlay["display"]["headingDeg"] != spec["anchor"]["headingDeg"]


def test_split_shape_rephoto_heading_is_also_derived_not_authored():
    """Alignment mode (frontend/src/app/align/align-mode.ts) emits a split
    {anchor, display} rephoto shape, not the flat v1-ish shape above.
    in_world_overlay must accept that shape -- so pasting align mode's output
    into stops.json actually works -- while still deriving the heading: a
    pasted display.headingDeg, however wrong, must be ignored exactly like
    the flat shape's authored anchor.headingDeg already is."""
    spec = {
        "id": "test-rephoto-split",
        "title": "Test rephoto (split shape)",
        "anchor": {"type": "geo", "lng": -77.307, "lat": 38.846, "altitudeM": 8.0},
        "display": {
            "mode": "inWorld",
            "headingDeg": 7.0,  # deliberately bogus -- must be ignored
            "widthM": 30,
            "heightM": 24,
        },
    }
    pano_lng, pano_lat = -77.307, 38.845
    credit = {"type": "sourced", "source": "s", "url": "u", "license": "l", "creator": None}

    overlay = in_world_overlay(spec, "test-rephoto-split.jpg", credit, pano_lng, pano_lat, 0)

    expected = round(
        bearing_between(spec["anchor"]["lng"], spec["anchor"]["lat"], pano_lng, pano_lat), 1)
    assert overlay["display"]["headingDeg"] == expected
    assert overlay["display"]["headingDeg"] != spec["display"]["headingDeg"]
    assert overlay["anchor"] == {"type": "geo", "lng": -77.307, "lat": 38.846, "altitudeM": 8.0}
    assert overlay["display"]["widthM"] == 30
    assert overlay["display"]["heightM"] == 24
