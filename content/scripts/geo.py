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
