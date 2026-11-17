"""The open tour: an unpacked working directory, not a zip held in memory.

The editor needs somewhere to put an uploaded photograph before the tour is
saved anywhere, so the working directory IS the open document and every edit
writes through to it immediately. The zip is only its portable form.
"""

from __future__ import annotations

import json
import os
import re
import shutil
import tempfile
from pathlib import Path

from pydantic import ValidationError

from .bundle import (
    BUNDLE_VERSION,
    DEFAULT_MAX_BUNDLE_BYTES,
    DEFAULT_MAX_ENTRIES,
    read_bundle,
)
from .media_store import orphan_ids
from .migration import migrate
from .models import SCHEMA_VERSION, Tour


class SessionConflict(Exception):
    """A destructive operation was attempted without replacing what is
    already open. The message is shown to the author."""


def _atomic_write_text(path: Path, text: str) -> None:
    """Write `text` to `path` so a crash mid-write can never leave `path`
    truncated or otherwise corrupted.

    `Path.write_text` truncates the file in place: a process death between
    the truncation and the write completing leaves an unparseable file
    behind. Writing to a sibling temp file and swapping it in with
    `os.replace` avoids that window, because the replace is a single atomic
    rename — but only because the temp file is a SIBLING (same directory,
    same filesystem) of `path` rather than one in `$TMPDIR`, which may be a
    different filesystem where no such atomicity guarantee holds.

    This covers crash-during-write. It does not, and cannot, guarantee the
    CONTENT being written is valid — callers that care about that (see
    `Session.write_tour`) must validate before calling this.
    """
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp_name = tempfile.mkstemp(
        prefix=f".{path.name}.", suffix=".tmp", dir=path.parent
    )
    tmp_path = Path(tmp_name)
    try:
        with os.fdopen(fd, "w") as f:
            f.write(text)
        os.replace(tmp_path, path)
    except Exception:
        tmp_path.unlink(missing_ok=True)
        raise


def skeleton(title: str) -> dict:
    """The smallest document that validates, so a new tour opens in the editor
    rather than in an error state. The panorama is a placeholder the author
    replaces; `Stop` requires one and there is nothing honest to put there yet.
    """
    slug = re.sub(r"[^a-z0-9]+", "-", title.lower().replace("'", "")).strip("-") or "untitled"
    return {
        "id": slug,
        "schemaVersion": SCHEMA_VERSION,
        "title": title,
        "description": "",
        "attribution": [],
        "stops": [{
            "id": "stop-1",
            "order": 1,
            "title": "First stop",
            "summary": "Describe this place.",
            "location": {"lng": 0.0, "lat": 0.0},
            "osmRef": None,
            "panorama": {"provider": "mapillary", "imageId": "0",
                         "bearing": 0.0, "cachedMediaId": None},
            "overlays": [],
        }],
    }


