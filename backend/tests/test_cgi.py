"""The CGI entry point and the egress diagnostic.

The entry point is exercised the way Apache exercises it: an environ dict,
a byte stream in, a byte stream out. Nothing here spawns a process and
nothing here touches the network -- the diagnostic is driven through
`app.state.http_transport`, the same seam `test_tools.py` uses.
"""

from __future__ import annotations

import io
import json
import os
from pathlib import Path
from urllib.parse import quote

import httpx
import pytest
from a2wsgi import ASGIMiddleware
from fastapi.testclient import TestClient

from app import cgi, tools
from app.config import Settings
from app.main import create_app
from app.sessions import SID_COOKIE

ROOT = Path(__file__).resolve().parents[2]

# The same four magic bytes `test_session_cookie.py:36` uses, padded: enough
# for `store_media` to sniff a real JPEG.
JPEG = b"\xff\xd8\xff\xe0" + b"J" * 32

# What Apache hands a front-controller script: the request's own path is NOT
# in SCRIPT_NAME or PATH_INFO, which is the whole reason `cgi_environ` exists.
CGI_ENV = {
    "REQUEST_METHOD": "GET", "SERVER_NAME": "h", "SERVER_PORT": "443",
    "SERVER_PROTOCOL": "HTTP/1.1", "SCRIPT_NAME": "/app.cgi", "PATH_INFO": "",
    "QUERY_STRING": "", "HTTP_HOST": "h", "wsgi.url_scheme": "https",
}


def _cfg(tmp_path):
    return Settings(content_dir=tmp_path, sessions_dir=tmp_path / "sessions",
                    frontend_dist=tmp_path / "nodist")


def _wsgi(tmp_path):
    return ASGIMiddleware(create_app(_cfg(tmp_path)))


def _drive(wsgi_app, request_body=b"", **overrides):
    """Run one request through the CGI handler; return (headers, body, stderr)."""
    out, err = io.BytesIO(), io.StringIO()
    cgi.run(io.BytesIO(request_body), out, err,
            {**CGI_ENV, **overrides}, wsgi_app=wsgi_app)
    head, _, body = out.getvalue().partition(b"\r\n\r\n")
    return head.decode("latin-1"), body, err.getvalue()


@pytest.fixture
def client(tmp_path):
    with TestClient(create_app(_cfg(tmp_path))) as c:
        yield c


@pytest.fixture
def historian_media(tmp_path):
    """A real session with one awkwardly named file in it.

    Returns `(wsgi_app, sid)`: the bridged app the CGI handler will run, and
    the owning historian's sid. The two media tests below share this so the
    second one asks for the SAME file over the SAME app as the first, which
    is what makes its 404 mean containment rather than a missing file.
    """
    cfg = _cfg(tmp_path)
    app = create_app(cfg)
    with TestClient(app, base_url="https://testserver") as c:
        c.post("/api/session/new", json={"title": "T"})
        sid = c.cookies[SID_COOKIE]
    (cfg.sessions_dir / sid / "media" / "façade one.jpg").write_bytes(JPEG)
    return ASGIMiddleware(app), sid


# --- the CGI environment ------------------------------------------------


def test_the_path_comes_from_request_uri_not_path_info():
    env = cgi.cgi_environ({**CGI_ENV, "REQUEST_URI": "/api/health"})
    assert env["PATH_INFO"] == "/api/health"
    assert env["SCRIPT_NAME"] == ""


def test_a_query_string_is_not_part_of_the_path():
    env = cgi.cgi_environ({**CGI_ENV, "REQUEST_URI": "/api/session/examples?x=1"})
    assert env["PATH_INFO"] == "/api/session/examples"


def test_a_percent_encoded_utf8_filename_survives_the_bridge():
    # a2wsgi does PATH_INFO.encode("latin1").decode("utf8"), so PATH_INFO must
    # be the decoded BYTES read back as latin-1 -- not str.
    env = cgi.cgi_environ(
        {**CGI_ENV, "REQUEST_URI": "/tour-data/media/fa%C3%A7ade%20one.jpg"})
    assert env["PATH_INFO"].encode("latin-1").decode("utf-8") == \
        "/tour-data/media/façade one.jpg"


