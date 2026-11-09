"""The session is keyed on a cookie, so two historians cannot collide.

Hosted on shared hosting, one global `Session` meant one open tour for
everybody and the last save winning. These tests are the isolation
guarantee: two clients against the SAME `Settings` must see two tours, and
neither may reach the other's media by any URL.

`base_url` is https here, and in the three other session test files, because
the cookie is `Secure`: `http.cookiejar.DefaultCookiePolicy.return_ok_secure`
refuses to SEND a secure cookie over an insecure request, so over the
default `http://testserver` the jar would store the cookie and then never
send it back, and every test below would pass vacuously or fail for the
wrong reason.
"""

from __future__ import annotations

import io
import json
import os
import shutil
import zipfile

import pytest
from fastapi.testclient import TestClient

from app.config import Settings
from app.main import create_app
from app.sessions import COOKIE_MAX_AGE, SID_COOKIE, valid_sid

from .test_bundle import BUNDLE_VERSION, _minimal_doc

HTTPS = "https://testserver"
# The same four magic bytes `test_session_api.py` uses, padded: enough for
# `store_media` to sniff a real JPEG.
JPEG = b"\xff\xd8\xff\xe0" + b"J" * 32


@pytest.fixture
def cfg(tmp_path):
    return Settings(content_dir=tmp_path, sessions_dir=tmp_path / "sessions",
                    frontend_dist=tmp_path / "nodist",
                    mapillary_token="test-token")


@pytest.fixture
def client(cfg):
    with TestClient(create_app(cfg), base_url=HTTPS) as c:
        yield c


def session_dirs(cfg):
    """The session directories, counted apart from the sweep's own stamp.

    `.last-sweep` is a sibling of the sessions, not one of them: it records
    when the sweep last ran. It fails `valid_sid`, which is also how `sweep`
    passes it over, so that is what distinguishes it here too.
    """
    return [p for p in cfg.sessions_dir.iterdir() if valid_sid(p.name)]


def session_path(client, cfg):
    """Where this client's session actually lives, read off its own cookie."""
    return cfg.sessions_dir / client.cookies[SID_COOKIE]


# --- isolation: the whole point of the task ------------------------------


def test_two_clients_get_their_own_tours(cfg):
    a = TestClient(create_app(cfg), base_url=HTTPS)
    b = TestClient(create_app(cfg), base_url=HTTPS)
    a.post("/api/session/new", json={"title": "Alice"})
    assert a.get("/api/session").json()["title"] == "Alice"
    assert b.get("/api/session").json() == {"open": False}
    b.post("/api/session/new", json={"title": "Bob"})
    assert a.get("/api/session").json()["title"] == "Alice"
    assert b.get("/api/session").json()["title"] == "Bob"


def test_two_clients_get_their_own_directories(cfg):
    a = TestClient(create_app(cfg), base_url=HTTPS)
    b = TestClient(create_app(cfg), base_url=HTTPS)
    a.get("/api/session")
    b.get("/api/session")
    assert a.cookies[SID_COOKIE] != b.cookies[SID_COOKIE]
    assert len(session_dirs(cfg)) == 2


def test_a_second_clients_new_tour_does_not_touch_the_first(cfg):
    """The last-save-wins failure, stated directly: `b` opening a tour must
    not reach into `a`'s document."""
    a = TestClient(create_app(cfg), base_url=HTTPS)
    b = TestClient(create_app(cfg), base_url=HTTPS)
    a.post("/api/session/new", json={"title": "Alice"})
    doc = a.get("/tour-data/tour.json").json()
    doc["title"] = "Alice, renamed"
    assert a.put("/api/session/tour", json=doc).status_code == 200

    b.post("/api/session/new", json={"title": "Bob"})
    assert a.get("/tour-data/tour.json").json()["title"] == "Alice, renamed"
    assert b.get("/tour-data/tour.json").json()["title"] == "Bob"


# --- the cookie ----------------------------------------------------------


