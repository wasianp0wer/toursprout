from __future__ import annotations

import inspect
import json
import zipfile

import pytest
from fastapi.testclient import TestClient

from app import main
from app.bundle import BundleError
from app.config import Settings
from app.loose_import import _media_name
from app.main import create_app

from .test_bundle import JPEG, _minimal_doc


@pytest.fixture
def client(tmp_path):
    cfg = Settings(content_dir=tmp_path, frontend_dist=tmp_path / "nodist",
                   mapillary_token="test-token")
    with TestClient(create_app(cfg)) as c:
        yield c


def tour_json(media_id="photo.jpg") -> bytes:
    return json.dumps(_minimal_doc(media_id)).encode()


def test_imports_a_document_with_flat_media(client):
    res = client.post("/api/session/import-files", files=[
        ("files", ("tour.json", tour_json(), "application/json")),
        ("files", ("media/photo.jpg", JPEG, "image/jpeg")),
    ])
    assert res.status_code == 200
    assert res.json()["mediaCount"] == 1
    assert res.json()["warnings"] == []


def test_preserves_nested_media_paths(client, tmp_path):
    res = client.post("/api/session/import-files", files=[
        ("files", ("tour.json", tour_json("pano/p.jpg"), "application/json")),
        ("files", ("media/pano/p.jpg", JPEG, "image/jpeg")),
    ])
    assert res.status_code == 200
    assert (tmp_path / "work" / "media" / "pano" / "p.jpg").is_file()


def test_tour_json_may_arrive_after_the_media(client):
    res = client.post("/api/session/import-files", files=[
        ("files", ("media/photo.jpg", JPEG, "image/jpeg")),
        ("files", ("tour.json", tour_json(), "application/json")),
    ])
    assert res.status_code == 200


def test_refuses_a_drop_with_no_tour_json(client):
    res = client.post("/api/session/import-files", files=[
        ("files", ("media/photo.jpg", JPEG, "image/jpeg")),
    ])
    assert res.status_code == 400
    assert "tour.json" in res.json()["detail"]


def test_refuses_a_tour_json_that_is_not_json(client):
    res = client.post("/api/session/import-files", files=[
        ("files", ("tour.json", b"{nope", "application/json")),
    ])
    assert res.status_code == 400
    assert "tour.json" in res.json()["detail"]


def test_refuses_a_second_tour_json(client):
    res = client.post("/api/session/import-files", files=[
        ("files", ("tour.json", tour_json(), "application/json")),
        ("files", ("tour.json", tour_json(), "application/json")),
    ])
    assert res.status_code == 400


@pytest.mark.parametrize("bad", ["../escape.jpg", "/abs.jpg", "media/../../x.jpg",
                                 "media/./x.jpg", "notmedia/x.jpg", "media/a\\b.jpg",
                                 "media//x.jpg", "media", "media/"])
def test_refuses_unsafe_or_unexpected_paths(client, tmp_path, bad):
    res = client.post("/api/session/import-files", files=[
        ("files", ("tour.json", tour_json(), "application/json")),
        ("files", (bad, JPEG, "image/jpeg")),
    ])
    assert res.status_code == 400
    assert not (tmp_path / "escape.jpg").exists()
    assert client.get("/api/session").json()["open"] is False


def test_refuses_a_disallowed_media_type(client):
    res = client.post("/api/session/import-files", files=[
        ("files", ("tour.json", tour_json(), "application/json")),
        ("files", ("media/evil.html", b"<h1>hi</h1>", "text/html")),
    ])
    assert res.status_code == 400


def test_refuses_html_wearing_an_image_extension(client):
    res = client.post("/api/session/import-files", files=[
        ("files", ("tour.json", tour_json(), "application/json")),
        ("files", ("media/photo.jpg", b"<h1>hi</h1>", "image/jpeg")),
    ])
    assert res.status_code == 400


def test_refuses_a_drop_while_a_tour_is_open(client):
    """The hole the welcome screen's other two controls did not have.

    A *stale* welcome screen is ordinary: the author opened the app in two
    tabs and made a tour in one, so the other still shows the front door.
    There, *New empty tour* 409s and *Open example* 409s, both because
    replacing the working directory throws away the author's only copy of an
    unexported tour. A VALID drop is the case that mattered — it needs no
    refusal of its own to be stopped, so before this guard it simply
    succeeded, and the other tab's tour was gone without a word.
    """
    client.post("/api/session/new", json={"title": "Keep me"})
    res = client.post("/api/session/import-files", files=[
        ("files", ("tour.json", tour_json(), "application/json")),
        ("files", ("media/photo.jpg", JPEG, "image/jpeg")),
    ])
    assert res.status_code == 409
    assert "already open" in res.json()["detail"]
    assert client.get("/api/session").json()["title"] == "Keep me"


def test_refuses_too_many_parts_before_staging_anything(client, monkeypatch):
    """The count cap, and WHERE it is applied.

    `read_bundle` already refuses more than `MAX_ENTRIES`, but only after
    `stage_loose_bundle` has copied the whole drop into a staging tree and
    deflated it into a zip — twice the drop's bytes written to $TMPDIR on
    the machine whose working directory is the author's only copy. The spy is
    the assertion that matters: the limits are checked off the parts list,
    before a byte is written.

    The constants are patched rather than honoured so that the test does not
    have to post five thousand parts; the route reads them as module
    globals for exactly this reason.
    """
    staged: list[object] = []
    monkeypatch.setattr(main, "MAX_ENTRIES", 2)
    monkeypatch.setattr(main, "stage_loose_bundle",
                        lambda *a, **k: staged.append(a))
    res = client.post("/api/session/import-files", files=[
        ("files", ("tour.json", tour_json(), "application/json")),
        ("files", ("media/photo.jpg", JPEG, "image/jpeg")),
        ("files", ("media/other.jpg", JPEG, "image/jpeg")),
    ])
    assert res.status_code == 400
    assert "too many" in res.json()["detail"]
    assert staged == []


