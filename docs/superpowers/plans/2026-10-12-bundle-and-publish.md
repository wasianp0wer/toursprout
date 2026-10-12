# Bundle and Publish Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make a tour a portable `.zip` document with an unpacked working directory behind it, and give it a static-site export that runs with no backend.

**Architecture:** An open tour is a working directory (`bundle.json` + `tour.json` + `media/`). FastAPI serves it at `tour-data/`, and a published site is the same three paths as plain files next to `index.html` — so the viewer has exactly one set of URLs and no deployment detection. Import is the application's only untrusted input and is treated as a security boundary.

**Tech Stack:** Python 3.14, pydantic v2, FastAPI, Starlette `StaticFiles`, `zipfile`, pytest. Angular 22 (signals, standalone), TypeScript, Vitest.

**Spec:** `docs/superpowers/specs/2026-10-12-bundle-and-publish-design.md`
**Umbrella:** `docs/superpowers/specs/2026-10-12-authoring-application-overview.md`
**Prior sub-project:** `docs/superpowers/specs/2026-10-12-schema-v2-design.md`

## Global Constraints

- All commands run through `make`, which pins Node 24 at `/Users/maddiepersonal/.local/share/fnm/node-versions/v24.21.0/installation/bin`. **Never call `npx`/`ng` directly** — ambient `node` is v25 and Angular 22 rejects it.
- `UV_CACHE_DIR` must stay inside the repo (`$(CURDIR)/.uv-cache`). The Makefile sets it.
- Angular's build cache must stay disabled, or `ng build` SIGABRTs with no output.
- **No browser can launch in this sandbox.** Never attempt Playwright or `make e2e`. jsdom (Vitest) carries all frontend verification.
- **Never use `urllib`** — it truncates through the egress proxy about one time in ten. `httpx` everywhere. This task needs no network at all.
- Use `$TMPDIR`, never `/tmp`, for scratch files.
- Baseline to preserve: **162 pytest, 210 Vitest**, lint clean, bundle 2.04 MB raw / 348.29 kB transferred.
- JSON is camelCase on the wire, snake_case in Python. `Strict` models are `extra="forbid"` + `populate_by_name=True`.
- The published tour-data prefix is `tour-data/`, never `media/` — Angular's build already emits `media/` for Leaflet's marker images and they would collide.
- Let git use its own config. Do **not** pass `-c user.email=...`.
- Commit messages end with `Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>`.

## Review Focus

Input classes the spec implies that no happy-path test exercises. Each is assigned to the task that owns the code.

1. **A zip entry that escapes the extraction root** — `../../etc/passwd`, an absolute path, or a symlink pointing outside. Must abort the entire import before writing anything. → Task 1.
2. **A zip bomb** — few entries, enormous uncompressed size, or tens of thousands of entries. Must fail on the declared size before extraction, not after filling the disk. → Task 1.
3. **An import that fails halfway.** The previously open document must be exactly as it was — not half-replaced, not empty. → Task 1.
4. **A document whose `mediaId` has no file**, and the reverse: media in the bundle no overlay references. The first is an error, the second a warning that must not delete anything. → Task 1.
5. **Publish before `make build`.** No `frontend/dist`, so the site would be a tour-data directory with no application. Must fail with a message naming the fix, not emit a broken zip. → Task 3.

---

### Task 1: The bundle format and the working directory

Pure library code, no HTTP. This is where the security boundary lives, so it
is built and tested before anything exposes it.

**Files:**
- Create: `backend/app/bundle.py`
- Create: `backend/app/session.py`
- Create: `backend/tests/test_bundle.py`
- Create: `backend/tests/test_session.py`
- Modify: `backend/app/config.py` (add `work_dir`)

**Interfaces:**
- Consumes: `app.models.Tour`, `app.migration.migrate_v1_to_v2`.
- Produces:
  - `app.bundle.BUNDLE_VERSION: int = 1`
  - `app.bundle.BundleError(Exception)`
  - `app.bundle.read_bundle(zip_path: Path, dest: Path) -> list[str]` — safely extracts and validates; returns warnings; raises `BundleError` on anything wrong
  - `app.bundle.write_bundle(work: Path, zip_path: Path) -> None`
  - `app.session.Session` with `.path`, `.is_open`, `.tour() -> Tour`, `.write_tour(doc: dict) -> Tour`, `.new(title: str)`, `.replace_from(staged: Path)`, `.summary() -> dict`, `.write_config(cfg) -> None`

- [ ] **Step 1: Write the failing bundle tests**

Create `backend/tests/test_bundle.py`:

