from __future__ import annotations

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