def test_a_cookie_is_set_on_first_contact(client):
    r = client.get("/api/session")
    assert valid_sid(r.cookies[SID_COOKIE])


def test_the_cookie_is_httponly_secure_lax_and_long_lived(client):
    header = client.get("/api/session").headers["set-cookie"]
    assert "HttpOnly" in header and "Secure" in header
    assert "samesite=lax" in header.lower()
    assert f"Max-Age={COOKIE_MAX_AGE}" in header


def test_one_browser_one_session_directory(client, cfg):
    client.get("/api/session")
    client.get("/api/session")
    client.get("/api/session")
    assert len(session_dirs(cfg)) == 1


def test_a_resolved_session_is_not_re_minted(client):
    """The sid is a recovery key (task 7), so resolving must not rotate it."""
    first = client.get("/api/session").cookies[SID_COOKIE]
    client.get("/api/session")
    assert client.cookies[SID_COOKIE] == first


def test_a_cookie_whose_directory_is_gone_reads_as_closed(client, cfg):
    """Closed, and still the SAME session: a re-minted one would also answer
    `{"open": false}`, so without the sid assertions this would only prove
    "not a 500". Keeping the sid is what task 7's recovery key depends on —
    a historian whose directory was swept must still be able to read their
    key back, not be silently handed a new one."""
    client.post("/api/session/new", json={"title": "T"})
    before = client.cookies[SID_COOKIE]
    shutil.rmtree(cfg.sessions_dir)

    r = client.get("/api/session")
    assert r.json() == {"open": False}   # not a 500
    assert "set-cookie" not in r.headers
    assert client.cookies[SID_COOKIE] == before


def test_a_forged_sid_is_refused(client):
    client.cookies.set(SID_COOKIE, "../../etc")
    assert client.get("/api/session").status_code in (200, 400)
    assert client.get("/api/session").json()["open"] is False


@pytest.mark.parametrize("bad", ["", "../../etc", "0123456789ABCDEF", "short",
                                 "0123456789abcdef0", "0123456789abcde/"])
def test_a_forged_sid_never_resolves_to_a_directory(client, cfg, bad):
    """Whatever the cookie says, the answer is a session of this client's
    own — never a path built from caller-controlled text."""
    client.cookies.set(SID_COOKIE, bad)
    r = client.get("/api/session")
    assert r.json() == {"open": False}
    # Read off the RESPONSE, not the jar, which now holds two `tour_sid`
    # cookies: a fresh, well-formed sid was minted in its place.
    assert valid_sid(r.cookies[SID_COOKIE])


# --- the minting boundary ------------------------------------------------


def test_the_viewer_config_is_written_at_mint_time(client, cfg):
    """It used to be written in the lifespan, which `a2wsgi` never runs."""
    client.get("/api/session")
    config = json.loads((session_path(client, cfg) / "config.json").read_text())
    assert config["mapillaryToken"] == "test-token"
    assert "tileUrl" in config and "attribution" in config


def test_new_mints_so_the_tour_it_creates_is_reachable(client):
    """A creating route has nowhere safe to write without a cookie: a shared
    placeholder collides, and an un-cookied sid is a tour the browser can
    never reach again. `docs/HANDOFF.md` documents this as the first call in
    a cookieless terminal flow, too."""
    assert client.post("/api/session/new", json={"title": "T"}).status_code == 200
    assert valid_sid(client.cookies[SID_COOKIE])
    assert client.get("/api/session").json()["title"] == "T"


def test_import_files_mints_so_the_tour_it_creates_is_reachable(client):
    res = client.post("/api/session/import-files", files=[
        ("files", ("tour.json", json.dumps(_minimal_doc("photo.jpg")).encode(),
                   "application/json")),
        ("files", ("media/photo.jpg", JPEG, "image/jpeg")),
    ])
    assert res.status_code == 200
    assert valid_sid(client.cookies[SID_COOKIE])
    assert client.get("/api/session").json()["mediaCount"] == 1


