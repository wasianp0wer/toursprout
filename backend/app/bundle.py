"""Reading and writing tour bundles.

A bundle is a zip whose contents are exactly what a published site serves:
`bundle.json`, `tour.json` and `media/`. `bundle.json` describes the container
and `tour.json` is purely the schema's business, so the two can version
independently — a v1 bundle may carry a v2 document.

Import is this application's only untrusted input, and it arrives as an
archive, which is the classic way to get files written where nobody intended.
Everything in `read_bundle` before and during extraction is there for that
reason — including that the uncompressed-size cap is enforced on bytes
actually produced during extraction, not on what the archive declares about
itself; see `_extract_safely`.
"""

from __future__ import annotations

import json
import os
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
    document and any SVG are not, and the cost is negligible at this size.

    Dotfiles (`.DS_Store` and the like) are never picked up: they are the
    filesystem's business, not the tour's, and have no place in something
    an author will later re-import.
    """
    work = Path(work)
    zip_path.parent.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(zip_path, "w", zipfile.ZIP_DEFLATED) as zf:
        for path in sorted(work.rglob("*")):
            if path.is_file() and not path.name.startswith("."):
                zf.write(path, path.relative_to(work).as_posix())


def read_bundle(zip_path: Path, dest: Path) -> list[str]:
    """Extract and validate a bundle into `dest`. Returns warnings.

    `dest` is only touched once everything has been checked, so a failed
    import cannot leave a half-written directory behind — and even the swap
    into `dest` goes through a sibling temp directory and renames rather
    than a delete-then-copy, so a crash during the swap itself cannot leave
    `dest` empty or half-populated either. See `_swap_in`.
    """
    if not zipfile.is_zipfile(zip_path):
        raise BundleError("that file is not a zip archive")

    with zipfile.ZipFile(zip_path) as zf:
        infos = zf.infolist()
        _check_safe(infos)

        with tempfile.TemporaryDirectory() as staging_name:
            staging = Path(staging_name)
            _extract_safely(zf, staging)
            warnings = _validate_tree(staging)
            _swap_in(staging, Path(dest))
    return warnings


def _check_safe(infos: list[zipfile.ZipInfo]) -> None:
    """Cheap, metadata-only checks, run before a single byte is read from the
    archive. These catch an HONESTLY declared bomb or an obviously unsafe
    name for free, but `ZipInfo.file_size` is attacker-controlled — nothing
    in the zip format requires it to match what the DEFLATE stream actually
    expands to — so the size check here is only an early-out, never the
    enforcement. `_extract_safely` is what actually enforces the cap, by
    counting real bytes as they are written.
    """
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
        # Backslashes and drive letters are not meaningful path separators on
        # POSIX (and so are not currently exploitable here — CPython's own
        # extraction does not treat `\` as a separator either), but they are
        # rejected anyway as defense in depth, since `_extract_safely` below
        # replaces stdlib `extractall` and that backstop goes with it.
        if "\\" in name:
            raise BundleError(f"unsafe archive entry (backslash separator): {name}")
        if len(name) >= 2 and name[1] == ":" and name[0].isalpha():
            raise BundleError(f"unsafe archive entry (drive letter): {name}")
        path = Path(name)
        if path.is_absolute() or name.startswith("/") or ".." in path.parts:
            raise BundleError(f"unsafe archive entry (escapes the bundle): {name}")


def _extract_safely(zf: zipfile.ZipFile, staging: Path) -> None:
    """Extract entry by entry, counting actual decompressed bytes as they
    are written, aborting the moment the running total exceeds
    `MAX_TOTAL_BYTES`.

    `_check_safe`'s size check sums `ZipInfo.file_size` — metadata an
    attacker controls — and is only an early-out for an HONESTLY declared
    bomb. This loop enforces the cap on bytes actually produced, rather than
    on what the archive claims about itself, so the guarantee does not rest
    on trusting that metadata.

    In practice, CPython's `ZipExtFile` (what `zf.open()` returns) already
    truncates decompressed output to the declared `file_size` and then
    fails a CRC check if that is a lie — so forging a small `file_size` to
    mask a larger real stream does not, in this implementation, let more
    bytes through than the lie itself; see the "declared size lies" test
    for the measurement that established this. That truncation is an
    interpreter-internal behavior, not a documented part of the zipfile
    contract, so this loop does not rely on it: it is an explicit,
    self-contained enforcement of the cap on the bytes it itself writes,
    which holds regardless of what any particular Python version or
    implementation does internally.
    """
    chunk_size = 1024 * 1024
    total = 0
    for info in zf.infolist():
        target = staging / info.filename
        if info.filename.endswith("/"):
            target.mkdir(parents=True, exist_ok=True)
            continue
        target.parent.mkdir(parents=True, exist_ok=True)
        try:
            with zf.open(info) as src, open(target, "wb") as dst:
                while True:
                    chunk = src.read(chunk_size)
                    if not chunk:
                        break
                    total += len(chunk)
                    if total > MAX_TOTAL_BYTES:
                        raise BundleError(
                            "archive is too large uncompressed (streamed): "
                            f"exceeded {MAX_TOTAL_BYTES} bytes while "
                            f"extracting {info.filename!r} — its declared "
                            "size cannot be trusted"
                        )
                    dst.write(chunk)
        except BundleError:
            raise
        except (zipfile.BadZipFile, EOFError) as exc:
            # A forged declared size (lying about `file_size` to mask a
            # larger real stream) does not let more bytes through than the
            # lie itself: `ZipExtFile` truncates output to the declared size
            # and then fails this CRC check, because the CRC on record was
            # computed over the real, larger payload. So the lie is
            # self-defeating for an attacker — but without this wrapper the
            # failure would surface as a raw `zipfile.BadZipFile` rather
            # than the `BundleError` this function's callers are promised.
            raise BundleError(
                f"{info.filename!r} is corrupt, or its declared size does "
                f"not match its real contents: {exc}"
            ) from exc


def _swap_in(staging: Path, dest: Path) -> None:
    """Move a fully validated staging tree into `dest`, without ever leaving
    `dest` deleted-but-not-yet-replaced.

    `staging` lives in `$TMPDIR`, possibly a different filesystem than
    `dest`, so it cannot simply be renamed into place. Instead it is copied
    to a sibling of `dest` (same directory, same filesystem) and ONLY THEN
    swapped in with renames, which are atomic on one filesystem: the
    previous `dest` is renamed aside before the new one is renamed into
    `dest`'s place. A crash between those two renames can leave a stray
    `.incoming` or `.outgoing` directory next to `dest` — recoverable by
    hand — but it can never leave the author with a half-copied `dest` and
    nothing to recover.
    """
    dest.parent.mkdir(parents=True, exist_ok=True)
    incoming = dest.parent / f"{dest.name}.incoming"
    outgoing = dest.parent / f"{dest.name}.outgoing"

    if incoming.exists():
        shutil.rmtree(incoming)
    try:
        shutil.copytree(staging, incoming)
    except Exception as exc:
        shutil.rmtree(incoming, ignore_errors=True)
        raise BundleError(f"could not stage the import: {exc}") from exc

    if outgoing.exists():
        shutil.rmtree(outgoing)
    moved_dest_aside = False
    try:
        if dest.exists():
            os.replace(dest, outgoing)
            moved_dest_aside = True
        os.replace(incoming, dest)
    except Exception as exc:
        # Best-effort restoration: put the original back if we moved it
        # aside and the swap itself did not complete.
        if moved_dest_aside and not dest.exists() and outgoing.exists():
            os.replace(outgoing, dest)
        raise BundleError(f"could not finalize the import: {exc}") from exc

    if outgoing.exists():
        shutil.rmtree(outgoing)


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
