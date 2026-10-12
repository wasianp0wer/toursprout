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

import zipfile
from pathlib import Path


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
        for path in sorted(dist.rglob("*")):
            if path.is_file() and not path.name.startswith("."):
                zf.write(path, path.relative_to(dist).as_posix())
        for path in sorted(session_path.rglob("*")):
            if path.is_file() and not path.name.startswith("."):
                arc = Path("tour-data") / path.relative_to(session_path)
                zf.write(path, arc.as_posix())