```python
from __future__ import annotations

import json
import zipfile
from pathlib import Path

import pytest

from app.bundle import BUNDLE_VERSION, BundleError, read_bundle, write_bundle
from app.models import Tour

REPO = Path(__file__).resolve().parents[2]
V1_FIXTURE = Path(__file__).parent / "fixtures" / "fairfax-old-town-v1.json"
SHIPPED = REPO / "content" / "tours" / "fairfax-old-town.json"


def _make_work(tmp_path: Path, doc: dict, media: dict[str, bytes]) -> Path:
    work = tmp_path / "work"
    (work / "media").mkdir(parents=True)
    work.joinpath("tour.json").write_text(json.dumps(doc))
    work.joinpath("bundle.json").write_text(
        json.dumps({"bundleVersion": BUNDLE_VERSION, "tourId": doc["id"]})
    )
    for name, data in media.items():
        work.joinpath("media", name).write_bytes(data)
    return work


def _minimal_doc(media_id="m.jpg"):
    return {
        "id": "t", "schemaVersion": 2, "title": "T", "description": "d",
        "attribution": [], "stops": [{
            "id": "s1", "order": 1, "title": "S", "summary": "sum",
            "location": {"lng": -77.3, "lat": 38.84}, "osmRef": None,
            "panorama": {"provider": "mapillary", "imageId": "1",
                         "bearing": 90.0, "cachedPath": None},
            "overlays": [{
                "id": "o1", "kind": "image",
                "anchor": {"type": "geo", "lng": -77.3, "lat": 38.84, "altitudeM": 2.0},
                "display": {"mode": "marker", "icon": "photo"},
                "title": "Photo", "body": None, "mediaId": media_id,
                "credit": {"type": "original", "creator": "M", "license": "CC-BY-4.0"},
            }],
        }],
    }


def test_round_trip_preserves_the_document_and_media(tmp_path):
    work = _make_work(tmp_path, _minimal_doc(), {"m.jpg": b"\xff\xd8bytes"})
    zip_path = tmp_path / "out.zip"
    write_bundle(work, zip_path)

    dest = tmp_path / "back"
    read_bundle(zip_path, dest)

    assert json.loads((dest / "tour.json").read_text()) == _minimal_doc()
    assert (dest / "media" / "m.jpg").read_bytes() == b"\xff\xd8bytes"


def test_the_shipped_tour_round_trips_byte_identically(tmp_path):
    doc = json.loads(SHIPPED.read_text())
    media = {}
    for stop in doc["stops"]:
        for ov in stop["overlays"]:
            if ov.get("mediaId"):
                media[ov["mediaId"]] = b"x" * 16
    work = _make_work(tmp_path, doc, media)
    zip_path = tmp_path / "shipped.zip"
    write_bundle(work, zip_path)
    dest = tmp_path / "back"
    read_bundle(zip_path, dest)
    assert json.loads((dest / "tour.json").read_text()) == doc
    assert sorted(p.name for p in (dest / "media").iterdir()) == sorted(media)


def test_a_v1_bundle_is_migrated_on_import(tmp_path):
    v1 = json.loads(V1_FIXTURE.read_text())
    media = {}
    for stop in v1["stops"]:
        for ov in stop["overlays"]:
            if ov.get("mediaId"):
                media[ov["mediaId"]] = b"x"
    work = _make_work(tmp_path, v1, media)
    zip_path = tmp_path / "v1.zip"
    write_bundle(work, zip_path)

    dest = tmp_path / "back"
    read_bundle(zip_path, dest)

    migrated = json.loads((dest / "tour.json").read_text())
    assert migrated["schemaVersion"] == 2
    Tour.model_validate(migrated)


@pytest.mark.parametrize("entry", [
    "../escape.txt",
    "../../etc/passwd",
    "media/../../escape.txt",
    "/absolute.txt",
])
def test_path_traversal_entries_are_refused(tmp_path, entry):
    zip_path = tmp_path / "evil.zip"
    with zipfile.ZipFile(zip_path, "w") as zf:
        zf.writestr("bundle.json", json.dumps({"bundleVersion": 1, "tourId": "t"}))
        zf.writestr("tour.json", json.dumps(_minimal_doc()))
        zf.writestr(entry, "pwned")
    with pytest.raises(BundleError, match="unsafe"):
        read_bundle(zip_path, tmp_path / "dest")
    assert not (tmp_path / "escape.txt").exists()


def test_a_symlink_entry_is_refused(tmp_path):
    zip_path = tmp_path / "link.zip"
    with zipfile.ZipFile(zip_path, "w") as zf:
        zf.writestr("bundle.json", json.dumps({"bundleVersion": 1, "tourId": "t"}))
        zf.writestr("tour.json", json.dumps(_minimal_doc()))
        info = zipfile.ZipInfo("media/m.jpg")
        # 0xA000 is S_IFLNK in the high 16 bits of external_attr.
        info.external_attr = (0xA1FF) << 16
        zf.writestr(info, "/etc/passwd")
    with pytest.raises(BundleError, match="unsafe"):
        read_bundle(zip_path, tmp_path / "dest")


def test_an_oversized_archive_is_refused_before_extraction(tmp_path):
    zip_path = tmp_path / "bomb.zip"
    with zipfile.ZipFile(zip_path, "w", zipfile.ZIP_DEFLATED) as zf:
        zf.writestr("bundle.json", json.dumps({"bundleVersion": 1, "tourId": "t"}))
        zf.writestr("tour.json", json.dumps(_minimal_doc()))
        zf.writestr("media/big.bin", b"\0" * (600 * 1024 * 1024))
    with pytest.raises(BundleError, match="too large"):
        read_bundle(zip_path, tmp_path / "dest")


def test_too_many_entries_is_refused(tmp_path):
    zip_path = tmp_path / "many.zip"
    with zipfile.ZipFile(zip_path, "w") as zf:
        zf.writestr("bundle.json", json.dumps({"bundleVersion": 1, "tourId": "t"}))
        zf.writestr("tour.json", json.dumps(_minimal_doc()))
        for i in range(5001):
            zf.writestr(f"media/f{i}.bin", b"x")
    with pytest.raises(BundleError, match="too many"):
        read_bundle(zip_path, tmp_path / "dest")


def test_a_missing_referenced_media_file_is_an_error(tmp_path):
    work = _make_work(tmp_path, _minimal_doc(media_id="gone.jpg"), {})
    zip_path = tmp_path / "missing.zip"
    write_bundle(work, zip_path)
    with pytest.raises(BundleError, match="gone.jpg"):
        read_bundle(zip_path, tmp_path / "dest")


def test_orphaned_media_is_warned_about_not_deleted(tmp_path):
    work = _make_work(tmp_path, _minimal_doc(),
                      {"m.jpg": b"a", "unused.jpg": b"b"})
    zip_path = tmp_path / "orphan.zip"
    write_bundle(work, zip_path)
    dest = tmp_path / "dest"
    warnings = read_bundle(zip_path, dest)
    assert any("unused.jpg" in w for w in warnings)
    assert (dest / "media" / "unused.jpg").exists()


def test_an_invalid_document_is_refused(tmp_path):
    bad = _minimal_doc()
    bad["stops"][0]["overlays"][0]["display"] = {"mode": "ambient", "autoplay": True}
    work = _make_work(tmp_path, bad, {"m.jpg": b"a"})
    zip_path = tmp_path / "bad.zip"
    write_bundle(work, zip_path)
    with pytest.raises(BundleError):
        read_bundle(zip_path, tmp_path / "dest")


def test_a_zip_without_a_tour_is_refused(tmp_path):
    zip_path = tmp_path / "empty.zip"
    with zipfile.ZipFile(zip_path, "w") as zf:
        zf.writestr("readme.txt", "nope")
    with pytest.raises(BundleError, match="tour.json"):
        read_bundle(zip_path, tmp_path / "dest")
```

