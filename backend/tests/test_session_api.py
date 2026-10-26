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
    cfg = Settings(content_dir=tmp_path, frontend_dist=tmp_path / "nodist",
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
    cfg = Settings(content_dir=tmp_path / "content",
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


def test_new_refuses_with_409_when_a_tour_is_already_open(client):
    client.post("/api/session/new", json={"title": "First"})
    r = client.post("/api/session/new", json={"title": "Second"})
    assert r.status_code == 409
    assert "export" in r.json()["detail"]
    # The first tour must still be the one open.
    assert client.get("/api/session").json()["title"] == "First"


def test_new_with_force_discards_what_was_open(client):
    client.post("/api/session/new", json={"title": "First"})
    r = client.post("/api/session/new", json={"title": "Second", "force": True})
    assert r.status_code == 200
    assert client.get("/api/session").json()["title"] == "Second"


def test_put_tour_refuses_with_409_when_nothing_is_open(client):
    doc = {
        "id": "t", "schemaVersion": 2, "title": "T", "description": "",
        "attribution": [], "stops": [{
            "id": "s1", "order": 1, "title": "S", "summary": "sum",
            "location": {"lng": -77.3, "lat": 38.84}, "osmRef": None,
            "panorama": {"provider": "mapillary", "imageId": "1",
                         "bearing": 0.0, "cachedPath": None},
            "overlays": [],
        }],
    }
    r = client.put("/api/session/tour", json=doc)
    assert r.status_code == 409
    assert client.get("/api/session").json() == {"open": False}


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


def test_put_tour_accepts_a_document_shaped_by_the_editors_own_transforms(client):
    """The frontend's idea of a valid document is not evidence of anything —
    only the backend's validator is. This takes the skeleton a new session
    produces and applies the exact shapes frontend/src/app/editor/
    document-ops.ts's `addStop` and `addTextOverlay` produce (a cloned
    second stop, a text overlay with a default 'original' credit) rather
    than a shape this test invents, so a pass here is the real contract the
    whole editor depends on."""
    client.post("/api/session/new", json={"title": "My Tour"})
    doc = client.get("/tour-data/tour.json").json()
    first = doc["stops"][0]

    # Mirrors addStop: clone the previous stop's location and panorama
    # rather than inventing new ones, a blank placeholder summary, and no
    # OSM reference yet.
    second_stop = {
        "id": "stop-2",
        "order": 2,
        "title": "Second stop",
        "summary": "Describe this place.",
        "location": dict(first["location"]),
        "osmRef": None,
        "panorama": dict(first["panorama"]),
        "overlays": [],
    }
    # Mirrors addTextOverlay: a text overlay anchored at the stop's own
    # location, a placeholder body, and defaultCreditFor's fallback credit
    # for a tour with no `defaults` set.
    second_stop["overlays"].append({
        "id": "a-text-overlay",
        "kind": "text",
        "anchor": {
            "type": "geo",
            "lng": second_stop["location"]["lng"],
            "lat": second_stop["location"]["lat"],
            "altitudeM": 2,
        },
        "display": {"mode": "marker", "icon": "note"},
        "title": "A text overlay",
        "body": "Write something about this.",
        "mediaId": None,
        "credit": {
            "type": "original",
            "creator": "Unknown",
            "license": "All rights reserved",
        },
    })
    doc["stops"].append(second_stop)

    r = client.put("/api/session/tour", json=doc)
    assert r.status_code == 200
    saved = client.get("/tour-data/tour.json").json()
    assert len(saved["stops"]) == 2
    assert saved["stops"][1]["title"] == "Second stop"
    assert saved["stops"][1]["overlays"][0]["credit"]["type"] == "original"


def test_export_then_import_round_trips(client):
    client.post("/api/session/new", json={"title": "Exported"})
    blob = client.get("/api/session/export")
    assert blob.status_code == 200
    assert blob.headers["content-type"] == "application/zip"

    # Already exported, so discarding what's open now is safe; force says so.
    client.post("/api/session/new", json={"title": "Something Else", "force": True})
    r = client.post("/api/session/import",
                    files={"file": ("t.zip", blob.content, "application/zip")})
    assert r.status_code == 200
    assert client.get("/api/session").json()["title"] == "Exported"


def test_export_refuses_with_409_when_referenced_media_is_missing(client):
    """The export/import asymmetry: `_validate_tree` enforces "every
    referenced mediaId exists in media/" on import and nothing enforced it
    on export, so a broken save sat in the working directory until the
    author tried to reopen it. `PUT /api/session/tour` only validates the
    document's SCHEMA, not that its media exists, so it is possible to end
    up with a tour that references media nothing ever uploaded."""
    client.post("/api/session/new", json={"title": "My Tour"})
    doc = client.get("/tour-data/tour.json").json()
    doc["stops"][0]["overlays"] = [{
        "id": "o1", "kind": "image",
        "anchor": {"type": "geo", "lng": -77.3, "lat": 38.84, "altitudeM": 0.0},
        "display": {"mode": "marker", "icon": "photo"},
        "title": "Photo", "body": None, "mediaId": "never-uploaded.jpg",
        "credit": {"type": "original", "creator": "M", "license": "CC-BY-4.0"},
    }]
    assert client.put("/api/session/tour", json=doc).status_code == 200

    r = client.get("/api/session/export")
    assert r.status_code == 409
    assert "never-uploaded.jpg" in r.json()["detail"]


def test_importing_rubbish_is_a_400_and_keeps_the_open_tour(client):
    client.post("/api/session/new", json={"title": "Keep Me"})
    r = client.post("/api/session/import",
                    files={"file": ("x.zip", b"not a zip", "application/zip")})
    assert r.status_code == 400
    assert client.get("/api/session").json()["title"] == "Keep Me"


def test_importing_a_traversal_archive_is_refused(client):
    client.post("/api/session/new", json={"title": "Keep Me"})
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as zf:
        zf.writestr("tour.json", json.dumps({"id": "x"}))
        zf.writestr("../escape.txt", "pwned")
    r = client.post("/api/session/import",
                    files={"file": ("e.zip", buf.getvalue(), "application/zip")})
    assert r.status_code == 400
    assert "unsafe" in r.json()["detail"]
    # (No assertion about where "escape.txt" might have landed: extraction
    # stages under `$TMPDIR`, never under `tmp_path`, so a check phrased
    # against `tmp_path` could never fail either way. The 400 and the
    # "unsafe" message above are the real coverage.)


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


# --- CSRF defence in depth (I5) ----------------------------------------
#
# A multipart/form-data POST (and the plain POST/PUT the other two mutating
# routes take) is a CORS-simple request: the browser never preflights it, so
# `CORSMiddleware`'s origin allowlist runs too late to stop the side effect,
# only the response. `Sec-Fetch-Site: cross-site` is what a real browser
# sends when some OTHER page issued the request; refusing exactly that
# value is the guard under test here. Absence of the header (what curl,
# httpx and this test suite itself send on every other test in this file)
# must keep working — that is the whole reason every test above this
# section passes with no header at all.

def test_new_refuses_a_cross_site_request(client):
    r = client.post(
        "/api/session/new", json={"title": "Attacker"},
        headers={"Sec-Fetch-Site": "cross-site"},
    )
    assert r.status_code == 403
    assert client.get("/api/session").json() == {"open": False}


def test_put_tour_refuses_a_cross_site_request(client):
    client.post("/api/session/new", json={"title": "Keep Me"})
    doc = client.get("/tour-data/tour.json").json()
    doc["title"] = "Attacker"
    r = client.put(
        "/api/session/tour", json=doc,
        headers={"Sec-Fetch-Site": "cross-site"},
    )
    assert r.status_code == 403
    assert client.get("/api/session").json()["title"] == "Keep Me"


def test_import_refuses_a_cross_site_request(client):
    client.post("/api/session/new", json={"title": "Keep Me"})
    r = client.post(
        "/api/session/import",
        files={"file": ("t.zip", b"not a zip", "application/zip")},
        headers={"Sec-Fetch-Site": "cross-site"},
    )
    assert r.status_code == 403
    assert client.get("/api/session").json()["title"] == "Keep Me"


def test_a_same_site_request_is_not_refused(client):
    """Confirms the guard checks for the literal value `cross-site` rather
    than refusing anything unexpected: a same-origin request must keep
    working exactly like the no-header requests every other test sends."""
    r = client.post(
        "/api/session/new", json={"title": "Same Site"},
        headers={"Sec-Fetch-Site": "same-origin"},
    )
    assert r.status_code == 200


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


def test_publish_without_a_build_is_a_409(client):
    client.post("/api/session/new", json={"title": "My Tour"})
    r = client.get("/api/session/publish")
    assert r.status_code == 409
    assert "make build" in r.json()["detail"]


@pytest.fixture
def media_dir(client_with_frontend, tmp_path):
    """Opens a session and returns (client, its media directory)."""
    client_with_frontend.post("/api/session/new", json={"title": "My Tour"})
    return client_with_frontend, tmp_path / "content" / "work" / "media"


@pytest.fixture
def media_clip(media_dir):
    """Drops a distinguishable 1024-byte file into the open session's media
    directory, returning the client and the exact bytes written."""
    client, media_path = media_dir
    payload = bytes(range(256)) * 4  # 1024 distinguishable bytes
    (media_path / "clip.bin").write_bytes(payload)
    return client, payload


def test_tour_data_media_range_request_returns_a_slice(media_clip):
    """Range requests through the tour-data mount must work: this is the
    narration-audio guarantee, and it is also the permanent home of the
    range-request coverage that `test_media.py`'s hand-rolled handling in
    `/api/media/{id}` provided before Task 4 deleted it along with the
    frontend's last use of that route."""
    client, payload = media_clip
    r = client.get("/tour-data/media/clip.bin", headers={"Range": "bytes=10-19"})
    assert r.status_code == 206
    assert r.headers["content-range"] == "bytes 10-19/1024"
    assert r.content == payload[10:20]


def test_tour_data_media_full_request_returns_200(media_clip):
    client, payload = media_clip
    r = client.get("/tour-data/media/clip.bin")
    assert r.status_code == 200
    assert r.headers["accept-ranges"] == "bytes"
    assert r.content == payload


def test_tour_data_media_suffix_range(media_clip):
    client, payload = media_clip
    r = client.get("/tour-data/media/clip.bin", headers={"Range": "bytes=-100"})
    assert r.status_code == 206
    assert r.headers["content-range"] == "bytes 924-1023/1024"
    assert r.content == payload[-100:]


def test_tour_data_media_unsatisfiable_range_returns_416(media_clip):
    client, _ = media_clip
    r = client.get("/tour-data/media/clip.bin", headers={"Range": "bytes=5000-"})
    assert r.status_code == 416


def test_tour_data_media_missing_file_is_404(media_clip):
    client, _ = media_clip
    assert client.get("/tour-data/media/nope.bin").status_code == 404


@pytest.mark.parametrize("filename,content_type", [
    # media.py's deleted MEDIA_TYPES table mapped these; Python's stdlib
    # `mimetypes` disagrees with it (and with browsers) for exactly these
    # two extensions, which is why main.py overrides them at import time.
    # The narration audio actually shipped is .m4a, and its <audio> tag has
    # no `type` attribute to fall back on, so this is the one that matters
    # most, but .wav gets the same treatment so it is pinned too.
    ("narration.m4a", "audio/mp4"),
    ("clip.wav", "audio/wav"),
    # Unaffected by the override — stdlib already agrees with media.py here
    # — but real content ships as .jpg, so it is worth pinning too.
    ("photo.jpg", "image/jpeg"),
])
def test_tour_data_media_reports_a_browser_recognised_content_type(
    media_dir, filename, content_type
):
    client, media_path = media_dir
    (media_path / filename).write_bytes(b"not real media, just bytes")
    r = client.get(f"/tour-data/media/{filename}")
    assert r.status_code == 200
    assert r.headers["content-type"] == content_type


def test_tour_data_media_path_traversal_is_refused(media_clip):
    """StaticFiles, not a hand-rolled resolver, is now the only thing
    guarding this path. `_resolve_media`'s eight parametrized rejection
    cases went with it when media.py was deleted; this pins the same
    guarantee through the real mount instead of against a resolver that no
    longer exists.

    A literal `../../etc/passwd` in the URL is collapsed by the HTTP client
    itself before the request is even sent (every real browser does the
    same), so it never reaches the mount as a traversal attempt — it lands
    on the unrelated path `/etc/passwd`, which the SPA catch-all answers
    with its own shell page. That case is asserted here anyway, purely to
    pin that no passwd content ever comes back. The percent-encoded variant
    is the real test: it reaches `StaticFiles` with the traversal sequence
    intact, and must be refused there.
    """
    client, payload = media_clip

    r = client.get("/tour-data/media/../../../../../../etc/passwd")
    assert b"root:" not in r.content

    r = client.get("/tour-data/media/%2e%2e%2f%2e%2e%2f%2e%2e%2fetc%2fpasswd")
    assert r.status_code == 404
    assert b"root:" not in r.content

    r = client.get("/tour-data/media/..%2f..%2f..%2fetc%2fpasswd")
    assert r.status_code == 404
    assert b"root:" not in r.content

    # The legitimate file must still be reachable afterward.
    assert client.get("/tour-data/media/clip.bin").content == payload


JPEG = b"\xff\xd8\xff\xe0" + b"J" * 32


def test_upload_media_stores_and_reports_it(client):
    client.post("/api/session/new", json={"title": "T"})
    r = client.post("/api/session/media",
                    files={"file": ("../../x.html", JPEG, "text/html")})
    assert r.status_code == 200
    body = r.json()
    assert body["mediaId"].endswith(".jpg") and "/" not in body["mediaId"]
    assert body["mediaCount"] == 1
    assert body["orphanCount"] == 1


def test_upload_media_refuses_a_non_media_payload_with_400(client):
    client.post("/api/session/new", json={"title": "T"})
    r = client.post("/api/session/media",
                    files={"file": ("a.jpg", b"<script>x</script>", "image/jpeg")})
    assert r.status_code == 400
    assert "not an allowed" in r.json()["detail"]
    assert client.get("/api/session").json()["mediaCount"] == 0


def test_upload_media_without_a_tour_is_409(client):
    r = client.post("/api/session/media", files={"file": ("a.jpg", JPEG)})
    assert r.status_code == 409


def test_upload_media_refuses_a_cross_site_request(client):
    client.post("/api/session/new", json={"title": "T"})
    r = client.post("/api/session/media", files={"file": ("a.jpg", JPEG)},
                    headers={"Sec-Fetch-Site": "cross-site"})
    assert r.status_code == 403
    assert client.get("/api/session").json()["mediaCount"] == 0


def test_upload_media_oversize_is_400_and_leaves_no_temp_file(client, monkeypatch, tmp_path):
    import tempfile

    import app.media_store as ms
    monkeypatch.setattr(ms, "MAX_FILE_BYTES", 10)
    monkeypatch.setattr(tempfile, "tempdir", str(tmp_path / "spool"))
    (tmp_path / "spool").mkdir()
    client.post("/api/session/new", json={"title": "T"})
    r = client.post("/api/session/media", files={"file": ("a.jpg", JPEG)})
    assert r.status_code == 400
    assert list((tmp_path / "spool").iterdir()) == []


def test_upload_media_spool_failure_is_400_and_leaves_no_temp_file(client, monkeypatch, tmp_path):
    import shutil
    import tempfile
    monkeypatch.setattr(tempfile, "tempdir", str(tmp_path / "spool"))
    (tmp_path / "spool").mkdir()
    def boom(*a, **k):
        raise OSError("disk full")
    monkeypatch.setattr(shutil, "copyfileobj", boom)
    client.post("/api/session/new", json={"title": "T"})
    r = client.post("/api/session/media", files={"file": ("a.jpg", JPEG)})
    assert r.status_code == 400
    assert list((tmp_path / "spool").iterdir()) == []