def test_a_cross_site_post_is_refused_before_it_mints(client, cfg):
    """`_reject_cross_site` is a route-level dependency, and FastAPI solves
    those before the signature's own. That ordering is what makes minting on
    a POST safe: a cross-site POST never reaches `mint_session`, so this
    opens no door that `GET /api/session` did not already open."""
    r = client.post("/api/session/new", json={"title": "Attacker"},
                    headers={"Sec-Fetch-Site": "cross-site"})
    assert r.status_code == 403
    assert client.cookies.get(SID_COOKIE) is None
    assert not cfg.sessions_dir.exists()


def test_import_mints_so_the_bundle_it_opens_is_reachable(client):
    """The `import` route is the only `async def` among the four that mint,
    so the injected `Response` carrying the Set-Cookie is worth pinning on
    this one specifically."""
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as zf:
        zf.writestr("tour.json", json.dumps(_minimal_doc("m.jpg")))
        zf.writestr("bundle.json", json.dumps(
            {"bundleVersion": BUNDLE_VERSION, "tourId": "t"}))
        zf.writestr("media/m.jpg", JPEG)
    res = client.post("/api/session/import",
                      files={"file": ("t.zip", buf.getvalue(), "application/zip")})
    assert res.status_code == 200, res.text
    assert valid_sid(client.cookies[SID_COOKIE])
    assert client.get("/api/session").json()["mediaCount"] == 1
    assert client.get("/tour-data/media/m.jpg").status_code == 200


def test_put_tour_does_not_mint(client, cfg):
    """Decision 1: every route that is not creating a tour resolves or
    fails. A cookieless PUT gets the existing 409, not a new session."""
    r = client.put("/api/session/tour", json={"id": "x"})
    assert r.status_code == 409
    assert "no tour is open" in r.json()["detail"]
    assert client.cookies.get(SID_COOKIE) is None
    assert not cfg.sessions_dir.exists()


@pytest.mark.parametrize("method,path,kwargs", [
    ("delete", "/api/session", {}),
    ("post", "/api/session/media",
     {"files": {"file": ("a.jpg", JPEG, "image/jpeg")}}),
    ("get", "/api/session/export", {}),
    ("get", "/api/session/publish", {}),
])
def test_a_resolve_only_route_mints_nothing(client, cfg, method, path, kwargs):
    r = getattr(client, method)(path, **kwargs)
    assert r.status_code == 409, r.text
    assert client.cookies.get(SID_COOKIE) is None
    assert not cfg.sessions_dir.exists()


# --- /tour-data ----------------------------------------------------------


def test_tour_data_does_not_mint(client, cfg):
    assert client.get("/tour-data/tour.json").status_code == 404
    assert not cfg.sessions_dir.exists() or list(cfg.sessions_dir.iterdir()) == []


def test_tour_data_with_an_unknown_sid_is_404_and_mints_nothing(client, cfg):
    client.cookies.set(SID_COOKIE, "0123456789abcdef")
    assert client.get("/tour-data/tour.json").status_code == 404
    assert not cfg.sessions_dir.exists()


def test_tour_data_with_a_forged_sid_is_404(client):
    client.cookies.set(SID_COOKIE, "../../etc")
    assert client.get("/tour-data/tour.json").status_code == 404


def test_tour_data_serves_only_this_sessions_media(cfg):
    """Anti-goal: one historian reading another's media, by URL or otherwise.
    A mediaId is content-addressed, so Alice's is perfectly guessable."""
    alice = TestClient(create_app(cfg), base_url=HTTPS)
    bob = TestClient(create_app(cfg), base_url=HTTPS)
    alice.post("/api/session/new", json={"title": "Alice"})
    media_id = alice.post(
        "/api/session/media", files={"file": ("a.jpg", JPEG, "image/jpeg")}
    ).json()["mediaId"]
    assert alice.get(f"/tour-data/media/{media_id}").status_code == 200

    bob.post("/api/session/new", json={"title": "Bob"})
    assert bob.get(f"/tour-data/media/{media_id}").status_code == 404
    assert bob.get("/tour-data/tour.json").json()["title"] == "Bob"