- [ ] **Step 2: Run them and watch them fail**

Run: `cd backend && uv run pytest tests/test_bundle.py -q`
Expected: collection error, `ModuleNotFoundError: No module named 'app.bundle'`.

- [ ] **Step 3: Implement the bundle module**

Create `backend/app/bundle.py`:

```python
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
```

- [ ] **Step 4: Run the bundle tests**

Run: `cd backend && uv run pytest tests/test_bundle.py -q`
Expected: PASS, 12 tests.

- [ ] **Step 5: Write the failing session tests**

Create `backend/tests/test_session.py`:

```python
from __future__ import annotations

import json
from pathlib import Path

import pytest

from app.bundle import BundleError, write_bundle
from app.models import Tour
from app.session import Session


@pytest.fixture
def session(tmp_path):
    return Session(tmp_path / "work")


def test_a_fresh_session_is_not_open(session):
    assert session.is_open is False
    assert session.summary() == {"open": False}


def test_new_creates_a_valid_one_stop_skeleton(session):
    session.new("My Tour")
    assert session.is_open is True
    tour = session.tour()
    assert tour.title == "My Tour"
    assert len(tour.stops) == 1
    assert tour.schema_version == 2
    assert (session.path / "media").is_dir()


def test_summary_reports_the_open_document(session):
    session.new("My Tour")
    summary = session.summary()
    assert summary["open"] is True
    assert summary["title"] == "My Tour"
    assert summary["mediaCount"] == 0


def test_write_tour_validates_and_persists(session):
    session.new("My Tour")
    doc = json.loads((session.path / "tour.json").read_text())
    doc["title"] = "Renamed"
    session.write_tour(doc)
    assert session.tour().title == "Renamed"
    assert json.loads((session.path / "tour.json").read_text())["title"] == "Renamed"


def test_write_tour_rejects_an_invalid_document_and_keeps_the_old_one(session):
    session.new("My Tour")
    bad = json.loads((session.path / "tour.json").read_text())
    bad["stops"] = []
    with pytest.raises(ValueError):
        session.write_tour(bad)
    assert session.tour().title == "My Tour"
    assert len(session.tour().stops) == 1


def test_a_failed_replace_leaves_the_open_document_untouched(session, tmp_path):
    session.new("Original")
    broken = tmp_path / "broken.zip"
    broken.write_bytes(b"not a zip at all")
    with pytest.raises(BundleError):
        session.replace_from(broken)
    assert session.tour().title == "Original"


def test_replace_from_swaps_in_a_valid_bundle(session, tmp_path):
    other = Session(tmp_path / "other")
    other.new("Imported")
    zip_path = tmp_path / "other.zip"
    write_bundle(other.path, zip_path)

    session.new("Original")
    session.replace_from(zip_path)
    assert session.tour().title == "Imported"


def test_write_config_emits_what_the_viewer_needs(session):
    session.new("My Tour")
    session.write_config({"mapillaryToken": "tok", "tileUrl": "u", "attribution": []})
    cfg = json.loads((session.path / "config.json").read_text())
    assert cfg["mapillaryToken"] == "tok"
```

- [ ] **Step 6: Run them and watch them fail**

Run: `cd backend && uv run pytest tests/test_session.py -q`
Expected: `ModuleNotFoundError: No module named 'app.session'`.

- [ ] **Step 7: Implement the session**

Create `backend/app/session.py`:

