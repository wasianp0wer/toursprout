# Virtual Walking Tour Prototype Implementation Plan

> **Status: implemented.** All eleven tasks are complete. 86 backend tests,
> 50 frontend tests, lint and production build all pass via `make check`.
> Deviations found during implementation are recorded in section 10 of the
> spec; the task text below is the plan as written, not a post-hoc edit.
>
> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a working proof-of-concept that plays a six-stop historical walking tour of Old Town Fairfax, Virginia, overlaying text, images and audio on real Mapillary street-level panoramas.

**Architecture:** A FastAPI backend serves versioned tour documents and range-capable media from SQLite, seeded from committed JSON. An Angular 22 frontend renders a Mapillary 360 panorama per stop with geo-anchored overlay markers, a MapLibre minimap, and a media panel. Pydantic models are the single source of truth for the schema; TypeScript interfaces are generated from exported JSON Schema so the contract cannot drift.

**Tech Stack:** Python 3.14, FastAPI, pydantic v2, httpx, pytest, uv · Angular 22.1.7, TypeScript, MapLibre GL 6, mapillary-js 4.1.2, Vitest, Playwright · SQLite · OpenStreetMap (Overpass, raster tiles), Mapillary Graph API

**Spec:** `docs/superpowers/specs/2026-09-20-walking-tour-framework-design.md`

## Global Constraints

These apply to every task. They were verified by probe, not assumed — see `docs/ENVIRONMENT.md`.

- **Never use `urllib.request`.** It truncates response bodies through the sandbox egress proxy (measured 9/10 success identity, 0/10 gzip). Use `httpx` for every outbound HTTP call, including one-off scripts.
- **Always set `UV_CACHE_DIR`** before any `uv` command: `export UV_CACHE_DIR="$PWD/.uv-cache"`. The default cache is outside the writable tree and every uv command fails without it.
- **Node must be resolved explicitly.** Ambient `node` is v25.8.1, which Angular 22 rejects (`node: ^22.22.3 || ^24.15.0 || >=26.0.0`). Node 24.21.0 lives at `/Users/maddiepersonal/.local/share/fnm/node-versions/v24.21.0/installation/bin`. Prepend it to `PATH`; never rely on the shell shim, which only loads interactively.
- **`git` writes are denied in this sandbox.** `git add` fails on `.git/index.lock`. Steps that would normally commit are written as **Checkpoint** steps that run the test suite instead. Do not attempt commits; do not treat their absence as failure.
- **Mapillary token** is read from `backend/.env` (`MAPILLARY_TOKEN=MLY|...`). It is served to the browser at runtime by `/api/config` and must never be written into frontend source, fixtures, or committed files.
- **Every overlay requires a populated `credit` block.** A missing credit is a schema validation failure, not a warning. Mapillary imagery is CC-BY-SA 4.0 and must be attributed in the UI.
- **Angular 22 style:** standalone components, signals, zoneless change detection. No NgModules.
- Python line length 100, `from __future__ import annotations` in every module.

## File Structure

```
backend/
  pyproject.toml            deps, pytest + ruff config
  .env                      MAPILLARY_TOKEN (exists, gitignored)
  app/
    __init__.py
    models.py               pydantic schema — SINGLE SOURCE OF TRUTH
    db.py                   SQLite connection + idempotent seed
    config.py               settings, reads .env
    media.py                range-request streaming (pure, testable)
    main.py                 FastAPI app + routes
  tests/
    test_models.py          schema validation incl. rejection cases
    test_db.py              seeding idempotency
    test_media.py           range-request correctness
    test_api.py             endpoint contract
content/
  scripts/
    probe_coverage.py       DONE — do not modify
    fetch_media.py          LoC/Commons images + panorama caching
    make_narration.py       say -> ffmpeg -> m4a
    build_tour.py           assembles tours/fairfax-old-town.json
  tours/fairfax-old-town.json
  media/                    images, audio, cached panoramas
  coverage-report.json      DONE
frontend/
  src/app/
    core/tour.models.ts     generated from JSON Schema
    core/tour-api.ts        typed HTTP
    core/tour-store.ts      signal state — no DOM, no HTTP
    panorama/panorama-viewer.ts        PanoramaViewer interface
    panorama/mapillary-viewer.ts       mapillary-js adapter
    panorama/panorama-pane.ts          component
    map/map-pane.ts                    MapLibre minimap
    stop/stop-panel.ts                 text/image/audio + credits
    app.ts                             layout shell
  tests/e2e/                Playwright specs + Mapillary fixtures
Makefile                    `make check` runs everything
```

---

### Task 1: Backend scaffold and tour schema

**Files:**
- Create: `backend/pyproject.toml`, `backend/app/__init__.py`, `backend/app/models.py`, `backend/app/config.py`
- Create: `backend/tests/test_models.py`
- Create: `Makefile`, `.gitignore`

**Interfaces:**
- Produces: `Tour`, `Stop`, `Overlay`, `GeoAnchor`, `Credit`, `Panorama`, `Attribution` pydantic models. `Tour.model_validate(dict) -> Tour`, `Tour.model_json_schema() -> dict`. `Settings` with attributes `mapillary_token: str`, `database_path: Path`, `content_dir: Path`, `media_dir: Path`.

- [ ] **Step 1: Create the project files**

`backend/pyproject.toml`:

```toml
[project]
name = "clio-wired-backend"
version = "0.1.0"
requires-python = ">=3.13"
dependencies = [
    "fastapi>=0.115",
    "uvicorn[standard]>=0.32",
    "pydantic>=2.9",
    "pydantic-settings>=2.6",
    "httpx>=0.28",
]

[dependency-groups]
dev = ["pytest>=8.3", "pytest-asyncio>=0.24", "ruff>=0.8"]

[tool.pytest.ini_options]
testpaths = ["tests"]
pythonpath = ["."]

[tool.ruff]
line-length = 100
```

`.gitignore` at repo root:

```
.uv-cache/
.venv/
node_modules/
backend/.env
backend/*.db
__pycache__/
frontend/.angular/
frontend/dist/
test-results/
playwright-report/
```

- [ ] **Step 2: Write the failing schema tests**

`backend/tests/test_models.py`:

```python
from __future__ import annotations

import pytest
from pydantic import ValidationError

from app.models import Credit, GeoAnchor, Overlay, Stop, Tour

VALID_CREDIT = {
    "source": "Library of Congress",
    "url": "https://www.loc.gov/item/2016123456/",
    "license": "No known restrictions",
    "creator": "National Photo Company",
}


def _overlay(**over):
    base = {
        "id": "ov-1",
        "kind": "text",
        "anchor": {"type": "geo", "lng": -77.30732, "lat": 38.84562, "altitude": 3.0},
        "title": "The 1800 Courthouse",
        "body": "Built in 1800 at the crossroads of two turnpikes.",
        "credit": VALID_CREDIT,
    }
    base.update(over)
    return base


def _stop(**over):
    base = {
        "id": "historic-courthouse",
        "order": 1,
        "title": "Fairfax County Historic Courthouse",
        "summary": "The county's seat of justice since 1800.",
        "location": {"lng": -77.30732, "lat": 38.84562},
        "osmRef": "way/123456",
        "panorama": {
            "provider": "mapillary",
            "imageId": "2116094392633820",
            "bearing": 270.0,
            "cachedPath": "media/pano/historic-courthouse.jpg",
        },
        "overlays": [_overlay()],
    }
    base.update(over)
    return base


def _tour(**over):
    base = {
        "id": "fairfax-old-town",
        "schemaVersion": 1,
        "title": "Old Town Fairfax",
        "description": "A walking tour of six historic sites.",
        "attribution": [
            {"text": "Imagery (c) contributors", "url": "https://www.mapillary.com",
             "license": "CC-BY-SA-4.0"}
        ],
        "stops": [_stop()],
    }
    base.update(over)
    return base


def test_valid_tour_parses():
    tour = Tour.model_validate(_tour())
    assert tour.id == "fairfax-old-town"
    assert tour.stops[0].overlays[0].credit.source == "Library of Congress"


def test_geo_anchor_is_discriminated_by_type():
    anchor = GeoAnchor.model_validate(
        {"type": "geo", "lng": -77.3, "lat": 38.8, "altitude": 2.0})
    assert anchor.type == "geo"


def test_overlay_without_credit_is_rejected():
    """Provenance is a humanities requirement, not a nicety."""
    bad = _overlay()
    del bad["credit"]
    with pytest.raises(ValidationError):
        Overlay.model_validate(bad)


def test_overlay_with_blank_credit_source_is_rejected():
    bad = _overlay(credit={**VALID_CREDIT, "source": "   "})
    with pytest.raises(ValidationError):
        Overlay.model_validate(bad)


def test_unknown_overlay_kind_is_rejected():
    with pytest.raises(ValidationError):
        Overlay.model_validate(_overlay(kind="hologram"))


def test_latitude_out_of_range_is_rejected():
    with pytest.raises(ValidationError):
        GeoAnchor.model_validate({"type": "geo", "lng": 0.0, "lat": 91.0, "altitude": 0.0})


def test_longitude_out_of_range_is_rejected():
    with pytest.raises(ValidationError):
        GeoAnchor.model_validate({"type": "geo", "lng": 181.0, "lat": 0.0, "altitude": 0.0})


def test_stop_order_must_be_positive():
    with pytest.raises(ValidationError):
        Stop.model_validate(_stop(order=0))


def test_tour_requires_at_least_one_stop():
    with pytest.raises(ValidationError):
        Tour.model_validate(_tour(stops=[]))


def test_duplicate_stop_ids_are_rejected():
    with pytest.raises(ValidationError):
        Tour.model_validate(_tour(stops=[_stop(), _stop()]))


def test_stop_orders_must_be_contiguous_from_one():
    a, b = _stop(id="a", order=1), _stop(id="b", order=3)
    with pytest.raises(ValidationError):
        Tour.model_validate(_tour(stops=[a, b]))


def test_extra_fields_are_rejected():
    """Typos in hand-authored content must fail loudly, not vanish."""
    with pytest.raises(ValidationError):
        Tour.model_validate(_tour(titel="Old Town Fairfax"))


def test_json_schema_exports():
    schema = Tour.model_json_schema()
    assert schema["title"] == "Tour"
    assert "stops" in schema["properties"]
```

- [ ] **Step 3: Run the tests and verify they fail**

```bash
cd backend && export UV_CACHE_DIR="$PWD/../.uv-cache" && uv sync && uv run pytest tests/test_models.py -v
```

Expected: collection error, `ModuleNotFoundError: No module named 'app.models'`.

- [ ] **Step 4: Implement the models**

`backend/app/models.py`:

```python
"""Tour schema. This module is the single source of truth for the data model.

The frontend's TypeScript interfaces are generated from the JSON Schema these
models export, so the contract cannot drift between the two halves of the app.
"""

from __future__ import annotations

from typing import Annotated, Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator


class Strict(BaseModel):
    """Reject unknown keys everywhere: a typo in hand-authored content is a bug."""

    model_config = ConfigDict(extra="forbid", populate_by_name=True)


class LngLat(Strict):
    lng: Annotated[float, Field(ge=-180.0, le=180.0)]
    lat: Annotated[float, Field(ge=-90.0, le=90.0)]


class GeoAnchor(Strict):
    """Anchors an overlay to a point in the world rather than to an image.

    `type` is a discriminator with one member today. Image-anchored overlays
    (pinned to pixel coordinates within a single panorama) are the expected
    second variant; modelling the union now keeps that additive.
    """

    type: Literal["geo"] = "geo"
    lng: Annotated[float, Field(ge=-180.0, le=180.0)]
    lat: Annotated[float, Field(ge=-90.0, le=90.0)]
    altitude: float = 0.0


Anchor = Annotated[GeoAnchor, Field(discriminator="type")]


class Credit(Strict):
    """Provenance for a single piece of media. Required, never blank."""

    source: str = Field(min_length=1)
    url: str = Field(min_length=1)
    license: str = Field(min_length=1)
    creator: str | None = None

    @field_validator("source", "url", "license")
    @classmethod
    def _not_whitespace(cls, v: str) -> str:
        if not v.strip():
            raise ValueError("must not be blank")
        return v


class Overlay(Strict):
    id: str = Field(min_length=1)
    kind: Literal["text", "image", "audio"]
    anchor: Anchor
    title: str = Field(min_length=1)
    body: str | None = None
    media_id: str | None = Field(default=None, alias="mediaId")
    credit: Credit

    @model_validator(mode="after")
    def _payload_matches_kind(self) -> Overlay:
        if self.kind == "text" and not (self.body or "").strip():
            raise ValueError("text overlays require a body")
        if self.kind in ("image", "audio") and not self.media_id:
            raise ValueError(f"{self.kind} overlays require a mediaId")
        return self


class Panorama(Strict):
    provider: Literal["mapillary"]
    image_id: str = Field(min_length=1, alias="imageId")
    bearing: Annotated[float, Field(ge=0.0, lt=360.0)]
    cached_path: str | None = Field(default=None, alias="cachedPath")


class Stop(Strict):
    id: str = Field(min_length=1)
    order: Annotated[int, Field(ge=1)]
    title: str = Field(min_length=1)
    summary: str = Field(min_length=1)
    location: LngLat
    osm_ref: str | None = Field(default=None, alias="osmRef")
    panorama: Panorama
    overlays: list[Overlay] = Field(default_factory=list)


class Attribution(Strict):
    text: str = Field(min_length=1)
    url: str
    license: str


class Tour(Strict):
    id: str = Field(min_length=1)
    schema_version: int = Field(alias="schemaVersion")
    title: str = Field(min_length=1)
    description: str
    attribution: list[Attribution] = Field(default_factory=list)
    stops: list[Stop] = Field(min_length=1)

    @model_validator(mode="after")
    def _stops_are_well_ordered(self) -> Tour:
        ids = [s.id for s in self.stops]
        if len(ids) != len(set(ids)):
            raise ValueError("stop ids must be unique")
        orders = sorted(s.order for s in self.stops)
        if orders != list(range(1, len(orders) + 1)):
            raise ValueError("stop orders must be contiguous starting at 1")
        return self


class TourSummary(Strict):
    """What `GET /api/tours` returns: enough to list, not the whole document."""

    id: str
    title: str
    description: str
    stop_count: int = Field(alias="stopCount")
```

