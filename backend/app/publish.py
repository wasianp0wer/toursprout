"""Build a static site from the open tour.

The output is the built Angular application with the working directory
alongside it under `tour-data/` — the same relative paths the editor serves,
so the viewer code is identical in both. Unzip it onto any static host.

The `tour-data/` prefix is not cosmetic: Angular's build already emits a
`media/` directory for Leaflet's bundled marker images. If tour media were
published to `media/` at the root, the two would collide and overwrite each
other. Keeping tour media under `tour-data/media/` keeps them apart.

Publishing reads one field of the document: the tour's `icon`, which is
written into the zip's `index.html` as the page's icon link.
"""

from __future__ import annotations

import html as htmllib
import json
import re
import stat
import time
import zipfile
from pathlib import Path

from pydantic import ValidationError

from .migration import migrate
from .models import Tour

_HTML_TAG = re.compile(r"<html\b([^>]*)>", re.IGNORECASE)
_ICON_LINK = re.compile(r"""<link\b[^>]*\brel=["']icon["'][^>]*>""", re.IGNORECASE)


def mark_published(html: str) -> str:
    """Add the valueless `data-published` attribute to the first `<html>` tag.

    A published page reads this to know it is published and never probes
    `/api`. Inserted after whatever attributes the tag already carries; a no-op
    if the tag already has the mark or there is no `<html` tag at all.

    Not hardened against a literal `>` inside an attribute value or a
    self-closing `<html/>`: both are unreachable for a file this project
    builds itself, so do not "fix" them.
    """
    match = _HTML_TAG.search(html)
    if match is None or re.search(r"(?<![\w-])data-published\b", match.group(1)):
        return html
    at = match.end(1)
    return html[:at] + " data-published" + html[at:]


def set_icon(html: str, media_id: str) -> str:
    """Replace the first `<link rel="icon">` with one naming the tour's icon.

    The icon is served from `tour-data/media/`, where the session's media
    ships. A no-op if the page has no such link. The id is escaped into the
    attribute.

    Not hardened against a literal `>` inside an attribute value: unreachable
    for a file this project builds itself, so do not "fix" it.
    """
    href = htmllib.escape(f"tour-data/media/{media_id}", quote=True)
    link = f'<link rel="icon" type="image/png" href="{href}">'
    return _ICON_LINK.sub(lambda _: link, html, count=1)


def _add(zf: zipfile.ZipFile, path: Path, arc: str, data: bytes) -> None:
    """Write `data` as `arc`, mtime from `path`, mode always 0o644.

    The session directory is private (0o600) by design, but a published zip is
    public web content, so the source's mode is deliberately not copied.
    """
    info = zipfile.ZipInfo(arc, time.localtime(max(path.stat().st_mtime, 315532800))[:6])
    info.compress_type = zipfile.ZIP_DEFLATED
    info.external_attr = (0o644 | stat.S_IFREG) << 16
    zf.writestr(info, data)


class PublishError(Exception):
    """Publishing could not proceed. The message is shown to the author."""


def build_site(session_path: Path, dist: Path, out_zip: Path) -> None:
    session_path, dist = Path(session_path), Path(dist)

    if not (session_path / "tour.json").is_file():
        raise PublishError("no tour is open, so there is nothing to publish")
    if not (dist / "index.html").is_file():
        raise PublishError(
            f"no built application at {dist}: run `make build` first"
        )

    try:
        icon = Tour.model_validate(
            migrate(json.loads((session_path / "tour.json").read_text("utf-8")))
        ).icon
    except (ValueError, ValidationError) as exc:
        raise PublishError(f"the open tour could not be read: {exc}") from exc

    out_zip.parent.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(out_zip, "w", zipfile.ZIP_DEFLATED) as zf:
        # Dotfiles are skipped in both trees: in the session directory they
        # are the half-written `.<name>.*.tmp` files of session.py's atomic
        # replace, which must never ship; in dist they are build-tool litter.
        for path in sorted(dist.rglob("*")):
            if path.is_file() and not path.name.startswith("."):
                arc = path.relative_to(dist).as_posix()
                data = path.read_bytes()
                if arc == "index.html":
                    # Marked in the zip only; the file on disk serves the
                    # authoring host and must stay unmarked.
                    data = mark_published(data.decode("utf-8")).encode("utf-8")
                    if icon:
                        data = set_icon(data.decode("utf-8"), icon).encode("utf-8")
                _add(zf, path, arc, data)
        for path in sorted(session_path.rglob("*")):
            if path.is_file() and not path.name.startswith("."):
                arc = Path("tour-data") / path.relative_to(session_path)
                _add(zf, path, arc.as_posix(), path.read_bytes())