```python
"""The open tour: an unpacked working directory, not a zip held in memory.

The editor needs somewhere to put an uploaded photograph before the tour is
saved anywhere, so the working directory IS the open document and every edit
writes through to it immediately. The zip is only its portable form.
"""

from __future__ import annotations

import json
import shutil
from pathlib import Path

from pydantic import ValidationError

from .bundle import BUNDLE_VERSION, read_bundle
from .migration import migrate_v1_to_v2
from .models import Tour


def skeleton(title: str) -> dict:
    """The smallest document that validates, so a new tour opens in the editor
    rather than in an error state. The panorama is a placeholder the author
    replaces; `Stop` requires one and there is nothing honest to put there yet.
    """
    slug = "-".join(title.lower().split()) or "untitled"
    return {
        "id": slug,
        "schemaVersion": 2,
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
                         "bearing": 0.0, "cachedPath": None},
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
        raw = json.loads((self.path / "tour.json").read_text())
        return Tour.model_validate(migrate_v1_to_v2(raw))

    def new(self, title: str) -> Tour:
        doc = skeleton(title)
        if self.path.exists():
            shutil.rmtree(self.path)
        (self.path / "media").mkdir(parents=True)
        self._write_bundle_json(doc["id"])
        return self.write_tour(doc)

    def write_tour(self, doc: dict) -> Tour:
        """Validate, then persist. Validation first means tour.json on disk
        always parses — the editor can crash mid-edit without corrupting it."""
        try:
            tour = Tour.model_validate(doc)
        except ValidationError as exc:
            raise ValueError(str(exc)) from exc
        self.path.mkdir(parents=True, exist_ok=True)
        (self.path / "tour.json").write_text(json.dumps(doc, indent=2) + "\n")
        return tour

    def replace_from(self, zip_path: Path) -> list[str]:
        """Import a bundle. read_bundle validates into staging and only then
        swaps, so a failure here leaves the open document exactly as it was."""
        return read_bundle(zip_path, self.path)

    def write_config(self, cfg: dict) -> None:
        (self.path / "config.json").write_text(json.dumps(cfg, indent=2) + "\n")

    def summary(self) -> dict:
        if not self.is_open:
            return {"open": False}
        tour = self.tour()
        media_dir = self.path / "media"
        count = len(list(media_dir.iterdir())) if media_dir.is_dir() else 0
        return {
            "open": True,
            "tourId": tour.id,
            "title": tour.title,
            "stopCount": len(tour.stops),
            "mediaCount": count,
        }

    def _write_bundle_json(self, tour_id: str) -> None:
        (self.path / "bundle.json").write_text(json.dumps(
            {"bundleVersion": BUNDLE_VERSION, "tourId": tour_id}, indent=2) + "\n")
```

Add to `backend/app/config.py`, inside `Settings`:

```python
    @property
    def work_dir(self) -> Path:
        return self.content_dir / "work"
```

- [ ] **Step 8: Run everything**

Run: `make backend-test && make lint`
Expected: green, 162 + 20 or so new tests. The frontend is untouched and still
green, but do not run `make check` yet — nothing has changed for it.

Add `content/work/` to `.gitignore`: it is a scratch directory, and committing
an author's in-progress tour would be wrong.

- [ ] **Step 9: Commit**

