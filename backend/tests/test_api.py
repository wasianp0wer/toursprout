from __future__ import annotations

import json

import pytest
from fastapi.testclient import TestClient

from app.config import Settings
from app.main import _resolve_media, create_app
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
    with TestClient(create_app(overrides)) as c:
        yield c


def test_health(client):
    assert client.get("/api/health").json() == {"status": "ok"}


def test_config_exposes_token_and_attribution(client):
    body = client.get("/api/config").json()
    assert body["mapillaryToken"] == "MLY|test-token"
    assert "tileUrl" in body
    assert any("Mapillary" in a["text"] for a in body["attribution"])
    assert any("OpenStreetMap" in a["text"] for a in body["attribution"])


def test_list_tours(client):
    body = client.get("/api/tours").json()
    assert len(body) == 1
    assert body[0]["id"] == "fairfax-old-town"
    assert body[0]["stopCount"] == 1


def test_get_tour_returns_camel_case_document(client):
    body = client.get("/api/tours/fairfax-old-town").json()
    assert body["schemaVersion"] == 2
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


def test_media_range_returns_the_right_bytes(client):
    r = client.get("/api/media/narration-1.m4a", headers={"Range": "bytes=256-258"})
    assert r.content == bytes([0, 1, 2])


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


def test_media_nested_path_is_refused(client):
    """A media id is a filename, never a path.

    Traversal sequences containing `..` are normalised away by HTTP clients
    before they reach the route, so the guarantee is tested directly against
    the resolver in test_resolve_media_rejects_paths below.
    """
    assert client.get("/api/media/subdir/file.m4a").status_code == 404


@pytest.mark.parametrize("evil", [
    "../../../etc/passwd",
    "../secrets.env",
    "subdir/file.m4a",
    "..",
    ".",
    "",
    "nested\\windows.m4a",
])
def test_resolve_media_rejects_paths(tmp_path, evil):
    """The resolver itself must refuse anything path-like, however it arrives."""
    media = tmp_path / "media"
    media.mkdir()
    (tmp_path / "secrets.env").write_text("MAPILLARY_TOKEN=leak")
    assert _resolve_media(media, evil) is None


def test_resolve_media_accepts_a_plain_filename(tmp_path):
    media = tmp_path / "media"
    media.mkdir()
    (media / "narration.m4a").write_bytes(b"x")
    assert _resolve_media(media, "narration.m4a") is not None
