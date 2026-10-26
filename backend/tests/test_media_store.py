from __future__ import annotations

import re
from pathlib import Path

import pytest

import app.media_store as ms
from app.media_store import (
    ALLOWED_TYPES,
    MediaError,
    orphan_ids,
    sniff,
    store_media,
)
from app.models import Tour

from .test_bundle import _minimal_doc

JPEG_BYTES = b"\xff\xd8\xff\xe0" + b"A" * 32
OTHER_JPEG_BYTES = b"\xff\xd8\xff\xe0" + b"B" * 32
PNG_BYTES = b"\x89PNG\r\n\x1a\n" + b"\x00" * 16

SAMPLES = {
    "image/jpeg": JPEG_BYTES,
    "image/png": PNG_BYTES,
    "image/webp": b"RIFF\x24\x00\x00\x00WEBPVP8 " + b"\x00" * 16,
    "audio/wav": b"RIFF\x24\x00\x00\x00WAVEfmt " + b"\x00" * 16,
    "audio/mp4": b"\x00\x00\x00\x18ftypM4A \x00\x00\x00\x00" + b"\x00" * 16,
    "audio/mpeg": b"ID3\x03\x00\x00" + b"\x00" * 16,
    "audio/ogg": b"OggS\x00\x02" + b"\x00" * 16,
    "audio/webm": b"\x1a\x45\xdf\xa3" + b"\x00" * 16,
}


def _work(tmp_path):
    work = tmp_path / "deep" / "work"
    (work / "media").mkdir(parents=True)
    return work


def test_the_client_never_chooses_the_stored_name(tmp_path):
    work = _work(tmp_path)
    media_id = store_media(work, JPEG_BYTES, "../../etc/passwd.jpg")
    assert "/" not in media_id and ".." not in media_id
    assert (work / "media" / media_id).is_file()
    assert not (tmp_path.parent / "etc").exists()
    assert not (tmp_path / "etc").exists()
    assert not (work.parent / "etc").exists()
    # Nothing but media/ was touched.
    assert [p.name for p in work.iterdir()] == ["media"]


@pytest.mark.parametrize("name", [
    "..\\..\\evil.jpg", "/abs/path.jpg", "a\x00b.jpg", "..", ".", "", "....//",
])
def test_hostile_names_still_store_inside_media(tmp_path, name):
    work = _work(tmp_path)
    media_id = store_media(work, JPEG_BYTES, name)
    stored = (work / "media" / media_id).resolve()
    assert stored.parent == (work / "media").resolve()
    assert re.fullmatch(r"[a-z0-9-]+\.jpg", media_id)


def test_the_extension_comes_from_the_content_not_the_name(tmp_path):
    work = _work(tmp_path)
    media_id = store_media(work, JPEG_BYTES, "payload.html")
    assert media_id.endswith(".jpg")


def test_html_disguised_as_an_image_is_refused(tmp_path):
    work = _work(tmp_path)
    with pytest.raises(MediaError, match="not an allowed"):
        store_media(work, b"<!doctype html><script>x()</script>", "photo.jpg")
    assert list((work / "media").iterdir()) == []


def test_svg_is_refused(tmp_path):
    with pytest.raises(MediaError, match="not an allowed"):
        store_media(_work(tmp_path), b"<svg xmlns='x'><script/></svg>", "a.svg")


def test_identical_content_yields_one_id_and_one_file(tmp_path):
    work = _work(tmp_path)
    a = store_media(work, JPEG_BYTES, "one.jpg")
    b = store_media(work, JPEG_BYTES, "two.jpg")
    assert a == b
    assert len(list((work / "media").iterdir())) == 1


def test_different_content_with_the_same_name_does_not_collide(tmp_path):
    work = _work(tmp_path)
    a = store_media(work, JPEG_BYTES, "photo.jpg")
    b = store_media(work, OTHER_JPEG_BYTES, "photo.jpg")
    assert a != b
    assert len(list((work / "media").iterdir())) == 2


def test_an_existing_different_file_is_never_overwritten(tmp_path, monkeypatch):
    """Force a hash collision: the same id for different content must not
    replace what is there."""
    work = _work(tmp_path)
    first = store_media(work, JPEG_BYTES, "photo.jpg")
    path = work / "media" / first
    # Plant a different file at exactly the id the next upload would get.
    other_id = ms._media_id("photo.jpg", OTHER_JPEG_BYTES, ".jpg", ms._HASH_CHARS[0])
    (work / "media" / other_id).write_bytes(b"planted")
    got = store_media(work, OTHER_JPEG_BYTES, "photo.jpg")
    assert (work / "media" / other_id).read_bytes() == b"planted"
    assert got != other_id
    assert (work / "media" / got).read_bytes() == OTHER_JPEG_BYTES
    assert path.read_bytes() == JPEG_BYTES