```bash
git add backend/app/bundle.py backend/app/session.py backend/app/config.py \
        backend/tests/test_bundle.py backend/tests/test_session.py .gitignore
git commit -m "$(cat <<'EOF'
Add the tour bundle format and the working-directory session

A bundle is a zip of bundle.json, tour.json and media/ — exactly what a
published site serves. An open tour is that archive unpacked into a
working directory, which the editor writes through to on every edit.

Import is the only untrusted input this application has, so read_bundle
refuses path traversal, absolute paths, symlinks, oversized archives and
too many entries before extracting anything, and validates into staging
so a failed import leaves the open document untouched.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 2: The session API and the tour-data mount

Additive only. The old `/api/config`, `/api/tours` and `/api/media` endpoints
stay for now so every commit is green; Task 4 removes them together with the
frontend change that stops using them.

**Files:**
- Modify: `backend/app/main.py`
- Create: `backend/tests/test_session_api.py`

**Interfaces:**
- Consumes: `app.session.Session`, `app.bundle.write_bundle`, `BundleError`.
- Produces: `GET /api/session`, `POST /api/session/new`, `POST /api/session/import`, `PUT /api/session/tour`, `GET /api/session/export`, and `tour-data/*` served from the working directory.

- [ ] **Step 1: Write the failing API tests**

Create `backend/tests/test_session_api.py`:

```python
from __future__ import annotations

import io
import json
import zipfile

import pytest
from fastapi.testclient import TestClient

from app.config import Settings
from app.main import create_app


@pytest.fixture
def client(tmp_path):
    # frontend_dist is pinned at a path that does not exist so these tests
    # never depend on whether `make build` has been run. Task 3's
    # publish-without-a-build test relies on this.
    cfg = Settings(content_dir=tmp_path, database_path=tmp_path / "t.db",
                   frontend_dist=tmp_path / "nodist",
                   mapillary_token="test-token")
    with TestClient(create_app(cfg)) as c:
        yield c


def test_session_starts_closed(client):
    assert client.get("/api/session").json() == {"open": False}


def test_new_opens_a_skeleton(client):
    r = client.post("/api/session/new", json={"title": "My Tour"})
    assert r.status_code == 200
    body = client.get("/api/session").json()
    assert body["open"] is True
    assert body["title"] == "My Tour"


def test_tour_data_serves_the_open_document(client):
    client.post("/api/session/new", json={"title": "My Tour"})
    doc = client.get("/tour-data/tour.json")
    assert doc.status_code == 200
    assert doc.json()["title"] == "My Tour"


def test_tour_data_serves_config_with_the_token(client):
    client.post("/api/session/new", json={"title": "My Tour"})
    cfg = client.get("/tour-data/config.json").json()
    assert cfg["mapillaryToken"] == "test-token"
    assert "tileUrl" in cfg and "attribution" in cfg


def test_put_tour_persists_a_valid_document(client):
    client.post("/api/session/new", json={"title": "My Tour"})
    doc = client.get("/tour-data/tour.json").json()
    doc["title"] = "Renamed"
    assert client.put("/api/session/tour", json=doc).status_code == 200
    assert client.get("/tour-data/tour.json").json()["title"] == "Renamed"


def test_put_tour_rejects_an_invalid_document_with_a_message(client):
    client.post("/api/session/new", json={"title": "My Tour"})
    doc = client.get("/tour-data/tour.json").json()
    doc["stops"] = []
    r = client.put("/api/session/tour", json=doc)
    assert r.status_code == 422
    assert "detail" in r.json()
    assert client.get("/tour-data/tour.json").json()["title"] == "My Tour"


def test_export_then_import_round_trips(client):
    client.post("/api/session/new", json={"title": "Exported"})
    blob = client.get("/api/session/export")
    assert blob.status_code == 200
    assert blob.headers["content-type"] == "application/zip"

    client.post("/api/session/new", json={"title": "Something Else"})
    r = client.post("/api/session/import",
                    files={"file": ("t.zip", blob.content, "application/zip")})
    assert r.status_code == 200
    assert client.get("/api/session").json()["title"] == "Exported"


def test_importing_rubbish_is_a_400_and_keeps_the_open_tour(client):
    client.post("/api/session/new", json={"title": "Keep Me"})
    r = client.post("/api/session/import",
                    files={"file": ("x.zip", b"not a zip", "application/zip")})
    assert r.status_code == 400
    assert client.get("/api/session").json()["title"] == "Keep Me"


def test_importing_a_traversal_archive_is_refused(client, tmp_path):
    client.post("/api/session/new", json={"title": "Keep Me"})
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as zf:
        zf.writestr("tour.json", json.dumps({"id": "x"}))
        zf.writestr("../escape.txt", "pwned")
    r = client.post("/api/session/import",
                    files={"file": ("e.zip", buf.getvalue(), "application/zip")})
    assert r.status_code == 400
    assert "unsafe" in r.json()["detail"]
    assert not (tmp_path / "escape.txt").exists()


def test_tour_data_404s_when_nothing_is_open(client):
    assert client.get("/tour-data/tour.json").status_code == 404
```

- [ ] **Step 2: Run them and watch them fail**

Run: `cd backend && uv run pytest tests/test_session_api.py -q`
Expected: 404s on every new route.

- [ ] **Step 3: Add the endpoints**

In `backend/app/main.py`, import what is needed and build the session once in
`lifespan`, storing it on `app.state` beside `cfg`:

```python
from .bundle import BundleError, write_bundle
from .session import Session
```

In `lifespan`, after the existing seeding:

```python
        app.state.session = Session(cfg.work_dir)
        if app.state.session.is_open:
            app.state.session.write_config(_viewer_config(cfg))
```

Add a helper beside `ATTRIBUTION`:

```python
def _viewer_config(cfg: Settings) -> dict:
    """What the viewer needs, identical in the editor and in a published site.

    The Mapillary token travels with a published site. It is a public client
    token — mapillary-js runs in the browser and cannot use anything else — so
    this is not a leak, though it looks like one.
    """
    return {"mapillaryToken": cfg.mapillary_token, "tileUrl": TILE_URL,
            "attribution": ATTRIBUTION}
```

Then the routes, all before `_mount_frontend(app, cfg)`:

```python
    @app.get("/api/session")
    def get_session() -> dict:
        return app.state.session.summary()

    @app.post("/api/session/new")
    def new_session(body: dict) -> dict:
        title = (body.get("title") or "Untitled tour").strip() or "Untitled tour"
        session = app.state.session
        session.new(title)
        session.write_config(_viewer_config(app.state.cfg))
        return session.summary()

    @app.put("/api/session/tour")
    def put_tour(doc: dict) -> dict:
        try:
            app.state.session.write_tour(doc)
        except ValueError as exc:
            raise HTTPException(status_code=422, detail=str(exc)) from exc
        return app.state.session.summary()

    @app.post("/api/session/import")
    async def import_bundle(file: UploadFile) -> dict:
        session = app.state.session
        # Spool to disk rather than holding the archive in memory: the caps in
        # bundle.py are about what is INSIDE the zip, and a bundle with media
        # is tens of megabytes.
        with tempfile.NamedTemporaryFile(suffix=".zip", delete=False) as tmp:
            tmp.write(await file.read())
            staged = Path(tmp.name)
        try:
            warnings = session.replace_from(staged)
        except BundleError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc
        finally:
            staged.unlink(missing_ok=True)
        session.write_config(_viewer_config(app.state.cfg))
        return {**session.summary(), "warnings": warnings}

    @app.get("/api/session/export")
    def export_bundle() -> Response:
        session = app.state.session
        if not session.is_open:
            raise HTTPException(status_code=409, detail="no tour is open")
        with tempfile.TemporaryDirectory() as tmp:
            out = Path(tmp) / "tour.zip"
            write_bundle(session.path, out)
            data = out.read_bytes()
        name = f"{session.tour().id}.zip"
        return Response(
            content=data, media_type="application/zip",
            headers={"Content-Disposition": f'attachment; filename="{name}"'},
        )
```

Add the imports `tempfile`, `Path` and `UploadFile` as needed.

Mount the working directory. It must come **before** `_mount_frontend`, and it
must tolerate the directory not existing yet:

```python
def _mount_tour_data(app: FastAPI, cfg: Settings) -> None:
    """Serve the working directory at the same relative path a published site
    uses, so the viewer has exactly one set of URLs and no deployment
    detection. StaticFiles handles Range, which the narration audio needs.

    `check_dir=False` because the working directory legitimately does not
    exist until a tour is opened; requests 404 until it does.
    """
    cfg.work_dir.mkdir(parents=True, exist_ok=True)
    app.mount("/tour-data",
              StaticFiles(directory=cfg.work_dir, check_dir=False),
              name="tour-data")
```

Call it just before `_mount_frontend(app, cfg)`.

- [ ] **Step 4: Verify**

Run: `make backend-test && make lint`
Expected: green. Confirm `make frontend-test` is also still green — nothing
removed yet.

- [ ] **Step 5: Commit**

```bash
git add backend/app/main.py backend/tests/test_session_api.py
git commit -m "$(cat <<'EOF'
Add the session API and serve the working directory at tour-data/

The viewer gets one set of URLs that both deployments satisfy: in the
editor FastAPI serves tour-data/ from the working directory, and in a
published site those are plain files beside index.html. No runtime
detection and no second code path.

The old read-only endpoints stay for now so every commit is green; they
go in the task that switches the frontend over.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 3: Publish a static site

**Files:**
- Create: `backend/app/publish.py`
- Create: `backend/tests/test_publish.py`
- Modify: `backend/app/main.py` (one route)
- Modify: `backend/tests/test_session_api.py` (route test)

**Interfaces:**
- Consumes: `app.session.Session`, `Settings.frontend_dist`.
- Produces: `app.publish.PublishError(Exception)`, `app.publish.build_site(session_path: Path, dist: Path, out_zip: Path) -> None`, and `GET /api/session/publish`.

- [ ] **Step 1: Write the failing tests**

Create `backend/tests/test_publish.py`:

```python
from __future__ import annotations

import zipfile
from pathlib import Path

import pytest

from app.publish import PublishError, build_site
from app.session import Session


@pytest.fixture
def ready(tmp_path):
    session = Session(tmp_path / "work")
    session.new("Publishable")
    session.write_config({"mapillaryToken": "t", "tileUrl": "u", "attribution": []})
    (session.path / "media" / "photo.jpg").write_bytes(b"img")
    dist = tmp_path / "dist"
    (dist / "media").mkdir(parents=True)
    (dist / "index.html").write_text("<html><base href='./'></html>")
    (dist / "main-ABC.js").write_text("console.log(1)")
    (dist / "media" / "layers.png").write_bytes(b"leaflet")
    return session, dist, tmp_path / "site.zip"


def _names(zip_path: Path) -> set[str]:
    with zipfile.ZipFile(zip_path) as zf:
        return set(zf.namelist())


def test_the_site_contains_the_application_and_the_tour(ready):
    session, dist, out = ready
    build_site(session.path, dist, out)
    names = _names(out)
    assert "index.html" in names
    assert "main-ABC.js" in names
    assert "tour-data/tour.json" in names
    assert "tour-data/config.json" in names
    assert "tour-data/media/photo.jpg" in names


def test_leaflet_media_and_tour_media_do_not_collide(ready):
    """Angular's build emits media/ for Leaflet's marker images. Tour media
    lives under tour-data/media/, so both must survive."""
    session, dist, out = ready
    build_site(session.path, dist, out)
    names = _names(out)
    assert "media/layers.png" in names
    assert "tour-data/media/photo.jpg" in names


def test_publishing_without_a_build_fails_with_a_useful_message(ready, tmp_path):
    session, _dist, out = ready
    with pytest.raises(PublishError, match="make build"):
        build_site(session.path, tmp_path / "no-such-dist", out)
    assert not out.exists()


def test_publishing_with_nothing_open_fails(tmp_path):
    empty = Session(tmp_path / "work")
    dist = tmp_path / "dist"
    dist.mkdir()
    (dist / "index.html").write_text("<html></html>")
    with pytest.raises(PublishError):
        build_site(empty.path, dist, tmp_path / "s.zip")


def test_the_published_tour_document_is_the_working_one(ready):
    import json
    session, dist, out = ready
    build_site(session.path, dist, out)
    with zipfile.ZipFile(out) as zf:
        doc = json.loads(zf.read("tour-data/tour.json"))
    assert doc["title"] == "Publishable"
```

- [ ] **Step 2: Run them and watch them fail**

Run: `cd backend && uv run pytest tests/test_publish.py -q`
Expected: `ModuleNotFoundError: No module named 'app.publish'`.

- [ ] **Step 3: Implement publish**

Create `backend/app/publish.py`:

```python
"""Build a static site from the open tour.

The output is the built Angular application with the working directory
alongside it under `tour-data/` — the same relative paths the editor serves,
so the viewer code is identical in both. Unzip it onto any static host.
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
            if path.is_file():
                zf.write(path, path.relative_to(dist).as_posix())
        for path in sorted(session_path.rglob("*")):
            if path.is_file():
                arc = Path("tour-data") / path.relative_to(session_path)
                zf.write(path, arc.as_posix())
```

Add the route to `main.py`, beside the export route:

```python
    @app.get("/api/session/publish")
    def publish_site() -> Response:
        session = app.state.session
        with tempfile.TemporaryDirectory() as tmp:
            out = Path(tmp) / "site.zip"
            try:
                build_site(session.path, Path(app.state.cfg.frontend_dist), out)
            except PublishError as exc:
                raise HTTPException(status_code=409, detail=str(exc)) from exc
            data = out.read_bytes()
        name = f"{session.tour().id}-site.zip"
        return Response(
            content=data, media_type="application/zip",
            headers={"Content-Disposition": f'attachment; filename="{name}"'},
        )
```

and append to `backend/tests/test_session_api.py`:

```python
def test_publish_without_a_build_is_a_409(client):
    client.post("/api/session/new", json={"title": "My Tour"})
    r = client.get("/api/session/publish")
    assert r.status_code == 409
    assert "make build" in r.json()["detail"]
```

Task 2's `client` fixture already pins `frontend_dist` at a non-existent path
for exactly this reason, so the test is deterministic whether or not
`make build` has been run. Confirm that is still true before relying on it.

- [ ] **Step 4: Verify**

Run: `make backend-test && make lint`
Expected: green.

- [ ] **Step 5: Commit**

```bash
git add backend/app/publish.py backend/app/main.py \
        backend/tests/test_publish.py backend/tests/test_session_api.py
git commit -m "$(cat <<'EOF'
Publish the open tour as a static site

The built application plus the working directory under tour-data/,
zipped. Unzip onto any static host and the tour runs with no backend.
Refuses to produce a broken site when the application has not been built.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 4: Point the viewer at tour-data/ and delete the read-only API

The atomic one. The frontend stops calling `/api`, and the endpoints it stops
calling are removed in the same commit along with the database that backed
them.

**Files:**
- Modify: `frontend/src/app/core/tour-api.ts`
- Create: `frontend/src/app/core/session-api.ts`
- Modify: `frontend/src/app/app.ts` (whatever loads config and tour at startup)
- Modify: `frontend/src/index.html` (`<base href="./">`)
- Modify: `frontend/src/app/core/tour-api.spec.ts`, `frontend/src/app/integration/real-tour.spec.ts`, and any spec stubbing `/api`
- Delete: `backend/app/db.py`, `backend/app/media.py`, `backend/tests/test_db.py`, `backend/tests/test_media.py`
- Modify: `backend/app/main.py` (remove `/api/config`, `/api/tours`, `/api/tours/{id}`, `/api/media/{id}`, the seeding in `lifespan`, and the CORS `allow_methods` to include writes)
- Modify: `backend/tests/test_api.py` (remove tests for deleted routes)

**Interfaces:**
- Produces: `TourApi.getConfig()`, `.getTour()`, `.mediaUrl(id)` all against `tour-data/`; `SessionApi.get()`, `.putTour(doc)`.

- [ ] **Step 1: Write the failing frontend test**

In `frontend/src/app/core/tour-api.spec.ts`, replace the `/api` expectations
with `tour-data/` ones, and add the claim the whole static deployment rests on:

```typescript
it('reads everything from tour-data/ and never touches /api', async () => {
  const seen: string[] = [];
  const http = { get: (url: string) => { seen.push(url); return of({}); } };
  const api = new TourApi(http as never);
  await api.getConfig();
  await api.getTour();
  const mediaUrl = api.mediaUrl('court-1863.jpg');

  expect(seen).toEqual(['tour-data/config.json', 'tour-data/tour.json']);
  expect(mediaUrl).toBe('tour-data/media/court-1863.jpg');
  expect([...seen, mediaUrl].some((u) => u.includes('/api'))).toBe(false);
});
```

Adapt the construction to however the existing spec builds `TourApi` — it uses
Angular's `HttpClient` via `inject`, so follow the existing pattern rather than
this sketch if they differ.

- [ ] **Step 2: Run it and watch it fail**

Run: `make frontend-test`
Expected: FAIL, the URLs are still `/api/...`.

- [ ] **Step 3: Rewrite `tour-api.ts`**

```typescript
import { HttpClient } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { firstValueFrom } from 'rxjs';
import type { AppConfig, Tour } from './tour.models';

/**
 * Everything the viewer needs, relative to the page.
 *
 * In the editor FastAPI serves these from the open working directory; in a
 * published site they are plain files beside index.html. One set of URLs, so
 * there is no deployment detection and no second code path — which is the
 * whole reason a published tour needs no backend.
 */