def test_without_a_request_uri_path_info_is_left_alone():
    env = cgi.cgi_environ({**CGI_ENV, "PATH_INFO": "/api/health"})
    assert env["PATH_INFO"] == "/api/health"


def test_an_empty_request_uri_counts_as_no_request_uri():
    # Apache always sets a non-empty REQUEST_URI; `is None` would nonetheless
    # let "" through and rewrite the path to nothing, 404ing every route.
    env = cgi.cgi_environ({**CGI_ENV, "REQUEST_URI": "", "PATH_INFO": "/api/health"})
    assert env["PATH_INFO"] == "/api/health"


@pytest.mark.parametrize("uri", [
    "/tour-data/media/%FF.jpg",       # percent-encoded, but not UTF-8
    "/tour-data/media/\udcff.jpg",    # a raw byte, as os.environ surrogate-escapes it
])
def test_a_byte_that_is_not_utf8_cannot_break_the_bridge(uri):
    # a2wsgi does exactly this and has no error handler, so whatever
    # `cgi_environ` produces must survive it: a path that cannot be UTF-8
    # cannot name a file we hold, so it becomes U+FFFD and the router 404s.
    env = cgi.cgi_environ({**CGI_ENV, "REQUEST_URI": uri})
    assert env["PATH_INFO"].encode("latin-1").decode("utf-8") == \
        "/tour-data/media/�.jpg"


def test_the_incoming_environ_is_not_mutated():
    # `main` passes `os.environ`; rewriting it in place would be a surprise.
    source = {**CGI_ENV, "REQUEST_URI": "/api/health"}
    cgi.cgi_environ(source)
    assert source["SCRIPT_NAME"] == "/app.cgi"
    assert source["PATH_INFO"] == ""


# --- the handler, end to end --------------------------------------------


def test_the_cgi_script_answers_a_dynamic_route(tmp_path):
    head, body, errors = _drive(_wsgi(tmp_path), REQUEST_URI="/api/health")
    assert head.startswith("Status: 200 OK")
    assert json.loads(body) == {"status": "ok"}
    assert errors == ""


@pytest.mark.parametrize("uri", [
    "/tour-data/media/%FF.jpg",
    "/tour-data/media/\udcff.jpg",
])
def test_a_malformed_path_is_a_404_not_a_crash(historian_media, uri):
    """A client that sends a byte which is not UTF-8 gets the router's 404.
    A 500 here would put a traceback in the host's error log -- which is as
    sensitive as `sessions_dir` -- for a request anyone can send."""
    app, _ = historian_media
    head, _, errors = _drive(app, REQUEST_URI=uri)
    assert head.startswith("Status: 404")
    assert errors == ""


def test_a_request_body_reaches_the_app(tmp_path):
    # Every other end-to-end test here is a bodiless GET, so nothing else
    # exercises `wsgi.input` and `CONTENT_LENGTH` through the handler.
    payload = json.dumps({"title": "A tour that arrived in a body"}).encode()
    head, body, errors = _drive(
        _wsgi(tmp_path), request_body=payload,
        REQUEST_METHOD="POST", REQUEST_URI="/api/session/new",
        CONTENT_TYPE="application/json", CONTENT_LENGTH=str(len(payload)))
    assert head.startswith("Status: 200 OK")
    assert json.loads(body)["title"] == "A tour that arrived in a body"
    assert errors == ""


def test_the_cgi_script_serves_a_historians_own_media_by_its_real_name(historian_media):
    """The whole point of Review Focus 1, end to end: a session, a file with a
    space and a ç in its name, fetched the way a browser would ask for it."""
    app, sid = historian_media
    head, body, _ = _drive(
        app,
        REQUEST_URI="/tour-data/media/" + quote("façade one.jpg"),
        HTTP_COOKIE=f"{SID_COOKIE}={sid}")
    assert head.startswith("Status: 200 OK")
    assert "content-type: image/jpeg" in head.lower()
    assert body == JPEG


