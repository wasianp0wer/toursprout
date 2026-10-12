"""Reading and writing tour bundles.

A bundle is a zip whose contents are exactly what a published site serves:
`bundle.json`, `tour.json` and `media/`. `bundle.json` describes the container
and `tour.json` is purely the schema's business, so the two can version
independently — a v1 bundle may carry a v2 document.

Import is this application's only untrusted input, and it arrives as an
archive, which is the classic way to get files written where nobody intended.
Everything in `read_bundle` before the extraction is there for that reason.
"""

from __future__ import annotations

import json
import shutil
import stat
import tempfile
import zipfile
from pathlib import Path

from pydantic import ValidationError

from .migration import migrate_v1_to_v2
from .models import Tour

BUNDLE_VERSION = 1

# A tour is a few hundred kB of document and some tens of MB of media. These
# caps are far above anything legitimate and far below anything that hurts.
MAX_TOTAL_BYTES = 512 * 1024 * 1024
MAX_ENTRIES = 5000


class BundleError(Exception):
    """A bundle could not be read. The message is shown to the author."""


def write_bundle(work: Path, zip_path: Path) -> None:
    """Zip a working directory. Deflate: media is already compressed, but the
    document and any SVG are not, and the cost is negligible at this size."""
    work = Path(work)
    zip_path.parent.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(zip_path, "w", zipfile.ZIP_DEFLATED) as zf:
        for path in sorted(work.rglob("*")):
            if path.is_file():
                zf.write(path, path.relative_to(work).as_posix())


def read_bundle(zip_path: Path, dest: Path) -> list[str]:
    """Extract and validate a bundle into `dest`. Returns warnings.

    `dest` is only created once everything has been checked, so a failed
    import cannot leave a half-written directory behind.
    """
    if not zipfile.is_zipfile(zip_path):
        raise BundleError("that file is not a zip archive")

    with zipfile.ZipFile(zip_path) as zf:
        infos = zf.infolist()
        _check_safe(infos)

        with tempfile.TemporaryDirectory() as staging_name:
            staging = Path(staging_name)
            zf.extractall(staging)
            warnings = _validate_tree(staging)

            # Swap in only after validation. shutil.copytree onto a cleared
            # destination rather than a rename, because staging is in $TMPDIR
            # and may be on a different filesystem.
            if dest.exists():
                shutil.rmtree(dest)
            shutil.copytree(staging, dest)
    return warnings


def _check_safe(infos: list[zipfile.ZipInfo]) -> None:
    if len(infos) > MAX_ENTRIES:
        raise BundleError(
            f"too many entries in the archive: {len(infos)}, limit {MAX_ENTRIES}"
        )
    total = sum(i.file_size for i in infos)
    if total > MAX_TOTAL_BYTES:
        raise BundleError(
            f"archive is too large uncompressed: {total} bytes, "
            f"limit {MAX_TOTAL_BYTES}"
        )
    for info in infos:
        name = info.filename
        if stat.S_ISLNK(info.external_attr >> 16):
            raise BundleError(f"unsafe archive entry (symlink): {name}")
        path = Path(name)
        if path.is_absolute() or name.startswith("/") or ".." in path.parts:
            raise BundleError(f"unsafe archive entry (escapes the bundle): {name}")


def _validate_tree(root: Path) -> list[str]:
    tour_path = root / "tour.json"
    if not tour_path.is_file():
        raise BundleError("the archive has no tour.json at its root")

    try:
        raw = json.loads(tour_path.read_text())
    except json.JSONDecodeError as exc:
        raise BundleError(f"tour.json is not valid JSON: {exc}") from exc

    try:
        doc = migrate_v1_to_v2(raw)
    except ValueError as exc:
        raise BundleError(f"tour.json could not be migrated: {exc}") from exc

    try:
        tour = Tour.model_validate(doc)
    except ValidationError as exc:
        raise BundleError(f"tour.json is not a valid tour: {exc}") from exc

    # Write the migrated document back, so what lands on disk is always v2 and
    # nothing downstream has to migrate again.
    tour_path.write_text(json.dumps(doc, indent=2) + "\n")

    media_dir = root / "media"
    present = {p.name for p in media_dir.iterdir()} if media_dir.is_dir() else set()
    referenced = {
        ov.media_id for stop in tour.stops for ov in stop.overlays if ov.media_id
    }

    missing = sorted(referenced - present)
    if missing:
        raise BundleError(
            "the bundle is missing media its tour references: " + ", ".join(missing)
        )

    # Orphans are a warning, never an error: an author mid-edit will often have
    # uploaded something not yet placed, and deleting it would be the worse
    # failure.
    orphans = sorted(present - referenced)
    return [f"media/{name} is not referenced by any overlay" for name in orphans]