export const TOUR_DATA = 'tour-data';

@Injectable({ providedIn: 'root' })
export class TourApi {
  private readonly http = inject(HttpClient);

  getConfig(): Promise<AppConfig> {
    return firstValueFrom(this.http.get<AppConfig>(`${TOUR_DATA}/config.json`));
  }

  getTour(): Promise<Tour> {
    return firstValueFrom(this.http.get<Tour>(`${TOUR_DATA}/tour.json`));
  }

  /** Media is served with Range support by StaticFiles and by any static
   * host, which is what the narration audio needs. Never inline it. */
  mediaUrl(mediaId: string): string {
    return `${TOUR_DATA}/media/${mediaId}`;
  }
}
```

`listTours` and the `id` parameter of `getTour` go away: a document model has
one open tour.

- [ ] **Step 4: Add `SessionApi`**

Create `frontend/src/app/core/session-api.ts`:

```typescript
import { HttpClient } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { firstValueFrom } from 'rxjs';
import type { Tour } from './tour.models';

export interface SessionSummary {
  open: boolean;
  tourId?: string;
  title?: string;
  stopCount?: number;
  mediaCount?: number;
}

/**
 * The editor's half of the backend: what document is open, and writing it
 * back. Separate from TourApi because TourApi must keep working with no
 * backend at all, and nothing here can.
 */