def test_tour_data_refuses_a_traversal_path(client):
    client.post("/api/session/new", json={"title": "T"})
    assert client.get("/tour-data/../../../etc/passwd").status_code in (403, 404)


@pytest.mark.parametrize("escape", [
    # Percent-encoded, so the sequence survives the client and reaches the
    # route intact — the literal form is collapsed by httpx before it is sent.
    "%2e%2e%2f%2e%2e%2f%2e%2e%2fetc%2fpasswd",
    "..%2f..%2f..%2fetc%2fpasswd",
    "media%2f..%2f..%2f..%2fetc%2fpasswd",
    # An absolute path: `session.path / "/etc/passwd"` is `/etc/passwd`,
    # because pathlib discards the left side. The resolve guard is what
    # catches it.
    "%2fetc%2fpasswd",
])
def test_tour_data_refuses_an_escaping_path(client, escape):
    client.post("/api/session/new", json={"title": "T"})
    r = client.get(f"/tour-data/{escape}")
    assert r.status_code == 404
    assert b"root:" not in r.content
    # The legitimate document must still be reachable afterwards.
    assert client.get("/tour-data/tour.json").json()["title"] == "T"


def test_tour_data_refuses_another_sessions_directory_by_path(cfg):
    """The session directories are siblings, so `../<other sid>/tour.json` is
    the shortest route from one historian's cookie to another's document."""
    alice = TestClient(create_app(cfg), base_url=HTTPS)
    bob = TestClient(create_app(cfg), base_url=HTTPS)
    alice.post("/api/session/new", json={"title": "Alice"})
    bob.post("/api/session/new", json={"title": "Bob"})
    alice_sid = alice.cookies[SID_COOKIE]
    r = bob.get(f"/tour-data/..%2f{alice_sid}%2ftour.json")
    assert r.status_code == 404
    assert b"Alice" not in r.content


def test_tour_data_sends_nosniff_and_accepts_a_range(client, cfg):
    """Range is the narration-audio guarantee the StaticFiles mount gave for
    free; the historians' own recorded audio needs it just as much."""
    client.post("/api/session/new", json={"title": "T"})
    payload = bytes(range(256)) * 4  # 1024 distinguishable bytes
    (session_path(client, cfg) / "media" / "clip.bin").write_bytes(payload)

    full = client.get("/tour-data/media/clip.bin")
    assert full.status_code == 200
    assert full.headers["x-content-type-options"] == "nosniff"
    assert full.headers["accept-ranges"] == "bytes"
    assert full.content == payload

    part = client.get("/tour-data/media/clip.bin", headers={"Range": "bytes=10-19"})
    assert part.status_code == 206
    assert part.headers["content-range"] == "bytes 10-19/1024"
    assert part.content == payload[10:20]
    assert part.headers["x-content-type-options"] == "nosniff"

    suffix = client.get("/tour-data/media/clip.bin", headers={"Range": "bytes=-100"})
    assert suffix.status_code == 206
    assert suffix.content == payload[-100:]

    assert client.get("/tour-data/media/clip.bin",
                      headers={"Range": "bytes=5000-"}).status_code == 416


def test_tour_data_does_not_serve_a_directory(client):
    client.post("/api/session/new", json={"title": "T"})
    assert client.get("/tour-data/media").status_code == 404
    assert client.get("/tour-data/").status_code == 404


# --- no lifespan (decision 4) -------------------------------------------


