from __future__ import annotations

from pathlib import Path
from typing import get_args

import pytest
from pydantic import ValidationError

from app import models
from app.models import (
    DISPLAY_MODES_BY_KIND,
    GeoAnchor,
    Overlay,
    Stop,
    Theme,
    ThemeOverrides,
    Tour,
)

from .theme_vocabulary import interface_fields, names_in

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
            "cachedMediaId": "pano/historic-courthouse.jpg",
        },
        "overlays": [_overlay()],
    }
    base.update(over)
    return base


def _tour(**over):
    base = {
        "id": "fairfax-old-town",
        "schemaVersion": 4,
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


def test_duplicate_overlay_ids_in_one_stop_are_rejected():
    with pytest.raises(ValidationError, match="overlay ids"):
        Tour.model_validate(
            _tour(stops=[_stop(overlays=[_overlay(), _overlay()])])
        )


def test_duplicate_overlay_ids_across_stops_are_rejected():
    """The editor looks overlays up by id across every stop
    (`mapOverlay`/`deleteOverlay` in document-ops.ts), so two stops sharing an
    overlay id means editing or deleting one edits or deletes both."""
    with pytest.raises(ValidationError, match="overlay ids"):
        Tour.model_validate(
            _tour(stops=[
                _stop(id="a", order=1, overlays=[_overlay(id="shared")]),
                _stop(id="b", order=2, overlays=[_overlay(id="shared")]),
            ])
        )


def test_an_overlay_id_may_not_collide_with_a_stop_id():
    """One id namespace: `allIds()` in document-ops.ts allocates stop and
    overlay ids from the same pool, so the schema says so too."""
    with pytest.raises(ValidationError, match="ids"):
        Tour.model_validate(
            _tour(stops=[_stop(id="historic-courthouse",
                               overlays=[_overlay(id="historic-courthouse")])])
        )


def test_an_attribution_may_have_no_url():
    """The same lesson as the `Credit` split (ADR 0001): a line of
    attribution with nothing to link to is ordinary, and a required `url`
    is how v1's single credit shape became unsatisfiable."""
    tour = Tour.model_validate(
        _tour(attribution=[{"text": "Photographs by the author",
                            "url": None, "license": "CC-BY-4.0"}])
    )
    assert tour.attribution[0].url is None


def test_an_attribution_url_may_be_omitted_entirely():
    tour = Tour.model_validate(
        _tour(attribution=[{"text": "Photographs by the author",
                            "license": "CC-BY-4.0"}])
    )
    assert tour.attribution[0].url is None


def test_a_blank_attribution_url_is_rejected():
    """Absent is `null`; `""` is a field someone failed to fill in."""
    with pytest.raises(ValidationError):
        Tour.model_validate(
            _tour(attribution=[{"text": "t", "url": "  ", "license": "ODbL"}])
        )


def test_a_blank_attribution_license_is_rejected():
    with pytest.raises(ValidationError):
        Tour.model_validate(
            _tour(attribution=[{"text": "t", "url": "https://e.org",
                                "license": ""}])
        )


@pytest.mark.parametrize("ref", [
    "court-1863.jpg",
    "pano/pano-historic-courthouse.jpg",
    "a/b/c/deep.jpg",
])
def test_a_media_reference_may_be_a_relative_path_inside_media(ref):
    """Nesting is the point: the shipped tour keeps its panoramas in
    `media/pano/`, and import preserves directories."""
    assert Overlay.model_validate(
        _overlay(kind="image", mediaId=ref, body=None)
    ).media_id == ref


@pytest.mark.parametrize("ref", [
    "../escape.jpg",
    "pano/../../escape.jpg",
    "/etc/passwd",
    "pano\\windows.jpg",
    "./here.jpg",
    "pano//double.jpg",
    " leading.jpg",
    "trailing.jpg ",
    "media/pano/already-prefixed.jpg",
])
def test_a_media_reference_that_is_not_inside_media_is_rejected(ref):
    """`mediaId` was unvalidated through v2, so `../../etc/passwd` was a valid
    document. The last case is the one that is easy to get wrong by hand: a
    reference is relative to `media/`, so repeating the prefix would resolve
    to `media/media/...`."""
    with pytest.raises(ValidationError):
        Overlay.model_validate(_overlay(kind="image", mediaId=ref, body=None))


def test_a_cached_panorama_is_held_to_the_same_rule(ref="../escape.jpg"):
    """Both media references share one type, so neither can drift from the
    other. ADR 0005."""
    bad = _stop()
    bad["panorama"] = {**bad["panorama"], "cachedMediaId": ref}
    with pytest.raises(ValidationError):
        Stop.model_validate(bad)


def test_referenced_media_counts_overlays_and_cached_panoramas():
    """The collector both the orphan check and the missing-media check use.
    While it read overlays only, six referenced panoramas were reported as
    orphans."""
    tour = Tour.model_validate(_tour(stops=[_stop(
        overlays=[_overlay(kind="image", mediaId="court-1863.jpg", body=None)],
    )]))
    assert models.referenced_media(tour) == {
        "court-1863.jpg", "pano/historic-courthouse.jpg",
    }


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


def test_a_hex_colour_must_be_six_digits_with_a_hash():
    for bad in ("#fff", "red", "#12345g", "url(x)", "#ffffff;", "", "#ffffffff"):
        with pytest.raises(ValidationError):
            ThemeOverrides(accent=bad)


def test_a_hex_colour_is_stored_lowercased():
    assert ThemeOverrides(accent="#AABBCC").accent == "#aabbcc"


def test_a_theme_defaults_to_nocturne_with_no_overrides():
    t = Theme()
    assert (t.preset, t.type_pairing, t.type_scale, t.layout) == (
        "nocturne", "georgia", "comfortable", "widePanel")
    assert t.overrides.model_dump(exclude_none=True) == {}


def test_a_tour_has_no_theme_by_default():
    assert Tour.model_validate(_tour()).theme is None


def test_an_unknown_preset_is_refused():
    with pytest.raises(ValidationError):
        Theme(preset="brutalist")


def test_the_frontend_theme_vocabulary_matches_this_one():
    """frontend/src/app/core/theme.ts spells the four enumerated choices out
    again so a viewer with no Python in the path can validate them. Same idiom
    as test_the_frontend_mode_table_matches_this_one: read the TypeScript as
    text so the two copies cannot drift."""
    for name, field in (
        ("PRESET_NAMES", "preset"),
        ("TYPE_PAIRINGS", "type_pairing"),
        ("TYPE_SCALES", "type_scale"),
        ("LAYOUT_NAMES", "layout"),
    ):
        want = list(get_args(Theme.model_fields[field].annotation))
        assert names_in(name) == want, name


def test_the_frontend_theme_overrides_have_the_same_thirteen_fields():
    """A fourteenth token must not be addable on one side only. The TypeScript
    uses the camelCase JSON spelling, which is each field's alias if it has one."""
    want = [f.alias or n for n, f in ThemeOverrides.model_fields.items()]
    assert len(want) == 13
    assert interface_fields("ThemeOverrides") == want
