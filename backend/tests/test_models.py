from __future__ import annotations

from pathlib import Path
from typing import get_args

import pytest
from pydantic import ValidationError

from app import models
from app.models import DISPLAY_MODES_BY_KIND, GeoAnchor, Overlay, Stop, Tour

VALID_CREDIT = {
    "type": "sourced",
    "source": "Library of Congress",
    "url": "https://www.loc.gov/item/2016123456/",
    "license": "No known restrictions",
    "creator": "National Photo Company",
}

ORIGINAL_CREDIT = {
    "type": "original",
    "creator": "Madelyn Harrington",
    "license": "CC-BY-4.0",
}


def _overlay(**over):
    base = {
        "id": "ov-1",
        "kind": "text",
        "anchor": {"type": "geo", "lng": -77.30732, "lat": 38.84562, "altitudeM": 3.0},
        "display": {"mode": "marker", "icon": "note"},
        "title": "The 1800 Courthouse",
        "body": "Built in 1800 at the crossroads of two turnpikes.",
        "credit": VALID_CREDIT,
    }
    base.update(over)
    return base


def _stop(**over):
    base = {
        "id": "historic-courthouse",
        "order": 1,
        "title": "Fairfax County Historic Courthouse",
        "summary": "The county's seat of justice since 1800.",
        "location": {"lng": -77.30732, "lat": 38.84562},
        "osmRef": "way/123456",
        "panorama": {
            "provider": "mapillary",
            "imageId": "2116094392633820",
            "bearing": 270.0,
            "cachedPath": "media/pano/historic-courthouse.jpg",
        },
        "overlays": [_overlay()],
    }
    base.update(over)
    return base


def _tour(**over):
    base = {
        "id": "fairfax-old-town",
        "schemaVersion": 2,
        "title": "Old Town Fairfax",
        "description": "A walking tour of six historic sites.",
        "attribution": [
            {"text": "Imagery (c) contributors", "url": "https://www.mapillary.com",
             "license": "CC-BY-SA-4.0"}
        ],
        "stops": [_stop()],
    }
    base.update(over)
    return base


def test_valid_tour_parses():
    tour = Tour.model_validate(_tour())
    assert tour.id == "fairfax-old-town"
    assert tour.stops[0].overlays[0].credit.source == "Library of Congress"


def test_geo_anchor_round_trips_its_type_literal():
    """`Anchor` is a plain alias for `GeoAnchor` today, not a discriminated
    union (pydantic's `discriminator` requires 2+ members) — this only checks
    that the literal `type` field parses and reads back."""
    anchor = GeoAnchor.model_validate(
        {"type": "geo", "lng": -77.3, "lat": 38.8, "altitudeM": 2.0})
    assert anchor.type == "geo"


def test_overlay_without_credit_is_rejected():
    """Provenance is a humanities requirement, not a nicety."""
    bad = _overlay()
    del bad["credit"]
    with pytest.raises(ValidationError):
        Overlay.model_validate(bad)


def test_overlay_with_blank_credit_source_is_rejected():
    with pytest.raises(ValidationError):
        Overlay.model_validate(_overlay(credit={**VALID_CREDIT, "source": "   "}))


def test_unknown_overlay_kind_is_rejected():
    with pytest.raises(ValidationError):
        Overlay.model_validate(_overlay(kind="hologram"))


def test_latitude_out_of_range_is_rejected():
    with pytest.raises(ValidationError):
        GeoAnchor.model_validate({"type": "geo", "lng": 0.0, "lat": 91.0, "altitudeM": 0.0})


def test_longitude_out_of_range_is_rejected():
    with pytest.raises(ValidationError):
        GeoAnchor.model_validate({"type": "geo", "lng": 181.0, "lat": 0.0, "altitudeM": 0.0})


def test_stop_order_must_be_positive():
    with pytest.raises(ValidationError):
        Stop.model_validate(_stop(order=0))


def test_tour_requires_at_least_one_stop():
    with pytest.raises(ValidationError):
        Tour.model_validate(_tour(stops=[]))


def test_duplicate_stop_ids_are_rejected():
    with pytest.raises(ValidationError):
        Tour.model_validate(_tour(stops=[_stop(), _stop()]))


def test_stop_orders_must_be_contiguous_from_one():
    with pytest.raises(ValidationError):
        Tour.model_validate(_tour(stops=[_stop(id="a", order=1), _stop(id="b", order=3)]))


def test_extra_fields_are_rejected():
    """Typos in hand-authored content must fail loudly, not vanish."""
    with pytest.raises(ValidationError):
        Tour.model_validate(_tour(titel="Old Town Fairfax"))


def test_text_overlay_requires_a_body():
    with pytest.raises(ValidationError):
        Overlay.model_validate(_overlay(body="  "))


def test_image_overlay_requires_a_media_id():
    with pytest.raises(ValidationError):
        Overlay.model_validate(_overlay(kind="image", body=None))


def test_json_schema_exports():
    schema = Tour.model_json_schema()
    assert schema["title"] == "Tour"
    assert "stops" in schema["properties"]


IN_WORLD = {"mode": "inWorld", "opacity": 0.7,
            "headingDeg": 284.4, "widthM": 18.0, "heightM": 12.0}


def _image(**over):
    """Merge before delegating, matching _overlay/_stop/_tour in this file, so
    a caller can override `kind` without a duplicate-keyword TypeError."""
    base = {"kind": "image", "body": None, "mediaId": "court-1863.jpg",
            "display": IN_WORLD}
    base.update(over)
    return _overlay(**base)