def test_the_app_works_without_its_lifespan_ever_running(cfg):
    """`a2wsgi` never runs the ASGI lifespan, so nothing may depend on it.
    No `with` block here: that is the whole assertion."""
    c = TestClient(create_app(cfg), base_url=HTTPS)
    assert c.get("/api/health").json() == {"status": "ok"}
    assert c.get("/api/session").json() == {"open": False}
    assert c.post("/api/session/new", json={"title": "T"}).status_code == 200
    assert c.get("/tour-data/tour.json").json()["title"] == "T"


def test_there_is_no_single_shared_session_on_app_state(cfg):
    app = create_app(cfg)
    assert app.state.cfg is cfg          # set in create_app's body, not a lifespan
    assert not hasattr(app.state, "session")


def test_a_sid_set_by_hand_really_reaches_the_server(cfg):
    """Guards the forged-sid tests above from passing vacuously: httpx will
    happily STORE a cookie it then never sends (any `domain=` argument does
    exactly that), which would make every assertion about a forged cookie
    meaningless. Carrying one client's sid over to another must reopen the
    same tour."""
    alice = TestClient(create_app(cfg), base_url=HTTPS)
    alice.post("/api/session/new", json={"title": "Alice"})
    sid = alice.cookies[SID_COOKIE]

    carried = TestClient(create_app(cfg), base_url=HTTPS)
    carried.cookies.set(SID_COOKIE, sid)
    assert carried.get("/api/session").json()["title"] == "Alice"


def test_tour_data_answers_a_head_request(client, cfg):
    """The StaticFiles mount answered HEAD, and some media players issue one
    before a ranged GET, so the route keeps it."""
    client.post("/api/session/new", json={"title": "T"})
    (session_path(client, cfg) / "media" / "clip.bin").write_bytes(b"x" * 64)
    r = client.head("/tour-data/media/clip.bin")
    assert r.status_code == 200
    assert r.headers["content-length"] == "64"
    assert r.headers["x-content-type-options"] == "nosniff"
    assert r.content == b""
    assert client.head("/tour-data/media/nope.bin").status_code == 404


def test_tour_data_reports_a_browser_recognised_content_type(client, cfg):
    """`FileResponse` must honour the two `mimetypes` overrides pinned at the
    top of `main.py`, which the StaticFiles mount used to be what honoured."""
    client.post("/api/session/new", json={"title": "T"})
    media = session_path(client, cfg) / "media"
    for name, expected in [("narration.m4a", "audio/mp4"), ("clip.wav", "audio/wav"),
                           ("photo.jpg", "image/jpeg")]:
        (media / name).write_bytes(b"not real media, just bytes")
        r = client.get(f"/tour-data/media/{name}")
        assert r.status_code == 200
        assert r.headers["content-type"] == expected, name


def test_tour_data_answers_304_to_a_validator_it_advertised(client, cfg):
    """`FileResponse` sends `ETag` and `Last-Modified` but ignores them on
    the way back, where the `StaticFiles` mount answered 304. On shared
    hosting with a media-heavy tour that meant every editor reload
    re-transferred every panorama and audio clip."""
    client.post("/api/session/new", json={"title": "T"})
    first = client.get("/tour-data/tour.json")
    assert first.status_code == 200
    etag = first.headers["etag"]

    again = client.get("/tour-data/tour.json", headers={"If-None-Match": etag})
    assert again.status_code == 304
    assert again.content == b""
    assert again.headers["etag"] == etag
    assert again.headers["x-content-type-options"] == "nosniff"

    # A weak validator, and one inside a list, are the same file.
    assert client.get("/tour-data/tour.json",
                      headers={"If-None-Match": f"W/{etag}"}).status_code == 304
    assert client.get("/tour-data/tour.json",
                      headers={"If-None-Match": f'"other", {etag}'}).status_code == 304

    # A stale validator still gets the body.
    stale = client.get("/tour-data/tour.json", headers={"If-None-Match": '"nope"'})
    assert stale.status_code == 200
    assert stale.json()["title"] == "T"


