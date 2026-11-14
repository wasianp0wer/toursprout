from __future__ import annotations

import io
import json
import struct
import zipfile
import zlib
from pathlib import Path

import pytest

import app.bundle as bundle_module
from app.bundle import (
    BUNDLE_VERSION,
    BundleError,
    missing_media,
    read_bundle,
    stage_bundle_root,
    write_bundle,
)
from app.models import SCHEMA_VERSION, Tour

# Import sniffs everything under media/, so fixtures need real signatures.
JPEG = b"\xff\xd8\xff\xe0" + b"\x00" * 12
M4A = b"\x00\x00\x00\x18ftypM4A " + b"\x00" * 8


def _media_bytes(name: str) -> bytes:
    return M4A if name.endswith(".m4a") else JPEG


REPO = Path(__file__).resolve().parents[2]
V1_FIXTURE = Path(__file__).parent / "fixtures" / "fairfax-old-town-v1.json"
SHIPPED = REPO / "content" / "tours" / "fairfax-old-town.json"


def _make_work(tmp_path: Path, doc: dict, media: dict[str, bytes]) -> Path:
    work = tmp_path / "work"
    (work / "media").mkdir(parents=True)
    work.joinpath("tour.json").write_text(json.dumps(doc))
    work.joinpath("bundle.json").write_text(
        json.dumps({"bundleVersion": BUNDLE_VERSION, "tourId": doc["id"]})
    )
    for name, data in media.items():
        target = work.joinpath("media", name)
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(data)
    return work


def _referenced_media(doc: dict) -> dict[str, bytes]:
    """Every file the document points at, ready to stage under `media/`.

    Both kinds of reference, because a stop's cached panorama is one as of v3
    and `read_bundle` now refuses a bundle that is missing one. Reads v1/v2's
    `cachedPath` as well as v3's `cachedMediaId`: the same file, with
    `media/` still on the front.
    """
    names = [
        ov["mediaId"] for s in doc["stops"] for ov in s["overlays"]
        if ov.get("mediaId")
    ]
    for stop in doc["stops"]:
        pano = stop["panorama"]
        cached = pano.get("cachedMediaId") or pano.get("cachedPath")
        if cached:
            names.append(cached.removeprefix("media/"))
    return {name: _media_bytes(name) for name in names}


def _minimal_doc(media_id="m.jpg", cached=None):
    return {
        "id": "t", "schemaVersion": 4, "title": "T", "description": "d",
        "attribution": [], "stops": [{
            "id": "s1", "order": 1, "title": "S", "summary": "sum",
            "location": {"lng": -77.3, "lat": 38.84}, "osmRef": None,
            "panorama": {"provider": "mapillary", "imageId": "1",
                         "bearing": 90.0, "cachedMediaId": cached},
            "overlays": [{
                "id": "o1", "kind": "image",
                "anchor": {"type": "geo", "lng": -77.3, "lat": 38.84, "altitudeM": 2.0},
                "display": {"mode": "marker", "icon": "photo"},
                "title": "Photo", "body": None, "mediaId": media_id,
                "credit": {"type": "original", "creator": "M", "license": "CC-BY-4.0"},
            }],
        }],
    }


def test_round_trip_preserves_the_document_and_media(tmp_path):
    work = _make_work(tmp_path, _minimal_doc(), {"m.jpg": JPEG})
    zip_path = tmp_path / "out.zip"
    write_bundle(work, zip_path)

    dest = tmp_path / "back"
    read_bundle(zip_path, dest)

    assert json.loads((dest / "tour.json").read_text()) == _minimal_doc()
    assert (dest / "media" / "m.jpg").read_bytes() == JPEG


def test_the_shipped_tour_round_trips_byte_identically(tmp_path):
    doc = json.loads(SHIPPED.read_text())
    media = _referenced_media(doc)
    work = _make_work(tmp_path, doc, media)
    zip_path = tmp_path / "shipped.zip"
    write_bundle(work, zip_path)
    dest = tmp_path / "back"
    read_bundle(zip_path, dest)
    assert json.loads((dest / "tour.json").read_text()) == doc
    # Relative POSIX paths, walked recursively: the shipped tour keeps its six
    # panoramas under `media/pano/`, and comparing leaf names alone would both
    # miss the nesting and collide if two directories held the same name.
    present = sorted(
        q.relative_to(dest / "media").as_posix()
        for q in (dest / "media").rglob("*") if q.is_file()
    )
    assert present == sorted(media)


