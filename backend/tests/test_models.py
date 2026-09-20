from __future__ import annotations

import json

import pytest
from pydantic import ValidationError

from app.models import Credit, GeoAnchor, Overlay, Stop, Tour

VALID_CREDIT = {
    "source": "Library of Congress",
    "url": "https://www.loc.gov/item/2016123456/",
    "license": "No known restrictions",
    "creator": "National Photo Company",
}


def _overlay(**over):
    base = {
        "id": "ov-1",
        "kind": "text",
        "anchor": {"type": "geo", "lng": -77.30732, "lat": 38.84562, "altitude": 3.0},
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
        "schemaVersion": 1,
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


def test_geo_anchor_is_discriminated_by_type():
    anchor = GeoAnchor.model_validate(
        {"type": "geo", "lng": -77.3, "lat": 38.8, "altitude": 2.0})
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
        GeoAnchor.model_validate({"type": "geo", "lng": 0.0, "lat": 91.0, "altitude": 0.0})


def test_longitude_out_of_range_is_rejected():
    with pytest.raises(ValidationError):
        GeoAnchor.model_validate({"type": "geo", "lng": 181.0, "lat": 0.0, "altitude": 0.0})


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


def test_credit_object_rejects_blank_license():
    with pytest.raises(ValidationError):
        Credit.model_validate({**VALID_CREDIT, "license": ""})


def test_json_schema_exports():
    schema = Tour.model_json_schema()
    assert schema["title"] == "Tour"
    assert "stops" in schema["properties"]


GEO_QUAD = {
    "type": "geoQuad",
    "lng": -77.30732, "lat": 38.84562, "altitude": 6.0,
    "headingDeg": 200.0, "widthM": 18.0, "heightM": 14.0,
}


def _rephoto(**over):
    base = {
        "id": "court-1863",
        "kind": "rephoto",
        "anchor": dict(GEO_QUAD),
        "title": "Fairfax Court House, 1863",
        "mediaId": "court-1863.jpg",
        "credit": VALID_CREDIT,
    }
    base.update(over)
    return base


def test_rephoto_overlay_parses():
    ov = Overlay.model_validate(_rephoto())
    assert ov.kind == "rephoto"
    assert ov.anchor.type == "geoQuad"
    assert ov.anchor.heading_deg == 200.0
    assert ov.anchor.width_m == 18.0


def test_rephoto_requires_a_geo_quad_anchor():
    """A rephoto is a plane in the world; a bare point cannot place one."""
    with pytest.raises(ValidationError):
        Overlay.model_validate(_rephoto(
            anchor={"type": "geo", "lng": -77.3, "lat": 38.8, "altitude": 3.0}))


def test_rephoto_requires_a_media_id():
    with pytest.raises(ValidationError):
        Overlay.model_validate(_rephoto(mediaId=None))


def test_text_overlay_rejects_a_geo_quad_anchor():
    """geoQuad is meaningless for a marker; accepting it would hide a mistake."""
    with pytest.raises(ValidationError):
        Overlay.model_validate(_overlay(anchor=dict(GEO_QUAD)))


def test_geo_quad_heading_must_be_a_compass_bearing():
    with pytest.raises(ValidationError):
        Overlay.model_validate(_rephoto(anchor={**GEO_QUAD, "headingDeg": 360.0}))
    with pytest.raises(ValidationError):
        Overlay.model_validate(_rephoto(anchor={**GEO_QUAD, "headingDeg": -1.0}))


def test_geo_quad_dimensions_must_be_positive():
    for field in ("widthM", "heightM"):
        with pytest.raises(ValidationError):
            Overlay.model_validate(_rephoto(anchor={**GEO_QUAD, field: 0.0}))


def test_geo_quad_dimensions_have_a_sane_upper_bound():
    """A 500 m photograph is a typo, not a design choice."""
    with pytest.raises(ValidationError):
        Overlay.model_validate(_rephoto(anchor={**GEO_QUAD, "widthM": 500.0}))


def test_anchor_union_discriminates_on_type():
    assert Overlay.model_validate(_overlay()).anchor.type == "geo"
    assert Overlay.model_validate(_rephoto()).anchor.type == "geoQuad"


def test_tour_with_a_rephoto_stop_validates():
    stop = _stop(overlays=[_overlay(), _rephoto()])
    tour = Tour.model_validate(_tour(stops=[stop]))
    assert [o.kind for o in tour.stops[0].overlays] == ["text", "rephoto"]


def test_rephoto_round_trips_through_camel_case_json():
    tour = Tour.model_validate(_tour(stops=[_stop(overlays=[_rephoto()])]))
    dumped = json.loads(tour.model_dump_json(by_alias=True))
    anchor = dumped["stops"][0]["overlays"][0]["anchor"]
    assert anchor["headingDeg"] == 200.0
    assert anchor["widthM"] == 18.0
