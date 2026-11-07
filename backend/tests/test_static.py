from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from app.config import Settings
from app.main import create_app


def _settings(tmp_path, dist):
    return Settings(
        mapillary_token="MLY|t",
        content_dir=tmp_path,
        sessions_dir=tmp_path / "sessions",
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
        # An unmatched path under /api/ is a real 404, not the SPA shell.
        assert c.get("/api/nope").status_code == 404
        assert "tour app" not in c.get("/api/nope").text


def test_app_works_without_a_built_frontend(tmp_path):
    """The backend must still boot when the frontend has not been built."""
    with TestClient(create_app(_settings(tmp_path, tmp_path / "missing"))) as c:
        assert c.get("/api/health").status_code == 200
        assert c.get("/").status_code == 404


def test_index_is_not_cached(tmp_path, dist):
    """index.html names hashed bundles, so a cached copy pins the whole app to
    an old build. This silently served stale JavaScript during development."""
    with TestClient(create_app(_settings(tmp_path, dist))) as c:
        r = c.get("/")
        assert "no-cache" in r.headers.get("cache-control", "").lower()


def test_spa_fallback_is_not_cached(tmp_path, dist):
    with TestClient(create_app(_settings(tmp_path, dist))) as c:
        r = c.get("/some/deep/route")
        assert "no-cache" in r.headers.get("cache-control", "").lower()


def test_hashed_assets_stay_cacheable(tmp_path, dist):
    """Content-hashed filenames change when the content does, so they are safe
    to cache; only the HTML that names them must revalidate."""
    (dist / "main-ABC123.js").write_text("console.log('x')")
    with TestClient(create_app(_settings(tmp_path, dist))) as c:
        r = c.get("/main-ABC123.js")
        assert r.status_code == 200
        assert "no-cache" not in r.headers.get("cache-control", "").lower()