def test_a_v1_bundle_is_migrated_on_import(tmp_path):
    v1 = json.loads(V1_FIXTURE.read_text())
    work = _make_work(tmp_path, v1, _referenced_media(v1))
    zip_path = tmp_path / "v1.zip"
    write_bundle(work, zip_path)

    dest = tmp_path / "back"
    read_bundle(zip_path, dest)

    migrated = json.loads((dest / "tour.json").read_text())
    assert migrated["schemaVersion"] == SCHEMA_VERSION
    Tour.model_validate(migrated)


def test_a_theme_survives_export_and_import(tmp_path):
    """The whole reason the theme is in the document and not config.json:
    config.json is derived state and is not in a bundle; tour.json is."""
    doc = _minimal_doc() | {"theme": {
        "preset": "archival", "typePairing": "garamond",
        "typeScale": "generous", "layout": "immersive",
        "overrides": {"accent": "#4f6b2a"}}}
    work = _make_work(tmp_path, doc, {"m.jpg": JPEG})
    zip_path = tmp_path / "themed.zip"
    write_bundle(work, zip_path)

    dest = tmp_path / "back"
    read_bundle(zip_path, dest)

    back = json.loads((dest / "tour.json").read_text())
    assert back["theme"] == doc["theme"]


def test_a_tour_lowercases_an_imported_override(tmp_path):
    """The MODEL normalises, not the stored file: import swaps the staged tree
    in without rewriting tour.json, so the document on disk keeps the author's
    spelling (and the shipped tour must round-trip byte-identically). That is
    safe: the pattern has already refused anything but six hex digits, CSS hex
    is case-insensitive, and every server-side reader goes through Tour."""
    doc = _minimal_doc() | {"theme": {"overrides": {"accent": "#9C5A24"}}}
    work = _make_work(tmp_path, doc, {"m.jpg": JPEG})
    zip_path = tmp_path / "upper.zip"
    write_bundle(work, zip_path)

    dest = tmp_path / "back"
    read_bundle(zip_path, dest)

    tour = Tour.model_validate(json.loads((dest / "tour.json").read_text()))
    assert tour.theme.overrides.accent == "#9c5a24"


@pytest.mark.parametrize("entry", [
    "../escape.txt",
    "../../etc/passwd",
    "media/../../escape.txt",
    "/absolute.txt",
    "..\\evil.txt",
    "C:\\evil.txt",
    "C:evil.txt",
])
def test_path_traversal_entries_are_refused(tmp_path, entry):
    zip_path = tmp_path / "evil.zip"
    with zipfile.ZipFile(zip_path, "w") as zf:
        zf.writestr("bundle.json", json.dumps({"bundleVersion": 1, "tourId": "t"}))
        zf.writestr("tour.json", json.dumps(_minimal_doc()))
        zf.writestr(entry, "pwned")
    with pytest.raises(BundleError, match="unsafe"):
        read_bundle(zip_path, tmp_path / "dest")
    # (No further assertion about where "escape.txt" might have landed:
    # extraction stages under `$TMPDIR`, never under `tmp_path`, so an
    # assertion phrased against `tmp_path` here could never fail regardless
    # of whether this guard worked. The `pytest.raises` above is the real
    # coverage.)


def test_a_symlink_entry_is_refused(tmp_path):
    zip_path = tmp_path / "link.zip"
    with zipfile.ZipFile(zip_path, "w") as zf:
        zf.writestr("bundle.json", json.dumps({"bundleVersion": 1, "tourId": "t"}))
        zf.writestr("tour.json", json.dumps(_minimal_doc()))
        info = zipfile.ZipInfo("media/m.jpg")
        # 0xA000 is S_IFLNK in the high 16 bits of external_attr.
        info.external_attr = (0xA1FF) << 16
        zf.writestr(info, "/etc/passwd")
    with pytest.raises(BundleError, match="unsafe"):
        read_bundle(zip_path, tmp_path / "dest")


def _write_zeros(zf: zipfile.ZipFile, name: str, total_bytes: int) -> None:
    """Write `total_bytes` of zero bytes to a new entry, one chunk at a time,
    so building a huge entry for a test never allocates the whole payload as
    a single Python `bytes` object (600 MB and 520 MB, in the two tests that
    use this)."""
    chunk = b"\0" * (1024 * 1024)
    with zf.open(name, "w") as f:
        written = 0
        while written < total_bytes:
            n = min(len(chunk), total_bytes - written)
            f.write(chunk[:n])
            written += n