`backend/app/config.py`:

```python
from __future__ import annotations

from pathlib import Path

from pydantic_settings import BaseSettings, SettingsConfigDict

BACKEND_DIR = Path(__file__).resolve().parent.parent
REPO_DIR = BACKEND_DIR.parent


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=BACKEND_DIR / ".env", extra="ignore")

    mapillary_token: str = ""
    database_path: Path = BACKEND_DIR / "tours.db"
    content_dir: Path = REPO_DIR / "content"

    @property
    def media_dir(self) -> Path:
        return self.content_dir / "media"

    @property
    def tours_dir(self) -> Path:
        return self.content_dir / "tours"


settings = Settings()
```

`backend/app/__init__.py`: empty file.

- [ ] **Step 5: Run the tests and verify they pass**

```bash
cd backend && export UV_CACHE_DIR="$PWD/../.uv-cache" && uv run pytest tests/test_models.py -v
```

Expected: 13 passed.

- [ ] **Step 6: Checkpoint**

Run `uv run ruff check app tests` — expect no findings. Git commits are blocked in this sandbox; do not attempt one.

---

### Task 2: SQLite storage and idempotent seeding

**Files:**
- Create: `backend/app/db.py`, `backend/tests/test_db.py`

**Interfaces:**
- Consumes: `Tour`, `TourSummary` from `app.models`; `settings` from `app.config`.
- Produces: `connect(path: Path) -> sqlite3.Connection`, `init_schema(conn) -> None`, `seed_from_dir(conn, tours_dir: Path) -> int` (returns number of tours seeded), `load_tour(conn, tour_id: str) -> Tour | None`, `list_tours(conn) -> list[TourSummary]`.

- [ ] **Step 1: Write the failing tests**

`backend/tests/test_db.py`:

```python
from __future__ import annotations

import json

import pytest

from app.db import connect, init_schema, list_tours, load_tour, seed_from_dir
from tests.test_models import _tour


@pytest.fixture
def conn():
    c = connect(":memory:")
    init_schema(c)
    yield c
    c.close()


@pytest.fixture
def tours_dir(tmp_path):
    (tmp_path / "fairfax-old-town.json").write_text(json.dumps(_tour()))
    return tmp_path


def test_seed_inserts_tour(conn, tours_dir):
    assert seed_from_dir(conn, tours_dir) == 1
    tour = load_tour(conn, "fairfax-old-town")
    assert tour is not None
    assert tour.title == "Old Town Fairfax"


def test_seed_is_idempotent(conn, tours_dir):
    """Startup seeds every boot; running twice must not duplicate or error."""
    seed_from_dir(conn, tours_dir)
    seed_from_dir(conn, tours_dir)
    assert len(list_tours(conn)) == 1


def test_seed_reflects_edited_content(conn, tours_dir):
    seed_from_dir(conn, tours_dir)
    edited = _tour(title="Old Town Fairfax, revised")
    (tours_dir / "fairfax-old-town.json").write_text(json.dumps(edited))
    seed_from_dir(conn, tours_dir)
    assert load_tour(conn, "fairfax-old-town").title == "Old Town Fairfax, revised"


def test_invalid_tour_file_raises_with_filename(conn, tmp_path):
    """A malformed tour must name the file, or debugging content is guesswork."""
    (tmp_path / "broken.json").write_text(json.dumps({"id": "x"}))
    with pytest.raises(ValueError, match="broken.json"):
        seed_from_dir(conn, tmp_path)


def test_load_missing_tour_returns_none(conn):
    assert load_tour(conn, "nope") is None


def test_list_tours_returns_summaries(conn, tours_dir):
    seed_from_dir(conn, tours_dir)
    summaries = list_tours(conn)
    assert summaries[0].stop_count == 1
```

- [ ] **Step 2: Run and verify failure**

`cd backend && uv run pytest tests/test_db.py -v` — expected: `ModuleNotFoundError: No module named 'app.db'`.

- [ ] **Step 3: Implement**

`backend/app/db.py`:

```python
"""SQLite persistence.

Tour documents are stored whole as validated JSON rather than shredded across
relational tables. The prototype only ever reads entire tours, and keeping the
document intact means `app.models` stays the single source of truth.
"""

from __future__ import annotations

import json
import sqlite3
from pathlib import Path

from pydantic import ValidationError

from .models import Tour, TourSummary

SCHEMA = """
CREATE TABLE IF NOT EXISTS tours (
    id         TEXT PRIMARY KEY,
    title      TEXT NOT NULL,
    document   TEXT NOT NULL,
    stop_count INTEGER NOT NULL
);
"""


def connect(path: Path | str) -> sqlite3.Connection:
    conn = sqlite3.connect(str(path))
    conn.row_factory = sqlite3.Row
    return conn


def init_schema(conn: sqlite3.Connection) -> None:
    conn.executescript(SCHEMA)
    conn.commit()


def seed_from_dir(conn: sqlite3.Connection, tours_dir: Path) -> int:
    """Load every tour JSON file into the database. Safe to run on every boot."""
    count = 0
    for path in sorted(Path(tours_dir).glob("*.json")):
        raw = json.loads(path.read_text())
        try:
            tour = Tour.model_validate(raw)
        except ValidationError as exc:
            raise ValueError(f"{path.name} is not a valid tour: {exc}") from exc
        conn.execute(
            "INSERT INTO tours (id, title, document, stop_count) VALUES (?, ?, ?, ?) "
            "ON CONFLICT(id) DO UPDATE SET "
            "title=excluded.title, document=excluded.document, stop_count=excluded.stop_count",
            (tour.id, tour.title, tour.model_dump_json(by_alias=True), len(tour.stops)),
        )
        count += 1
    conn.commit()
    return count


def load_tour(conn: sqlite3.Connection, tour_id: str) -> Tour | None:
    row = conn.execute("SELECT document FROM tours WHERE id = ?", (tour_id,)).fetchone()
    return Tour.model_validate_json(row["document"]) if row else None


def list_tours(conn: sqlite3.Connection) -> list[TourSummary]:
    rows = conn.execute("SELECT id, title, document, stop_count FROM tours ORDER BY id").fetchall()
    out = []
    for row in rows:
        doc = json.loads(row["document"])
        out.append(TourSummary.model_validate({
            "id": row["id"],
            "title": row["title"],
            "description": doc.get("description", ""),
            "stopCount": row["stop_count"],
        }))
    return out
```

- [ ] **Step 4: Run and verify pass**

`cd backend && uv run pytest tests/test_db.py -v` — expected: 6 passed.

- [ ] **Step 5: Checkpoint** — `uv run pytest -v` (all backend tests), `uv run ruff check app tests`.

---

### Task 3: Range-capable media streaming

Audio seeking in Safari depends on correct `206 Partial Content` handling. This is a tested requirement, not polish. The range parser is written as a pure function so it can be tested exhaustively without HTTP.

**Files:**
- Create: `backend/app/media.py`, `backend/tests/test_media.py`

**Interfaces:**
- Produces: `parse_range(header: str | None, file_size: int) -> tuple[int, int] | None` returning an inclusive `(start, end)` byte range, `None` when no range was requested, and raising `RangeNotSatisfiable` when the range cannot be served. Also `RangeNotSatisfiable(Exception)` and `guess_media_type(path: Path) -> str`.

- [ ] **Step 1: Write the failing tests**

`backend/tests/test_media.py`:

```python
from __future__ import annotations

from pathlib import Path

import pytest

from app.media import RangeNotSatisfiable, guess_media_type, parse_range


def test_no_header_means_full_body():
    assert parse_range(None, 1000) is None


def test_empty_header_means_full_body():
    assert parse_range("", 1000) is None


def test_simple_closed_range():
    assert parse_range("bytes=0-499", 1000) == (0, 499)


def test_open_ended_range_runs_to_last_byte():
    assert parse_range("bytes=500-", 1000) == (500, 999)


def test_suffix_range_returns_final_n_bytes():
    assert parse_range("bytes=-200", 1000) == (800, 999)


def test_suffix_larger_than_file_clamps_to_whole_file():
    assert parse_range("bytes=-5000", 1000) == (0, 999)


def test_end_beyond_eof_is_clamped():
    assert parse_range("bytes=900-5000", 1000) == (900, 999)


def test_start_beyond_eof_is_unsatisfiable():
    with pytest.raises(RangeNotSatisfiable):
        parse_range("bytes=1000-", 1000)


def test_reversed_range_is_unsatisfiable():
    with pytest.raises(RangeNotSatisfiable):
        parse_range("bytes=500-100", 1000)


def test_zero_length_file_range_is_unsatisfiable():
    with pytest.raises(RangeNotSatisfiable):
        parse_range("bytes=0-", 0)


def test_non_byte_units_are_ignored():
    """RFC 9110: unrecognised units mean serve the whole representation."""
    assert parse_range("items=0-10", 1000) is None


def test_malformed_header_is_ignored():
    assert parse_range("bytes=abc", 1000) is None


def test_multipart_ranges_fall_back_to_full_body():
    """Multipart responses are out of scope; serving the whole file is legal."""
    assert parse_range("bytes=0-99,200-299", 1000) is None


@pytest.mark.parametrize("name,expected", [
    ("a.m4a", "audio/mp4"),
    ("a.mp3", "audio/mpeg"),
    ("a.jpg", "image/jpeg"),
    ("a.png", "image/png"),
    ("a.unknown", "application/octet-stream"),
])
def test_media_type_detection(name, expected):
    assert guess_media_type(Path(name)) == expected
```

- [ ] **Step 2: Run and verify failure** — `uv run pytest tests/test_media.py -v`, expected `ModuleNotFoundError`.

- [ ] **Step 3: Implement**

`backend/app/media.py`:

```python
"""HTTP range request parsing.

Extracted from the route layer so the byte-arithmetic edge cases can be tested
directly. Follows RFC 9110 section 14: unrecognised units and syntactically
invalid ranges are ignored (serve the whole representation), while a
syntactically valid but unsatisfiable range is an error.
"""

from __future__ import annotations

from pathlib import Path

MEDIA_TYPES = {
    ".m4a": "audio/mp4",
    ".mp4": "video/mp4",
    ".mp3": "audio/mpeg",
    ".ogg": "audio/ogg",
    ".wav": "audio/wav",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".png": "image/png",
    ".webp": "image/webp",
    ".json": "application/json",
}


class RangeNotSatisfiable(Exception):
    """The client asked for a range that cannot be served: HTTP 416."""


def guess_media_type(path: Path) -> str:
    return MEDIA_TYPES.get(path.suffix.lower(), "application/octet-stream")


def parse_range(header: str | None, file_size: int) -> tuple[int, int] | None:
    """Return an inclusive (start, end) byte range, or None to serve everything."""
    if not header:
        return None

    unit, _, spec = header.partition("=")
    if unit.strip().lower() != "bytes" or not spec:
        return None
    if "," in spec:  # multipart ranges are out of scope
        return None

    start_s, sep, end_s = spec.strip().partition("-")
    if not sep:
        return None

    try:
        if not start_s:                      # suffix range: bytes=-N
            if not end_s:
                return None
            length = int(end_s)
            if length <= 0:
                raise RangeNotSatisfiable(header)
            if file_size == 0:
                raise RangeNotSatisfiable(header)
            return (max(0, file_size - length), file_size - 1)
        start = int(start_s)
        end = int(end_s) if end_s else file_size - 1
    except ValueError:
        return None

    if start < 0 or start >= file_size or end < start:
        raise RangeNotSatisfiable(header)

    return (start, min(end, file_size - 1))
```

- [ ] **Step 4: Run and verify pass** — `uv run pytest tests/test_media.py -v`, expected 18 passed.

- [ ] **Step 5: Checkpoint** — `uv run pytest -v`, `uv run ruff check app tests`.

---

### Task 4: FastAPI application and routes

**Files:**
- Create: `backend/app/main.py`, `backend/tests/test_api.py`

**Interfaces:**
- Consumes: everything from Tasks 1–3.
- Produces: `app` (FastAPI instance), `create_app(settings_override=None) -> FastAPI`. Routes: `GET /api/config`, `GET /api/tours`, `GET /api/tours/{tour_id}`, `GET /api/media/{media_id}`, `GET /api/health`.

The media route resolves `media_id` against `settings.media_dir` and **must reject path traversal**. Media ids are slugs; anything containing a separator or `..` is a 404, not a 500.

- [ ] **Step 1: Write the failing tests**

`backend/tests/test_api.py`:

```python
from __future__ import annotations

import json

import pytest
from fastapi.testclient import TestClient

from app.config import Settings
from app.main import create_app
from tests.test_models import _tour


@pytest.fixture
def client(tmp_path):
    (tmp_path / "tours").mkdir()
    (tmp_path / "media").mkdir()
    (tmp_path / "tours" / "fairfax-old-town.json").write_text(json.dumps(_tour()))
    (tmp_path / "media" / "narration-1.m4a").write_bytes(bytes(range(256)) * 4)  # 1024 bytes
    overrides = Settings(
        mapillary_token="MLY|test-token",
        database_path=tmp_path / "test.db",
        content_dir=tmp_path,
    )
    return TestClient(create_app(overrides))


def test_health(client):
    assert client.get("/api/health").json() == {"status": "ok"}


def test_config_exposes_token_and_attribution(client):
    body = client.get("/api/config").json()
    assert body["mapillaryToken"] == "MLY|test-token"
    assert "tileUrl" in body
    assert any("Mapillary" in a["text"] for a in body["attribution"])


def test_list_tours(client):
    body = client.get("/api/tours").json()
    assert len(body) == 1
    assert body[0]["id"] == "fairfax-old-town"
    assert body[0]["stopCount"] == 1


def test_get_tour_returns_camel_case_document(client):
    body = client.get("/api/tours/fairfax-old-town").json()
    assert body["schemaVersion"] == 1
    assert body["stops"][0]["panorama"]["imageId"] == "2116094392633820"
    assert body["stops"][0]["overlays"][0]["credit"]["license"]


def test_get_missing_tour_is_404(client):
    assert client.get("/api/tours/nope").status_code == 404


def test_media_full_request(client):
    r = client.get("/api/media/narration-1.m4a")
    assert r.status_code == 200
    assert r.headers["accept-ranges"] == "bytes"
    assert r.headers["content-type"] == "audio/mp4"
    assert len(r.content) == 1024


def test_media_range_request_returns_206(client):
    r = client.get("/api/media/narration-1.m4a", headers={"Range": "bytes=0-99"})
    assert r.status_code == 206
    assert r.headers["content-range"] == "bytes 0-99/1024"
    assert r.headers["content-length"] == "100"
    assert len(r.content) == 100


def test_media_suffix_range(client):
    r = client.get("/api/media/narration-1.m4a", headers={"Range": "bytes=-100"})
    assert r.status_code == 206
    assert r.headers["content-range"] == "bytes 924-1023/1024"


def test_media_unsatisfiable_range_returns_416(client):
    r = client.get("/api/media/narration-1.m4a", headers={"Range": "bytes=5000-"})
    assert r.status_code == 416
    assert r.headers["content-range"] == "bytes */1024"


def test_media_missing_file_is_404(client):
    assert client.get("/api/media/nothing.m4a").status_code == 404


@pytest.mark.parametrize("evil", [
    "../../../etc/passwd",
    "..%2F..%2Fetc%2Fpasswd",
    "subdir/file.m4a",
])
def test_media_path_traversal_is_refused(client, evil):
    """A media id is a filename, never a path."""
    assert client.get(f"/api/media/{evil}").status_code == 404
```

- [ ] **Step 2: Run and verify failure** — expected `ModuleNotFoundError: No module named 'app.main'`.

- [ ] **Step 3: Implement**

`backend/app/main.py`:

```python
from __future__ import annotations

from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI, HTTPException, Request, Response
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse

from .config import Settings, settings as default_settings
from .db import connect, init_schema, list_tours, load_tour, seed_from_dir
from .media import RangeNotSatisfiable, guess_media_type, parse_range

# Raster tiles carry the OSM usage policy; fine at prototype volume.
TILE_URL = "https://tile.openstreetmap.org/{z}/{x}/{y}.png"

ATTRIBUTION = [
    {"text": "Map data (c) OpenStreetMap contributors",
     "url": "https://www.openstreetmap.org/copyright", "license": "ODbL"},
    {"text": "Street-level imagery (c) Mapillary contributors",
     "url": "https://www.mapillary.com", "license": "CC-BY-SA-4.0"},
]

CHUNK = 64 * 1024


def create_app(settings_override: Settings | None = None) -> FastAPI:
    cfg = settings_override or default_settings

    @asynccontextmanager
    async def lifespan(app: FastAPI):
        conn = connect(cfg.database_path)
        init_schema(conn)
        if cfg.tours_dir.exists():
            seed_from_dir(conn, cfg.tours_dir)
        app.state.conn = conn
        app.state.cfg = cfg
        yield
        conn.close()

    app = FastAPI(title="clio-wired", lifespan=lifespan)
    app.add_middleware(
        CORSMiddleware,
        allow_origins=["http://localhost:4200"],
        allow_methods=["GET"],
        allow_headers=["*"],
    )

    @app.get("/api/health")
    def health() -> dict:
        return {"status": "ok"}

    @app.get("/api/config")
    def get_config() -> dict:
        return {
            "mapillaryToken": app.state.cfg.mapillary_token,
            "tileUrl": TILE_URL,
            "attribution": ATTRIBUTION,
        }

    @app.get("/api/tours")
    def get_tours() -> list[dict]:
        return [t.model_dump(by_alias=True) for t in list_tours(app.state.conn)]

    @app.get("/api/tours/{tour_id}")
    def get_tour(tour_id: str) -> dict:
        tour = load_tour(app.state.conn, tour_id)
        if tour is None:
            raise HTTPException(status_code=404, detail="tour not found")
        return tour.model_dump(by_alias=True)

    @app.get("/api/media/{media_id}")
    def get_media(media_id: str, request: Request) -> Response:
        path = _resolve_media(app.state.cfg.media_dir, media_id)
        if path is None:
            raise HTTPException(status_code=404, detail="media not found")

        size = path.stat().st_size
        media_type = guess_media_type(path)

        try:
            byte_range = parse_range(request.headers.get("range"), size)
        except RangeNotSatisfiable:
            return Response(
                status_code=416,
                headers={"Content-Range": f"bytes */{size}", "Accept-Ranges": "bytes"},
            )

        if byte_range is None:
            return FileResponse(path, media_type=media_type,
                                headers={"Accept-Ranges": "bytes"})

        start, end = byte_range
        return Response(
            content=_read_slice(path, start, end),
            status_code=206,
            media_type=media_type,
            headers={
                "Content-Range": f"bytes {start}-{end}/{size}",
                "Content-Length": str(end - start + 1),
                "Accept-Ranges": "bytes",
            },
        )

    return app


def _resolve_media(media_dir: Path, media_id: str) -> Path | None:
    """A media id is a bare filename. Anything path-like is refused."""
    if not media_id or "/" in media_id or "\\" in media_id or ".." in media_id:
        return None
    path = (media_dir / media_id).resolve()
    if not path.is_file() or media_dir.resolve() not in path.parents:
        return None
    return path


def _read_slice(path: Path, start: int, end: int) -> bytes:
    with path.open("rb") as fh:
        fh.seek(start)
        return fh.read(end - start + 1)


app = create_app()
```

- [ ] **Step 4: Run and verify pass** — `uv run pytest tests/test_api.py -v`, expected 13 passed.

- [ ] **Step 5: Smoke-run the server**

```bash
cd backend && uv run uvicorn app.main:app --port 8000 &
sleep 3 && curl -s localhost:8000/api/health && kill %1
```

Expected: `{"status":"ok"}`.

- [ ] **Step 6: Checkpoint** — `uv run pytest -v` (all backend tests green), `uv run ruff check app tests`.

---

### Task 5: Editorial content source

The historical text below is drafted for the prototype and is **not peer-reviewed**. It is committed as a separate, human-editable source file precisely so it can be corrected without touching code. Flag to the user that it needs review before any publication.

**Files:**
- Create: `content/source/stops.json`, `backend/tests/test_content.py`

**Interfaces:**
- Produces: `content/source/stops.json` — an array of six objects with keys `id`, `order`, `title`, `summary`, `osmRef`, `location {lng, lat}`, `bearing`, `narration`, `overlays[]`. Each overlay has `id`, `kind`, `title`, `anchorOffset {east, north, altitude}` (metres from the stop location), `body` for text overlays, and `imageQuery` for image overlays.

- [ ] **Step 1: Write the content file**

Coordinates come from `content/coverage-report.json` (OSM-derived). `anchorOffset` places an overlay a few metres from the stop centre so markers do not stack; `build_tour.py` converts offsets to absolute lng/lat.

`content/source/stops.json`:

```json
[
  {
    "id": "historic-courthouse",
    "order": 1,
    "title": "Fairfax County Historic Courthouse",
    "summary": "The county's seat of justice since 1800, and the keeper of George Washington's will.",
    "osmRef": "way/historic-courthouse",
    "location": { "lng": -77.30732, "lat": 38.84562 },
    "bearing": 200,
    "narration": "You are standing at the Fairfax County Historic Courthouse, completed in 1800. The county seat was moved here because the site sat at the crossroads of two turnpikes, roughly equidistant from the county's scattered settlements. Among the records kept by the county's circuit court is the will of George Washington, written in his own hand. The building has survived occupation by both armies during the Civil War, and remains in use by the county court system.",
    "overlays": [
      {
        "id": "courthouse-founding",
        "kind": "text",
        "title": "A courthouse at the crossroads",
        "anchorOffset": { "east": 8, "north": 4, "altitude": 3 },
        "body": "Completed in 1800, the courthouse was sited where two turnpikes met, so that no corner of the county was unreasonably far from the law."
      },
      {
        "id": "courthouse-photo",
        "kind": "image",
        "title": "Fairfax Court House, early twentieth century",
        "anchorOffset": { "east": -6, "north": 10, "altitude": 4 },
        "imageQuery": "Fairfax Court House Virginia"
      }
    ]
  },
  {
    "id": "marr-monument",
    "order": 2,
    "title": "Marr Monument",
    "summary": "Marking the death of Captain John Quincy Marr on 1 June 1861.",
    "osmRef": "node/marr-monument",
    "location": { "lng": -77.30716, "lat": 38.84566 },
    "bearing": 150,
    "narration": "This obelisk marks the death of Captain John Quincy Marr, killed here on the first of June, 1861, during a brief pre-dawn skirmish known as the Battle of Fairfax Court House. Marr is generally identified as the first Confederate officer killed in combat in the Civil War. The monument was erected in 1904, more than four decades after the event, during a period when such memorials were being raised across the South.",
    "overlays": [
      {
        "id": "marr-death",
        "kind": "text",
        "title": "1 June 1861",
        "anchorOffset": { "east": 5, "north": 3, "altitude": 2.5 },
        "body": "A skirmish before dawn left Captain John Quincy Marr dead, the first Confederate officer killed in combat in the war. The monument came much later, in 1904."
      }
    ]
  },
  {
    "id": "old-town-hall",
    "order": 3,
    "title": "Old Town Hall",
    "summary": "A 1900 gift to the town, still its gathering place.",
    "osmRef": "way/old-town-hall",
    "location": { "lng": -77.30617, "lat": 38.84604 },
    "bearing": 250,
    "narration": "Old Town Hall was built in 1900 as a gift to the town from Joseph Willard, whose family had long-standing ties to the area. For most of the twentieth century it served as the civic centre of Fairfax, hosting town meetings, dances and elections. It stands at the junction of Main Street and University Drive, and is still used for public events.",
    "overlays": [
      {
        "id": "town-hall-gift",
        "kind": "text",
        "title": "A gift, with conditions",
        "anchorOffset": { "east": -7, "north": 6, "altitude": 3.5 },
        "body": "Joseph Willard gave the building to the town in 1900. It served as the centre of civic life for most of the century that followed."
      }
    ]
  },
  {
    "id": "ratcliffe-allison-pozer-house",
    "order": 4,
    "title": "Ratcliffe-Allison-Pozer House",
    "summary": "The oldest surviving house in the City of Fairfax, built about 1812.",
    "osmRef": "way/ratcliffe-allison-pozer",
    "location": { "lng": -77.30468, "lat": 38.84601 },
    "bearing": 180,
    "narration": "This is the oldest surviving house in the City of Fairfax, built around 1812 by Richard Ratcliffe, the landowner who sold the county the ground its courthouse stands on. The house passed through the Allison and Pozer families, and each left its mark on the structure. It is now a museum property, and its successive names record the layered ownership typical of a small county town.",
    "overlays": [
      {
        "id": "ratcliffe-oldest",
        "kind": "text",
        "title": "Three families, one house",
        "anchorOffset": { "east": 6, "north": -5, "altitude": 3 },
        "body": "Built around 1812 by Richard Ratcliffe, who had sold the county the land for its courthouse. The Allison and Pozer families followed; the hyphenated name records all three."
      }
    ]
  },
  {
    "id": "fairfax-museum",
    "order": 5,
    "title": "Fairfax Museum and Visitor Center",
    "summary": "An 1873 schoolhouse, now the city's museum.",
    "osmRef": "way/fairfax-museum",
    "location": { "lng": -77.30050, "lat": 38.84455 },
    "bearing": 300,
    "narration": "The Fairfax Museum and Visitor Center occupies a brick building put up in 1873 as Fairfax Elementary School. It served as a school into the middle of the twentieth century before being converted to its present use. The building is a reminder that public education in Virginia was being rebuilt in the years immediately after the Civil War.",
    "overlays": [
      {
        "id": "museum-school",
        "kind": "text",
        "title": "Built as a school",
        "anchorOffset": { "east": -8, "north": 4, "altitude": 3.5 },
        "body": "Fairfax Elementary School opened here in 1873, part of the rebuilding of public education in Virginia after the Civil War."
      }
    ]
  },
  {
    "id": "fairfax-city-hall",
    "order": 6,
    "title": "Fairfax City Hall",
    "summary": "Where the independent city governs itself, separately from the county that surrounds it.",
    "osmRef": "way/fairfax-city-hall",
    "location": { "lng": -77.30815, "lat": 38.84094 },
    "bearing": 60,
    "narration": "Fairfax City Hall is the seat of a city that is, unusually, independent of the county bearing the same name. Virginia is distinctive in the United States for its independent cities, which sit outside county government entirely. The City of Fairfax became independent in 1961, while remaining the county seat of Fairfax County, an arrangement that still confuses visitors.",
    "overlays": [
      {
        "id": "city-hall-independence",
        "kind": "text",
        "title": "A city outside its county",
        "anchorOffset": { "east": 7, "north": 7, "altitude": 3 },
        "body": "The City of Fairfax became independent of Fairfax County in 1961, yet remains the county seat. Virginia's independent cities are close to unique in the United States."
      }
    ]
  }
]
```