@Injectable({ providedIn: 'root' })
export class SessionApi {
  private readonly http = inject(HttpClient);

  get(): Promise<SessionSummary> {
    return firstValueFrom(this.http.get<SessionSummary>('/api/session'));
  }

  putTour(doc: Tour): Promise<SessionSummary> {
    return firstValueFrom(this.http.put<SessionSummary>('/api/session/tour', doc));
  }
}
```

With a spec covering both methods and the URLs they call.

- [ ] **Step 5: Update the startup path and `index.html`**

`frontend/src/app/app.ts` currently fetches config then a tour by id. It now
fetches config then the single tour. Keep the existing error handling — the
fatal-error path is what shows the author a useful message when nothing is
open.

In `frontend/src/index.html`, add `<base href="./">` inside `<head>`. Without
it a published site breaks in any subdirectory, which is where most static
hosts put things.

- [ ] **Step 6: Remove the read-only API and the database**

```bash
git rm backend/app/db.py backend/app/media.py \
       backend/tests/test_db.py backend/tests/test_media.py
```

In `backend/app/main.py`: delete `get_config`, `get_tours`, `get_tour` and
`get_media`; delete the `connect`/`init_schema`/`seed_from_dir` calls and
imports in `lifespan`; delete the `media` imports. Widen CORS, which was
read-only:

```python
        allow_methods=["GET", "POST", "PUT", "DELETE"],