def test_an_oversized_archive_is_refused_before_extraction(tmp_path):
    zip_path = tmp_path / "bomb.zip"
    with zipfile.ZipFile(zip_path, "w", zipfile.ZIP_DEFLATED) as zf:
        zf.writestr("bundle.json", json.dumps({"bundleVersion": 1, "tourId": "t"}))
        zf.writestr("tour.json", json.dumps(_minimal_doc()))
        _write_zeros(zf, "media/big.bin", 600 * 1024 * 1024)
    with pytest.raises(BundleError, match="too large"):
        read_bundle(zip_path, tmp_path / "dest")


def test_too_many_entries_is_refused(tmp_path):
    zip_path = tmp_path / "many.zip"
    with zipfile.ZipFile(zip_path, "w") as zf:
        zf.writestr("bundle.json", json.dumps({"bundleVersion": 1, "tourId": "t"}))
        zf.writestr("tour.json", json.dumps(_minimal_doc()))
        for i in range(5001):
            zf.writestr(f"media/f{i}.bin", b"x")
    with pytest.raises(BundleError, match="too many"):
        read_bundle(zip_path, tmp_path / "dest")


def test_a_missing_referenced_media_file_is_an_error(tmp_path):
    work = _make_work(tmp_path, _minimal_doc(media_id="gone.jpg"), {})
    zip_path = tmp_path / "missing.zip"
    write_bundle(work, zip_path)
    with pytest.raises(BundleError, match="gone.jpg"):
        read_bundle(zip_path, tmp_path / "dest")


def test_orphaned_media_is_warned_about_not_deleted(tmp_path):
    work = _make_work(tmp_path, _minimal_doc(),
                      {"m.jpg": JPEG, "unused.jpg": JPEG})
    zip_path = tmp_path / "orphan.zip"
    write_bundle(work, zip_path)
    dest = tmp_path / "dest"
    warnings = read_bundle(zip_path, dest)
    assert any("unused.jpg" in w for w in warnings)
    assert (dest / "media" / "unused.jpg").exists()


def test_an_invalid_document_is_refused(tmp_path):
    bad = _minimal_doc()
    bad["stops"][0]["overlays"][0]["display"] = {"mode": "ambient", "autoplay": True}
    work = _make_work(tmp_path, bad, {"m.jpg": JPEG})
    zip_path = tmp_path / "bad.zip"
    write_bundle(work, zip_path)
    with pytest.raises(BundleError):
        read_bundle(zip_path, tmp_path / "dest")


def test_a_zip_without_a_tour_is_refused(tmp_path):
    # An allowed root filename, deliberately, so this test exercises the
    # missing-tour.json rejection and not the unexpected-file one above it.
    zip_path = tmp_path / "empty.zip"
    with zipfile.ZipFile(zip_path, "w") as zf:
        zf.writestr("bundle.json", json.dumps({"bundleVersion": 1, "tourId": "t"}))
    with pytest.raises(BundleError, match="tour.json"):
        read_bundle(zip_path, tmp_path / "dest")


# --- Forged declared-size "lying" archive -----------------------------------
#
# `ZipInfo.file_size` lives in the zip's central directory, which is just
# bytes an attacker fully controls. The stdlib `zipfile` module writes
# consistent sizes, so to build an archive where the DECLARED size lies
# about the REAL decompressed length, we hand-roll the container: a local
# file header, a real DEFLATE stream (genuinely large, cheap to produce
# because it is all zero bytes), and a central directory record whose
# uncompressed-size field is a small lie. The CRC-32 we record is the
# HONEST one for the real, large payload — the natural thing to compute if
# you don't know (or don't bother accounting for) how `ZipExtFile` truncates
# output to the declared size.

def _zip_entry(buf: io.BytesIO, name: bytes, data: bytes, declared_size: int):
    """Write one local-file-header + deflate-stream entry, lying about its
    uncompressed size, and return the bookkeeping the central directory
    record needs."""
    co = zlib.compressobj(6, zlib.DEFLATED, -15)
    compressed = co.compress(data) + co.flush()
    crc = zlib.crc32(data) & 0xFFFFFFFF  # honest CRC over the REAL data
    header_offset = buf.tell()
    buf.write(struct.pack(
        "<IHHHHHIIIHH",
        0x04034B50, 20, 0, 8, 0, 0,          # sig, version, flags, method, time, date
        crc, len(compressed), declared_size,  # crc, compressed size, LIE
        len(name), 0,                         # filename len, extra len
    ))
    buf.write(name)
    buf.write(compressed)
    return {
        "name": name, "crc": crc, "comp_size": len(compressed),
        "uncomp_size": declared_size, "header_offset": header_offset,
    }


