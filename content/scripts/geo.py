"""Local metre-offset to lng/lat conversion.

An equirectangular approximation is correct enough at walking-tour scale: the
offsets involved are single-digit metres, where the error against a proper
geodesic is far below GPS noise.
"""

from __future__ import annotations

import math

METRES_PER_DEGREE_LAT = 111_320.0


def offset_to_lnglat(lng: float, lat: float, east_m: float, north_m: float) -> tuple[float, float]:
    d_lat = north_m / METRES_PER_DEGREE_LAT
    d_lng = east_m / (METRES_PER_DEGREE_LAT * math.cos(math.radians(lat)))
    return lng + d_lng, lat + d_lat


def bearing_between(lng1: float, lat1: float, lng2: float, lat2: float) -> float:
    """Compass bearing in degrees from one point to another: 0 north, clockwise.

    Used to derive each stop's initial view direction from where its panorama
    actually stands, rather than trusting a hand-guessed value. Every bearing
    authored by eye for the Fairfax tour turned out to be wrong, one of them by
    138 degrees, which left the subject behind the viewer.
    """
    east = (lng2 - lng1) * math.cos(math.radians(lat1)) * METRES_PER_DEGREE_LAT
    north = (lat2 - lat1) * METRES_PER_DEGREE_LAT
    return (math.degrees(math.atan2(east, north)) + 360.0) % 360.0