- [ ] **Step 2: Write a test that the content file is well-formed**

`backend/tests/test_content.py`:

```python
from __future__ import annotations

import json
from pathlib import Path

CONTENT = Path(__file__).resolve().parents[2] / "content" / "source" / "stops.json"


def _stops():
    return json.loads(CONTENT.read_text())


def test_six_stops_in_contiguous_order():
    stops = _stops()
    assert len(stops) == 6
    assert [s["order"] for s in stops] == [1, 2, 3, 4, 5, 6]


def test_stop_ids_are_unique():
    stops = _stops()
    assert len({s["id"] for s in stops}) == 6


def test_every_stop_has_narration_and_an_overlay():
    for stop in _stops():
        assert stop["narration"].strip()
        assert stop["overlays"]


def test_overlay_ids_are_globally_unique():
    ids = [o["id"] for s in _stops() for o in s["overlays"]]
    assert len(ids) == len(set(ids))


def test_text_overlays_have_bodies_and_image_overlays_have_queries():
    for stop in _stops():
        for ov in stop["overlays"]:
            if ov["kind"] == "text":
                assert ov["body"].strip()
            if ov["kind"] == "image":
                assert ov["imageQuery"].strip()


def test_bearings_are_valid_compass_degrees():
    for stop in _stops():
        assert 0 <= stop["bearing"] < 360


def test_locations_are_inside_the_fairfax_bounding_box():
    for stop in _stops():
        assert 38.840 <= stop["location"]["lat"] <= 38.856
        assert -77.318 <= stop["location"]["lng"] <= -77.295
```

- [ ] **Step 3: Run and verify pass** — `uv run pytest tests/test_content.py -v`, expected 7 passed.

- [ ] **Step 4: Checkpoint** — full backend suite green.

---

### Task 6: Content pipeline — panoramas, images, narration, tour assembly

Three scripts, run once, whose outputs are committed so the app boots with no network access. All HTTP goes through `httpx` (see Global Constraints).

**Files:**
- Create: `content/scripts/fetch_media.py`, `content/scripts/make_narration.py`, `content/scripts/build_tour.py`, `content/scripts/geo.py`
- Create: `backend/tests/test_geo.py`
- Output: `content/media/*`, `content/media/manifest.json`, `content/tours/fairfax-old-town.json`

**Interfaces:**
- Produces: `content/scripts/geo.py` exposing `offset_to_lnglat(lng: float, lat: float, east_m: float, north_m: float) -> tuple[float, float]`.
- `fetch_media.py` writes `content/media/manifest.json`: `{ media_id: {"file": str, "credit": {...}} }`.
- `build_tour.py` reads `content/source/stops.json`, `content/coverage-report.json` and the manifest, and writes a tour document that validates against `app.models.Tour`.

- [ ] **Step 1: Write the failing geo test**

`backend/tests/test_geo.py`:

```python
from __future__ import annotations

import math
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "content" / "scripts"))

from geo import offset_to_lnglat  # noqa: E402


def test_zero_offset_is_identity():
    lng, lat = offset_to_lnglat(-77.307, 38.845, 0, 0)
    assert math.isclose(lng, -77.307, abs_tol=1e-9)
    assert math.isclose(lat, 38.845, abs_tol=1e-9)


def test_north_offset_increases_latitude_only():
    lng, lat = offset_to_lnglat(-77.307, 38.845, 0, 111.32)
    assert math.isclose(lng, -77.307, abs_tol=1e-9)
    assert math.isclose(lat, 38.846, abs_tol=1e-5)


def test_east_offset_increases_longitude():
    lng, _ = offset_to_lnglat(-77.307, 38.845, 100, 0)
    assert lng > -77.307


def test_east_offset_shrinks_with_latitude():
    """A metre of easting is more degrees of longitude nearer the poles."""
    near_equator, _ = offset_to_lnglat(0.0, 0.0, 100, 0)
    near_pole, _ = offset_to_lnglat(0.0, 60.0, 100, 0)
    assert near_pole > near_equator


def test_offsets_are_small_enough_to_stay_local():
    lng, lat = offset_to_lnglat(-77.30732, 38.84562, 8, 4)
    assert abs(lng + 77.30732) < 0.001
    assert abs(lat - 38.84562) < 0.001
```

- [ ] **Step 2: Run and verify failure** — `ModuleNotFoundError: No module named 'geo'`.

- [ ] **Step 3: Implement `content/scripts/geo.py`**

```python
"""Local metre-offset to lng/lat conversion.

An equirectangular approximation is correct enough at walking-tour scale: the
offsets involved are single-digit metres, where the error against a proper
geodesic is far below GPS noise.
"""

from __future__ import annotations

import math

METRES_PER_DEGREE_LAT = 111_320.0


def offset_to_lnglat(lng: float, lat: float, east_m: float, north_m: float) -> tuple[float, float]:
    d_lat = north_m / METRES_PER_DEGREE_LAT
    d_lng = east_m / (METRES_PER_DEGREE_LAT * math.cos(math.radians(lat)))
    return lng + d_lng, lat + d_lat
```

- [ ] **Step 4: Run and verify pass** — 5 passed.

- [ ] **Step 5: Implement `content/scripts/fetch_media.py`**

```python
"""Fetch panoramas and historical images, recording provenance for each.

Every downloaded file gets a credit block. Media without provenance is not
written, because an overlay without a credit fails schema validation anyway.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

import httpx

REPO = Path(__file__).resolve().parents[2]
MEDIA = REPO / "content" / "media"
SOURCE = REPO / "content" / "source" / "stops.json"
COVERAGE = REPO / "content" / "coverage-report.json"
ENV = REPO / "backend" / ".env"

UA = "clio-wired-prototype/0.1 (graduates@rrchnm.org)"
LOC_SEARCH = "https://www.loc.gov/photos/"
GRAPH = "https://graph.mapillary.com"

CLIENT = httpx.Client(timeout=90.0, headers={"User-Agent": UA}, follow_redirects=True)


def read_token() -> str:
    for line in ENV.read_text().splitlines():
        if line.strip().startswith("MAPILLARY_TOKEN="):
            return line.split("=", 1)[1].strip().strip("\"'")
    sys.exit("MAPILLARY_TOKEN not found in backend/.env")


def best_pano_for(coverage: dict, stop_id: str, title: str) -> dict | None:
    """Match a stop to its probed panorama by OSM name."""
    for entry in coverage["stops"]:
        if entry["name"].lower() == title.lower() and entry.get("best_pano"):
            return entry["best_pano"]
    return None


def fetch_panorama(token: str, image_id: str, dest: Path) -> dict:
    meta = CLIENT.get(f"{GRAPH}/{image_id}", params={
        "access_token": token,
        "fields": "id,thumb_2048_url,captured_at,creator,is_pano",
    }).json()
    img = CLIENT.get(meta["thumb_2048_url"])
    img.raise_for_status()
    dest.write_bytes(img.content)
    return {
        "source": "Mapillary",
        "url": f"https://www.mapillary.com/app/?pKey={image_id}",
        "license": "CC-BY-SA-4.0",
        "creator": (meta.get("creator") or {}).get("username", "Mapillary contributor"),
    }


def fetch_loc_image(query: str, dest: Path) -> dict | None:
    r = CLIENT.get(LOC_SEARCH, params={"q": query, "fo": "json", "c": 5})
    r.raise_for_status()
    for item in r.json().get("results", []):
        urls = item.get("image_url") or []
        if not urls:
            continue
        img_url = urls[-1].split("#")[0]
        if not img_url.startswith("http"):
            img_url = "https:" + img_url
        img = CLIENT.get(img_url)
        if img.status_code != 200 or img.content[:2] != b"\xff\xd8":
            continue
        dest.write_bytes(img.content)
        return {
            "source": "Library of Congress",
            "url": item.get("id") or item.get("url") or LOC_SEARCH,
            "license": "No known restrictions on publication",
            "creator": item.get("creator") or "Unknown",
        }
    return None


def main() -> int:
    MEDIA.mkdir(parents=True, exist_ok=True)
    (MEDIA / "pano").mkdir(exist_ok=True)
    token = read_token()
    coverage = json.loads(COVERAGE.read_text())
    stops = json.loads(SOURCE.read_text())
    manifest: dict[str, dict] = {}

    for stop in stops:
        pano = best_pano_for(coverage, stop["id"], stop["title"])
        if pano:
            media_id = f"pano-{stop['id']}.jpg"
            credit = fetch_panorama(token, pano["id"], MEDIA / "pano" / media_id)
            manifest[media_id] = {"file": f"pano/{media_id}", "credit": credit,
                                  "imageId": pano["id"]}
            print(f"  pano   {stop['id']:<32} {pano['id']}")
        else:
            print(f"  pano   {stop['id']:<32} NOT FOUND", file=sys.stderr)

        for ov in stop["overlays"]:
            if ov["kind"] != "image":
                continue
            media_id = f"{ov['id']}.jpg"
            credit = fetch_loc_image(ov["imageQuery"], MEDIA / media_id)
            if credit:
                manifest[media_id] = {"file": media_id, "credit": credit}
                print(f"  image  {ov['id']:<32} {credit['source']}")
            else:
                print(f"  image  {ov['id']:<32} NOT FOUND", file=sys.stderr)

    (MEDIA / "manifest.json").write_text(json.dumps(manifest, indent=2))
    print(f"\n{len(manifest)} media files -> content/media/manifest.json")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
```

- [ ] **Step 6: Implement `content/scripts/make_narration.py`**

Audio is synthesized with the macOS `say` command and encoded to m4a with ffmpeg. The credit block states plainly that the voice is synthetic — a listener should never be misled into thinking it is an archival recording.

```python
"""Generate spoken narration for each stop from its editorial text.

The voice is synthesized, and its credit block says so. Nothing here should be
mistaken for an archival recording.
"""

from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
MEDIA = REPO / "content" / "media"
SOURCE = REPO / "content" / "source" / "stops.json"
VOICE = "Samantha"

CREDIT = {
    "source": "Synthesized narration (macOS speech synthesis)",
    "url": "https://support.apple.com/guide/mac-help/change-the-voice-your-mac-uses-mchlp2290/mac",
    "license": "Generated for this prototype",
    "creator": f"macOS `say`, voice {VOICE}",
}


def synth(text: str, dest: Path) -> None:
    aiff = dest.with_suffix(".aiff")
    subprocess.run(["say", "-v", VOICE, "-o", str(aiff), text], check=True)
    subprocess.run(
        ["ffmpeg", "-y", "-loglevel", "error", "-i", str(aiff),
         "-c:a", "aac", "-b:a", "96k", str(dest)],
        check=True)
    aiff.unlink()


def main() -> int:
    MEDIA.mkdir(parents=True, exist_ok=True)
    manifest_path = MEDIA / "manifest.json"
    manifest = json.loads(manifest_path.read_text()) if manifest_path.exists() else {}

    for stop in json.loads(SOURCE.read_text()):
        media_id = f"narration-{stop['id']}.m4a"
        synth(stop["narration"], MEDIA / media_id)
        size = (MEDIA / media_id).stat().st_size
        manifest[media_id] = {"file": media_id, "credit": CREDIT}
        print(f"  {media_id:<44} {size:>8} bytes")

    manifest_path.write_text(json.dumps(manifest, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
```

- [ ] **Step 7: Implement `content/scripts/build_tour.py`**

```python
"""Assemble the tour document from editorial source, coverage and media manifest.

Validates the result against app.models.Tour before writing, so a broken tour
never reaches the database.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(REPO / "backend"))
sys.path.insert(0, str(Path(__file__).resolve().parent))

from app.models import Tour  # noqa: E402
from geo import offset_to_lnglat  # noqa: E402

SOURCE = REPO / "content" / "source" / "stops.json"
MANIFEST = REPO / "content" / "media" / "manifest.json"
OUT = REPO / "content" / "tours" / "fairfax-old-town.json"

ATTRIBUTION = [
    {"text": "Map data (c) OpenStreetMap contributors",
     "url": "https://www.openstreetmap.org/copyright", "license": "ODbL"},
    {"text": "Street-level imagery (c) Mapillary contributors",
     "url": "https://www.mapillary.com", "license": "CC-BY-SA-4.0"},
]


def main() -> int:
    stops_src = json.loads(SOURCE.read_text())
    manifest = json.loads(MANIFEST.read_text())
    stops = []

    for src in stops_src:
        pano_key = f"pano-{src['id']}.jpg"
        pano_entry = manifest.get(pano_key)
        if not pano_entry:
            sys.exit(f"no cached panorama for {src['id']}; run fetch_media.py first")

        overlays = []
        for ov in src["overlays"]:
            off = ov["anchorOffset"]
            lng, lat = offset_to_lnglat(
                src["location"]["lng"], src["location"]["lat"], off["east"], off["north"])
            entry = {
                "id": ov["id"],
                "kind": ov["kind"],
                "anchor": {"type": "geo", "lng": lng, "lat": lat,
                           "altitude": off["altitude"]},
                "title": ov["title"],
                "credit": pano_entry["credit"],
            }
            if ov["kind"] == "text":
                entry["body"] = ov["body"]
                entry["credit"] = {
                    "source": "Written for this prototype",
                    "url": "https://github.com/",
                    "license": "Draft, not peer-reviewed",
                    "creator": "Project author",
                }
            else:
                media_id = f"{ov['id']}.jpg"
                if media_id not in manifest:
                    sys.exit(f"missing media {media_id}; run fetch_media.py first")
                entry["mediaId"] = media_id
                entry["credit"] = manifest[media_id]["credit"]
            overlays.append(entry)

        narration_id = f"narration-{src['id']}.m4a"
        if narration_id in manifest:
            lng, lat = offset_to_lnglat(
                src["location"]["lng"], src["location"]["lat"], 0, 2)
            overlays.append({
                "id": f"narration-{src['id']}",
                "kind": "audio",
                "anchor": {"type": "geo", "lng": lng, "lat": lat, "altitude": 2.0},
                "title": f"Narration: {src['title']}",
                "mediaId": narration_id,
                "credit": manifest[narration_id]["credit"],
            })

        stops.append({
            "id": src["id"],
            "order": src["order"],
            "title": src["title"],
            "summary": src["summary"],
            "location": src["location"],
            "osmRef": src["osmRef"],
            "panorama": {
                "provider": "mapillary",
                "imageId": pano_entry["imageId"],
                "bearing": float(src["bearing"]),
                "cachedPath": f"media/{pano_entry['file']}",
            },
            "overlays": overlays,
        })

    doc = {
        "id": "fairfax-old-town",
        "schemaVersion": 1,
        "title": "Old Town Fairfax",
        "description": "Six historic sites in the City of Fairfax, Virginia, "
                       "told through street-level panoramas.",
        "attribution": ATTRIBUTION,
        "stops": stops,
    }

    Tour.model_validate(doc)  # fail here rather than at runtime
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps(doc, indent=2))
    print(f"wrote {OUT.relative_to(REPO)} — {len(stops)} stops, "
          f"{sum(len(s['overlays']) for s in stops)} overlays")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
```