def _build_forged_zip(entries: list[tuple[bytes, bytes, int]], path: Path) -> None:
    buf = io.BytesIO()
    records = [_zip_entry(buf, name, data, declared) for name, data, declared in entries]
    cd_start = buf.tell()
    for r in records:
        buf.write(struct.pack(
            "<IHHHHHHIIIHHHHHII",
            0x02014B50, 20, 20, 0, 8, 0, 0,                    # sig, versions, flags, method, time, date
            r["crc"], r["comp_size"], r["uncomp_size"],
            len(r["name"]), 0, 0, 0, 0, 0, r["header_offset"],
        ))
        buf.write(r["name"])
    cd_size = buf.tell() - cd_start
    buf.write(struct.pack(
        "<IHHHHIIH", 0x06054B50, 0, 0, len(records), len(records), cd_size, cd_start, 0,
    ))
    path.write_bytes(buf.getvalue())


def test_a_declared_size_that_lies_about_a_real_bomb_is_refused(tmp_path):
    """A forged `file_size` declares 100 bytes while the real DEFLATE stream
    decompresses to 5 MB of zeros (honest CRC over those 5 MB). This cannot
    reach the "too large" early-out, since the DECLARED total is tiny — the
    only way it is caught is during actual extraction.

    (CPython's `ZipExtFile` happens to truncate output to the declared size
    and then fail its own CRC check in this situation, so no bytes beyond
    the lie are ever produced either way — but `read_bundle` must still
    surface this as a `BundleError`, not propagate a raw `zipfile.BadZipFile`
    and not leave anything written at the destination.)
    """
    zip_path = tmp_path / "lying.zip"
    real_bomb = b"\0" * (5 * 1024 * 1024)
    bundle_bytes = json.dumps({"bundleVersion": 1, "tourId": "t"}).encode()
    tour_bytes = json.dumps(_minimal_doc()).encode()
    _build_forged_zip([
        (b"bundle.json", bundle_bytes, len(bundle_bytes)),
        (b"tour.json", tour_bytes, len(tour_bytes)),
        (b"media/m.jpg", real_bomb, 100),
    ], zip_path)

    dest = tmp_path / "dest"
    with pytest.raises(BundleError):
        read_bundle(zip_path, dest)
    assert not dest.exists()


def test_the_streamed_cap_is_enforced_on_an_honestly_large_archive(tmp_path):
    """Fallback case alongside the lying test above: even with an honest
    declared size, `_extract_safely` itself (not just `_check_safe`'s cheap
    early-out) must refuse an archive once real extracted bytes exceed the
    cap. We force this by calling `_extract_safely` directly, bypassing
    `_check_safe`, so this test fails if the running-total enforcement is
    ever removed from the extraction loop itself."""
    zip_path = tmp_path / "honest-big.zip"
    with zipfile.ZipFile(zip_path, "w", zipfile.ZIP_DEFLATED) as zf:
        _write_zeros(zf, "media/big.bin", 520 * 1024 * 1024)

    staging = tmp_path / "staging"
    staging.mkdir()
    with zipfile.ZipFile(zip_path) as zf, pytest.raises(BundleError, match="too large"):
        bundle_module._extract_safely(zf, staging)


def test_a_crash_during_the_destination_swap_leaves_it_untouched(tmp_path, monkeypatch):
    """`read_bundle` must never leave `dest` deleted-but-not-replaced. We
    establish a known-good `dest`, then force `shutil.copytree` (used by
    `_swap_in` to stage the new tree next to `dest`) to blow up partway, and
    assert `dest` is still exactly what it was — not emptied, not partially
    overwritten."""
    dest = tmp_path / "dest"
    work = _make_work(tmp_path, _minimal_doc(), {"m.jpg": JPEG})
    read_bundle(_zip_from_work(work, tmp_path / "good.zip"), dest)

    before = {
        p.relative_to(dest): p.read_bytes() for p in sorted(dest.rglob("*")) if p.is_file()
    }

    other_work = _make_work(
        tmp_path / "second", _minimal_doc(media_id="other.jpg"), {"other.jpg": JPEG + b"new"}
    )
    other_zip = _zip_from_work(other_work, tmp_path / "other.zip")

    def boom(*_args, **_kwargs):
        raise OSError("disk full (simulated)")

    monkeypatch.setattr(bundle_module.shutil, "copytree", boom)

    with pytest.raises(BundleError):
        read_bundle(other_zip, dest)

    after = {
        p.relative_to(dest): p.read_bytes() for p in sorted(dest.rglob("*")) if p.is_file()
    }
    assert after == before
    restored = json.loads((dest / "tour.json").read_text())
    assert restored["stops"][0]["overlays"][0]["mediaId"] == "m.jpg"


