from __future__ import annotations

import json

import pytest
from fastapi.testclient import TestClient

from app.config import Settings
from app.main import create_app
from tests.test_models import _tour


def _settings(tmp_path, dist):
    (tmp_path / "tours").mkdir(exist_ok=True)
    (tmp_path / "media").mkdir(exist_ok=True)
    (tmp_path / "tours" / "t.json").write_text(json.dumps(_tour()))
    return Settings(
        mapillary_token="MLY|t",
        database_path=tmp_path / "t.db",
        content_dir=tmp_path,
        frontend_dist=dist,
    )


@pytest.fixture
def dist(tmp_path):
    d = tmp_path / "dist"
    d.mkdir()
    (d / "index.html").write_text("<html><body>tour app</body></html>")
    (d / "main.js").write_text("console.log('x')")
    return d


def test_serves_index_at_root(tmp_path, dist):
    with TestClient(create_app(_settings(tmp_path, dist))) as c:
        r = c.get("/")
        assert r.status_code == 200
        assert "tour app" in r.text


def test_serves_static_assets(tmp_path, dist):
    with TestClient(create_app(_settings(tmp_path, dist))) as c:
        assert c.get("/main.js").status_code == 200


def test_unknown_path_falls_back_to_index(tmp_path, dist):
    """A single-page app owns its routes; deep links must not 404."""
    with TestClient(create_app(_settings(tmp_path, dist))) as c:
        r = c.get("/some/deep/route")
        assert r.status_code == 200
        assert "tour app" in r.text


def test_api_routes_still_win_over_the_spa_fallback(tmp_path, dist):
    with TestClient(create_app(_settings(tmp_path, dist))) as c:
        assert c.get("/api/health").json() == {"status": "ok"}
        assert c.get("/api/tours/nope").status_code == 404


def test_app_works_without_a_built_frontend(tmp_path):
    """The backend must still boot when the frontend has not been built."""
    with TestClient(create_app(_settings(tmp_path, tmp_path / "missing"))) as c:
        assert c.get("/api/health").status_code == 200
        assert c.get("/").status_code == 404
