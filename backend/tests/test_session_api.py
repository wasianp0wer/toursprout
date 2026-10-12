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