def _zip_from_work(work: Path, zip_path: Path) -> Path:
    write_bundle(work, zip_path)
    return zip_path


def test_dotfiles_are_excluded_from_written_bundles(tmp_path):
    work = _make_work(tmp_path, _minimal_doc(), {"m.jpg": JPEG})
    (work / "media" / ".DS_Store").write_bytes(b"junk")
    zip_path = tmp_path / "clean.zip"
    write_bundle(work, zip_path)
    with zipfile.ZipFile(zip_path) as zf:
        names = zf.namelist()
    assert not any(Path(n).name.startswith(".") for n in names)


def test_a_dotfile_inside_a_hidden_directory_is_also_excluded(tmp_path):
    """The leaf-only version of this filter (`path.name.startswith(".")`)
    missed a dotfile sitting inside a hidden directory, e.g. `.git/config`,
    because `config`'s own leaf name does not start with a dot. The filter
    must be applied to every component of the relative path."""
    work = _make_work(tmp_path, _minimal_doc(), {"m.jpg": JPEG})
    (work / ".git").mkdir()
    (work / ".git" / "config").write_text("[core]\n")
    zip_path = tmp_path / "clean.zip"
    write_bundle(work, zip_path)
    with zipfile.ZipFile(zip_path) as zf:
        names = zf.namelist()
    assert not any(n.startswith(".git") for n in names)


def test_config_json_is_excluded_from_exported_bundles(tmp_path):
    """config.json is derived state — rebuilt from the backend's settings,
    Mapillary token included — not part of the document. It is excluded
    from exports (publish.py still emits it for a published site, which is
    the one place it belongs)."""
    work = _make_work(tmp_path, _minimal_doc(), {"m.jpg": JPEG})
    work.joinpath("config.json").write_text(
        json.dumps({"mapillaryToken": "secret", "tileUrl": "u", "attribution": []})
    )
    zip_path = tmp_path / "out.zip"
    write_bundle(work, zip_path)
    with zipfile.ZipFile(zip_path) as zf:
        assert "config.json" not in zf.namelist()


def test_an_unexpected_root_file_is_refused(tmp_path):
    """The bundle format is exactly bundle.json, tour.json, config.json and
    files under media/. Anything else would otherwise land in the working
    directory and get copied straight onto the author's published origin by
    publish.py."""
    zip_path = tmp_path / "evil.zip"
    with zipfile.ZipFile(zip_path, "w") as zf:
        zf.writestr("bundle.json", json.dumps({"bundleVersion": 1, "tourId": "t"}))
        zf.writestr("tour.json", json.dumps(_minimal_doc(media_id="m.jpg")))
        zf.writestr("media/m.jpg", JPEG)
        zf.writestr("evil.html", "<script>pwned</script>")
    with pytest.raises(BundleError, match="evil.html"):
        read_bundle(zip_path, tmp_path / "dest")


def test_an_unexpected_file_outside_media_in_a_subdirectory_is_refused(tmp_path):
    zip_path = tmp_path / "evil.zip"
    with zipfile.ZipFile(zip_path, "w") as zf:
        zf.writestr("bundle.json", json.dumps({"bundleVersion": 1, "tourId": "t"}))
        zf.writestr("tour.json", json.dumps(_minimal_doc(media_id="m.jpg")))
        zf.writestr("media/m.jpg", JPEG)
        zf.writestr("assets/payload.js", "pwned();")
    with pytest.raises(BundleError, match="assets/payload.js"):
        read_bundle(zip_path, tmp_path / "dest")