def test_an_oversized_file_is_refused(tmp_path, monkeypatch):
    monkeypatch.setattr(ms, "MAX_FILE_BYTES", 40)
    work = _work(tmp_path)
    with pytest.raises(MediaError, match="limit"):
        store_media(work, JPEG_BYTES + b"x" * 40, "big.jpg")
    assert list((work / "media").iterdir()) == []


def test_exceeding_the_directory_total_is_refused(tmp_path, monkeypatch):
    monkeypatch.setattr(ms, "MAX_TOTAL_BYTES", len(JPEG_BYTES) * 2 + 5)
    work = _work(tmp_path)
    store_media(work, JPEG_BYTES, "a.jpg")
    store_media(work, OTHER_JPEG_BYTES, "b.jpg")
    with pytest.raises(MediaError, match="exceed"):
        store_media(work, PNG_BYTES + b"z" * 40, "c.png")
    assert len(list((work / "media").iterdir())) == 2


def test_repeated_uploads_cannot_exceed_the_total(tmp_path, monkeypatch):
    cap = 400
    monkeypatch.setattr(ms, "MAX_TOTAL_BYTES", cap)
    work = _work(tmp_path)
    for i in range(50):
        try:
            store_media(work, b"\xff\xd8\xff" + bytes([i]) * 60, f"p{i}.jpg")
        except MediaError:
            pass
    total = sum(p.stat().st_size for p in (work / "media").rglob("*") if p.is_file())
    assert 0 < total <= cap


def test_re_uploading_existing_content_at_the_cap_still_succeeds(tmp_path, monkeypatch):
    monkeypatch.setattr(ms, "MAX_TOTAL_BYTES", len(JPEG_BYTES))
    work = _work(tmp_path)
    a = store_media(work, JPEG_BYTES, "a.jpg")
    assert store_media(work, JPEG_BYTES, "a.jpg") == a


@pytest.mark.parametrize("kind", sorted(SAMPLES))
def test_each_allowed_type_round_trips(tmp_path, kind):
    work = _work(tmp_path)
    media_id = store_media(work, SAMPLES[kind], "thing")
    assert media_id.endswith(ALLOWED_TYPES[kind])
    assert (work / "media" / media_id).read_bytes() == SAMPLES[kind]
    assert sniff(SAMPLES[kind]) == (kind, ALLOWED_TYPES[kind])


def test_allowed_types_covers_every_sample():
    assert set(ALLOWED_TYPES) == set(SAMPLES)


@pytest.mark.parametrize("data", [
    b"RIFF\x24\x00\x00\x00AVI LIST" + b"\x00" * 16,        # RIFF, neither WebP nor WAV
    b"RIFF\x24\x00\x00\x00",                                # truncated RIFF
    b"\x00\x00\x00\x18ftypheic\x00\x00\x00\x00",            # HEIC is ISO-BMFF too
    b"\x00\x00\x00\x18ftypqt  \x00\x00\x00\x00",            # QuickTime
    b"ftyp",                                                # too short
    b"",
    b"GIF89a" + b"\x00" * 16,
])
def test_containers_are_told_apart_by_their_second_look(data):
    with pytest.raises(MediaError, match="not an allowed"):
        sniff(data)


@pytest.mark.parametrize("brand", [b"M4A ", b"mp42", b"isom", b"M4B "])
def test_iso_bmff_brands_that_are_audio_or_generic_mp4(brand):
    assert sniff(b"\x00\x00\x00\x18ftyp" + brand + b"\x00" * 8)[0] == "audio/mp4"


def test_the_id_is_a_readable_slug_plus_a_hash(tmp_path):
    media_id = store_media(_work(tmp_path), JPEG_BYTES, "Old Town Hall, 1920!.JPEG")
    assert re.fullmatch(r"old-town-hall-1920-[0-9a-f]{10}\.jpg", media_id)


def test_a_name_with_no_usable_characters_gets_a_default_slug(tmp_path):
    media_id = store_media(_work(tmp_path), JPEG_BYTES, "日本語.jpg")
    assert media_id.startswith("media-")


