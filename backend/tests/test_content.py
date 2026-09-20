from __future__ import annotations

import json
from pathlib import Path

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
