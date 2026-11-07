from __future__ import annotations

import json
import os
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from app.config import Settings
from app.examples import Example, ExampleError, list_examples, open_example
from app.main import create_app
from app.session import Session

from .test_bundle import BUNDLE_VERSION, JPEG, _minimal_doc

# The repository's own content directory, read the way test_content.py reads
# it. Only the one Fairfax acceptance test below uses this; everything else
# runs against the synthetic example, which is faster and cannot be broken by
# a future re-run of `make content`.
REPO_CONTENT = Path(__file__).resolve().parents[2] / "content"

SYNTHETIC_ID = "tiny-town"


def _write_synthetic_example(content_dir: Path) -> dict:
    """A one-stop example laid out exactly like the shipped one: a frozen
    document in the example's own directory and a `mediaDir` pointing up and
    across at the shared `media/` tree.

    It carries the two things the Fairfax example carries that a flat copy
    would lose — a nested `pano/` path and a `manifest.json` that must be
    filtered out rather than refused — so the generic tests exercise the real
    hazards without reading 4.4 MB of repository content.
    """
    doc = _minimal_doc("photo.jpg")
    example_dir = content_dir / "examples" / SYNTHETIC_ID
    example_dir.mkdir(parents=True)
    (example_dir / "tour.json").write_text(json.dumps(doc))
    (example_dir / "example.json").write_text(json.dumps({
        "title": "Tiny Town",
        "description": "One stop, one photograph.",
        "document": "tour.json",
        "mediaDir": "../../media",
    }))
    media = content_dir / "media"
    (media / "pano").mkdir(parents=True)
    (media / "photo.jpg").write_bytes(JPEG)
    (media / "pano" / "pano-tiny.jpg").write_bytes(JPEG)
    (media / "manifest.json").write_text('{"generated": "never"}')
    return doc


@pytest.fixture
def cfg(tmp_path):
    _write_synthetic_example(tmp_path)
    return Settings(content_dir=tmp_path, sessions_dir=tmp_path / "sessions",
                    frontend_dist=tmp_path / "nodist",
                    mapillary_token="test-token")


@pytest.fixture
def session(cfg):
    """An explicit path: `Settings.work_dir` is gone, and a session is now
    one directory per browser under `sessions_dir`. These tests drive
    `open_example` directly, so any empty directory will do."""
    return Session(cfg.sessions_dir / "0123456789abcdef")


@pytest.fixture
def client(tmp_path):
    # Copied from test_session_api.py, with the synthetic example written into
    # `content_dir` first: that fixture pins `content_dir` at a temp directory,
    # which has no `content/examples/` of its own.
    _write_synthetic_example(tmp_path)
    cfg = Settings(content_dir=tmp_path, sessions_dir=tmp_path / "sessions",
                   frontend_dist=tmp_path / "nodist",
                   mapillary_token="test-token")
    # https, because the session cookie is `Secure` and a cookiejar will not
    # send one over an insecure request — see test_session_cookie.py.
    with TestClient(create_app(cfg), base_url="https://testserver") as c:
        yield c


@pytest.fixture
def real_cfg(tmp_path):
    """The repository's real `content/`, with the session directory redirected
    into `tmp_path`. The session is still constructed by hand below, because
    these tests call `open_example` directly rather than through a request
    that would have a cookie; pointing a Session anywhere inside
    `REPO_CONTENT` would overwrite whatever the author actually has open."""
    return Settings(content_dir=REPO_CONTENT,
                    sessions_dir=tmp_path / "sessions",
                    frontend_dist=tmp_path / "nodist",
                    mapillary_token="test-token")


# --- listing ---------------------------------------------------------------


def test_lists_the_synthetic_example(cfg):
    assert list_examples(cfg) == [
        Example(id=SYNTHETIC_ID, title="Tiny Town",
                description="One stop, one photograph."),
    ]


def test_lists_the_fairfax_example(real_cfg):
    ids = [e.id for e in list_examples(real_cfg)]
    assert "fairfax-old-town" in ids


def test_lists_nothing_when_there_are_no_examples(tmp_path):
    assert list_examples(Settings(content_dir=tmp_path,
                                  sessions_dir=tmp_path / "sessions")) == []


def test_listing_is_sorted_and_skips_a_directory_with_no_manifest(cfg):
    (cfg.content_dir / "examples" / "aardvark").mkdir()
    second = cfg.content_dir / "examples" / "another-town"
    second.mkdir()
    (second / "example.json").write_text(json.dumps({
        "title": "Another Town", "description": "d",
        "document": "tour.json", "mediaDir": "../../media",
    }))
    assert [e.id for e in list_examples(cfg)] == ["another-town", SYNTHETIC_ID]