def test_no_temp_file_is_left_behind(tmp_path):
    work = _work(tmp_path)
    store_media(work, JPEG_BYTES, "a.jpg")
    assert all(not p.name.startswith(".") for p in (work / "media").iterdir())


def test_orphan_ids_lists_media_no_overlay_references(tmp_path):
    work = _work(tmp_path)
    (work / "media" / "m.jpg").write_bytes(b"x")
    (work / "media" / "loose.jpg").write_bytes(b"y")
    tour = Tour.model_validate(_minimal_doc("m.jpg"))
    assert orphan_ids(work, tour) == ["loose.jpg"]


def test_orphan_ids_is_empty_when_everything_is_referenced(tmp_path):
    work = _work(tmp_path)
    (work / "media" / "m.jpg").write_bytes(b"x")
    tour = Tour.model_validate(_minimal_doc("m.jpg"))
    assert orphan_ids(work, tour) == []


def test_orphan_ids_without_a_media_dir_is_empty(tmp_path):
    tour = Tour.model_validate(_minimal_doc("m.jpg"))
    assert orphan_ids(tmp_path / "nowhere", tour) == []


@pytest.mark.parametrize("head", [b"\xff\xfb\x90\x00", b"\xff\xf3\x90\x00", b"\xff\xf1\x50\x80"])
def test_mp3_without_an_id3_tag_is_recognised(head):
    assert sniff(head + b"\x00" * 16)[0] == "audio/mpeg"


def test_a_jpeg_is_not_mistaken_for_an_mp3_frame_sync():
    assert sniff(JPEG_BYTES)[0] == "image/jpeg"


def _ts_list(src: str, name: str) -> set[str]:
    line = next(ln for ln in src.splitlines() if ln.startswith(f"const {name} ="))
    return set(re.findall(r"'(\.[a-z0-9]+)'", line))


def test_the_frontend_extension_lists_match_the_allowed_types():
    """document-ops.ts hand-mirrors ALLOWED_TYPES as IMAGE_EXTS / AUDIO_EXTS
    to decide what kind a stored id is. Same idiom as the display-mode table
    in test_models: read the TypeScript and fail when the two drift."""
    from app.media_store import ALLOWED_TYPES

    src = (Path(__file__).resolve().parents[2] / "frontend" / "src" / "app"
           / "editor" / "document-ops.ts").read_text()
    want_image = {ext for t, ext in ALLOWED_TYPES.items() if t.startswith("image/")}
    want_audio = {ext for t, ext in ALLOWED_TYPES.items() if t.startswith("audio/")}
    assert _ts_list(src, "IMAGE_EXTS") == want_image
    assert _ts_list(src, "AUDIO_EXTS") == want_audio


def test_the_frontend_droppable_list_matches_the_import_allowlist():
    """The welcome screen filters a dropped folder before posting it, so that
    `manifest.json` beside the photographs is left out with a notice instead
    of refused along with the whole drop. It filters against
    DROPPABLE_MEDIA_EXTS, which must therefore be the *import* allowlist
    (bundle.MEDIA_EXTENSIONS, which accepts .jpeg) and not this module's
    upload table. Drift either way is a bug the author would see as a refusal
    naming a file they can do nothing about, so tie the two together here as
    the lists above are tied.
    """
    from app.bundle import MEDIA_EXTENSIONS

    src = (Path(__file__).resolve().parents[2] / "frontend" / "src" / "app"
           / "editor" / "document-ops.ts").read_text()
    assert _ts_droppable(src) == MEDIA_EXTENSIONS


def _ts_droppable(src: str) -> set[str]:
    """Resolve `[...IMAGE_EXTS, '.jpeg', ...AUDIO_EXTS]` to the set it makes.

    The list is derived rather than hand-written so it cannot drift from the
    kinds the editor understands, which means reading it needs the spreads
    followed. Asserting which names are spread is the point as much as the
    result: a future hand-copied list would satisfy the set comparison on the
    day it was written and silently rot afterwards.
    """
    line = next(
        ln for ln in src.splitlines()
        if ln.startswith("export const DROPPABLE_MEDIA_EXTS =")
    )
    spread = set(re.findall(r"\.\.\.([A-Z_]+)", line))
    assert spread == {"IMAGE_EXTS", "AUDIO_EXTS"}
    exts = set(re.findall(r"'(\.[a-z0-9]+)'", line))
    for name in spread:
        exts |= _ts_list(src, name)
    return exts
