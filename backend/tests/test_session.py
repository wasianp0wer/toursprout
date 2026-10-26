from __future__ import annotations

import json

import pytest

import app.session as session_module
from app.bundle import BundleError, write_bundle
from app.session import Session, SessionConflict


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


def test_summary_counts_media_recursively(session):
    """A non-recursive count treated a nested directory (`media/pano/`, the
    layout the bundle spec's own example shows) as a single entry — the
    directory itself — rather than counting the files inside it."""
    session.new("My Tour")
    (session.path / "media" / "pano").mkdir()
    (session.path / "media" / "pano" / "pano-x.jpg").write_bytes(b"x")
    (session.path / "media" / "flat.jpg").write_bytes(b"y")
    assert session.summary()["mediaCount"] == 2


def test_new_refuses_when_a_tour_is_already_open(session):
    session.new("First")
    with pytest.raises(SessionConflict):
        session.new("Second")
    assert session.tour().title == "First"


def test_new_with_force_discards_what_was_open(session):
    session.new("First")
    session.new("Second", force=True)
    assert session.tour().title == "Second"


def test_a_fresh_session_accepts_new_without_force(session):
    """The guard only fires when something is already open; starting the
    very first tour must not require `force`."""
    session.new("First")  # no force=True, and no SessionConflict
    assert session.tour().title == "First"


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


def _no_tmp_leftovers(directory) -> bool:
    return not any(".tmp" in p.name for p in directory.iterdir())


def test_write_tour_cleans_up_its_temp_file_on_success(session):
    session.new("My Tour")
    doc = json.loads((session.path / "tour.json").read_text())
    doc["title"] = "Renamed"
    session.write_tour(doc)
    assert _no_tmp_leftovers(session.path)


def test_write_config_cleans_up_its_temp_file_on_success(session):
    session.new("My Tour")
    session.write_config({"mapillaryToken": "tok", "tileUrl": "u", "attribution": []})
    assert _no_tmp_leftovers(session.path)


def test_a_failed_write_tour_leaves_the_previous_file_intact(session, monkeypatch):
    session.new("Original")
    original_bytes = (session.path / "tour.json").read_bytes()
    doc = json.loads((session.path / "tour.json").read_text())
    doc["title"] = "Renamed"

    def boom(*_args, **_kwargs):
        raise OSError("disk full (simulated)")

    monkeypatch.setattr(session_module.os, "replace", boom)

    with pytest.raises(OSError):
        session.write_tour(doc)

    # The previous tour.json is untouched, byte for byte, and still parses.
    assert (session.path / "tour.json").read_bytes() == original_bytes
    assert session.tour().title == "Original"
    # The temp file that never got to replace it is cleaned up too.
    assert _no_tmp_leftovers(session.path)


@pytest.mark.parametrize("title,slug", [
    ("Untitled tour", "untitled-tour"),
    ("Courthouse Square", "courthouse-square"),
    ("Mason's \"Walk\" / 1st & Main!", "masons-walk-1st-main"),
    ("***", "untitled"),
])
def test_a_tour_id_is_a_safe_slug_of_the_title(title, slug):
    """The id names the exported file in a Content-Disposition header, and
    authors now type the title."""
    from app.session import skeleton
    assert skeleton(title)["id"] == slug


def test_close_removes_the_working_directory(tmp_path):
    session = Session(tmp_path / "work")
    session.new("A tour")
    session.close()
    assert not session.is_open
    assert session.summary() == {"open": False}


def test_close_refuses_when_nothing_is_open(tmp_path):
    with pytest.raises(SessionConflict):
        Session(tmp_path / "work").close()