def test_a_bundle_version_newer_than_this_build_understands_is_refused(tmp_path):
    zip_path = tmp_path / "future.zip"
    with zipfile.ZipFile(zip_path, "w") as zf:
        zf.writestr("bundle.json", json.dumps({"bundleVersion": BUNDLE_VERSION + 1, "tourId": "t"}))
        zf.writestr("tour.json", json.dumps(_minimal_doc(media_id="m.jpg")))
        zf.writestr("media/m.jpg", JPEG)
    with pytest.raises(BundleError, match="bundleVersion"):
        read_bundle(zip_path, tmp_path / "dest")


def test_a_bundle_with_no_bundle_json_at_all_still_imports(tmp_path):
    """Older exports lack bundle.json entirely (it was added when the
    container format was first versioned); refusing them would be a regression, not a safety
    improvement."""
    zip_path = tmp_path / "old.zip"
    with zipfile.ZipFile(zip_path, "w") as zf:
        zf.writestr("tour.json", json.dumps(_minimal_doc(media_id="m.jpg")))
        zf.writestr("media/m.jpg", JPEG)
    dest = tmp_path / "dest"
    read_bundle(zip_path, dest)
    assert dest.is_dir()


def test_a_name_collision_during_extraction_is_a_bundle_error_not_a_500(tmp_path):
    """`media/x` as a file, then `media/x/y.jpg` needing `media/x` to be a
    directory, is exactly the kind of OSError (here, a file/directory name
    collision) that extraction can hit outside of the zip-corruption cases
    already handled. It must surface as an ordinary BundleError, the same
    promise every other rejection in this module makes, not escape as a raw
    OSError that would become an unhandled 500 at the API boundary."""
    zip_path = tmp_path / "collide.zip"
    with zipfile.ZipFile(zip_path, "w") as zf:
        zf.writestr("bundle.json", json.dumps({"bundleVersion": 1, "tourId": "t"}))
        zf.writestr("tour.json", json.dumps(_minimal_doc(media_id="m.jpg")))
        zf.writestr("media/x", "i am a file")
        zf.writestr("media/x/y.jpg", "i need media/x to be a directory")
    with pytest.raises(BundleError):
        read_bundle(zip_path, tmp_path / "dest")


def test_missing_media_reports_what_export_would_be_missing(tmp_path):
    """`missing_media` is the function the export route calls so the same
    referenced-media invariant import enforces is also enforced on export —
    see the export/import asymmetry fix in main.py."""
    work = _make_work(tmp_path, _minimal_doc(media_id="gone.jpg"), {})
    assert missing_media(work) == ["gone.jpg"]


def test_missing_media_is_empty_when_everything_referenced_is_present(tmp_path):
    work = _make_work(tmp_path, _minimal_doc(media_id="m.jpg"), {"m.jpg": JPEG})
    assert missing_media(work) == []


def test_missing_media_sees_a_nested_media_layout(tmp_path):
    """`present` is built by walking `media/` recursively, so a nested
    reference like `pano/pano-x.jpg` — the layout the bundle spec's own
    example shows — is found, not reported as missing just because it is
    not a direct child of `media/`."""
    work = _make_work(tmp_path, _minimal_doc(media_id="pano/pano-x.jpg"), {})
    (work / "media" / "pano").mkdir()
    (work / "media" / "pano" / "pano-x.jpg").write_bytes(JPEG)
    assert missing_media(work) == []


# --- media/ is held to the same definition of "media" as an upload ---------
#
# Import is the second door into a working directory, and publish.py copies
# everything in it onto the author's public origin. Anything the upload path
# refuses must be refused here too, or `media/evil.html` is served as
# text/html from the same origin that hosts the unauthenticated session API.


def _bundle_with(tmp_path: Path, name: str, data: bytes) -> Path:
    zip_path = tmp_path / "b.zip"
    with zipfile.ZipFile(zip_path, "w") as zf:
        zf.writestr("bundle.json", json.dumps({"bundleVersion": 1, "tourId": "t"}))
        zf.writestr("tour.json", json.dumps(_minimal_doc(media_id="m.jpg")))
        zf.writestr("media/m.jpg", JPEG)
        zf.writestr(name, data)
    return zip_path


@pytest.mark.parametrize("name,data", [
    ("media/evil.html", b"<!doctype html><script>x()</script>"),
    ("media/payload.js", b"alert(1);"),
    ("media/x.svg", b'<svg xmlns="http://www.w3.org/2000/svg" onload="x()"/>'),
])
def test_executable_content_under_media_is_refused(tmp_path, name, data):
    zip_path = _bundle_with(tmp_path, name, data)
    dest = tmp_path / "dest"
    with pytest.raises(BundleError, match=name):
        read_bundle(zip_path, dest)
    assert not dest.exists()


