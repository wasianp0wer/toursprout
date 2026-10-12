from __future__ import annotations

import io
import json
import zipfile
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from app import main as main_module
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


@pytest.fixture
def client_with_frontend(tmp_path):
    """A SEPARATE fixture from `client` above: this one builds a real
    `frontend_dist` so `_mount_frontend` actually mounts the SPA catch-all.

    The bare `client` fixture pins `frontend_dist` at a path that never
    exists, which is deliberate for the publish tests (see its docstring) —
    but it also means `_mount_frontend` never mounts anything there, so a
    `/tour-data/*` 404 under that fixture cannot tell "mount ordering is
    correct" apart from "there is no frontend at all". These tests need the
    SPA mount actually present and competing for the same request, so the
    distinction has something to catch.
    """
    frontend_dist = tmp_path / "dist"
    frontend_dist.mkdir()
    (frontend_dist / "index.html").write_text("<html>SPA shell</html>")
    (frontend_dist / "app.js").write_text("console.log('stub asset');")
    cfg = Settings(content_dir=tmp_path / "content", database_path=tmp_path / "t.db",
                   frontend_dist=frontend_dist, mapillary_token="test-token")
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


def test_import_spool_failure_is_a_400_and_leaves_no_temp_file(client, monkeypatch):
    """Forces the streaming copy in `import_bundle` to fail (as a disk-full
    or I/O error would) and checks two things the review flagged: the
    failure surfaces as an ordinary 400, not an unhandled 500, and the
    staged temp file this route creates does not leak."""
    client.post("/api/session/new", json={"title": "Keep Me"})

    created: list[Path] = []
    real_mkstemp = main_module.tempfile.mkstemp

    def tracking_mkstemp(*args, **kwargs):
        fd, name = real_mkstemp(*args, **kwargs)
        created.append(Path(name))
        return fd, name

    def boom(_src, _dst):
        raise OSError("disk full")

    monkeypatch.setattr(main_module.tempfile, "mkstemp", tracking_mkstemp)
    monkeypatch.setattr(main_module.shutil, "copyfileobj", boom)

    r = client.post("/api/session/import",
                    files={"file": ("t.zip", b"anything", "application/zip")})

    assert r.status_code == 400
    assert "detail" in r.json()
    assert created, "expected the route to have staged a temp file before copying"
    assert not created[-1].exists()
    # The failure must not have touched the already-open tour.
    assert client.get("/api/session").json()["title"] == "Keep Me"


def test_cors_allows_the_mutating_methods():
    """A configuration assertion, not a real preflight: TestClient does not
    enforce browser CORS preflight checks, so this can only confirm the
    middleware is configured with the mutating methods Task 2 added
    (POST/PUT, alongside the pre-existing GET and the DELETE Task 4 will
    need), not that an actual preflight request succeeds."""
    for middleware in main_module.app.user_middleware:
        if middleware.cls.__name__ == "CORSMiddleware":
            allow_methods = set(middleware.kwargs["allow_methods"])
            assert {"GET", "POST", "PUT", "DELETE"} <= allow_methods
            return
    pytest.fail("CORSMiddleware is not configured")


def test_tour_data_404s_not_the_spa_shell_when_unmatched(client_with_frontend):
    """With a real frontend mounted, an unmatched tour-data path must still
    404 rather than being swallowed into the SPA's index.html fallback —
    the thing `_mount_tour_data` being registered before `_mount_frontend`
    is supposed to guarantee."""
    client_with_frontend.post("/api/session/new", json={"title": "My Tour"})
    r = client_with_frontend.get("/tour-data/does-not-exist.json")
    assert r.status_code == 404
    assert b"SPA shell" not in r.content


def test_unknown_app_route_still_falls_back_to_the_spa_shell(client_with_frontend):
    """Mounting tour-data first must not break the SPA's own deep-link
    fallback for ordinary application routes."""
    r = client_with_frontend.get("/some/deep/link")
    assert r.status_code == 200
    assert b"SPA shell" in r.content


def test_tour_data_media_range_request_returns_a_slice(client_with_frontend, tmp_path):
    """Range requests through the tour-data mount must work: this is the
    narration-audio guarantee, and it is also the permanent home of the
    range-request coverage that `test_media.py`'s hand-rolled handling in
    `/api/media/{id}` provides today — that handler is deleted in Task 4,
    once the frontend stops using it."""
    client_with_frontend.post("/api/session/new", json={"title": "My Tour"})
    media_dir = tmp_path / "content" / "work" / "media"
    payload = bytes(range(256)) * 4  # 1024 distinguishable bytes
    (media_dir / "clip.bin").write_bytes(payload)

    r = client_with_frontend.get("/tour-data/media/clip.bin",
                                 headers={"Range": "bytes=10-19"})
    assert r.status_code == 206
    assert r.headers["content-range"] == "bytes 10-19/1024"
    assert r.content == payload[10:20]