def test_another_historian_cannot_read_it_through_cgi_either(historian_media):
    """Containment is not weakened by the new entry point: the same URL with
    a different cookie must not serve the file."""
    app, sid = historian_media
    other = "a" * 16
    assert other != sid  # a well-formed sid, so the 404 is containment
    url = "/tour-data/media/" + quote("façade one.jpg")
    head, body, _ = _drive(app, REQUEST_URI=url,
                           HTTP_COOKIE=f"{SID_COOKIE}={other}")
    assert head.startswith("Status: 404")
    assert body != JPEG
    # ... and the same URL over the same app, with the owner's cookie, does
    # serve it. Without this the 404 above could be a typo in the URL.
    owner_head, owner_body, _ = _drive(app, REQUEST_URI=url,
                                       HTTP_COOKIE=f"{SID_COOKIE}={sid}")
    assert owner_head.startswith("Status: 200 OK")
    assert owner_body == JPEG


def test_the_module_level_application_serves_a_request():
    # `application` is built at import time from `app.main.app`, so this is
    # also the check that importing the entry point does not explode.
    with httpx.Client(transport=httpx.WSGITransport(app=cgi.application),
                      base_url="http://testserver") as c:
        r = c.get("/api/health")
    assert r.json() == {"status": "ok"}


def test_app_state_exists_without_a_lifespan(tmp_path):
    # CGI never runs the ASGI lifespan, and a2wsgi has no lifespan support.
    # No `with` and no client: nothing enters a lifespan here.
    cfg = _cfg(tmp_path)
    assert create_app(cfg).state.cfg is cfg


class _Stream(io.StringIO):
    """A stdout stand-in with the `.buffer` `main` hands to the handler."""

    def __init__(self):
        super().__init__()
        self.buffer = io.BytesIO()


def test_main_hands_the_handler_the_right_three_streams(monkeypatch):
    """Transposing these is silent and ruinous: tracebacks would be written
    into stdin and request bodies read from the error log."""
    stdin, out, err = _Stream(), _Stream(), _Stream()
    monkeypatch.setattr(cgi.sys, "stdin", stdin)
    monkeypatch.setattr(cgi.sys, "stdout", out)
    monkeypatch.setattr(cgi.sys, "stderr", err)
    seen = {}
    monkeypatch.setattr(cgi, "run", lambda *a, **k: seen.update(args=a, kwargs=k))

    cgi.main()

    # Bytes in, bytes out, text for the log -- and the process's own environ.
    assert seen["args"] == (stdin.buffer, out.buffer, err, os.environ)
    assert seen["kwargs"] == {}


def test_a_crash_before_the_headers_reaches_the_browser_as_a_plain_500(monkeypatch):
    """A bad import on the host must not become "Premature end of script
    headers", and must not show the historian a traceback: a traceback can
    carry a sid, which is a credential and a recovery key."""
    sid = "0123456789abcdef"
    out, err = _Stream(), _Stream()
    monkeypatch.setattr(cgi.sys, "stdout", out)
    monkeypatch.setattr(cgi.sys, "stderr", err)

    def boom(*args, **kwargs):
        raise RuntimeError(f"no such session {sid}")

    monkeypatch.setattr(cgi, "run", boom)
    cgi.main()

    sent = out.getvalue()
    head, _, body = sent.partition("\r\n\r\n")
    assert head.startswith("Status: 500 Internal Server Error\r\n")
    assert "content-type:" in head.lower()
    assert body.strip() != ""
    assert "Traceback" not in sent
    assert "RuntimeError" not in sent
    assert sid not in sent
    logged = err.getvalue()
    assert "Traceback" in logged
    assert "RuntimeError" in logged


# --- the shipped artefact ------------------------------------------------


def test_the_apache_entry_script_is_executable_and_names_the_venv():
    """`app.cgi` is a deploy contract: Apache executes it, so the mode and the
    interpreter path are part of the shipped artefact, not cosmetics."""
    script = ROOT / "app.cgi"
    assert script.stat().st_mode & 0o111
    text = script.read_text()
    assert text.startswith("#!/bin/sh\n")
    assert ".venv/bin/python" in text
    assert "-m app.cgi" in text
    # The whole invocation, in one piece. `-P` is why `app/cgi.py` can claim
    # a file dropped beside this script cannot shadow a module -- without it
    # `-m` prepends the document root to `sys.path` -- and without
    # PYTHONPATH the module does not import at all. Asserted as one string
    # rather than as separate substrings because the comment above the line
    # also contains "-P", so a looser assertion passes without the flag.
    assert 'PYTHONPATH="$DIR/backend" exec "$DIR/.venv/bin/python" -P -m app.cgi' \
        in text


# --- the egress diagnostic ----------------------------------------------


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
