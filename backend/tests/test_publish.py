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
