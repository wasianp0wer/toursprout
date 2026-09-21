from __future__ import annotations

import math
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "content" / "scripts"))

from geo import offset_to_lnglat


def test_zero_offset_is_identity():
    lng, lat = offset_to_lnglat(-77.307, 38.845, 0, 0)
    assert math.isclose(lng, -77.307, abs_tol=1e-9)
    assert math.isclose(lat, 38.845, abs_tol=1e-9)


def test_north_offset_increases_latitude_only():
    lng, lat = offset_to_lnglat(-77.307, 38.845, 0, 111.32)
    assert math.isclose(lng, -77.307, abs_tol=1e-9)
    assert math.isclose(lat, 38.846, abs_tol=1e-5)


def test_south_offset_decreases_latitude():
    _, lat = offset_to_lnglat(-77.307, 38.845, 0, -111.32)
    assert math.isclose(lat, 38.844, abs_tol=1e-5)


def test_east_offset_increases_longitude():
    lng, _ = offset_to_lnglat(-77.307, 38.845, 100, 0)
    assert lng > -77.307


def test_west_offset_decreases_longitude():
    lng, _ = offset_to_lnglat(-77.307, 38.845, -100, 0)
    assert lng < -77.307


def test_east_offset_shrinks_with_latitude():
    """A metre of easting is more degrees of longitude nearer the poles."""
    near_equator, _ = offset_to_lnglat(0.0, 0.0, 100, 0)
    near_pole, _ = offset_to_lnglat(0.0, 60.0, 100, 0)
    assert near_pole > near_equator


def test_offsets_are_small_enough_to_stay_local():
    lng, lat = offset_to_lnglat(-77.30732, 38.84562, 8, 4)
    assert abs(lng + 77.30732) < 0.001
    assert abs(lat - 38.84562) < 0.001


from geo import bearing_between


def test_bearing_north_is_zero():
    assert bearing_between(-77.307, 38.845, -77.307, 38.846) == pytest.approx(0, abs=0.5)


def test_bearing_east_is_ninety():
    assert bearing_between(-77.307, 38.845, -77.306, 38.845) == pytest.approx(90, abs=0.5)


def test_bearing_south_is_one_eighty():
    assert bearing_between(-77.307, 38.845, -77.307, 38.844) == pytest.approx(180, abs=0.5)


def test_bearing_west_is_two_seventy():
    assert bearing_between(-77.307, 38.845, -77.308, 38.845) == pytest.approx(270, abs=0.5)


def test_bearing_always_in_range():
    for dlng, dlat in ((-0.001, -0.001), (0.001, -0.001), (-0.001, 0.001), (0.001, 0.001)):
        b = bearing_between(-77.307, 38.845, -77.307 + dlng, 38.845 + dlat)
        assert 0 <= b < 360


def test_bearing_courthouse_matches_measured_geometry():
    """The courthouse panorama stands on Main Street, north-east of the building."""
    b = bearing_between(-77.306888050888, 38.845533730977, -77.30732, 38.84562)
    assert b == pytest.approx(284, abs=2)


def test_reverse_bearing_is_opposed():
    there = bearing_between(-77.307, 38.845, -77.306, 38.846)
    back = bearing_between(-77.306, 38.846, -77.307, 38.845)
    assert abs(((back - there) % 360) - 180) < 0.5