def test_tour_data_answers_304_to_if_modified_since(client, cfg):
    """The mount honoured this one too, so it is not dropped on the way."""
    client.post("/api/session/new", json={"title": "T"})
    first = client.get("/tour-data/tour.json")
    last_modified = first.headers["last-modified"]

    r = client.get("/tour-data/tour.json",
                   headers={"If-Modified-Since": last_modified})
    assert r.status_code == 304
    assert r.content == b""

    # An etag that does not match wins over a satisfied If-Modified-Since,
    # per RFC 9110: the stronger validator decides, so this is a 200.
    both = client.get("/tour-data/tour.json", headers={
        "If-None-Match": '"nope"', "If-Modified-Since": last_modified})
    assert both.status_code == 200

    old = client.get("/tour-data/tour.json",
                     headers={"If-Modified-Since": "Thu, 01 Jan 1970 00:00:00 GMT"})
    assert old.status_code == 200


def test_tour_data_media_still_revalidates_and_ranges_together(client, cfg):
    """A matching etag answers 304 even alongside `Range`, and the range
    still works when the validator does not match."""
    client.post("/api/session/new", json={"title": "T"})
    payload = bytes(range(256)) * 4
    (session_path(client, cfg) / "media" / "clip.bin").write_bytes(payload)
    etag = client.get("/tour-data/media/clip.bin").headers["etag"]

    assert client.get("/tour-data/media/clip.bin", headers={
        "Range": "bytes=10-19", "If-None-Match": etag}).status_code == 304

    part = client.get("/tour-data/media/clip.bin", headers={
        "Range": "bytes=10-19", "If-None-Match": '"nope"'})
    assert part.status_code == 206
    assert part.content == payload[10:20]


# --- the recovery key (task 7) -------------------------------------------


def test_the_summary_carries_the_recovery_key(client):
    client.post("/api/session/new", json={"title": "T"})
    summary = client.get("/api/session").json()
    assert valid_sid(summary["recoveryKey"])
    assert summary["recoveryKey"] == client.cookies[SID_COOKIE]


def test_a_closed_summary_carries_no_recovery_key(client):
    """Nothing is open, so there is nothing to recover and nothing to write
    down; the key is only shown for a tour that exists."""
    assert client.get("/api/session").json() == {"open": False}


def test_reattaching_reopens_the_same_tour_from_a_fresh_browser(cfg):
    a = TestClient(create_app(cfg), base_url=HTTPS)
    a.post("/api/session/new", json={"title": "Lost"})
    key = a.get("/api/session").json()["recoveryKey"]

    # A new laptop: it has already visited, so it holds a cookie of its own
    # for an empty session, which reattaching must replace.
    b = TestClient(create_app(cfg), base_url=HTTPS)
    b.get("/api/session")
    own = b.cookies[SID_COOKIE]
    assert own != key

    r = b.post("/api/session/reattach", json={"key": key})
    assert r.status_code == 200
    assert r.json()["title"] == "Lost"
    assert r.cookies[SID_COOKIE] == key
    assert b.get("/api/session").json()["title"] == "Lost"
    assert b.get("/api/session").json()["recoveryKey"] == key


def test_reattaching_works_with_no_cookie_at_all(cfg):
    a = TestClient(create_app(cfg), base_url=HTTPS)
    a.post("/api/session/new", json={"title": "Lost"})
    key = a.cookies[SID_COOKIE]

    b = TestClient(create_app(cfg), base_url=HTTPS)
    assert SID_COOKIE not in b.cookies
    assert b.post("/api/session/reattach", json={"key": key}).status_code == 200
    assert b.get("/api/session").json()["title"] == "Lost"
    # It joined the existing directory; it did not mint another.
    assert len(session_dirs(cfg)) == 1


def test_an_unknown_key_is_404_and_opens_nothing(client, cfg):
    r = client.post("/api/session/reattach", json={"key": "0123456789abcdef"})
    assert r.status_code == 404
    assert r.json()["detail"] == "there is no tour with that recovery key"
    assert "set-cookie" not in r.headers
    assert client.get("/api/session").json()["open"] is False
    assert not (cfg.sessions_dir / "0123456789abcdef").exists()


