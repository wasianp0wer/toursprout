from __future__ import annotations

import json

import pytest

from app.bundle import BundleError, write_bundle
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