```

Leave `database_path` in `Settings` alone for now **only if something still
reads it** — if nothing does, remove it too and say so in your report.

Update `backend/tests/test_api.py`: delete the tests for the removed routes,
keep `/api/health` and the static-serving tests.

A note for your report: `backend/app/media.py`'s range handling is being
deleted rather than ported. `StaticFiles` provides the same behaviour, and the
custom code existed only because media was addressed by id. Its tests go with
it. **Confirm in your report that Range actually works through the
`tour-data` mount** — add a test asserting a `206` and a correct
`Content-Range` for a ranged request to a media file, so the behaviour those
deleted tests covered is still pinned somewhere.

- [ ] **Step 7: Run everything**

Run: `make check`
Expected: fully green. Test counts will move — backend loses the db/media
tests and gains the range test; frontend gains the session-api spec. Report
the new numbers and the bundle size.

- [ ] **Step 8: Commit**

```bash
git add -A
git commit -m "$(cat <<'EOF'
Serve the viewer from tour-data/ and delete the read-only API

The viewer now reads config, document and media from paths relative to
the page, so a published site needs no backend. With nothing left
reading them, /api/config, /api/tours and /api/media go, and the SQLite
tours table with them — it existed to serve a read-only prototype and a
document model has no use for it.

media.py's hand-rolled Range handling is deleted rather than ported:
StaticFiles does the same job, and a test pins that it still works.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 5: Record the decisions and sweep the docs

**Files:**
- Create: `docs/decisions/0002-the-tour-is-a-portable-document.md`
- Modify: `docs/HANDOFF.md`, `README.md`, `docs/ENVIRONMENT.md` as the sweep requires
- Modify: `Makefile` (a `serve` note, if its description is now wrong)

- [ ] **Step 1: Write the decision record**

Create `docs/decisions/0002-the-tour-is-a-portable-document.md`, following the
format `docs/decisions/README.md` sets and `0001` demonstrates — Problem,
Considered, Decision, Costs, and how the deferred features land on it. It must
cover, in prose, each of:

- Why a working directory rather than a zip in memory, and that this makes the
  working directory the document while the zip is only its portable form.
- **The departure from the brainstormed design**: "Save" was agreed as writing
  back to the opened bundle, and is delivered as continuous write-through plus
  an explicit export, because a browser cannot write back to a file it opened
  and the File System Access API is not broadly enough supported to build on.
  State the loss plainly: "save over the file I opened" becomes "export and
  replace it yourself". Mark it as open for the author to overrule.
- Why one set of `tour-data/` URLs instead of a build flag or runtime
  detection, and why the prefix is not `media/` (Angular's build already emits
  `media/` for Leaflet's marker images).
- Why the database and four endpoints were deleted, and that `media.py`'s
  range handling was replaced by `StaticFiles` rather than lost.
- That the Mapillary token travels with a published site, that this is
  unavoidable because mapillary-js runs in the browser, and that it is a public
  client token.

- [ ] **Step 2: Sweep the docs**

```bash
grep -n "api/tours\|api/media\|api/config\|SQLite\|tours.db\|seeded\|database" \
    README.md docs/HANDOFF.md docs/ENVIRONMENT.md Makefile
```

Every hit describing the removed read path is now false. In particular
`docs/HANDOFF.md`'s "Restart the backend after `make content`" warning exists
because tours were seeded into SQLite at startup — that is no longer true and
the warning must go or be rewritten.

Update `docs/HANDOFF.md`'s test counts and state line to this branch's head,
and add the bundle/publish workflow to the "Running it" section.

- [ ] **Step 3: Verify and commit**

Run: `make check`
Expected: green, counts unchanged from Task 4.

```bash
git add docs README.md Makefile
git commit -m "$(cat <<'EOF'
Record why the tour is a portable document

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```