def test_listing_skips_a_malformed_example_and_keeps_the_rest(cfg):
    """The listing feeds the welcome screen, which has to read correctly with
    no examples at all; one unreadable entry must not take the shelf down.
    `open_example` is where a malformed example is refused out loud — see
    `test_a_malformed_manifest_is_refused`."""
    broken = cfg.content_dir / "examples" / "broken"
    broken.mkdir()
    (broken / "example.json").write_text("{ not json")
    untitled = cfg.content_dir / "examples" / "untitled"
    untitled.mkdir()
    (untitled / "example.json").write_text(json.dumps({"description": "no title"}))
    assert [e.id for e in list_examples(cfg)] == [SYNTHETIC_ID]


# --- opening ---------------------------------------------------------------


def test_opening_the_example_matches_the_synthetic_figures(session, cfg):
    open_example(session, cfg, SYNTHETIC_ID)
    summary = session.summary()
    assert summary["stopCount"] == 1
    assert summary["mediaCount"] == 2
    assert summary["orphanCount"] == 1


def test_opening_the_example_preserves_names_and_nested_paths(session, cfg):
    open_example(session, cfg, SYNTHETIC_ID)
    media = session.path / "media"
    assert (media / "photo.jpg").is_file()
    assert (media / "pano" / "pano-tiny.jpg").is_file()


def test_opening_the_example_excludes_the_media_manifest(session, cfg):
    open_example(session, cfg, SYNTHETIC_ID)
    assert not (session.path / "media" / "manifest.json").exists()


def test_opening_the_example_warns_about_unreferenced_panoramas(session, cfg):
    warnings = open_example(session, cfg, SYNTHETIC_ID)
    assert warnings == ["media/pano/pano-tiny.jpg is not referenced by any overlay"]


def test_opening_the_example_writes_a_bundle_json(session, cfg):
    open_example(session, cfg, SYNTHETIC_ID)
    meta = json.loads((session.path / "bundle.json").read_text())
    assert meta == {"bundleVersion": BUNDLE_VERSION, "tourId": "t"}


def test_opening_the_example_leaves_the_source_media_untouched(session, cfg):
    media = cfg.content_dir / "media"
    before = sorted(p.relative_to(media).as_posix() for p in media.rglob("*"))
    open_example(session, cfg, SYNTHETIC_ID)
    after = sorted(p.relative_to(media).as_posix() for p in media.rglob("*"))
    assert after == before


def test_opening_an_example_replaces_whatever_was_open(session, cfg):
    session.new("Something else")
    open_example(session, cfg, SYNTHETIC_ID)
    assert session.summary()["title"] == "T"


def test_unknown_example_raises(session, cfg):
    with pytest.raises(KeyError):
        open_example(session, cfg, "no-such-example")


@pytest.mark.parametrize("bad", ["../../../etc", "..", ".", "a/b", "", "media"])
def test_example_id_cannot_escape_the_examples_directory(session, cfg, bad):
    with pytest.raises((KeyError, ExampleError)):
        open_example(session, cfg, bad)
    assert not session.is_open


def test_a_document_outside_the_content_directory_is_refused(session, cfg):
    outside = cfg.content_dir.parent / "elsewhere.json"
    outside.write_text(json.dumps(_minimal_doc()))
    manifest = cfg.content_dir / "examples" / SYNTHETIC_ID / "example.json"
    meta = json.loads(manifest.read_text())
    meta["document"] = "../../../elsewhere.json"
    manifest.write_text(json.dumps(meta))
    with pytest.raises(ExampleError):
        open_example(session, cfg, SYNTHETIC_ID)


def test_a_media_dir_outside_the_content_directory_is_refused(session, cfg):
    manifest = cfg.content_dir / "examples" / SYNTHETIC_ID / "example.json"
    meta = json.loads(manifest.read_text())
    meta["mediaDir"] = "../../.."
    manifest.write_text(json.dumps(meta))
    with pytest.raises(ExampleError):
        open_example(session, cfg, SYNTHETIC_ID)


def test_a_missing_media_dir_is_refused(session, cfg):
    manifest = cfg.content_dir / "examples" / SYNTHETIC_ID / "example.json"
    meta = json.loads(manifest.read_text())
    meta["mediaDir"] = "no-media-here"
    manifest.write_text(json.dumps(meta))
    with pytest.raises(ExampleError):
        open_example(session, cfg, SYNTHETIC_ID)


@pytest.mark.parametrize("document", ["[]", '"a string"', "42", "null"])
def test_a_document_that_is_not_an_object_is_refused(session, cfg, document):
    """Valid JSON is not necessarily a document. An array or a scalar parses,
    and then `stage_bundle_root`'s `document.get("id")` would raise
    AttributeError — an exception this module does not promise and the route
    does not map."""
    (cfg.content_dir / "examples" / SYNTHETIC_ID / "tour.json").write_text(document)
    with pytest.raises(ExampleError):
        open_example(session, cfg, SYNTHETIC_ID)
    assert not session.is_open