@pytest.mark.parametrize("kind,mode,ok", [
    ("text", "marker", True),
    ("text", "inWorld", False),
    ("text", "ambient", False),
    ("image", "marker", True),
    ("image", "inWorld", True),
    ("image", "ambient", False),
    ("audio", "marker", True),
    ("audio", "inWorld", False),
    ("audio", "ambient", True),
])
def test_display_mode_matrix(kind, mode, ok):
    display = {"marker": {"mode": "marker"},
               "inWorld": IN_WORLD,
               "ambient": {"mode": "ambient"}}[mode]
    payload = ({"body": "Body", "mediaId": None} if kind == "text"
               else {"body": None, "mediaId": "m.bin"})
    data = _overlay(kind=kind, display=display, **payload)
    if ok:
        assert Overlay.model_validate(data).display.mode == mode
    else:
        with pytest.raises(ValidationError, match=mode):
            Overlay.model_validate(data)


def test_rephoto_is_no_longer_a_kind():
    with pytest.raises(ValidationError):
        Overlay.model_validate(_image(kind="rephoto"))


def test_geoquad_anchors_are_rejected():
    with pytest.raises(ValidationError):
        Overlay.model_validate(_image(display=IN_WORLD, anchor={
            "type": "geoQuad", "lng": -77.3, "lat": 38.8, "altitude": 1.0,
            "headingDeg": 90.0, "widthM": 2.0, "heightM": 2.0}))


def test_original_credit_needs_no_url():
    ov = Overlay.model_validate(_overlay(credit=ORIGINAL_CREDIT))
    assert ov.credit.type == "original"
    assert ov.credit.creator == "Madelyn Harrington"


@pytest.mark.parametrize("field", ["creator", "license"])
def test_blank_original_credit_field_is_rejected(field):
    with pytest.raises(ValidationError):
        Overlay.model_validate(_overlay(credit={**ORIGINAL_CREDIT, field: "   "}))


@pytest.mark.parametrize("field", ["source", "url", "license"])
def test_blank_sourced_credit_field_is_rejected(field):
    with pytest.raises(ValidationError):
        Overlay.model_validate(_overlay(credit={**VALID_CREDIT, field: "   "}))


def test_unknown_credit_type_is_rejected():
    with pytest.raises(ValidationError):
        Overlay.model_validate(_overlay(credit={"type": "vibes", "license": "x"}))


@pytest.mark.parametrize("heading,ok", [(0.0, True), (359.9, True), (360.0, False),
                                        (-0.1, False)])
def test_heading_bounds(heading, ok):
    data = _image(display={**IN_WORLD, "headingDeg": heading})
    if ok:
        assert Overlay.model_validate(data).display.heading_deg == heading
    else:
        with pytest.raises(ValidationError):
            Overlay.model_validate(data)


@pytest.mark.parametrize("opacity,ok", [(0.0, True), (1.0, True), (-0.1, False),
                                        (1.1, False)])
def test_opacity_bounds(opacity, ok):
    data = _image(display={**IN_WORLD, "opacity": opacity})
    if ok:
        assert Overlay.model_validate(data).display.opacity == opacity
    else:
        with pytest.raises(ValidationError):
            Overlay.model_validate(data)


def test_zero_width_is_rejected():
    with pytest.raises(ValidationError):
        Overlay.model_validate(_image(display={**IN_WORLD, "widthM": 0.0}))


def test_opacity_defaults_to_seven_tenths():
    display = {k: v for k, v in IN_WORLD.items() if k != "opacity"}
    assert Overlay.model_validate(_image(display=display)).display.opacity == 0.7


def test_tour_defaults_round_trip():
    tour = Tour.model_validate(_tour(defaults={"creator": "M. Harrington",
                                               "license": "CC-BY-4.0"}))
    assert tour.defaults.creator == "M. Harrington"


def test_tour_defaults_are_optional():
    assert Tour.model_validate(_tour()).defaults is None


def test_schema_version_one_is_rejected_by_the_model():
    """v1 documents go through app.migration, never straight into the model."""
    with pytest.raises(ValidationError):
        Tour.model_validate(_tour(schemaVersion=1))


def test_a_stop_may_have_no_overlays():
    assert Stop.model_validate(_stop(overlays=[])).overlays == []


def test_display_modes_table_covers_every_kind():
    """A fourth `kind` added without a matching DISPLAY_MODES_BY_KIND row must
    fail loudly as a ValidationError, not a bare KeyError out of the
    validator. This pins the table's keys to the Literal's members so the two
    cannot silently drift apart."""
    kind_literal = models.Overlay.model_fields["kind"].annotation
    assert set(DISPLAY_MODES_BY_KIND.keys()) == set(get_args(kind_literal))


def test_the_frontend_mode_table_matches_this_one():
    """frontend/src/app/editor/document-ops.ts carries a copy of
    DISPLAY_MODES_BY_KIND so the editor can offer only legal modes without a
    round trip. Two copies of a rule drift; this fails when they do."""
    src = (Path(__file__).resolve().parents[2] / "frontend" / "src" / "app"
           / "editor" / "document-ops.ts").read_text()
    block = src.split("DISPLAY_MODES_BY_KIND", 1)[1].split("}", 1)[0]
    for kind, modes in DISPLAY_MODES_BY_KIND.items():
        line = next(ln for ln in block.splitlines() if ln.strip().startswith(kind))
        for mode in modes:
            assert f"'{mode}'" in line, f"{kind} should allow {mode}"
        for mode in {"marker", "inWorld", "ambient"} - set(modes):
            assert f"'{mode}'" not in line, f"{kind} should not allow {mode}"