def test_refuses_an_oversized_drop_before_staging_anything(client, monkeypatch):
    """The byte cap. The frontend's own `MAX_FILES` caps the count but not
    the size, and a folder of two thousand JPEGs is an ordinary thing for
    someone who moves photographs on USB sticks: it is well under 2000 files
    and far over 512 MB. Same spy, same reason.
    """
    staged: list[object] = []
    monkeypatch.setattr(main, "MAX_TOTAL_BYTES", len(JPEG))
    monkeypatch.setattr(main, "stage_loose_bundle",
                        lambda *a, **k: staged.append(a))
    res = client.post("/api/session/import-files", files=[
        ("files", ("tour.json", tour_json(), "application/json")),
        ("files", ("media/photo.jpg", JPEG, "image/jpeg")),
    ])
    assert res.status_code == 400
    assert "too large" in res.json()["detail"]
    assert staged == []


def test_the_loose_route_runs_in_the_threadpool(client):
    """Pinned on the endpoint itself, because no behavioural test here can
    see it: TestClient serialises requests, so a blocked event loop looks
    exactly like a working one.

    `stage_loose_bundle` copies every part and deflates the lot — seconds to
    minutes for a real media folder — and an `async def` would run all of
    that on the event loop, stalling every other request the backend serves,
    `tour-data/` media included. A plain `def` hands it to the threadpool.
    Same reason `upload_media` is a plain `def`; see its comment.
    """
    route = next(r for r in client.app.routes
                 if getattr(r, "path", None) == "/api/session/import-files")
    assert not inspect.iscoroutinefunction(route.endpoint)


def test_refuses_cross_site(client):
    res = client.post("/api/session/import-files",
                      files=[("files", ("tour.json", tour_json(), "application/json"))],
                      headers={"Sec-Fetch-Site": "cross-site"})
    assert res.status_code == 403


def test_a_non_bundle_zip_is_refused_and_leaves_the_open_tour(client, tmp_path):
    client.post("/api/session/new", json={"title": "Keep me"})
    junk = tmp_path / "junk.zip"
    with zipfile.ZipFile(junk, "w") as zf:
        zf.writestr("readme.txt", "not a tour")
    with junk.open("rb") as fh:
        # `force`, so the conflict guard does not answer first: what is under
        # test is that a BAD archive cannot lose the open tour even when the
        # caller has said to discard it.
        res = client.post("/api/session/import",
                          files={"file": ("junk.zip", fh, "application/zip")},
                          data={"force": "true"})
    assert res.status_code == 400
    assert client.get("/api/session").json()["title"] == "Keep me"


@pytest.mark.parametrize("bad,fragment", [
    ("../escape.jpg", "unexpected file"),
    ("/abs.jpg", "unexpected file"),
    ("media/../../x.jpg", "media/../../x.jpg"),
    ("media/./x.jpg", "media/./x.jpg"),
    ("media/a\\b.jpg", "media/a\\b.jpg"),
    ("media/a\x00b.jpg", "unsafe file path"),
    ("media/a\nb.jpg", "unsafe file path"),
    ("media/", "media/"),
    ("media//x.jpg", "media//x.jpg"),
    ("media/.hidden.jpg", "hidden file"),
    ("media/.d/x.jpg", "hidden file"),
    ("media/x.html", "media/x.html"),
])
def test_media_name_itself_refuses_and_names_the_original_path(bad, fragment):
    with pytest.raises(BundleError) as exc:
        _media_name(bad)
    assert fragment in str(exc.value)


def test_a_hidden_media_file_is_refused_honestly(client):
    res = client.post("/api/session/import-files", files=[
        ("files", ("tour.json", tour_json(".hidden.jpg"), "application/json")),
        ("files", ("media/.hidden.jpg", JPEG, "image/jpeg")),
    ])
    assert res.status_code == 400
    assert "hidden file" in res.json()["detail"]


def test_a_repeated_media_path_is_refused(client):
    res = client.post("/api/session/import-files", files=[
        ("files", ("tour.json", tour_json(), "application/json")),
        ("files", ("media/photo.jpg", JPEG, "image/jpeg")),
        ("files", ("media/photo.jpg", JPEG, "image/jpeg")),
    ])
    assert res.status_code == 400
    assert "more than once" in res.json()["detail"]


def test_warnings_match_the_equivalent_zip(client, tmp_path):
    loose = client.post("/api/session/import-files", files=[
        ("files", ("tour.json", tour_json(), "application/json")),
        ("files", ("media/photo.jpg", JPEG, "image/jpeg")),
        ("files", ("media/unused.jpg", JPEG, "image/jpeg")),
    ]).json()
    zpath = tmp_path / "eq.zip"
    with zipfile.ZipFile(zpath, "w") as zf:
        zf.writestr("tour.json", tour_json())
        zf.writestr("bundle.json", json.dumps({"bundleVersion": 1, "tourId": "t"}))
        zf.writestr("media/photo.jpg", JPEG)
        zf.writestr("media/unused.jpg", JPEG)
    with zpath.open("rb") as fh:
        # The loose import above left a tour open, so this one says to
        # discard it; the point of the test is the warnings, not the guard.
        via_zip = client.post("/api/session/import",
                              files={"file": ("eq.zip", fh, "application/zip")},
                              data={"force": "true"}).json()
    assert loose["warnings"] and any("unused.jpg" in w for w in loose["warnings"])
    assert loose["warnings"] == via_zip["warnings"]