- [ ] **Step 8: Run the pipeline**

```bash
cd /Users/maddiepersonal/phd/clio-wired
export UV_CACHE_DIR="$PWD/.uv-cache"
cd backend && uv run python ../content/scripts/fetch_media.py \
  && uv run python ../content/scripts/make_narration.py \
  && uv run python ../content/scripts/build_tour.py
```

Expected: six panoramas cached, at least one LoC image, six narration files, and a validated `content/tours/fairfax-old-town.json`.

- [ ] **Step 9: Verify the generated tour loads through the API**

```bash
cd backend && uv run pytest -v && uv run uvicorn app.main:app --port 8000 &
sleep 3 && curl -s localhost:8000/api/tours/fairfax-old-town | head -c 300 && kill %1
```

- [ ] **Step 10: Checkpoint** — full backend suite green; `content/tours/fairfax-old-town.json` exists and validates.

---

### Task 7: Frontend scaffold, typed API client, and tour store

The scaffold already exists (`ng new` was run during planning to pin the real shape). Angular 22.1, TypeScript 6.0, **Vitest 4 as the default runner** via `@angular/build:unit-test`, jsdom 28, zoneless by default — there is no `zone.js` dependency and no `provideZoneChangeDetection`.

Already configured in `frontend/angular.json`, do not undo:
- `cli.cache.enabled: false` — required, see Global Constraints
- production budgets raised to 3 MB warn / 4 MB error

**Files:**
- Create: `frontend/src/app/core/tour.models.ts`, `tour-api.ts`, `tour-store.ts`
- Create: `frontend/src/app/core/tour-store.spec.ts`, `tour-api.spec.ts`
- Modify: `frontend/src/app/app.config.ts` (add `provideHttpClient`)

**Interfaces:**
- Produces: TypeScript interfaces `Tour`, `Stop`, `Overlay`, `GeoAnchor`, `Credit`, `Panorama`, `Attribution`, `AppConfig`, `TourSummary`, mirroring the pydantic aliases exactly (camelCase: `schemaVersion`, `imageId`, `cachedPath`, `mediaId`, `osmRef`, `stopCount`).
- `TourApi` with `getConfig(): Promise<AppConfig>`, `getTour(id: string): Promise<Tour>`, `mediaUrl(mediaId: string): string`.
- `TourStore` with signals `tour`, `stops`, `currentIndex`, `currentStop`, `hasNext`, `hasPrevious`, `overlaysForCurrentStop`; methods `load(tour: Tour)`, `next()`, `previous()`, `goTo(index: number)`, `selectOverlay(id: string | null)`, signal `selectedOverlay`.

- [ ] **Step 1: Write the failing store tests**

`frontend/src/app/core/tour-store.spec.ts`:

```ts
import { describe, expect, it, beforeEach } from 'vitest';
import { TourStore } from './tour-store';
import type { Stop, Tour } from './tour.models';

function stop(id: string, order: number): Stop {
  return {
    id, order,
    title: `Stop ${order}`,
    summary: 'summary',
    location: { lng: -77.3, lat: 38.84 },
    osmRef: null,
    panorama: { provider: 'mapillary', imageId: `img-${order}`, bearing: 90, cachedPath: null },
    overlays: [{
      id: `ov-${order}`, kind: 'text',
      anchor: { type: 'geo', lng: -77.3, lat: 38.84, altitude: 2 },
      title: 'Overlay', body: 'Body', mediaId: null,
      credit: { source: 'S', url: 'U', license: 'L', creator: null },
    }],
  };
}

function tour(n = 3): Tour {
  return {
    id: 'fairfax-old-town', schemaVersion: 1,
    title: 'Old Town Fairfax', description: 'desc',
    attribution: [],
    stops: Array.from({ length: n }, (_, i) => stop(`s${i + 1}`, i + 1)),
  };
}

describe('TourStore', () => {
  let store: TourStore;
  beforeEach(() => { store = new TourStore(); });

  it('starts empty', () => {
    expect(store.tour()).toBeNull();
    expect(store.currentStop()).toBeNull();
    expect(store.stops()).toEqual([]);
  });

  it('loads a tour and selects the first stop', () => {
    store.load(tour());
    expect(store.currentIndex()).toBe(0);
    expect(store.currentStop()?.id).toBe('s1');
  });

  it('orders stops by their order field regardless of array order', () => {
    const t = tour();
    t.stops = [t.stops[2], t.stops[0], t.stops[1]];
    store.load(t);
    expect(store.stops().map((s) => s.id)).toEqual(['s1', 's2', 's3']);
  });

  it('advances and retreats', () => {
    store.load(tour());
    store.next();
    expect(store.currentStop()?.id).toBe('s2');
    store.previous();
    expect(store.currentStop()?.id).toBe('s1');
  });

  it('does not advance past the last stop', () => {
    store.load(tour());
    store.goTo(2);
    store.next();
    expect(store.currentIndex()).toBe(2);
    expect(store.hasNext()).toBe(false);
  });

  it('does not retreat before the first stop', () => {
    store.load(tour());
    store.previous();
    expect(store.currentIndex()).toBe(0);
    expect(store.hasPrevious()).toBe(false);
  });

  it('ignores out-of-range goTo', () => {
    store.load(tour());
    store.goTo(99);
    expect(store.currentIndex()).toBe(0);
    store.goTo(-1);
    expect(store.currentIndex()).toBe(0);
  });

  it('exposes overlays for the current stop', () => {
    store.load(tour());
    expect(store.overlaysForCurrentStop().map((o) => o.id)).toEqual(['ov-1']);
    store.next();
    expect(store.overlaysForCurrentStop().map((o) => o.id)).toEqual(['ov-2']);
  });

  it('clears the selected overlay when the stop changes', () => {
    store.load(tour());
    store.selectOverlay('ov-1');
    expect(store.selectedOverlay()?.id).toBe('ov-1');
    store.next();
    expect(store.selectedOverlay()).toBeNull();
  });

  it('ignores selection of an overlay that is not on the current stop', () => {
    store.load(tour());
    store.selectOverlay('ov-3');
    expect(store.selectedOverlay()).toBeNull();
  });

  it('resets position when a new tour is loaded', () => {
    store.load(tour());
    store.goTo(2);
    store.load(tour());
    expect(store.currentIndex()).toBe(0);
  });
});
```

- [ ] **Step 2: Run and verify failure**

```bash
cd frontend && PATH="/Users/maddiepersonal/.local/share/fnm/node-versions/v24.21.0/installation/bin:$PATH" npx ng test --watch=false
```

Expected: cannot resolve `./tour-store`.

- [ ] **Step 3: Implement the models**

`frontend/src/app/core/tour.models.ts` — mirrors the pydantic aliases exactly:

```ts
export interface Credit {
  source: string;
  url: string;
  license: string;
  creator: string | null;
}

export interface GeoAnchor {
  type: 'geo';
  lng: number;
  lat: number;
  altitude: number;
}

export type OverlayKind = 'text' | 'image' | 'audio';

export interface Overlay {
  id: string;
  kind: OverlayKind;
  anchor: GeoAnchor;
  title: string;
  body: string | null;
  mediaId: string | null;
  credit: Credit;
}

export interface Panorama {
  provider: 'mapillary';
  imageId: string;
  bearing: number;
  cachedPath: string | null;
}

export interface Stop {
  id: string;
  order: number;
  title: string;
  summary: string;
  location: { lng: number; lat: number };
  osmRef: string | null;
  panorama: Panorama;
  overlays: Overlay[];
}

export interface Attribution {
  text: string;
  url: string;
  license: string;
}

export interface Tour {
  id: string;
  schemaVersion: number;
  title: string;
  description: string;
  attribution: Attribution[];
  stops: Stop[];
}

export interface TourSummary {
  id: string;
  title: string;
  description: string;
  stopCount: number;
}

export interface AppConfig {
  mapillaryToken: string;
  tileUrl: string;
  attribution: Attribution[];
}
```

- [ ] **Step 4: Implement the store**

`frontend/src/app/core/tour-store.ts`:

```ts
import { Injectable, computed, signal } from '@angular/core';
import type { Overlay, Stop, Tour } from './tour.models';

/**
 * Tour navigation state. Deliberately free of DOM, HTTP and map concerns so it
 * can be tested directly and reused by any view.
 */
@Injectable({ providedIn: 'root' })
export class TourStore {
  private readonly _tour = signal<Tour | null>(null);
  private readonly _index = signal(0);
  private readonly _selectedOverlayId = signal<string | null>(null);

  readonly tour = this._tour.asReadonly();
  readonly currentIndex = this._index.asReadonly();

  /** Stops in walking order, whichever order the document happened to list them in. */
  readonly stops = computed<Stop[]>(() => {
    const tour = this._tour();
    return tour ? [...tour.stops].sort((a, b) => a.order - b.order) : [];
  });

  readonly currentStop = computed<Stop | null>(() => this.stops()[this._index()] ?? null);

  readonly overlaysForCurrentStop = computed<Overlay[]>(
    () => this.currentStop()?.overlays ?? [],
  );

  readonly selectedOverlay = computed<Overlay | null>(() => {
    const id = this._selectedOverlayId();
    return id ? (this.overlaysForCurrentStop().find((o) => o.id === id) ?? null) : null;
  });

  readonly hasNext = computed(() => this._index() < this.stops().length - 1);
  readonly hasPrevious = computed(() => this._index() > 0);

  load(tour: Tour): void {
    this._tour.set(tour);
    this._index.set(0);
    this._selectedOverlayId.set(null);
  }

  next(): void {
    if (this.hasNext()) this.goTo(this._index() + 1);
  }

  previous(): void {
    if (this.hasPrevious()) this.goTo(this._index() - 1);
  }

  goTo(index: number): void {
    if (index < 0 || index >= this.stops().length) return;
    this._index.set(index);
    this._selectedOverlayId.set(null);
  }

  selectOverlay(id: string | null): void {
    if (id !== null && !this.overlaysForCurrentStop().some((o) => o.id === id)) return;
    this._selectedOverlayId.set(id);
  }
}
```

- [ ] **Step 5: Implement the API client and wire HTTP**

`frontend/src/app/core/tour-api.ts`:

```ts
import { HttpClient } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { firstValueFrom } from 'rxjs';
import type { AppConfig, Tour, TourSummary } from './tour.models';

export const API_BASE = '/api';

@Injectable({ providedIn: 'root' })
export class TourApi {
  private readonly http = inject(HttpClient);

  getConfig(): Promise<AppConfig> {
    return firstValueFrom(this.http.get<AppConfig>(`${API_BASE}/config`));
  }

  listTours(): Promise<TourSummary[]> {
    return firstValueFrom(this.http.get<TourSummary[]>(`${API_BASE}/tours`));
  }

  getTour(id: string): Promise<Tour> {
    return firstValueFrom(this.http.get<Tour>(`${API_BASE}/tours/${id}`));
  }

  /** Media is streamed by the backend with range support; never inline it. */
  mediaUrl(mediaId: string): string {
    return `${API_BASE}/media/${mediaId}`;
  }
}
```

`frontend/src/app/app.config.ts`:

```ts
import { ApplicationConfig, provideBrowserGlobalErrorListeners } from '@angular/core';
import { provideHttpClient } from '@angular/common/http';

export const appConfig: ApplicationConfig = {
  providers: [provideBrowserGlobalErrorListeners(), provideHttpClient()],
};
```

`frontend/src/app/core/tour-api.spec.ts`:

```ts
import { describe, expect, it, beforeEach } from 'vitest';
import { TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TourApi } from './tour-api';

describe('TourApi', () => {
  let api: TourApi;
  let http: HttpTestingController;

  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [provideHttpClient(), provideHttpClientTesting()],
    });
    api = TestBed.inject(TourApi);
    http = TestBed.inject(HttpTestingController);
  });

  it('requests the tour by id', async () => {
    const promise = api.getTour('fairfax-old-town');
    const req = http.expectOne('/api/tours/fairfax-old-town');
    expect(req.request.method).toBe('GET');
    req.flush({ id: 'fairfax-old-town', stops: [] });
    expect((await promise).id).toBe('fairfax-old-town');
  });

  it('requests config', async () => {
    const promise = api.getConfig();
    http.expectOne('/api/config').flush({ mapillaryToken: 't', tileUrl: 'u', attribution: [] });
    expect((await promise).mapillaryToken).toBe('t');
  });

  it('builds media urls that hit the range-capable endpoint', () => {
    expect(api.mediaUrl('narration-x.m4a')).toBe('/api/media/narration-x.m4a');
  });
});
```

Install the HTTP testing package if absent: `npm install --save-dev @angular/common` is already present; `provideHttpClientTesting` ships with `@angular/common`.

- [ ] **Step 6: Add the dev-server proxy so `/api` reaches FastAPI**

`frontend/proxy.conf.json`:

```json
{
  "/api": { "target": "http://localhost:8000", "secure": false }
}
```

Register it in `angular.json` under `projects.frontend.architect.serve.options`:

```json
"proxyConfig": "proxy.conf.json"
```

- [ ] **Step 7: Run and verify pass** — `npx ng test --watch=false`, expected 11 store tests + 3 api tests + the 2 scaffold tests passing.

- [ ] **Step 8: Checkpoint** — `npx ng build` exits 0.

---

### Task 8: Panorama viewer behind a swappable interface

mapillary-js is contained here and nowhere else. Two API constraints, confirmed against the published typings:

- `Marker` takes `LngLat` only — **there is no altitude argument**. `anchor.altitude` is carried through the schema but not consumed by the panorama renderer.
- There is no `markerclick` event. Selection is `viewer.on('click', …)` then `MarkerComponent.getMarkerIdAt(pixelPoint)`, which returns a `Promise<string>`.

**Files:**
- Create: `frontend/src/app/panorama/panorama-viewer.ts` (interface), `mapillary-viewer.ts` (adapter), `panorama-pane.ts`, `panorama-pane.css`
- Create: `frontend/src/app/panorama/fake-viewer.ts`, `panorama-pane.spec.ts`
- Modify: `frontend/src/styles.css` to import mapillary-js CSS

**Interfaces:**
- Produces:

```ts
export interface OverlayMarker { id: string; lng: number; lat: number; selected: boolean }

export interface PanoramaViewer {
  attach(container: HTMLElement, accessToken: string): void;
  load(imageId: string, bearing: number): Promise<void>;
  setMarkers(markers: OverlayMarker[]): void;
  onMarkerClick(handler: (id: string) => void): void;
  destroy(): void;
}
```

- `MapillaryViewer implements PanoramaViewer`; `FakeViewer implements PanoramaViewer` recording calls for tests.
- `PanoramaPane` component, selector `app-panorama-pane`, with an injection token `PANORAMA_VIEWER` so tests substitute `FakeViewer`.

- [ ] **Step 1: Write the failing component test**

`frontend/src/app/panorama/panorama-pane.spec.ts`:

```ts
import { describe, expect, it, beforeEach } from 'vitest';
import { TestBed } from '@angular/core/testing';
import { PanoramaPane, PANORAMA_VIEWER } from './panorama-pane';
import { FakeViewer } from './fake-viewer';
import { TourStore } from '../core/tour-store';
import type { Tour } from '../core/tour.models';

function tour(): Tour {
  return {
    id: 't', schemaVersion: 1, title: 'T', description: '', attribution: [],
    stops: [1, 2].map((n) => ({
      id: `s${n}`, order: n, title: `Stop ${n}`, summary: '',
      location: { lng: -77.3, lat: 38.84 }, osmRef: null,
      panorama: { provider: 'mapillary' as const, imageId: `img-${n}`, bearing: 90 * n, cachedPath: null },
      overlays: [{
        id: `ov-${n}`, kind: 'text' as const,
        anchor: { type: 'geo' as const, lng: -77.3 + n * 0.0001, lat: 38.84, altitude: 2 },
        title: 'O', body: 'B', mediaId: null,
        credit: { source: 'S', url: 'U', license: 'L', creator: null },
      }],
    })),
  };
}

describe('PanoramaPane', () => {
  let fake: FakeViewer;
  let store: TourStore;

  beforeEach(() => {
    fake = new FakeViewer();
    TestBed.configureTestingModule({
      imports: [PanoramaPane],
      providers: [{ provide: PANORAMA_VIEWER, useValue: fake }],
    });
    store = TestBed.inject(TourStore);
  });

  it('loads the current stop panorama with its bearing', async () => {
    store.load(tour());
    const fixture = TestBed.createComponent(PanoramaPane);
    fixture.detectChanges();
    await fixture.whenStable();
    expect(fake.loaded).toEqual([{ imageId: 'img-1', bearing: 90 }]);
  });

  it('reloads when the stop changes', async () => {
    store.load(tour());
    const fixture = TestBed.createComponent(PanoramaPane);
    fixture.detectChanges();
    await fixture.whenStable();
    store.next();
    fixture.detectChanges();
    await fixture.whenStable();
    expect(fake.loaded.at(-1)).toEqual({ imageId: 'img-2', bearing: 180 });
  });

  it('places a marker for each overlay on the current stop', async () => {
    store.load(tour());
    const fixture = TestBed.createComponent(PanoramaPane);
    fixture.detectChanges();
    await fixture.whenStable();
    expect(fake.markers.at(-1)?.map((m) => m.id)).toEqual(['ov-1']);
  });

  it('selects the overlay when its marker is clicked', async () => {
    store.load(tour());
    const fixture = TestBed.createComponent(PanoramaPane);
    fixture.detectChanges();
    await fixture.whenStable();
    fake.emitMarkerClick('ov-1');
    fixture.detectChanges();
    expect(store.selectedOverlay()?.id).toBe('ov-1');
  });

  it('destroys the viewer when the component is torn down', async () => {
    store.load(tour());
    const fixture = TestBed.createComponent(PanoramaPane);
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.destroy();
    expect(fake.destroyed).toBe(true);
  });
});
```

- [ ] **Step 2: Run and verify failure** — cannot resolve `./panorama-pane`.

- [ ] **Step 3: Implement the interface and fake**

`frontend/src/app/panorama/panorama-viewer.ts`:

```ts
export interface OverlayMarker {
  id: string;
  lng: number;
  lat: number;
  selected: boolean;
}

/**
 * The seam that contains mapillary-js. Nothing outside the panorama folder
 * should import from 'mapillary-js' directly — the library was last published
 * in 2023 and is expected to be replaced.
 */
export interface PanoramaViewer {
  attach(container: HTMLElement, accessToken: string): void;
  load(imageId: string, bearing: number): Promise<void>;
  setMarkers(markers: OverlayMarker[]): void;
  onMarkerClick(handler: (id: string) => void): void;
  destroy(): void;
}
```

`frontend/src/app/panorama/fake-viewer.ts`:

```ts
import type { OverlayMarker, PanoramaViewer } from './panorama-viewer';

/** Records interactions so component behaviour can be asserted without WebGL. */
export class FakeViewer implements PanoramaViewer {
  loaded: { imageId: string; bearing: number }[] = [];
  markers: OverlayMarker[][] = [];
  destroyed = false;
  attachedTo: HTMLElement | null = null;
  private handler: ((id: string) => void) | null = null;

  attach(container: HTMLElement): void {
    this.attachedTo = container;
  }

  async load(imageId: string, bearing: number): Promise<void> {
    this.loaded.push({ imageId, bearing });
  }

  setMarkers(markers: OverlayMarker[]): void {
    this.markers.push(markers);
  }

  onMarkerClick(handler: (id: string) => void): void {
    this.handler = handler;
  }

  emitMarkerClick(id: string): void {
    this.handler?.(id);
  }

  destroy(): void {
    this.destroyed = true;
  }
}
```

- [ ] **Step 4: Implement the mapillary-js adapter**

`frontend/src/app/panorama/mapillary-viewer.ts`:

```ts
import { MarkerComponent, SimpleMarker, Viewer } from 'mapillary-js';
import type { OverlayMarker, PanoramaViewer } from './panorama-viewer';

const SELECTED = '#e8b04b';
const UNSELECTED = '#2f7fd4';

export class MapillaryViewer implements PanoramaViewer {
  private viewer: Viewer | null = null;
  private markerComponent: MarkerComponent | null = null;
  private handler: ((id: string) => void) | null = null;

  attach(container: HTMLElement, accessToken: string): void {
    this.viewer = new Viewer({
      accessToken,
      container,
      component: { cover: false, marker: true, bearing: true, zoom: true },
    });
    this.markerComponent = this.viewer.getComponent('marker') as MarkerComponent;

    // mapillary-js has no markerclick event: hit-test the click position.
    this.viewer.on('click', (event) => {
      if (!this.markerComponent || !event.pixelPoint) return;
      this.markerComponent
        .getMarkerIdAt(event.pixelPoint)
        .then((id) => { if (id) this.handler?.(id); })
        .catch(() => undefined);
    });
  }

  async load(imageId: string, bearing: number): Promise<void> {
    if (!this.viewer) return;
    await this.viewer.moveTo(imageId);
    // setCenter takes basic image coordinates; bearing maps onto the x axis.
    this.viewer.setCenter([((bearing % 360) + 360) % 360 / 360, 0.5]);
  }

  setMarkers(markers: OverlayMarker[]): void {
    if (!this.markerComponent) return;
    this.markerComponent.removeAll();
    this.markerComponent.add(
      markers.map((m) => new SimpleMarker(m.id, { lng: m.lng, lat: m.lat }, {
        color: m.selected ? SELECTED : UNSELECTED,
        ballColor: m.selected ? SELECTED : UNSELECTED,
        interactive: true,
        radius: 0.7,
      })),
    );
  }

  onMarkerClick(handler: (id: string) => void): void {
    this.handler = handler;
  }

  destroy(): void {
    this.viewer?.remove();
    this.viewer = null;
    this.markerComponent = null;
  }
}
```

- [ ] **Step 5: Implement the component**

`frontend/src/app/panorama/panorama-pane.ts`:

```ts
import {
  Component, DestroyRef, ElementRef, InjectionToken, effect, inject, viewChild,
} from '@angular/core';
import { ConfigStore } from '../core/config-store';
import { TourStore } from '../core/tour-store';
import { MapillaryViewer } from './mapillary-viewer';
import type { PanoramaViewer } from './panorama-viewer';

export const PANORAMA_VIEWER = new InjectionToken<PanoramaViewer>('PANORAMA_VIEWER', {
  providedIn: 'root',
  factory: () => new MapillaryViewer(),
});

@Component({
  selector: 'app-panorama-pane',
  template: `<div class="panorama" #container></div>`,
  styleUrl: './panorama-pane.css',
})
export class PanoramaPane {
  private readonly viewer = inject(PANORAMA_VIEWER);
  private readonly store = inject(TourStore);
  private readonly config = inject(ConfigStore);
  private readonly container = viewChild.required<ElementRef<HTMLElement>>('container');
  private attached = false;

  constructor() {
    inject(DestroyRef).onDestroy(() => this.viewer.destroy());
    this.viewer.onMarkerClick((id) => this.store.selectOverlay(id));

    effect(() => {
      const stop = this.store.currentStop();
      if (!stop) return;
      if (!this.attached) {
        this.viewer.attach(this.container().nativeElement, this.config.mapillaryToken());
        this.attached = true;
      }
      void this.viewer.load(stop.panorama.imageId, stop.panorama.bearing);
    });

    effect(() => {
      const selectedId = this.store.selectedOverlay()?.id ?? null;
      this.viewer.setMarkers(
        this.store.overlaysForCurrentStop().map((o) => ({
          id: o.id,
          lng: o.anchor.lng,
          lat: o.anchor.lat,
          selected: o.id === selectedId,
        })),
      );
    });
  }
}
```

`frontend/src/app/panorama/panorama-pane.css`:

```css
.panorama {
  width: 100%;
  height: 100%;
  background: #111;
}
```

- [ ] **Step 6: Create the config store consumed above**

`frontend/src/app/core/config-store.ts`:

```ts
import { Injectable, signal } from '@angular/core';
import type { AppConfig, Attribution } from './tour.models';

/** Runtime configuration from the backend. The Mapillary token lives here, never in source. */
@Injectable({ providedIn: 'root' })
export class ConfigStore {
  private readonly _config = signal<AppConfig | null>(null);
  readonly config = this._config.asReadonly();

  set(config: AppConfig): void {
    this._config.set(config);
  }

  mapillaryToken(): string {
    return this._config()?.mapillaryToken ?? '';
  }

  tileUrl(): string {
    return this._config()?.tileUrl ?? '';
  }

  attribution(): Attribution[] {
    return this._config()?.attribution ?? [];
  }
}
```

- [ ] **Step 7: Import the mapillary-js stylesheet**

Append to `frontend/src/styles.css`:

```css
@import 'mapillary-js/dist/mapillary.css';

