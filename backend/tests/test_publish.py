from __future__ import annotations

import re
import zipfile
from pathlib import Path

import pytest

from app.publish import PublishError, build_site, mark_published
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


def test_the_published_index_is_marked_and_the_built_one_is_not(ready):
    """The mark is how a published page knows not to probe /api. It lives
    only in the zip: the on-disk dist/index.html serves the authoring host,
    which must stay unmarked so it awaits the backend."""
    session, dist, out = ready
    before = (dist / "index.html").read_bytes()
    build_site(session.path, dist, out)
    with zipfile.ZipFile(out) as zf:
        html = zf.read("index.html").decode()
    assert re.search(r"<html[^>]*\bdata-published\b", html)
    assert (dist / "index.html").read_bytes() == before


def test_only_the_root_index_is_marked(ready):
    session, dist, out = ready
    (dist / "media" / "index.html").write_text("<html></html>")
    build_site(session.path, dist, out)
    with zipfile.ZipFile(out) as zf:
        assert zf.read("media/index.html") == b"<html></html>"


def test_mark_published_is_anchored_and_idempotent():
    assert mark_published('<html lang="en">x') == '<html lang="en" data-published>x'
    once = mark_published('<html lang="en">x')
    assert mark_published(once) == once
    assert mark_published("<p>no html tag</p>") == "<p>no html tag</p>"


def test_mark_published_follows_existing_attributes():
    built = '<!doctype html><html lang="en" data-beasties-container><head>'
    marked = mark_published(built)
    assert marked == (
        '<!doctype html><html lang="en" data-beasties-container data-published>'
        "<head>"
    )
    assert mark_published(marked) == marked
    assert mark_published("<html>x") == "<html data-published>x"
    assert mark_published("<html><body><html>") == "<html data-published><body><html>"


def test_every_published_file_is_world_readable(ready):
    """The session directory is private (0o600) by design; a published zip is
    public web content, so no entry may keep an owner-only mode."""
    session, dist, out = ready
    for p in (session.path / "tour.json", dist / "index.html"):
        p.chmod(0o600)
    build_site(session.path, dist, out)
    with zipfile.ZipFile(out) as zf:
        infos = zf.infolist()
        assert infos
        for info in infos:
            assert (info.external_attr >> 16) & 0o7777 == 0o644, info.filename
