"""Every byte that enters a working directory comes through here.

This is the application's second untrusted input, after bundle import, and
unlike import it is a file write driven by a name the client chose. So the
client does not get to choose the name: the stored id is derived from the
content and a slug of the original stem, and the extension comes from
sniffing the bytes rather than from what the upload claimed.

That one decision removes path traversal, overwrite-by-guessing, and
extension smuggling together — a published site serves `tour-data/` from the
author's own origin, so an `.html` that got through here would be served from
it.
"""

from __future__ import annotations

import hashlib
import os
import re
import tempfile
import threading
from pathlib import Path

from .models import Tour

# Sniffed type -> the one extension it is stored under.
ALLOWED_TYPES: dict[str, str] = {
    "image/jpeg": ".jpg",
    "image/png": ".png",
    "image/webp": ".webp",
    "audio/wav": ".wav",
    "audio/mp4": ".m4a",
    "audio/mpeg": ".mp3",
    "audio/ogg": ".ogg",
    "audio/webm": ".webm",
}

# Plain-prefix formats. `imghdr` was removed in Python 3.13, and a short
# explicit table is clearer than a dependency anyway. RIFF and ISO-BMFF are
# containers and are handled separately in `_sniff_type`.
_MAGIC: list[tuple[bytes, str]] = [
    (b"\xff\xd8\xff", "image/jpeg"),
    (b"\x89PNG\r\n\x1a\n", "image/png"),
    (b"ID3", "audio/mpeg"),
    (b"OggS", "audio/ogg"),
    (b"\x1a\x45\xdf\xa3", "audio/webm"),
]

MAX_FILE_BYTES = 64 * 1024 * 1024
MAX_TOTAL_BYTES = 1024 * 1024 * 1024

# Hex characters of the content hash in an id. Normally the first; the longer
# ones exist only so that a (practically impossible) collision between two
# different files escalates instead of overwriting.
_HASH_CHARS = (10, 20, 64)

# Uploads run in worker threads; the total-size check and the write must not
# interleave or two uploads could each pass the check and together exceed it.
# The upload route is a plain `def` and so runs in the threadpool, where
# requests really do overlap: do not remove this as dead weight.
_LOCK = threading.Lock()


class MediaError(Exception):
    """An upload was refused. The message is shown to the author."""


def _sniff_type(data: bytes) -> str | None:
    # RIFF is a container: WebP and WAV share the first four bytes and differ
    # at 8..12. Anything else RIFF (AVI...) is refused.
    if data[:4] == b"RIFF":
        form = data[8:12]
        if form == b"WEBP":
            return "image/webp"
        if form == b"WAVE":
            return "audio/wav"
        return None
    # ISO-BMFF: `ftyp` at 4..8, the brand at 8..12. HEIC, QuickTime and the
    # rest are the same container and are not allowed.
    if data[4:8] == b"ftyp":
        brand = data[8:12]
        if brand[:3] in (b"M4A", b"M4B", b"mp4", b"iso"):
            return "audio/mp4"
        return None
    # (After the table, so JPEG's FF D8 FF wins.) MP3 with no ID3 tag starts
    # at a frame sync: 0xFF then 0b111xxxxx.
    for prefix, kind in _MAGIC:
        if data.startswith(prefix):
            return kind
    if len(data) >= 2 and data[0] == 0xFF and data[1] & 0xE0 == 0xE0:
        return "audio/mpeg"
    return None


def sniff(data: bytes) -> tuple[str, str]:
    """Return (type, extension) from the bytes, or raise."""
    kind = _sniff_type(data)
    if kind is None:
        raise MediaError(
            "that file is not an allowed image or audio type "
            "(JPEG, PNG, WebP, MP4/M4A, MP3, WAV, WebM or Ogg)"
        )
    return kind, ALLOWED_TYPES[kind]


def _slug(name: str) -> str:
    """A readable stem, from the name only. The result is [a-z0-9-] and
    nothing else, so it cannot contain a separator or a dot: the id is joined
    to media/ and must not be able to leave it."""
    stem = Path(name.replace("\\", "/")).stem
    slug = re.sub(r"[^a-z0-9]+", "-", stem.lower()).strip("-")
    return slug[:48].strip("-") or "media"


def _media_id(name: str, data: bytes, ext: str, nchars: int) -> str:
    digest = hashlib.sha256(data).hexdigest()[:nchars]
    return f"{_slug(name)}-{digest}{ext}"


def _total_bytes(media_dir: Path) -> int:
    return sum(p.stat().st_size for p in media_dir.rglob("*") if p.is_file())


def store_media(work: Path, data: bytes, original_name: str) -> str:
    """Store `data` under a server-chosen id and return it."""
    if len(data) > MAX_FILE_BYTES:
        raise MediaError(
            f"that file is {len(data)} bytes; the limit is {MAX_FILE_BYTES}"
        )
    _kind, ext = sniff(data)

    media_dir = work / "media"
    media_dir.mkdir(parents=True, exist_ok=True)

    with _LOCK:
        full = hashlib.sha256(data).hexdigest()
        # Same content, same stored file: an author re-uploads the same
        # photograph constantly, and writing it twice would be a lie about
        # two media. Compare bytes rather than trusting the name.
        for nchars in _HASH_CHARS:
            for existing in media_dir.glob(f"*-{full[:nchars]}{ext}"):
                if existing.is_file() and existing.read_bytes() == data:
                    return existing.name

        if _total_bytes(media_dir) + len(data) > MAX_TOTAL_BYTES:
            raise MediaError(
                "this tour's media would exceed "
                f"{MAX_TOTAL_BYTES} bytes; remove something first"
            )

        # Never overwrite a different file that already holds this id.
        for nchars in _HASH_CHARS:
            media_id = _media_id(original_name, data, ext, nchars)
            if not (media_dir / media_id).exists():
                break
        else:  # pragma: no cover - a full SHA-256 collision
            raise MediaError("could not choose a unique name for that file")

        _write_atomic(media_dir / media_id, data)
        return media_id


def _write_atomic(path: Path, data: bytes) -> None:
    """Sibling temp file plus os.replace, so a reader (or a publish copying
    the directory) never sees a half-written media file. The temp name is a
    dotfile, which bundle export skips."""
    fd, tmp_name = tempfile.mkstemp(dir=path.parent, prefix=".upload-")
    try:
        with os.fdopen(fd, "wb") as tmp:
            tmp.write(data)
        os.replace(tmp_name, path)
    except BaseException:
        Path(tmp_name).unlink(missing_ok=True)
        raise


def orphan_ids(work: Path, tour: Tour) -> list[str]:
    """Media no overlay references. A warning, never a deletion: an author
    mid-edit routinely has media not yet placed."""
    media_dir = work / "media"
    if not media_dir.is_dir():
        return []
    present = {
        p.relative_to(media_dir).as_posix()
        for p in media_dir.rglob("*")
        if p.is_file() and not p.name.startswith(".")
    }
    referenced = {o.media_id for s in tour.stops for o in s.overlays if o.media_id}
    return sorted(present - referenced)
