from __future__ import annotations

import json
import zipfile

import pytest
from fastapi.testclient import TestClient

from app.config import Settings
from app.main import create_app

from .test_bundle import JPEG, _minimal_doc


@pytest.fixture
def client(tmp_path):
    cfg = Settings(content_dir=tmp_path, frontend_dist=tmp_path / "nodist",
                   mapillary_token="test-token")
    with TestClient(create_app(cfg)) as c:
        yield c


def tour_json(media_id="photo.jpg") -> bytes:
    return json.dumps(_minimal_doc(media_id)).encode()


def test_imports_a_document_with_flat_media(client):
    res = client.post("/api/session/import-files", files=[
        ("files", ("tour.json", tour_json(), "application/json")),
        ("files", ("media/photo.jpg", JPEG, "image/jpeg")),
    ])
    assert res.status_code == 200
    assert res.json()["mediaCount"] == 1
    assert res.json()["warnings"] == []


def test_preserves_nested_media_paths(client, tmp_path):
    res = client.post("/api/session/import-files", files=[
        ("files", ("tour.json", tour_json("pano/p.jpg"), "application/json")),
        ("files", ("media/pano/p.jpg", JPEG, "image/jpeg")),
    ])
    assert res.status_code == 200
    assert (tmp_path / "work" / "media" / "pano" / "p.jpg").is_file()


def test_tour_json_may_arrive_after_the_media(client):
    res = client.post("/api/session/import-files", files=[
        ("files", ("media/photo.jpg", JPEG, "image/jpeg")),
        ("files", ("tour.json", tour_json(), "application/json")),
    ])
    assert res.status_code == 200


def test_refuses_a_drop_with_no_tour_json(client):
    res = client.post("/api/session/import-files", files=[
        ("files", ("media/photo.jpg", JPEG, "image/jpeg")),
    ])
    assert res.status_code == 400
    assert "tour.json" in res.json()["detail"]


def test_refuses_a_tour_json_that_is_not_json(client):
    res = client.post("/api/session/import-files", files=[
        ("files", ("tour.json", b"{nope", "application/json")),
    ])
    assert res.status_code == 400
    assert "tour.json" in res.json()["detail"]


def test_refuses_a_second_tour_json(client):
    res = client.post("/api/session/import-files", files=[
        ("files", ("tour.json", tour_json(), "application/json")),
        ("files", ("tour.json", tour_json(), "application/json")),
    ])
    assert res.status_code == 400


@pytest.mark.parametrize("bad", ["../escape.jpg", "/abs.jpg", "media/../../x.jpg",
                                 "media/./x.jpg", "notmedia/x.jpg", "media/a\\b.jpg",
                                 "media//x.jpg", "media", "media/"])
def test_refuses_unsafe_or_unexpected_paths(client, tmp_path, bad):
    res = client.post("/api/session/import-files", files=[
        ("files", ("tour.json", tour_json(), "application/json")),
        ("files", (bad, JPEG, "image/jpeg")),
    ])
    assert res.status_code == 400
    assert not (tmp_path / "escape.jpg").exists()
    assert client.get("/api/session").json()["open"] is False


def test_refuses_a_disallowed_media_type(client):
    res = client.post("/api/session/import-files", files=[
        ("files", ("tour.json", tour_json(), "application/json")),
        ("files", ("media/evil.html", b"<h1>hi</h1>", "text/html")),
    ])
    assert res.status_code == 400


def test_refuses_html_wearing_an_image_extension(client):
    res = client.post("/api/session/import-files", files=[
        ("files", ("tour.json", tour_json(), "application/json")),
        ("files", ("media/photo.jpg", b"<h1>hi</h1>", "image/jpeg")),
    ])
    assert res.status_code == 400


def test_a_refused_drop_leaves_the_open_tour(client):
    client.post("/api/session/new", json={"title": "Keep me"})
    res = client.post("/api/session/import-files", files=[
        ("files", ("media/photo.jpg", JPEG, "image/jpeg")),
    ])
    assert res.status_code == 400
    assert client.get("/api/session").json()["title"] == "Keep me"


def test_refuses_cross_site(client):
    res = client.post("/api/session/import-files",
                      files=[("files", ("tour.json", tour_json(), "application/json"))],
                      headers={"Sec-Fetch-Site": "cross-site"})
    assert res.status_code == 403


def test_a_non_bundle_zip_is_refused_and_leaves_the_open_tour(client, tmp_path):
    client.post("/api/session/new", json={"title": "Keep me"})
    junk = tmp_path / "junk.zip"
    with zipfile.ZipFile(junk, "w") as zf:
        zf.writestr("readme.txt", "not a tour")
    with junk.open("rb") as fh:
        res = client.post("/api/session/import",
                          files={"file": ("junk.zip", fh, "application/zip")})
    assert res.status_code == 400
    assert client.get("/api/session").json()["title"] == "Keep me"
