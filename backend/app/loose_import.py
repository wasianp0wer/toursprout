"""Turning a loose `tour.json` plus its media folder into a bundle zip.

The repository's own tour is in exactly this shape (`content/tours/*.json`
beside `content/media/`), and the welcome screen lets an author drop it as
it stands. The result is an ordinary bundle zip handed to `Session.replace_from`,
so a loose drop gets the same validation, media allow-list, migration, orphan
warnings and atomic swap as a `.zip` import; nothing here writes to the
working directory.

Division of labour with the frontend: it filters a dropped folder and tells
the author which files it skipped. This module is the backend's defence in
depth and REFUSES what reaches it, as `/api/session/import` does for a zip.
"""

from __future__ import annotations

import json
import tempfile
from pathlib import Path
from typing import BinaryIO

from .bundle import MEDIA_EXTENSIONS, BundleError, stage_bundle_root, write_bundle


def _media_name(path: str) -> str | None:
    """Return the name under `media/` for a media part, None for `tour.json`,
    or raise. Components are checked on the raw string, since `Path` silently
    drops `.` and doubled slashes, which would let `media/./x.jpg` through as
    if it had been a different, clean name.
    """
    if path == "tour.json":
        return None
    parts = path.split("/")
    if parts[0] != "media" or len(parts) < 2:
        raise BundleError(f"unexpected file in the drop (not tour.json or media/): {path}")
    # Control characters (NUL especially) would reach `open()` as a
    # ValueError, not an OSError, and surface as a 500.
    if "\\" in path or any(ord(c) < 32 or ord(c) == 127 for c in path):
        raise BundleError(f"unsafe file path: {path}")
    if any(p in ("", ".", "..") for p in parts):
        raise BundleError(f"unsafe file path: {path}")
    # `write_bundle` skips dot-prefixed components by policy; accepting one
    # here would stage it, lose it, and blame the author for missing media.
    if any(p.startswith(".") for p in parts):
        raise BundleError(f"a hidden file cannot be part of a tour: {path}")
    name = "/".join(parts[1:])
    if Path(name).suffix.lower() not in MEDIA_EXTENSIONS:
        raise BundleError(f"not an allowed image or audio type: {path}")
    return name


def stage_loose_bundle(parts: list[tuple[str, BinaryIO]], dest_zip: Path) -> None:
    """Zip `(relative_path, stream)` parts into a bundle at `dest_zip`.

    Every path is validated before anything is read or written. Streams are
    left open; the caller owns them.
    """
    tour: BinaryIO | None = None
    media: list[tuple[str, BinaryIO]] = []
    seen: set[str] = set()
    for path, stream in parts:
        name = _media_name(path)
        if name is None:
            if tour is not None:
                raise BundleError("the drop contains more than one tour.json")
            tour = stream
        else:
            if name in seen:
                raise BundleError(f"the drop contains {path} more than once")
            seen.add(name)
            media.append((name, stream))
    if tour is None:
        raise BundleError("the drop has no tour.json")
    try:
        document = json.load(tour)
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise BundleError(f"tour.json is not valid JSON: {exc}") from exc
    if not isinstance(document, dict):
        raise BundleError("tour.json must contain a JSON object")

    with tempfile.TemporaryDirectory() as tmp:
        root = Path(tmp) / "bundle"
        stage_bundle_root(root, document, media)
        write_bundle(root, dest_zip)
