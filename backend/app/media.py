"""HTTP range request parsing.

Extracted from the route layer so the byte-arithmetic edge cases can be tested
directly. Follows RFC 9110 section 14: unrecognised units and syntactically
invalid ranges are ignored (serve the whole representation), while a
syntactically valid but unsatisfiable range is an error.
"""

from __future__ import annotations

from pathlib import Path

MEDIA_TYPES = {
    ".m4a": "audio/mp4",
    ".mp4": "video/mp4",
    ".mp3": "audio/mpeg",
    ".ogg": "audio/ogg",
    ".wav": "audio/wav",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".png": "image/png",
    ".webp": "image/webp",
    ".json": "application/json",
}


class RangeNotSatisfiable(Exception):
    """The client asked for a range that cannot be served: HTTP 416."""


def guess_media_type(path: Path) -> str:
    return MEDIA_TYPES.get(path.suffix.lower(), "application/octet-stream")


def parse_range(header: str | None, file_size: int) -> tuple[int, int] | None:
    """Return an inclusive (start, end) byte range, or None to serve everything."""
    if not header:
        return None

    unit, _, spec = header.partition("=")
    if unit.strip().lower() != "bytes" or not spec:
        return None
    if "," in spec:  # multipart ranges are out of scope
        return None

    start_s, sep, end_s = spec.strip().partition("-")
    if not sep:
        return None

    try:
        if not start_s:  # suffix range: bytes=-N
            if not end_s:
                return None
            length = int(end_s)
            if length <= 0 or file_size == 0:
                raise RangeNotSatisfiable(header)
            return (max(0, file_size - length), file_size - 1)
        start = int(start_s)
        end = int(end_s) if end_s else file_size - 1
    except ValueError:
        return None

    if start < 0 or start >= file_size or end < start:
        raise RangeNotSatisfiable(header)

    return (start, min(end, file_size - 1))
