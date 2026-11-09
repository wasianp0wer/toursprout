"""Passenger entry point and the egress diagnostic.

No test here touches the network: the diagnostic is driven through
`app.state.http_transport`, the same seam `test_tools.py` uses.
"""

from __future__ import annotations

import importlib.util
from pathlib import Path

import httpx
import pytest
from fastapi.testclient import TestClient

from app import tools
from app.config import Settings
from app.main import create_app

ROOT = Path(__file__).resolve().parents[2]


def _cfg(tmp_path):
    return Settings(content_dir=tmp_path, sessions_dir=tmp_path / "sessions",
                    frontend_dist=tmp_path / "nodist")


@pytest.fixture
def client(tmp_path):
    with TestClient(create_app(_cfg(tmp_path))) as c:
        yield c


def test_app_state_exists_without_a_lifespan(tmp_path):
    # Passenger never runs the ASGI lifespan, and a2wsgi has no lifespan
    # support. No `with` and no client: nothing enters a lifespan here.
    cfg = _cfg(tmp_path)
    assert create_app(cfg).state.cfg is cfg


def test_the_wsgi_callable_serves_a_request():
    # Runs on the host, where a2wsgi is installed. It is not in the dev venv.
    pytest.importorskip(
        "a2wsgi",
        reason="a2wsgi is installed on the Reclaim host (Passenger), not in this dev "
               "environment; run this test on the server to verify the WSGI bridge",
    )
    spec = importlib.util.spec_from_file_location("passenger_wsgi", ROOT / "passenger_wsgi.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    with httpx.Client(transport=httpx.WSGITransport(app=module.application),
                      base_url="http://testserver") as c:
        r = c.get("/api/health")
    assert r.json() == {"status": "ok"}


def _hosts():
    return ["graph.mapillary.com", "www.loc.gov",
            *[httpx.URL(m).host for m in tools.OVERPASS_MIRRORS]]


def test_egress_reports_every_host(client):
    seen = []

    def handler(request):
        seen.append(request.url.host)
        return httpx.Response(200)

    client.app.state.http_transport = httpx.MockTransport(handler)
    body = client.get("/api/diagnostics/egress").json()
    assert sorted(seen) == sorted(_hosts())
    assert set(body["hosts"]) == set(_hosts())
    assert all(v == {"status": 200} for v in body["hosts"].values())


def test_egress_one_failure_does_not_hide_the_others(client):
    def handler(request):
        host = request.url.host
        if host == "graph.mapillary.com":
            raise httpx.ConnectTimeout("dropped", request=request)
        if host == "www.loc.gov":
            return httpx.Response(403)
        if host == "overpass-api.de":
            raise RuntimeError("boom")
        return httpx.Response(200)

    client.app.state.http_transport = httpx.MockTransport(handler)
    r = client.get("/api/diagnostics/egress")
    assert r.status_code == 200
    hosts = r.json()["hosts"]
    assert set(hosts) == set(_hosts())
    assert "error" in hosts["graph.mapillary.com"]
    assert hosts["www.loc.gov"] == {"status": 403}
    assert "RuntimeError" in hosts["overpass-api.de"]["error"]
    assert hosts["overpass.kumi.systems"] == {"status": 200}


def test_egress_makes_no_call_at_rest(client):
    calls = []
    client.app.state.http_transport = httpx.MockTransport(
        lambda request: calls.append(request) or httpx.Response(200))
    client.get("/api/health")
    assert calls == []