class Session:
    """One open document, rooted at a working directory."""

    def __init__(self, path: Path) -> None:
        self.path = Path(path)

    @property
    def is_open(self) -> bool:
        return (self.path / "tour.json").is_file()

    def tour(self) -> Tour:
        """Read the open document, migrating it and HEALING THE FILE.

        Migrating in memory was not enough, and production proved it. Session
        directories outlive deploys on purpose — they sit outside the deploy
        tree so `rsync` cannot reach them — so after a schema bump the host
        holds documents at the previous version. Every backend read coped,
        because this method migrates; but the file stayed old, and
        `/tour-data/tour.json` hands that file over verbatim, because a
        published site has to receive the same bytes and so the route cannot
        parse or rewrite anything. The editor therefore loaded the old
        version, autosaved it back, and `write_tour` refused it — correctly,
        since a `PUT` must never migrate or a stale tab could overwrite a
        newer document with an older shape. The author met that as a bare
        pydantic `literal_error` in production, and restarting the backend
        could not clear it.

        So a read that had to migrate writes the result back. Validation
        comes first, exactly as in `write_tour`, so a document that cannot be
        migrated is never persisted; the write is atomic for the same reason
        every other write here is; and it fires only when the version
        actually moved, so an ordinary read does not rewrite the file or
        churn its mtime on every page load.

        This makes `tour()` the second writer of `tour.json`, where
        `write_tour` used to be the only one in the app — `ARCHITECTURE.md`
        says so and has been corrected. A failed heal is deliberately not
        swallowed: the only way it fails is a session directory this process
        cannot write, and in that state autosave cannot work either, so a
        loud failure beats a confusing 422 later.
        """
        raw = json.loads((self.path / "tour.json").read_text())
        migrated = migrate(raw)
        tour = Tour.model_validate(migrated)
        if migrated.get("schemaVersion") != raw.get("schemaVersion"):
            _atomic_write_text(
                self.path / "tour.json", json.dumps(migrated, indent=2) + "\n"
            )
        return tour

    def new(self, title: str, *, force: bool = False) -> Tour:
        """Start a brand-new skeleton tour, discarding whatever is open now.

        `_swap_in` (via `replace_from`) stages, validates and swaps through
        two renames specifically so an import can never lose what was open.
        This method used to undo all of that by calling `shutil.rmtree`
        unconditionally — unreachable from the route guard that makes export
        safe. Refusing when a tour is already open, unless the caller
        explicitly passes `force`, means the one remaining way to lose an
        open document requires saying so on purpose.
        """
        if self.is_open and not force:
            raise SessionConflict(
                "a tour is already open; export it first, or pass force "
                "to discard it"
            )
        doc = skeleton(title)
        self._discard()
        (self.path / "media").mkdir(parents=True)
        self._write_bundle_json(doc["id"])
        return self.write_tour(doc)

    def close(self) -> None:
        """Stop working on the open tour, discarding the working directory.

        Like `new`, this is the one place an open document can be thrown
        away on purpose, so it shares `_discard` rather than growing a
        second way to delete. Closing when nothing is open is a conflict,
        not a no-op: the caller's idea of the session is out of date, and
        saying so beats silently agreeing with it.
        """
        if not self.is_open:
            raise SessionConflict("nothing is open")
        self._discard()

    def _discard(self) -> None:
        """Remove the working directory if there is one; the only remover."""
        if self.path.exists():
            shutil.rmtree(self.path)

    def write_tour(self, doc: dict) -> Tour:
        """Validate, then persist atomically.

        Validation first means an invalid document is never written at
        all — tour.json on disk is always SCHEMA-valid. Writing through
        `_atomic_write_text` additionally means tour.json on disk always
        PARSES, because a crash mid-write lands on the old file or the new
        one, never a half-written mix of both; a plain `write_text` could
        not make that second promise, since it truncates in place.
        """
        try:
            tour = Tour.model_validate(doc)
        except ValidationError as exc:
            raise ValueError(str(exc)) from exc
        self.path.mkdir(parents=True, exist_ok=True)
        _atomic_write_text(self.path / "tour.json", json.dumps(doc, indent=2) + "\n")
        return tour

    def replace_from(
        self,
        zip_path: Path,
        *,
        max_bytes: int = DEFAULT_MAX_BUNDLE_BYTES,
        max_entries: int = DEFAULT_MAX_ENTRIES,
    ) -> list[str]:
        """Import a bundle. read_bundle validates into staging and only then
        swaps, so a failure here leaves the open document exactly as it was."""
        return read_bundle(
            zip_path, self.path, max_bytes=max_bytes, max_entries=max_entries
        )

    def write_config(self, cfg: dict) -> None:
        """Persist the viewer's config atomically — see `_atomic_write_text`.
        A half-written config.json breaks the viewer just as thoroughly as a
        half-written tour.json breaks the editor."""
        _atomic_write_text(self.path / "config.json", json.dumps(cfg, indent=2) + "\n")

    def summary(self) -> dict:
        if not self.is_open:
            return {"open": False}
        tour = self.tour()
        media_dir = self.path / "media"
        # Walked recursively and counting files, not directory entries: a
        # non-recursive `iterdir()` counted a nested layout like `media/pano/`
        # as a single entry (the directory itself), which both undercounts
        # and disagrees with `bundle.py`'s own (now also recursive)
        # referenced-media check.
        count = (
            sum(1 for p in media_dir.rglob("*") if p.is_file())
            if media_dir.is_dir()
            else 0
        )
        return {
            "open": True,
            "tourId": tour.id,
            "title": tour.title,
            "stopCount": len(tour.stops),
            "mediaCount": count,
            "orphanCount": len(orphan_ids(self.path, tour)),
        }

    def _write_bundle_json(self, tour_id: str) -> None:
        _atomic_write_text(
            self.path / "bundle.json",
            json.dumps({"bundleVersion": BUNDLE_VERSION, "tourId": tour_id}, indent=2)
            + "\n",
        )