html, body { height: 100%; margin: 0; }
body { font-family: Georgia, 'Times New Roman', serif; background: #14161a; color: #ecebe6; }
```

- [ ] **Step 8: Run and verify pass** — `npx ng test --watch=false`, expected all panorama tests green.

- [ ] **Step 9: Checkpoint** — `npx ng build` exits 0.

---

### Task 9: Minimap

**Files:**
- Create: `frontend/src/app/map/map-pane.ts`, `map-pane.css`, `map-pane.spec.ts`

**Interfaces:**
- Produces: `MapPane` component, selector `app-map-pane`. Exposes a pure helper `routeGeoJson(stops: Stop[]): GeoJSON.FeatureCollection` used by the component and tested directly, exported from `frontend/src/app/map/route.ts`.

MapLibre needs WebGL, which jsdom lacks, so the component test covers the pure route builder and the marker-click wiring; visual behaviour is covered by Playwright in Task 11. **MapLibre 6 has no default export** — named imports only.

- [ ] **Step 1: Write the failing route-builder test**

`frontend/src/app/map/map-pane.spec.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { routeGeoJson } from './route';
import type { Stop } from '../core/tour.models';

function stop(order: number, lng: number, lat: number): Stop {
  return {
    id: `s${order}`, order, title: `Stop ${order}`, summary: '',
    location: { lng, lat }, osmRef: null,
    panorama: { provider: 'mapillary', imageId: 'i', bearing: 0, cachedPath: null },
    overlays: [],
  };
}

describe('routeGeoJson', () => {
  it('returns an empty collection for no stops', () => {
    expect(routeGeoJson([]).features).toEqual([]);
  });

  it('produces no line for a single stop', () => {
    const fc = routeGeoJson([stop(1, -77.3, 38.84)]);
    expect(fc.features.filter((f) => f.geometry.type === 'LineString')).toHaveLength(0);
  });

  it('connects stops in walking order', () => {
    const fc = routeGeoJson([stop(2, -77.2, 38.85), stop(1, -77.3, 38.84)]);
    const line = fc.features.find((f) => f.geometry.type === 'LineString');
    expect((line!.geometry as GeoJSON.LineString).coordinates).toEqual([
      [-77.3, 38.84],
      [-77.2, 38.85],
    ]);
  });

  it('emits a point per stop carrying its id and order', () => {
    const fc = routeGeoJson([stop(1, -77.3, 38.84), stop(2, -77.2, 38.85)]);
    const points = fc.features.filter((f) => f.geometry.type === 'Point');
    expect(points).toHaveLength(2);
    expect(points[0].properties).toMatchObject({ id: 's1', order: 1 });
  });
});
```

- [ ] **Step 2: Run and verify failure** — cannot resolve `./route`.

- [ ] **Step 3: Implement `frontend/src/app/map/route.ts`**

```ts
import type { Stop } from '../core/tour.models';

/** Builds the route line and stop markers. Pure, so it can be tested without WebGL. */
export function routeGeoJson(stops: Stop[]): GeoJSON.FeatureCollection {
  const ordered = [...stops].sort((a, b) => a.order - b.order);
  const features: GeoJSON.Feature[] = ordered.map((s) => ({
    type: 'Feature',
    geometry: { type: 'Point', coordinates: [s.location.lng, s.location.lat] },
    properties: { id: s.id, order: s.order, title: s.title },
  }));

  if (ordered.length > 1) {
    features.unshift({
      type: 'Feature',
      geometry: {
        type: 'LineString',
        coordinates: ordered.map((s) => [s.location.lng, s.location.lat]),
      },
      properties: {},
    });
  }

  return { type: 'FeatureCollection', features };
}
```

- [ ] **Step 4: Implement `frontend/src/app/map/map-pane.ts`**

```ts
import {
  AfterViewInit, Component, DestroyRef, ElementRef, effect, inject, viewChild,
} from '@angular/core';
import { Map as MlMap, type StyleSpecification } from 'maplibre-gl';
import { ConfigStore } from '../core/config-store';
import { TourStore } from '../core/tour-store';
import { routeGeoJson } from './route';

const ROUTE_SOURCE = 'route';

@Component({
  selector: 'app-map-pane',
  template: `<div class="minimap" #container></div>`,
  styleUrl: './map-pane.css',
})
export class MapPane implements AfterViewInit {
  private readonly store = inject(TourStore);
  private readonly config = inject(ConfigStore);
  private readonly container = viewChild.required<ElementRef<HTMLElement>>('container');
  private map: MlMap | null = null;

  constructor() {
    inject(DestroyRef).onDestroy(() => this.map?.remove());

    effect(() => {
      const stop = this.store.currentStop();
      if (!this.map || !stop) return;
      this.map.easeTo({ center: [stop.location.lng, stop.location.lat], zoom: 17 });
      this.paintRoute();
    });
  }

  ngAfterViewInit(): void {
    const style: StyleSpecification = {
      version: 8,
      sources: {
        osm: {
          type: 'raster',
          tiles: [this.config.tileUrl()],
          tileSize: 256,
          attribution: '(c) OpenStreetMap contributors',
        },
      },
      layers: [{ id: 'osm', type: 'raster', source: 'osm' }],
    };

    this.map = new MlMap({
      container: this.container().nativeElement,
      style,
      center: [-77.3065, 38.8456],
      zoom: 16,
      attributionControl: { compact: true },
    });

    this.map.on('load', () => this.paintRoute());
    this.map.on('click', 'stops', (e) => {
      const id = e.features?.[0]?.properties?.['id'] as string | undefined;
      if (!id) return;
      const index = this.store.stops().findIndex((s) => s.id === id);
      if (index >= 0) this.store.goTo(index);
    });
  }

  private paintRoute(): void {
    const map = this.map;
    if (!map || !map.isStyleLoaded()) return;

    const data = routeGeoJson(this.store.stops());
    const existing = map.getSource(ROUTE_SOURCE);
    if (existing) {
      (existing as maplibregl.GeoJSONSource).setData(data);
    } else {
      map.addSource(ROUTE_SOURCE, { type: 'geojson', data });
      map.addLayer({
        id: 'route-line', type: 'line', source: ROUTE_SOURCE,
        filter: ['==', ['geometry-type'], 'LineString'],
        paint: { 'line-color': '#e8b04b', 'line-width': 3, 'line-opacity': 0.8 },
      });
      map.addLayer({
        id: 'stops', type: 'circle', source: ROUTE_SOURCE,
        filter: ['==', ['geometry-type'], 'Point'],
        paint: {
          'circle-radius': 9,
          'circle-color': '#2f7fd4',
          'circle-stroke-color': '#fff',
          'circle-stroke-width': 2,
        },
      });
      map.addLayer({
        id: 'stop-labels', type: 'symbol', source: ROUTE_SOURCE,
        filter: ['==', ['geometry-type'], 'Point'],
        layout: { 'text-field': ['get', 'order'], 'text-size': 12 },
        paint: { 'text-color': '#fff' },
      });
    }

    const current = this.store.currentStop();
    if (current && map.getLayer('stops')) {
      map.setPaintProperty('stops', 'circle-color', [
        'case', ['==', ['get', 'id'], current.id], '#e8b04b', '#2f7fd4',
      ]);
    }
  }
}
```

Add `import type maplibregl from 'maplibre-gl';` is **not** valid here — MapLibre 6 has no default export. Use `import type { GeoJSONSource } from 'maplibre-gl';` and cast to `GeoJSONSource`.

`frontend/src/app/map/map-pane.css`:

```css
.minimap { width: 100%; height: 100%; }
```

- [ ] **Step 5: Run and verify pass** — 4 route tests green.

- [ ] **Step 6: Checkpoint** — `npx ng build` exits 0.

---

### Task 10: Stop panel and application shell

**Files:**
- Create: `frontend/src/app/stop/stop-panel.ts`, `stop-panel.css`, `stop-panel.spec.ts`
- Modify: `frontend/src/app/app.ts`, `app.html`, `app.css`
- Delete: `frontend/src/app/app.spec.ts` scaffold assertions that reference the default template

**Interfaces:**
- Produces: `StopPanel` component, selector `app-stop-panel`. `App` shell loads config and tour on init and composes the three panes.

- [ ] **Step 1: Write the failing panel test**

`frontend/src/app/stop/stop-panel.spec.ts`:

```ts
import { describe, expect, it, beforeEach } from 'vitest';
import { TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { provideHttpClientTesting } from '@angular/common/http/testing';
import { StopPanel } from './stop-panel';
import { TourStore } from '../core/tour-store';
import type { Overlay, Tour } from '../core/tour.models';

const CREDIT = { source: 'Library of Congress', url: 'https://loc.gov/x', license: 'No known restrictions', creator: 'NPC' };

function overlay(over: Partial<Overlay> = {}): Overlay {
  return {
    id: 'ov-1', kind: 'text',
    anchor: { type: 'geo', lng: -77.3, lat: 38.84, altitude: 2 },
    title: 'The 1800 Courthouse', body: 'Built in 1800.', mediaId: null, credit: CREDIT,
    ...over,
  } as Overlay;
}

function tour(overlays: Overlay[]): Tour {
  return {
    id: 't', schemaVersion: 1, title: 'Old Town Fairfax', description: '', attribution: [],
    stops: [{
      id: 's1', order: 1, title: 'Historic Courthouse',
      summary: 'The county seat since 1800.',
      location: { lng: -77.3, lat: 38.84 }, osmRef: null,
      panorama: { provider: 'mapillary', imageId: 'i', bearing: 0, cachedPath: null },
      overlays,
    }],
  };
}

describe('StopPanel', () => {
  let store: TourStore;

  beforeEach(() => {
    TestBed.configureTestingModule({
      imports: [StopPanel],
      providers: [provideHttpClient(), provideHttpClientTesting()],
    });
    store = TestBed.inject(TourStore);
  });

  function render() {
    const fixture = TestBed.createComponent(StopPanel);
    fixture.detectChanges();
    return fixture.nativeElement as HTMLElement;
  }

  it('shows the current stop title and summary', () => {
    store.load(tour([overlay()]));
    const el = render();
    expect(el.textContent).toContain('Historic Courthouse');
    expect(el.textContent).toContain('The county seat since 1800.');
  });

  it('shows the stop position in the tour', () => {
    store.load(tour([overlay()]));
    expect(render().textContent).toContain('1 of 1');
  });

  it('renders the selected text overlay body', () => {
    store.load(tour([overlay()]));
    store.selectOverlay('ov-1');
    expect(render().textContent).toContain('Built in 1800.');
  });

  it('always renders the credit for a selected overlay', () => {
    store.load(tour([overlay()]));
    store.selectOverlay('ov-1');
    const text = render().textContent ?? '';
    expect(text).toContain('Library of Congress');
    expect(text).toContain('No known restrictions');
  });

  it('renders an audio element for audio overlays', () => {
    store.load(tour([overlay({ id: 'ov-a', kind: 'audio', body: null, mediaId: 'narration-s1.m4a' })]));
    store.selectOverlay('ov-a');
    const audio = render().querySelector('audio');
    expect(audio?.getAttribute('src')).toBe('/api/media/narration-s1.m4a');
  });

  it('renders an img for image overlays', () => {
    store.load(tour([overlay({ id: 'ov-i', kind: 'image', body: null, mediaId: 'photo.jpg' })]));
    store.selectOverlay('ov-i');
    expect(render().querySelector('img')?.getAttribute('src')).toBe('/api/media/photo.jpg');
  });

  it('lists every overlay on the stop so all content is reachable', () => {
    store.load(tour([overlay(), overlay({ id: 'ov-2', title: 'Second' })]));
    expect(render().querySelectorAll('[data-overlay-item]')).toHaveLength(2);
  });
});
```

- [ ] **Step 2: Run and verify failure.**

- [ ] **Step 3: Implement `frontend/src/app/stop/stop-panel.ts`**

```ts
import { Component, computed, inject } from '@angular/core';
import { TourApi } from '../core/tour-api';
import { TourStore } from '../core/tour-store';

@Component({
  selector: 'app-stop-panel',
  styleUrl: './stop-panel.css',
  template: `
    @let stop = store.currentStop();
    @if (stop) {
      <header>
        <p class="position">{{ position() }}</p>
        <h2>{{ stop.title }}</h2>
        <p class="summary">{{ stop.summary }}</p>
      </header>

      <nav class="overlay-list">
        @for (ov of store.overlaysForCurrentStop(); track ov.id) {
          <button
            type="button"
            data-overlay-item
            [class.active]="ov.id === store.selectedOverlay()?.id"
            (click)="store.selectOverlay(ov.id)">
            <span class="kind">{{ ov.kind }}</span>{{ ov.title }}
          </button>
        }
      </nav>

      @let selected = store.selectedOverlay();
      @if (selected) {
        <article class="overlay-detail">
          <h3>{{ selected.title }}</h3>

          @switch (selected.kind) {
            @case ('text') { <p>{{ selected.body }}</p> }
            @case ('image') {
              <img [src]="api.mediaUrl(selected.mediaId!)" [alt]="selected.title" />
            }
            @case ('audio') {
              <audio controls preload="none" [src]="api.mediaUrl(selected.mediaId!)"></audio>
            }
          }

          <p class="credit">
            {{ selected.credit.source }}
            @if (selected.credit.creator) { — {{ selected.credit.creator }} }
            · {{ selected.credit.license }}
          </p>
        </article>
      }

      <footer class="controls">
        <button type="button" data-prev [disabled]="!store.hasPrevious()" (click)="store.previous()">
          Previous
        </button>
        <button type="button" data-next [disabled]="!store.hasNext()" (click)="store.next()">
          Next
        </button>
      </footer>
    }
  `,
})
export class StopPanel {
  protected readonly store = inject(TourStore);
  protected readonly api = inject(TourApi);

  protected readonly position = computed(
    () => `${this.store.currentIndex() + 1} of ${this.store.stops().length}`,
  );
}
```

`frontend/src/app/stop/stop-panel.css`:

```css
:host { display: block; overflow-y: auto; padding: 1.25rem; background: #1b1e24; }
.position { text-transform: uppercase; letter-spacing: 0.08em; font-size: 0.7rem; color: #9aa0ab; margin: 0 0 0.3rem; }
h2 { margin: 0 0 0.4rem; font-size: 1.35rem; }
.summary { margin: 0 0 1rem; color: #c3c7cf; font-style: italic; }
.overlay-list { display: flex; flex-direction: column; gap: 0.35rem; margin-bottom: 1rem; }
.overlay-list button { text-align: left; background: #252a32; color: inherit; border: 1px solid transparent; border-radius: 4px; padding: 0.5rem 0.65rem; cursor: pointer; font: inherit; }
.overlay-list button.active { border-color: #e8b04b; background: #2d323c; }
.kind { display: inline-block; min-width: 3.6rem; font-size: 0.65rem; text-transform: uppercase; letter-spacing: 0.08em; color: #9aa0ab; }
.overlay-detail { border-top: 1px solid #333944; padding-top: 0.9rem; }
.overlay-detail h3 { margin: 0 0 0.5rem; font-size: 1rem; }
.overlay-detail img { max-width: 100%; border-radius: 4px; }
.overlay-detail audio { width: 100%; }
.credit { font-size: 0.72rem; color: #9aa0ab; margin-top: 0.7rem; }
.controls { display: flex; gap: 0.5rem; margin-top: 1.2rem; }
.controls button { flex: 1; padding: 0.55rem; background: #2f7fd4; color: #fff; border: 0; border-radius: 4px; font: inherit; cursor: pointer; }
.controls button:disabled { background: #333944; color: #6d7480; cursor: default; }
```

- [ ] **Step 4: Implement the shell**

`frontend/src/app/app.ts`:

```ts
import { Component, inject, signal } from '@angular/core';
import { ConfigStore } from './core/config-store';
import { TourApi } from './core/tour-api';
import { TourStore } from './core/tour-store';
import { MapPane } from './map/map-pane';
import { PanoramaPane } from './panorama/panorama-pane';
import { StopPanel } from './stop/stop-panel';

const TOUR_ID = 'fairfax-old-town';

@Component({
  selector: 'app-root',
  imports: [MapPane, PanoramaPane, StopPanel],
  templateUrl: './app.html',
  styleUrl: './app.css',
})
export class App {
  private readonly api = inject(TourApi);
  private readonly config = inject(ConfigStore);
  protected readonly store = inject(TourStore);
  protected readonly ready = signal(false);
  protected readonly error = signal<string | null>(null);

  constructor() {
    void this.bootstrap();
  }

  private async bootstrap(): Promise<void> {
    try {
      const [config, tour] = await Promise.all([
        this.api.getConfig(),
        this.api.getTour(TOUR_ID),
      ]);
      this.config.set(config);
      this.store.load(tour);
      this.ready.set(true);
    } catch {
      this.error.set('Could not reach the tour service. Is the backend running on port 8000?');
    }
  }

  protected attribution() {
    return this.config.attribution();
  }
}
```

`frontend/src/app/app.html`:

```html
@if (error()) {
  <p class="fatal" data-error>{{ error() }}</p>
} @else if (ready()) {
  <main class="layout" data-ready>
    <section class="panorama-slot"><app-panorama-pane /></section>
    <section class="map-slot"><app-map-pane /></section>
    <aside class="panel-slot"><app-stop-panel /></aside>
    <footer class="attribution">
      @for (a of attribution(); track a.url) {
        <a [href]="a.url" target="_blank" rel="noopener">{{ a.text }}</a>
      }
    </footer>
  </main>
} @else {
  <p class="loading">Loading the tour…</p>
}
```

`frontend/src/app/app.css`:

```css
:host { display: block; height: 100vh; }
.layout {
  display: grid;
  grid-template-columns: minmax(0, 2fr) minmax(320px, 1fr);
  grid-template-rows: minmax(0, 3fr) minmax(0, 2fr) auto;
  grid-template-areas: "pano panel" "map panel" "attr attr";
  height: 100vh;
}
.panorama-slot { grid-area: pano; min-height: 0; }
.map-slot { grid-area: map; min-height: 0; }
.panel-slot { grid-area: panel; min-height: 0; border-left: 1px solid #333944; }
.attribution { grid-area: attr; display: flex; gap: 1rem; padding: 0.35rem 0.75rem; font-size: 0.68rem; background: #0f1114; }
.attribution a { color: #9aa0ab; text-decoration: none; }
.loading, .fatal { padding: 2rem; }
.fatal { color: #e8825b; }
@media (max-width: 900px) {
  .layout { grid-template-columns: 1fr; grid-template-rows: 45vh 25vh 1fr auto;
            grid-template-areas: "pano" "map" "panel" "attr"; height: auto; }
}
```

- [ ] **Step 5: Replace the scaffold app spec**

Overwrite `frontend/src/app/app.spec.ts`:

```ts
import { describe, expect, it, beforeEach } from 'vitest';
import { TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { App } from './app';
import { PANORAMA_VIEWER } from './panorama/panorama-pane';
import { FakeViewer } from './panorama/fake-viewer';

describe('App', () => {
  beforeEach(() => {
    TestBed.configureTestingModule({
      imports: [App],
      providers: [
        provideHttpClient(),
        provideHttpClientTesting(),
        { provide: PANORAMA_VIEWER, useValue: new FakeViewer() },
      ],
    });
  });

  it('shows an actionable message when the backend is unreachable', async () => {
    const fixture = TestBed.createComponent(App);
    const http = TestBed.inject(HttpTestingController);
    fixture.detectChanges();
    http.expectOne('/api/config').error(new ProgressEvent('network'));
    http.expectOne('/api/tours/fairfax-old-town').error(new ProgressEvent('network'));
    await fixture.whenStable();
    fixture.detectChanges();
    const el = fixture.nativeElement as HTMLElement;
    expect(el.querySelector('[data-error]')?.textContent).toContain('backend');
  });
});
```

- [ ] **Step 6: Run and verify pass** — `npx ng test --watch=false`, all suites green.

- [ ] **Step 7: Checkpoint** — `npx ng build` exits 0.

---

### Task 11: End-to-end walkthrough and `make check`

Playwright runs against **recorded fixtures**, never the live Mapillary API, so the suite needs no token and no network.

**Files:**
- Create: `frontend/playwright.config.ts`, `frontend/tests/e2e/tour.spec.ts`, `frontend/tests/e2e/fixtures.ts`
- Create: `Makefile`
- Modify: `frontend/package.json` scripts

**Interfaces:**
- Consumes: the running backend on port 8000 and the Angular dev server on 4200.
- Produces: `make check` running backend tests, frontend unit tests, a production build, and the e2e suite.

- [ ] **Step 1: Install Playwright**

```bash
cd frontend && npm install --save-dev @playwright/test && npx playwright install chromium
```

- [ ] **Step 2: Write the fixture helper**

`frontend/tests/e2e/fixtures.ts`:

```ts
import type { Page } from '@playwright/test';

/**
 * Block every Mapillary request and serve a deterministic stub instead.
 * The panorama itself cannot render without WebGL imagery, so the tests
 * assert on tour navigation, overlays and credits — not on pixels.
 */
export async function stubMapillary(page: Page): Promise<void> {
  await page.route('**://*.mapillary.com/**', (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: '{"data":[]}' }),
  );
  await page.route('**://*.mapillary.com/**/*.jpg', (route) =>
    route.fulfill({ status: 200, contentType: 'image/jpeg', body: '' }),
  );
}

/** OSM tiles are equally irrelevant to what these tests assert. */
export async function stubTiles(page: Page): Promise<void> {
  await page.route('**://tile.openstreetmap.org/**', (route) =>
    route.fulfill({ status: 200, contentType: 'image/png', body: '' }),
  );
}
```

- [ ] **Step 3: Write the e2e spec**

`frontend/tests/e2e/tour.spec.ts`:

```ts
import { expect, test } from '@playwright/test';
import { stubMapillary, stubTiles } from './fixtures';

test.beforeEach(async ({ page }) => {
  await stubMapillary(page);
  await stubTiles(page);
  await page.goto('/');
  await expect(page.locator('[data-ready]')).toBeVisible({ timeout: 30_000 });
});

test('opens on the first stop of the Fairfax tour', async ({ page }) => {
  await expect(page.getByRole('heading', { name: 'Fairfax County Historic Courthouse' })).toBeVisible();
  await expect(page.getByText('1 of 6')).toBeVisible();
});

test('walks forward through all six stops and back again', async ({ page }) => {
  for (let i = 2; i <= 6; i++) {
    await page.locator('[data-next]').click();
    await expect(page.getByText(`${i} of 6`)).toBeVisible();
  }
  await expect(page.locator('[data-next]')).toBeDisabled();

  for (let i = 5; i >= 1; i--) {
    await page.locator('[data-prev]').click();
    await expect(page.getByText(`${i} of 6`)).toBeVisible();
  }
  await expect(page.locator('[data-prev]')).toBeDisabled();
});

test('shows overlay text with its credit when an overlay is selected', async ({ page }) => {
  await page.locator('[data-overlay-item]').first().click();
  const detail = page.locator('.overlay-detail');
  await expect(detail).toBeVisible();
  await expect(detail.locator('.credit')).not.toBeEmpty();
});

test('every stop exposes at least one overlay and every overlay carries a credit', async ({ page }) => {
  for (let i = 1; i <= 6; i++) {
    const items = page.locator('[data-overlay-item]');
    await expect(items.first()).toBeVisible();
    const count = await items.count();
    for (let j = 0; j < count; j++) {
      await items.nth(j).click();
      await expect(page.locator('.overlay-detail .credit')).not.toBeEmpty();
    }
    if (i < 6) await page.locator('[data-next]').click();
  }
});

test('narration audio points at the range-capable media endpoint', async ({ page }) => {
  const audioItem = page.locator('[data-overlay-item]', { hasText: 'Narration' }).first();
  await audioItem.click();
  const audio = page.locator('.overlay-detail audio');
  await expect(audio).toHaveAttribute('src', /\/api\/media\/narration-.*\.m4a/);
});

test('attribution for OpenStreetMap and Mapillary is always visible', async ({ page }) => {
  const attribution = page.locator('.attribution');
  await expect(attribution).toContainText('OpenStreetMap');
  await expect(attribution).toContainText('Mapillary');
});
```

- [ ] **Step 4: Write `frontend/playwright.config.ts`**

```ts
import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './tests/e2e',
  timeout: 60_000,
  fullyParallel: false,
  retries: 0,
  use: { baseURL: 'http://localhost:4200', trace: 'retain-on-failure' },
  webServer: {
    command: 'npm run start -- --port 4200',
    url: 'http://localhost:4200',
    reuseExistingServer: true,
    timeout: 180_000,
  },
});
```

The backend must already be running on port 8000; `make e2e` starts it.

- [ ] **Step 5: Write the `Makefile` at the repo root**

```makefile
NODE_BIN := /Users/maddiepersonal/.local/share/fnm/node-versions/v24.21.0/installation/bin
export PATH := $(NODE_BIN):$(PATH)
export UV_CACHE_DIR := $(CURDIR)/.uv-cache
export npm_config_cache := $(CURDIR)/.npm-cache

.PHONY: check backend-test frontend-test build e2e serve content

check: backend-test frontend-test build

backend-test:
	cd backend && uv run pytest -q

frontend-test:
	cd frontend && npx ng test --watch=false

build:
	cd frontend && npx ng build

serve:
	cd backend && uv run uvicorn app.main:app --port 8000

content:
	cd backend && uv run python ../content/scripts/fetch_media.py \
	  && uv run python ../content/scripts/make_narration.py \
	  && uv run python ../content/scripts/build_tour.py

e2e:
	cd backend && uv run uvicorn app.main:app --port 8000 & \
	  sleep 4; cd frontend && npx playwright test; status=$$?; kill %1; exit $$status
```

- [ ] **Step 6: Run the whole suite**

```bash
make check && make e2e
```

Expected: backend tests pass, frontend unit tests pass, build succeeds, all six e2e tests pass.

- [ ] **Step 7: Write `README.md`** documenting prerequisites (Node 24 path, `UV_CACHE_DIR`, Mapillary token in `backend/.env`), how to run the pipeline, how to start both servers, and how to run tests. Link `docs/ENVIRONMENT.md` for the sandbox constraints.

- [ ] **Step 8: Final checkpoint** — `make check` green, `make e2e` green, app manually loads at `localhost:4200` with a visible panorama.

---

## Self-review

**Spec coverage.** Section 3 stops → Task 5. Section 4 data model → Tasks 1 and 7. Section 5 backend → Tasks 1–4; frontend → Tasks 7–10. Section 6 pipeline → Task 6. Section 7 testing → Tasks 1–11, with Playwright in 11. Section 8 risks → local panorama caching in Task 6, `PanoramaViewer` seam in Task 8, httpx in Global Constraints.

**Known deviations from the spec, deliberate and verified:**
- `allowedCommonJsDependencies` is *not* needed; mapillary-js bundles cleanly as ESM. Bundle budgets are raised instead.
- `anchor.altitude` is not consumed by the panorama renderer, because mapillary-js `Marker` accepts no altitude. It stays in the schema for the map layer and future image-anchored overlays.
- Overlay content renders in the Angular panel rather than a mapillary `Popup`, because `Popup` anchors to image-relative coordinates, not geography.
- Angular's build cache must be disabled or `ng build` SIGABRTs silently.

**Type consistency.** `PanoramaViewer` methods (`attach`, `load`, `setMarkers`, `onMarkerClick`, `destroy`) are identical in the interface, `MapillaryViewer`, `FakeViewer` and `PanoramaPane`. `TourStore` members match between definition, specs and templates. Field aliases (`imageId`, `cachedPath`, `mediaId`, `osmRef`, `schemaVersion`, `stopCount`) are camelCase on both sides of the wire.
