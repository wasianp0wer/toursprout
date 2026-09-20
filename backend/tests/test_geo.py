from __future__ import annotations

import math
import sys
from pathlib import Path

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
