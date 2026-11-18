"""Build a static site from the open tour.

The output is the built Angular application with the working directory
alongside it under `tour-data/` — the same relative paths the editor serves,
so the viewer code is identical in both. Unzip it onto any static host.

The `tour-data/` prefix is not cosmetic: Angular's build already emits a
`media/` directory for Leaflet's bundled marker images. If tour media were
published to `media/` at the root, the two would collide and overwrite each
other. Keeping tour media under `tour-data/media/` keeps them apart.
"""

from __future__ import annotations

import re
import zipfile
from pathlib import Path

_HTML_TAG = re.compile(r"<html\b([^>]*)>", re.IGNORECASE)


def mark_published(html: str) -> str:
    """Add the valueless `data-published` attribute to the first `<html>` tag.

    A published page reads this to know it is published and never probes
    `/api`. Inserted after whatever attributes the tag already carries; a no-op
    if the tag already has the mark or there is no `<html` tag at all.
    """
    match = _HTML_TAG.search(html)
    if match is None or re.search(r"(?<![\w-])data-published\b", match.group(1)):
        return html
    at = match.end(1)
    return html[:at] + " data-published" + html[at:]


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

    out_zip.parent.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(out_zip, "w", zipfile.ZIP_DEFLATED) as zf:
        # Dotfiles are skipped in both trees: in the session directory they
        # are the half-written `.<name>.*.tmp` files of session.py's atomic
        # replace, which must never ship; in dist they are build-tool litter.
        for path in sorted(dist.rglob("*")):
            if path.is_file() and not path.name.startswith("."):
                arc = path.relative_to(dist).as_posix()
                if arc == "index.html":
                    # Marked in the zip only; the file on disk serves the
                    # authoring host and must stay unmarked.
                    text = path.read_text(encoding="utf-8")
                    zf.writestr(arc, mark_published(text))
                else:
                    zf.write(path, arc)
        for path in sorted(session_path.rglob("*")):
            if path.is_file() and not path.name.startswith("."):
                arc = Path("tour-data") / path.relative_to(session_path)
                zf.write(path, arc.as_posix())