def test_a_key_naming_a_closed_session_is_404(cfg):
    """A directory with no tour in it (a visit that never opened one) is not
    something to attach to: the historian would be handed a blank tour's
    worth of nothing and could mistake it for a recovered one."""
    a = TestClient(create_app(cfg), base_url=HTTPS)
    a.get("/api/session")
    b = TestClient(create_app(cfg), base_url=HTTPS)
    r = b.post("/api/session/reattach", json={"key": a.cookies[SID_COOKIE]})
    assert r.status_code == 404


@pytest.mark.parametrize("bad", ["", "..", "a/b", "nope", "0123456789ABCDEF",
                                 "0123456789abcdef\n", 12345, None, ["x"]])
def test_a_malformed_key_is_400(client, cfg, bad):
    r = client.post("/api/session/reattach", json={"key": bad})
    assert r.status_code == 400
    assert r.json()["detail"] == "that is not a recovery key"
    assert "set-cookie" not in r.headers
    # Checked BEFORE the GET below, which mints a directory of its own: a
    # refused key must not have created any session, and `open` is False
    # for a minted blank one too, so only the directory proves it.
    assert not cfg.sessions_dir.exists() or list(cfg.sessions_dir.iterdir()) == []
    assert client.get("/api/session").json()["open"] is False


@pytest.mark.parametrize("body", [{}, [], "x"])
def test_a_body_without_a_key_is_400(client, body):
    assert client.post("/api/session/reattach", json=body).status_code == 400


def test_a_refusal_never_echoes_the_key(client):
    hostile = "<script>alert(1)</script>"
    r = client.post("/api/session/reattach", json={"key": hostile})
    assert hostile not in r.text


def test_reattaching_refuses_to_discard_an_open_tour(cfg):
    a = TestClient(create_app(cfg), base_url=HTTPS)
    a.post("/api/session/new", json={"title": "Lost"})
    key = a.cookies[SID_COOKIE]

    b = TestClient(create_app(cfg), base_url=HTTPS)
    b.post("/api/session/new", json={"title": "Mine"})
    mine = b.cookies[SID_COOKIE]

    r = b.post("/api/session/reattach", json={"key": key})
    assert r.status_code == 409
    assert "export it first" in r.json()["detail"]
    assert "set-cookie" not in r.headers
    assert b.cookies[SID_COOKIE] == mine
    assert b.get("/api/session").json()["title"] == "Mine"


def test_the_409_comes_before_the_key_is_looked_at(client):
    """An open tour is refused whatever the key says, so a mistyped attempt
    teaches nothing about which keys exist."""
    client.post("/api/session/new", json={"title": "Mine"})
    for key in ("0123456789abcdef", "nope"):
        assert client.post("/api/session/reattach", json={"key": key}).status_code == 409


def test_reattach_is_refused_cross_site(client, cfg):
    r = client.post("/api/session/reattach", json={"key": "0123456789abcdef"},
                    headers={"Sec-Fetch-Site": "cross-site"})
    assert r.status_code == 403
    assert "set-cookie" not in r.headers


# --- the sweep, as the first mint triggers it -------------------------------


def _stale_dir(cfg, sid="c" * 16):
    d = cfg.sessions_dir / sid
    d.mkdir(parents=True)
    (d / "config.json").write_text("{}")
    old = 1_000_000_000
    os.utime(d / "config.json", (old, old))
    os.utime(d, (old, old))
    return d


def test_the_first_mint_sweeps_an_abandoned_directory(cfg):
    stale = _stale_dir(cfg)
    with TestClient(create_app(cfg), base_url=HTTPS) as c:
        assert c.get("/api/session").status_code == 200
    assert not stale.exists()


