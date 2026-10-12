from __future__ import annotations

import io
import json
import struct
import zipfile
import zlib
from pathlib import Path

import pytest

import app.bundle as bundle_module
from app.bundle import BUNDLE_VERSION, BundleError, read_bundle, write_bundle
from app.models import Tour

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
        work.joinpath("media", name).write_bytes(data)
    return work


def _minimal_doc(media_id="m.jpg"):
    return {
        "id": "t", "schemaVersion": 2, "title": "T", "description": "d",
        "attribution": [], "stops": [{
            "id": "s1", "order": 1, "title": "S", "summary": "sum",
            "location": {"lng": -77.3, "lat": 38.84}, "osmRef": None,
            "panorama": {"provider": "mapillary", "imageId": "1",
                         "bearing": 90.0, "cachedPath": None},
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
    work = _make_work(tmp_path, _minimal_doc(), {"m.jpg": b"\xff\xd8bytes"})
    zip_path = tmp_path / "out.zip"
    write_bundle(work, zip_path)

    dest = tmp_path / "back"
    read_bundle(zip_path, dest)

    assert json.loads((dest / "tour.json").read_text()) == _minimal_doc()
    assert (dest / "media" / "m.jpg").read_bytes() == b"\xff\xd8bytes"


def test_the_shipped_tour_round_trips_byte_identically(tmp_path):
    doc = json.loads(SHIPPED.read_text())
    media = {}
    for stop in doc["stops"]:
        for ov in stop["overlays"]:
            if ov.get("mediaId"):
                media[ov["mediaId"]] = b"x" * 16
    work = _make_work(tmp_path, doc, media)
    zip_path = tmp_path / "shipped.zip"
    write_bundle(work, zip_path)
    dest = tmp_path / "back"
    read_bundle(zip_path, dest)
    assert json.loads((dest / "tour.json").read_text()) == doc
    assert sorted(p.name for p in (dest / "media").iterdir()) == sorted(media)


def test_a_v1_bundle_is_migrated_on_import(tmp_path):
    v1 = json.loads(V1_FIXTURE.read_text())
    media = {}
    for stop in v1["stops"]:
        for ov in stop["overlays"]:
            if ov.get("mediaId"):
                media[ov["mediaId"]] = b"x"
    work = _make_work(tmp_path, v1, media)
    zip_path = tmp_path / "v1.zip"
    write_bundle(work, zip_path)

    dest = tmp_path / "back"
    read_bundle(zip_path, dest)

    migrated = json.loads((dest / "tour.json").read_text())
    assert migrated["schemaVersion"] == 2
    Tour.model_validate(migrated)


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
    assert not (tmp_path / "escape.txt").exists()


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


def test_an_oversized_archive_is_refused_before_extraction(tmp_path):
    zip_path = tmp_path / "bomb.zip"
    with zipfile.ZipFile(zip_path, "w", zipfile.ZIP_DEFLATED) as zf:
        zf.writestr("bundle.json", json.dumps({"bundleVersion": 1, "tourId": "t"}))
        zf.writestr("tour.json", json.dumps(_minimal_doc()))
        zf.writestr("media/big.bin", b"\0" * (600 * 1024 * 1024))
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
                      {"m.jpg": b"a", "unused.jpg": b"b"})
    zip_path = tmp_path / "orphan.zip"
    write_bundle(work, zip_path)
    dest = tmp_path / "dest"
    warnings = read_bundle(zip_path, dest)
    assert any("unused.jpg" in w for w in warnings)
    assert (dest / "media" / "unused.jpg").exists()


def test_an_invalid_document_is_refused(tmp_path):
    bad = _minimal_doc()
    bad["stops"][0]["overlays"][0]["display"] = {"mode": "ambient", "autoplay": True}
    work = _make_work(tmp_path, bad, {"m.jpg": b"a"})
    zip_path = tmp_path / "bad.zip"
    write_bundle(work, zip_path)
    with pytest.raises(BundleError):
        read_bundle(zip_path, tmp_path / "dest")


def test_a_zip_without_a_tour_is_refused(tmp_path):
    zip_path = tmp_path / "empty.zip"
    with zipfile.ZipFile(zip_path, "w") as zf:
        zf.writestr("readme.txt", "nope")
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
        zf.writestr("media/big.bin", b"\0" * (520 * 1024 * 1024))

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
    work = _make_work(tmp_path, _minimal_doc(), {"m.jpg": b"original-bytes"})
    read_bundle(_zip_from_work(work, tmp_path / "good.zip"), dest)

    before = {
        p.relative_to(dest): p.read_bytes() for p in sorted(dest.rglob("*")) if p.is_file()
    }

    other_work = _make_work(
        tmp_path / "second", _minimal_doc(media_id="other.jpg"), {"other.jpg": b"new-bytes"}
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
    work = _make_work(tmp_path, _minimal_doc(), {"m.jpg": b"a"})
    (work / "media" / ".DS_Store").write_bytes(b"junk")
    zip_path = tmp_path / "clean.zip"
    write_bundle(work, zip_path)
    with zipfile.ZipFile(zip_path) as zf:
        names = zf.namelist()
    assert not any(Path(n).name.startswith(".") for n in names)