@pytest.mark.skipif(os.geteuid() == 0, reason="root can read an unreadable file")
def test_media_that_cannot_be_opened_is_refused(session, cfg):
    """The open happens inside the generator `stage_bundle_root` pulls from, so
    a bare OSError there would reach the route unmapped."""
    photo = cfg.content_dir / "media" / "photo.jpg"
    photo.chmod(0o000)
    try:
        with pytest.raises(ExampleError, match="photo.jpg"):
            open_example(session, cfg, SYNTHETIC_ID)
    finally:
        photo.chmod(0o644)
    assert not session.is_open


def test_a_malformed_manifest_is_refused(session, cfg):
    manifest = cfg.content_dir / "examples" / SYNTHETIC_ID / "example.json"
    manifest.write_text("{ not json")
    with pytest.raises(ExampleError):
        open_example(session, cfg, SYNTHETIC_ID)


# --- the recorded Fairfax figures ------------------------------------------


def test_opening_the_fairfax_example_matches_the_recorded_figures(real_cfg, tmp_path):
    """The one test that reads the repository's real content, and the reason
    this feature exists: the figures HANDOFF.md recorded for the hand-authored
    tour, reached by a single call instead of a PUT and two `cp`s.

    The session deliberately points inside `tmp_path`, never anywhere
    under `REPO_CONTENT`, so running the suite cannot discard a tour the
    author has open.
    """
    session = Session(tmp_path / "work")
    warnings = open_example(session, real_cfg, "fairfax-old-town")

    summary = session.summary()
    assert summary["tourId"] == "fairfax-old-town"
    assert summary["stopCount"] == 6
    assert summary["mediaCount"] == 15
    # Zero, not six. Through v2 these six were the stops' cached panoramas,
    # referenced by `cachedPath` — which no reference check read, so every
    # one of them was reported as unreferenced. v3 makes them `cachedMediaId`
    # and `models.referenced_media` counts them. ADR 0005.
    assert summary["orphanCount"] == 0

    # Names and nested paths survive, which is what routing this through the
    # import allowlist rather than the upload one buys.
    media = session.path / "media"
    assert (media / "court-1863.jpg").is_file()
    assert (media / "narration-historic-courthouse.m4a").is_file()
    assert (media / "pano" / "pano-historic-courthouse.jpg").is_file()
    assert not (media / "manifest.json").exists()

    # And so there is nothing left to warn about: the six warnings this used
    # to emit, one per panorama, were the same accounting error.
    assert warnings == []


# --- routes ----------------------------------------------------------------


def test_get_examples_route(client):
    body = client.get("/api/session/examples").json()
    assert any(e["id"] == SYNTHETIC_ID for e in body["examples"])
    assert all({"id", "title", "description"} <= e.keys() for e in body["examples"])


def test_get_examples_route_still_answers_when_an_example_is_broken(client, tmp_path):
    (tmp_path / "examples" / SYNTHETIC_ID / "example.json").write_text("{ not json")
    res = client.get("/api/session/examples")
    assert res.status_code == 200
    assert res.json() == {"examples": []}


def test_post_example_opens_it(client):
    res = client.post(f"/api/session/examples/{SYNTHETIC_ID}")
    assert res.status_code == 200
    body = res.json()
    assert body["stopCount"] == 1 and body["mediaCount"] == 2
    assert len(body["warnings"]) == 1


def test_post_example_writes_the_viewer_config(client):
    client.post(f"/api/session/examples/{SYNTHETIC_ID}")
    config = client.get("/tour-data/config.json").json()
    assert config["mapillaryToken"] == "test-token"


def test_post_example_409s_when_a_tour_is_already_open(client):
    client.post("/api/session/new", json={"title": "A tour"})
    res = client.post(f"/api/session/examples/{SYNTHETIC_ID}")
    assert res.status_code == 409
    assert client.get("/api/session").json()["title"] == "A tour"


def test_post_a_malformed_example_400s(client, tmp_path):
    (tmp_path / "examples" / SYNTHETIC_ID / "tour.json").write_text("[]")
    res = client.post(f"/api/session/examples/{SYNTHETIC_ID}")
    assert res.status_code == 400
    assert SYNTHETIC_ID in res.json()["detail"]
    assert client.get("/api/session").json() == {"open": False}


def test_post_unknown_example_404s(client):
    assert client.post("/api/session/examples/nope").status_code == 404


def test_post_example_refuses_cross_site(client):
    res = client.post(f"/api/session/examples/{SYNTHETIC_ID}",
                      headers={"Sec-Fetch-Site": "cross-site"})
    assert res.status_code == 403
    assert client.get("/api/session").json() == {"open": False}


def test_open_example_honours_the_configured_bundle_caps(cfg, session):
    """`open_example` goes through `replace_from` like an import does, so an
    operator's lowered bundle caps apply to it too: no call site is left on
    the defaults."""
    from app.bundle import BundleError
    tight = cfg.model_copy(update={"max_bundle_entries": 1})
    with pytest.raises(BundleError, match="too many"):
        open_example(session, tight, SYNTHETIC_ID)
    small = cfg.model_copy(update={"max_bundle_bytes": 10})
    with pytest.raises(BundleError, match="too large"):
        open_example(session, small, SYNTHETIC_ID)
