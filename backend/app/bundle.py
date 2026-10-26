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
from collections.abc import Iterable
from pathlib import Path
from typing import IO

from pydantic import ValidationError

from .media_store import ALLOWED_TYPES, _sniff_type
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

    Dotfiles (`.DS_Store` and the like) are never picked up, and that check
    is applied to every PART of the relative path, not just the file's own
    name — a leaf-only check would miss a dotfile sitting inside a hidden
    directory (`.git/config` has a leaf name of `config`). They are the
    filesystem's business, not the tour's, and have no place in something an
    author will later re-import.

    `config.json` is excluded too. It is derived state (rebuilt from the
    backend's own settings every time a session opens or publishes), not
    part of the document, and was never meant to be the bundle's undocumented
    fourth member. `publish.py` still emits it for a published site, which is
    the one place it belongs.
    """
    work = Path(work)
    zip_path.parent.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(zip_path, "w", zipfile.ZIP_DEFLATED) as zf:
        for path in sorted(work.rglob("*")):
            if not path.is_file():
                continue
            rel = path.relative_to(work)
            if any(part.startswith(".") for part in rel.parts):
                continue
            if rel.as_posix() == "config.json":
                continue
            zf.write(path, rel.as_posix())


def stage_bundle_root(
    root: Path, document: dict, media: Iterable[tuple[str, IO[bytes]]]
) -> None:
    """Lay out a bundle's three members under `root`, ready for `write_bundle`.

    This exists so that the ways of getting a document plus some media INTO
    the application — opening a shipped example, dropping loose files on the
    editor — can all go through `read_bundle` instead of writing into the
    working directory themselves. That is the whole point: whoever stages a
    root here gets validation, the media allow-list, the bundle-version check,
    schema migration, the orphan warnings and the atomic swap for free, and
    none of them is reimplemented per entry point.

    `media` yields `(relative path under media/, open binary stream)`. Streams,
    not paths, because the loose-file caller already holds the upload's spooled
    file and copying it to disk first only to copy it again here would be
    pointless; a caller reading from disk opens each file itself. The stream is
    read to EOF and left open: its lifetime belongs to the caller, so a
    disk-backed caller can yield from inside a `with` block and have each file
    closed as the generator advances.

    Names are checked, not trusted. A loose-file caller's names come from the
    browser, and this writes them to the filesystem before `read_bundle`'s own
    entry-name checks ever see them. That is the whole of the division of
    labour: an unsafe name is refused HERE, while deciding what counts as
    media in the first place — and telling the author which of their files
    were skipped and why — belongs to the caller, which is the only one that
    knows where the files came from and who is waiting to hear about them.
    """
    root = Path(root)
    (root / "media").mkdir(parents=True, exist_ok=True)
    (root / "tour.json").write_text(json.dumps(document, indent=2) + "\n")
    # `tourId` is informational — `_check_bundle_version` reads only
    # `bundleVersion` — so a document with no `id` writes None here and is
    # then refused by `tour.json`'s own validation with a message about the
    # document, which is the one the author can act on.
    (root / "bundle.json").write_text(
        json.dumps(
            {"bundleVersion": BUNDLE_VERSION, "tourId": document.get("id")}, indent=2
        )
        + "\n"
    )
    for name, stream in media:
        target = root / "media" / _safe_media_name(name)
        target.parent.mkdir(parents=True, exist_ok=True)
        with open(target, "wb") as dst:
            shutil.copyfileobj(stream, dst)


def _safe_media_name(name: str) -> Path:
    """Reduce a caller's media name to a relative path under `media/`, or
    refuse it. Backslashes and bare `.`/`..` components are rejected rather
    than normalised away, for the same reason `_check_safe` rejects them in
    archive entries: a name that tried to escape is a name to refuse, not to
    quietly rewrite into something that did not.
    """
    rel = Path(name)
    if not name or name.endswith("/") or rel.is_absolute() or "\\" in name:
        raise BundleError(f"unsafe media name: {name}")
    if any(part in ("..", ".") for part in rel.parts):
        raise BundleError(f"unsafe media name (escapes media/): {name}")
    return rel


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
        try:
            if info.filename.endswith("/"):
                target.mkdir(parents=True, exist_ok=True)
                continue
            target.parent.mkdir(parents=True, exist_ok=True)
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
        except OSError as exc:
            # An entry named `.`, a file/directory name collision (e.g.
            # `media/x` then `media/x/y.jpg`), or a name past the
            # filesystem's length limit (ENAMETOOLONG) all surface here as
            # OSError from `mkdir`/`open` rather than from the zip-reading
            # code above. Without this, any of those turns an untrusted
            # upload into an unhandled 500 instead of the ordinary 400
            # `BundleError` this function's callers are promised.
            raise BundleError(
                f"could not extract {info.filename!r}: {exc}"
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


# The bundle format, per docs/superpowers/specs/2026-10-12-bundle-and-publish-
# design.md, is exactly these three root files plus `media/`. Everything in
# the working directory is later copied straight onto the author's own
# published origin by publish.py, so an archive that smuggled in, say,
# `evil.html` or `payload.js` would plant it there. Nothing short of an
# explicit allow-list closes that off, because "reject known-bad names" is a
# losing game against an attacker who picks the name.
_ALLOWED_ROOT_FILES = {"bundle.json", "tour.json", "config.json"}


# Extensions a file under media/ may carry: the ones uploads are stored under,
# plus the common spelling of JPEG. The sniff alone is not enough, because a
# static server types by extension, and valid JPEG bytes named `.html` are
# served as text/html.
MEDIA_EXTENSIONS = set(ALLOWED_TYPES.values()) | {".jpeg"}


def _check_media_file(path: Path, rel: Path) -> None:
    """Hold an imported media file to the upload path's definition of media.

    `media_store` is the one place that decides what media is; import used to
    wave all of `media/` through, which left `media/evil.html` servable as
    text/html from the editor's own origin and, via publish, the author's
    public one. Sixteen bytes is enough for every signature `_sniff_type`
    knows.
    """
    with open(path, "rb") as fh:
        head = fh.read(16)
    if _sniff_type(head) is None or path.suffix.lower() not in MEDIA_EXTENSIONS:
        raise BundleError(
            f"bundle contains a file that is not an allowed image or audio "
            f"type: {rel.as_posix()}"
        )


def _check_allowed_contents(root: Path) -> None:
    for path in sorted(root.rglob("*")):
        if not path.is_file():
            continue
        rel = path.relative_to(root)
        if rel.parts[0] == "media":
            _check_media_file(path, rel)
            continue
        if len(rel.parts) == 1 and rel.parts[0] in _ALLOWED_ROOT_FILES:
            continue
        raise BundleError(f"bundle contains an unexpected file: {rel.as_posix()}")


def _check_bundle_version(root: Path) -> None:
    """Refuse a bundle whose container format is newer than this build
    understands. `bundleVersion` is independent of `schemaVersion` — see the
    module docstring — so this is a separate check from the `tour.json`
    migration below.

    A bundle with no `bundle.json` at all still imports: it predates this
    file existing in exports at all (every export made before the container format was versioned),
    and refusing it would be a regression, not a safety improvement.
    """
    bundle_json = root / "bundle.json"
    if not bundle_json.is_file():
        return
    try:
        meta = json.loads(bundle_json.read_text())
    except json.JSONDecodeError as exc:
        raise BundleError(f"bundle.json is not valid JSON: {exc}") from exc
    version = meta.get("bundleVersion")
    if isinstance(version, int) and version > BUNDLE_VERSION:
        raise BundleError(
            f"this bundle needs bundleVersion {version}, but this build "
            f"only understands up to {BUNDLE_VERSION}"
        )


def _media_sets(tour: Tour, media_dir: Path) -> tuple[set[str], set[str]]:
    """`(present, referenced)` media names, as POSIX paths relative to
    `media/`. Walked recursively — not just the immediate children — so a
    nested layout like `media/pano/pano-historic-courthouse.jpg` (the
    spec's own example) is visible to both the referenced-media check below
    and `missing_media`, rather than only the top-level entry `pano` ever
    being seen."""
    present = (
        {p.relative_to(media_dir).as_posix() for p in media_dir.rglob("*") if p.is_file()}
        if media_dir.is_dir()
        else set()
    )
    referenced = {
        ov.media_id for stop in tour.stops for ov in stop.overlays if ov.media_id
    }
    return present, referenced


def missing_media(root: Path) -> list[str]:
    """Names the open tour's document references under `media/` that are not
    actually there. Shared by import's `_validate_tree` below and the export
    route in `main.py`: without this, only import enforced "every referenced
    mediaId exists", so a broken save could sit in the working directory
    indefinitely and the author would only learn of it when they tried to
    reopen the bundle they had just exported.
    """
    root = Path(root)
    raw = json.loads((root / "tour.json").read_text())
    tour = Tour.model_validate(migrate_v1_to_v2(raw))
    present, referenced = _media_sets(tour, root / "media")
    return sorted(referenced - present)


def _validate_tree(root: Path) -> list[str]:
    _check_allowed_contents(root)
    _check_bundle_version(root)

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

    present, referenced = _media_sets(tour, root / "media")

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