def test_allowed_bytes_under_a_dangerous_extension_are_refused(tmp_path):
    """The sniff alone is not enough: JPEG bytes named .html would be served
    as text/html, and a JPEG can carry markup after its header."""
    zip_path = _bundle_with(tmp_path, "media/evil.html", JPEG + b"<script>x()</script>")
    with pytest.raises(BundleError, match="evil.html"):
        read_bundle(zip_path, tmp_path / "dest")


def test_legitimate_media_still_imports(tmp_path):
    zip_path = _bundle_with(tmp_path, "media/pano/voice.m4a", M4A)
    dest = tmp_path / "dest"
    read_bundle(zip_path, dest)
    assert (dest / "media" / "pano" / "voice.m4a").read_bytes() == M4A


# --- stage_bundle_root ------------------------------------------------------
# The staging side of the same contract: `stage_bundle_root` is what the
# example opener and loose-file import use to turn "a document plus some
# media" into something `read_bundle` can validate, so the two must meet.


def test_a_staged_root_round_trips_through_read_bundle(tmp_path):
    root = tmp_path / "root"
    doc = _minimal_doc("photo.jpg")
    stage_bundle_root(root, doc, [
        ("photo.jpg", io.BytesIO(JPEG)),
        ("pano/voice.m4a", io.BytesIO(M4A)),
    ])
    zip_path = tmp_path / "staged.zip"
    write_bundle(root, zip_path)

    dest = tmp_path / "dest"
    warnings = read_bundle(zip_path, dest)

    assert json.loads((dest / "tour.json").read_text()) == doc
    assert json.loads((dest / "bundle.json").read_text()) == {
        "bundleVersion": BUNDLE_VERSION, "tourId": "t",
    }
    assert (dest / "media" / "photo.jpg").read_bytes() == JPEG
    assert (dest / "media" / "pano" / "voice.m4a").read_bytes() == M4A
    assert warnings == ["media/pano/voice.m4a is not referenced by any overlay"]


@pytest.mark.parametrize("name", [
    "../escaped.jpg", "a/../../escaped.jpg", "/absolute.jpg", "", "sub/",
    "..\\windows.jpg",
])
def test_staging_refuses_a_media_name_that_escapes(tmp_path, name):
    """These names come from the browser on the loose-file import path, and
    they are written to disk here, before `read_bundle`'s own entry-name
    checks ever see them."""
    root = tmp_path / "root"
    with pytest.raises(BundleError):
        stage_bundle_root(root, _minimal_doc(), [(name, io.BytesIO(JPEG))])
    assert not (tmp_path / "escaped.jpg").exists()


def test_missing_media_sees_a_cached_panorama(tmp_path):
    """A stop's `cachedMediaId` is a media reference like any other. Through
    v2 it was `cachedPath` and no reference check looked at it, so a bundle
    could be missing a panorama and still import clean."""
    work = _make_work(tmp_path, _minimal_doc(cached="pano/p.jpg"), {"m.jpg": JPEG})
    assert missing_media(work) == ["pano/p.jpg"]


def test_a_present_cached_panorama_is_not_missing(tmp_path):
    work = _make_work(
        tmp_path, _minimal_doc(cached="pano/p.jpg"),
        {"m.jpg": JPEG, "pano/p.jpg": JPEG},
    )
    assert missing_media(work) == []


def test_importing_a_bundle_without_its_cached_panorama_is_refused(tmp_path):
    work = _make_work(tmp_path, _minimal_doc(cached="pano/p.jpg"), {"m.jpg": JPEG})
    zip_path = tmp_path / "out.zip"
    write_bundle(work, zip_path)
    with pytest.raises(BundleError, match="pano/p.jpg"):
        read_bundle(zip_path, tmp_path / "dest")


def test_a_cached_panorama_is_not_an_orphan(tmp_path):
    """The shipped example's six panoramas were reported as unreferenced for
    as long as `cachedPath` sat outside the reference set."""
    work = _make_work(
        tmp_path, _minimal_doc(cached="pano/p.jpg"),
        {"m.jpg": JPEG, "pano/p.jpg": JPEG},
    )
    zip_path = tmp_path / "out.zip"
    write_bundle(work, zip_path)
    assert read_bundle(zip_path, tmp_path / "dest") == []
