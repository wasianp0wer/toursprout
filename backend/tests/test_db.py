from __future__ import annotations

import json
from pathlib import Path

import pytest

from app.db import connect, init_schema, list_tours, load_tour, seed_from_dir
from tests.test_models import _tour

# The frozen v1 snapshot used throughout test_migration.py: see that module
# for why it must never be refreshed.
V1_FIXTURE = Path(__file__).parent / "fixtures" / "fairfax-old-town-v1.json"


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
    (tours_dir / "fairfax-old-town.json").write_text(
        json.dumps(_tour(title="Old Town Fairfax, revised")))
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
    assert summaries[0].id == "fairfax-old-town"


def test_empty_dir_seeds_nothing(conn, tmp_path):
    assert seed_from_dir(conn, tmp_path) == 0
    assert list_tours(conn) == []


def test_seed_from_dir_migrates_a_v1_document_to_v2(conn, tmp_path):
    """The one place `migrate_v1_to_v2` is wired into a read path
    (`app.db.seed_from_dir`) is asserted everywhere in prose
    (docs/decisions/0001-three-axes-for-overlays.md, docs/HANDOFF.md) and,
    until now, tested nowhere: both test_db.py and test_api.py seed an
    already-v2 document, so deleting the migration call from db.py left all
    158 backend tests passing. This writes the frozen v1 fixture straight
    into a tours_dir and goes through the real seed_from_dir/load_tour path."""
    (tmp_path / "fairfax-old-town.json").write_text(V1_FIXTURE.read_text())

    seed_from_dir(conn, tmp_path)
    tour = load_tour(conn, "fairfax-old-town")

    assert tour is not None
    assert tour.schema_version == 2
    migrated_overlay = next(o for s in tour.stops for o in s.overlays)
    assert migrated_overlay.display is not None
