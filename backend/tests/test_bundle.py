from __future__ import annotations

import json
import zipfile
from pathlib import Path

import pytest

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
