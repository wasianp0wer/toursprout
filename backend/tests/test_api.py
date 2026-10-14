from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from app.config import Settings
from app.main import create_app


@pytest.fixture
def client(tmp_path):
    overrides = Settings(mapillary_token="MLY|test-token", content_dir=tmp_path)
    with TestClient(create_app(overrides)) as c:
        yield c


def test_health(client):
    assert client.get("/api/health").json() == {"status": "ok"}
