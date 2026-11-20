"""The three Omeka routes, against MockTransport and a fake resolver."""

from __future__ import annotations

import json
from pathlib import Path

import httpx
import pytest
from fastapi.testclient import TestClient

from app.config import Settings
from app.main import create_app

FIX = Path(__file__).parent / "fixtures" / "omeka"
SITE = "https://omeka.example"
JPEG = b"\xff\xd8\xff\xe0" + b"\x00" * 64


def PUBLIC(host: str, port: int) -> list[str]:
    return ["93.184.216.34"]


def PRIVATE(host: str, port: int) -> list[str]:
    return ["10.0.0.5"]


def fx(name: str) -> bytes:
    return (FIX / name).read_bytes()


@pytest.fixture
def client(tmp_path):
    cfg = Settings(content_dir=tmp_path, sessions_dir=tmp_path / "sessions",
                   frontend_dist=tmp_path / "nodist")
    with TestClient(create_app(cfg), base_url="https://testserver") as c:
        c.app.state.omeka_resolve = PUBLIC
        yield c


def mock(client, handler):
    seen: list[httpx.Request] = []

    def wrapped(request):
        seen.append(request)
        return handler(request)

    client.app.state.http_transport = httpx.MockTransport(wrapped)
    return seen


def api(request: httpx.Request) -> httpx.Response:
    path = request.url.path
    if path == "/api/site":
        return httpx.Response(200, content=fx("site.json"))
    if path == "/api/items":
        return httpx.Response(200, content=fx("items.json"),
                              headers={"Omeka-Total-Results": "6"})
    if path == "/api/files":
        return httpx.Response(200, content=fx("files-3.json"))
    if "/files/fullsize/" in path:
        return httpx.Response(200, content=JPEG)
    return httpx.Response(404)


BODIES = {
    "omeka-search": {"siteUrl": SITE, "query": "map"},
    "omeka-files": {"siteUrl": SITE, "itemId": 3},
    "omeka-import": {"siteUrl": SITE, "itemId": 3, "fileId": 3},
}


def open_tour(client):
    assert client.post("/api/session/new", json={"title": "T"}).status_code == 200


@pytest.mark.parametrize("tool", BODIES)
def test_cross_site_refused(client, tool):
    r = client.post(f"/api/tools/{tool}", json=BODIES[tool],
                    headers={"Sec-Fetch-Site": "cross-site"})
    assert r.status_code == 403


def test_search_live(client):
    mock(client, api)
    r = client.post("/api/tools/omeka-search", json=BODIES["omeka-search"])
    assert r.status_code == 200
    body = r.json()
    assert body["site"]["title"] == "Madelyn's Interests and Exhibits"
    assert body["total"] == 6
    assert body["page"] == 1


def test_search_api_disabled_message(client):
    mock(client, lambda r: httpx.Response(403, json={"message": "API is disabled"}))
    r = client.post("/api/tools/omeka-search", json=BODIES["omeka-search"])
    assert r.status_code == 409
    assert "Settings → API" in r.json()["detail"]


@pytest.mark.parametrize("query", ["", "   "])
def test_search_blank_query_422(client, query):
    r = client.post("/api/tools/omeka-search", json={**BODIES["omeka-search"], "query": query})
    assert r.status_code == 422


def test_files_live(client):
    mock(client, api)
    r = client.post("/api/tools/omeka-files", json=BODIES["omeka-files"])
    assert r.status_code == 200
    files = r.json()["files"]
    assert files[0]["kind"] == "image" and files[0]["importable"] is True


def test_import_stores_fullsize(client):
    open_tour(client)
    seen = mock(client, api)
    r = client.post("/api/tools/omeka-import", json=BODIES["omeka-import"])
    assert r.status_code == 200, r.text
    assert r.json()["mediaId"].endswith(".jpg")
    assert r.json()["open"] is True
    assert any("/files/fullsize/" in str(q.url) for q in seen)
    assert not any("/files/original/" in str(q.url) for q in seen)


def test_import_ignores_client_url(client):
    open_tour(client)
    seen = mock(client, api)
    r = client.post("/api/tools/omeka-import",
                    json={**BODIES["omeka-import"], "url": "http://evil/x.jpg"})
    assert r.status_code == 200
    assert not any(q.url.host == "evil" for q in seen)


def test_import_no_tour_409(client):
    mock(client, api)
    r = client.post("/api/tools/omeka-import", json=BODIES["omeka-import"])
    assert r.status_code == 409


def test_import_unknown_file_404(client):
    open_tour(client)
    mock(client, api)
    r = client.post("/api/tools/omeka-import", json={**BODIES["omeka-import"], "fileId": 999})
    assert r.status_code == 404
    assert r.json()["detail"] == "That file is no longer on the Omeka item."


def test_import_pdf_400(client):
    open_tour(client)
    pdf = json.loads(fx("files-3.json"))
    pdf[0]["mime_type"] = "application/pdf"
    pdf[0]["file_urls"].pop("fullsize")

    def handler(request):
        if request.url.path == "/api/files":
            return httpx.Response(200, json=pdf)
        return api(request)

    mock(client, handler)
    r = client.post("/api/tools/omeka-import", json=BODIES["omeka-import"])
    assert r.status_code == 400
    assert "PDF files can't be added to a tour" in r.json()["detail"]


def test_import_private_site_400(client):
    open_tour(client)
    client.app.state.omeka_resolve = PRIVATE
    seen = mock(client, api)
    r = client.post("/api/tools/omeka-import", json=BODIES["omeka-import"])
    assert r.status_code == 400
    assert seen == []