def test_a_second_mint_within_the_interval_does_not_sweep_but_one_after_does(
        cfg, monkeypatch):
    clock = [1_700_000_000.0]  # wall clock now, and after _stale_dir's 1_000_000_000
    monkeypatch.setattr("app.main._now", lambda: clock[0])
    with TestClient(create_app(cfg), base_url=HTTPS) as c:
        c.get("/api/session")
        stale = _stale_dir(cfg)
        c.cookies.clear()
        clock[0] += 60
        c.get("/api/session")
        assert stale.exists()
        c.cookies.clear()
        clock[0] += 3600
        c.get("/api/session")
        assert not stale.exists()


def test_the_throttle_holds_across_processes_not_just_within_one(cfg, monkeypatch):
    """Under CGI every request is a fresh interpreter, so a throttle in
    `app.state` would sweep on every cookieless mint. A fresh `create_app`
    per request is the closest this suite gets to that."""
    clock = [1_700_000_000.0]
    monkeypatch.setattr("app.main._now", lambda: clock[0])
    with TestClient(create_app(cfg), base_url=HTTPS) as c:
        c.get("/api/session")
    stale = _stale_dir(cfg)
    clock[0] += 60
    with TestClient(create_app(cfg), base_url=HTTPS) as c:  # new app, new state
        c.get("/api/session")
    assert stale.exists()


def test_a_stamp_that_cannot_be_written_does_not_sweep_on_every_request(
        cfg, monkeypatch):
    """Fail closed: if the stamp cannot be recorded, the walk is skipped
    rather than repeated on every mint."""
    monkeypatch.setattr("app.main.mark_swept", lambda *a, **kw: False)
    called = []
    monkeypatch.setattr("app.main.sweep", lambda *a, **kw: called.append(1))
    with TestClient(create_app(cfg), base_url=HTTPS) as c:
        for _ in range(2):
            c.cookies.clear()
            assert c.get("/api/session").status_code == 200
    assert called == []


def test_a_session_that_resolves_does_not_sweep(cfg):
    stale = _stale_dir(cfg)
    with TestClient(create_app(cfg), base_url=HTTPS) as c:
        c.cookies.set(SID_COOKIE, "d" * 16)
        c.get("/api/session")
    assert stale.exists()


def test_a_failing_sweep_does_not_fail_the_request(cfg, monkeypatch):
    def boom(*a, **kw):
        raise RuntimeError("disk on fire")

    monkeypatch.setattr("app.main.sweep", boom)
    with TestClient(create_app(cfg), base_url=HTTPS) as c:
        assert c.get("/api/session").status_code == 200
        assert SID_COOKIE in c.cookies


def test_a_failing_sweep_logs_the_type_and_never_the_sid(cfg, monkeypatch, caplog):
    sid = "e" * 16

    def boom(*a, **kw):
        raise RuntimeError(f"cannot read {sid}")

    monkeypatch.setattr("app.main.sweep", boom)
    with TestClient(create_app(cfg), base_url=HTTPS) as c:
        c.get("/api/session")
    assert "RuntimeError" in caplog.text
    assert sid not in caplog.text


def test_a_failing_entry_logs_the_type_and_never_the_sid(tmp_path, monkeypatch, caplog):
    from app import sessions
    sid = "f" * 16
    (tmp_path / sid).mkdir()

    def boom(*a, **kw):
        raise RuntimeError(f"cannot read {sid}")

    monkeypatch.setattr(sessions, "_newest_mtime", boom)
    sessions.sweep(tmp_path, without_tour_days=1, with_tour_days=90)
    assert "RuntimeError" in caplog.text
    assert sid not in caplog.text


@pytest.mark.parametrize("field", [
    "session_retention_days_with_tour", "session_retention_days_without_tour"])
@pytest.mark.parametrize("bad", [0, -1])
def test_a_non_positive_retention_is_refused(tmp_path, field, bad):
    with pytest.raises(ValueError):
        Settings(content_dir=tmp_path, sessions_dir=tmp_path / "s", **{field: bad})
