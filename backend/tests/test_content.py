from __future__ import annotations

import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "content" / "scripts"))

from build_tour import in_world_overlay
from geo import bearing_between

CONTENT = Path(__file__).resolve().parents[2] / "content" / "source" / "stops.json"


def _stops():
    return json.loads(CONTENT.read_text())


def test_six_stops_in_contiguous_order():
    stops = _stops()
    assert len(stops) == 6
    assert [s["order"] for s in stops] == [1, 2, 3, 4, 5, 6]


def test_stop_ids_are_unique():
    assert len({s["id"] for s in _stops()}) == 6


def test_every_stop_has_narration_and_an_overlay():
    for stop in _stops():
        assert stop["narration"].strip()
        assert stop["overlays"]


def test_overlay_ids_are_globally_unique():
    ids = [o["id"] for s in _stops() for o in s["overlays"]]
    assert len(ids) == len(set(ids))


def test_text_overlays_have_bodies_and_image_overlays_have_queries():
    for stop in _stops():
        for ov in stop["overlays"]:
            if ov["kind"] == "text":
                assert ov["body"].strip()
            if ov["kind"] == "image":
                assert ov["imageQuery"].strip()


def test_bearings_are_valid_compass_degrees():
    for stop in _stops():
        assert 0 <= stop["bearing"] < 360


def test_locations_are_inside_the_fairfax_bounding_box():
    for stop in _stops():
        assert 38.840 <= stop["location"]["lat"] <= 38.856
        assert -77.318 <= stop["location"]["lng"] <= -77.295


def test_anchor_offsets_are_small_enough_to_stay_at_the_stop():
    """Overlays belong at their stop, not halfway down the street."""
    for stop in _stops():
        for ov in stop["overlays"]:
            off = ov["anchorOffset"]
            assert abs(off["east"]) <= 25
            assert abs(off["north"]) <= 25
            assert 0 <= off["altitude"] <= 20


def test_build_tour_emits_schema_version_two():
    """A cheap source-text backstop against the v1 shapes this module used to
    emit. That the OUTPUT is valid is already proven by the migration suite
    against the real on-disk document; behavioural coverage of the one
    highest-stakes invariant (derived, not authored, heading) lives in
    test_rephoto_heading_is_derived_not_authored below."""
    src = Path(__file__).resolve().parents[2] / "content" / "scripts" / "build_tour.py"
    text = src.read_text()
    assert '"schemaVersion": SCHEMA_VERSION' in text
    assert '"kind": "rephoto"' not in text
    assert '"type": "geoQuad"' not in text
    assert '"altitude":' not in text


def test_rephoto_heading_is_derived_not_authored():
    """The spec's authored headingDeg must never reach the output. The display
    heading is derived from where the panorama actually stands, computed
    independently here with the same bearing_between the generator uses."""
    spec = {
        "id": "test-rephoto",
        "title": "Test rephoto",
        "anchor": {
            "type": "geoQuad",
            "lng": -77.307,
            "lat": 38.846,  # north of the panorama, so the photo must face south (~180)
            "altitude": 8.0,
            "headingDeg": 200,  # deliberately wrong authored value
            "widthM": 30,
            "heightM": 24,
        },
    }
    pano_lng, pano_lat = -77.307, 38.845
    credit = {"type": "sourced", "source": "s", "url": "u", "license": "l", "creator": None}

    overlay = in_world_overlay(spec, "test-rephoto.jpg", credit, pano_lng, pano_lat, 0)

    expected = round(
        bearing_between(spec["anchor"]["lng"], spec["anchor"]["lat"], pano_lng, pano_lat), 1)
    assert overlay["display"]["headingDeg"] == expected
    assert overlay["display"]["headingDeg"] != spec["anchor"]["headingDeg"]


def test_split_shape_rephoto_heading_is_also_derived_not_authored():
    """The editor's overlay model is a split {anchor, display} shape, not
    the flat v1-ish shape above. in_world_overlay must accept that shape --
    so pasting an overlay copied from an exported tour into stops.json
    actually works -- while still deriving the heading: a
    pasted display.headingDeg, however wrong, must be ignored exactly like
    the flat shape's authored anchor.headingDeg already is."""
    spec = {
        "id": "test-rephoto-split",
        "title": "Test rephoto (split shape)",
        "anchor": {"type": "geo", "lng": -77.307, "lat": 38.846, "altitudeM": 8.0},
        "display": {
            "mode": "inWorld",
            "headingDeg": 7.0,  # deliberately bogus -- must be ignored
            "widthM": 30,
            "heightM": 24,
        },
    }
    pano_lng, pano_lat = -77.307, 38.845
    credit = {"type": "sourced", "source": "s", "url": "u", "license": "l", "creator": None}

    overlay = in_world_overlay(spec, "test-rephoto-split.jpg", credit, pano_lng, pano_lat, 0)

    expected = round(
        bearing_between(spec["anchor"]["lng"], spec["anchor"]["lat"], pano_lng, pano_lat), 1)
    assert overlay["display"]["headingDeg"] == expected
    assert overlay["display"]["headingDeg"] != spec["display"]["headingDeg"]
    assert overlay["anchor"] == {"type": "geo", "lng": -77.307, "lat": 38.846, "altitudeM": 8.0}
    assert overlay["display"]["widthM"] == 30
    assert overlay["display"]["heightM"] == 24


# --- the pipeline and the shipped examples stay apart -----------------------

REPO = Path(__file__).resolve().parents[2]
SCRIPTS = REPO / "content" / "scripts"

# Every spelling by which something here could reach `content/examples/`: the
# quoted component a `Path(...) / "examples"` needs, the literal path, and the
# module and constant that already know the directory's name
# (`backend/app/examples.py`). Deliberately not a bare `examples`, which would
# fail over the word appearing in a comment.
EXAMPLES_REFERENCES = (
    '"examples"',
    "'examples'",
    "content/examples",
    "app.examples",
    "EXAMPLES_DIRNAME",
)


def _names_the_examples_directory(text: str) -> list[str]:
    return [ref for ref in EXAMPLES_REFERENCES if ref in text]


def test_the_content_pipeline_never_names_the_examples_directory():
    """`make content` must leave `content/examples/` alone, and this is the
    test that makes that true rather than accidental.

    The shipped example is a frozen committed snapshot precisely because the
    pipeline overwrites what it generates: `make content` regenerates
    `content/tours/fairfax-old-town.json` and silently reverts the hand-tuned
    rephoto alignment in `de48b0d` (HANDOFF.md, Outstanding item 2). An
    example that the pipeline could rewrite would have the same problem, and
    its recorded figures -- stopCount 6, mediaCount 15, orphanCount 6 -- would
    stop being reproducible.

    Same idiom as the allowlist tie-tests in test_media_store.py: read the
    source as text and fail when it says something it should not. If a script
    genuinely needs to read an example one day, that is a deliberate decision
    and this test is where to record it -- do not widen it to make a write
    pass.
    """
    offenders = {
        script.name: found
        for script in sorted(SCRIPTS.glob("*.py"))
        if (found := _names_the_examples_directory(script.read_text()))
    }
    assert offenders == {}, (
        f"a content script now names the examples directory: {offenders}"
    )


def test_the_content_make_target_never_names_the_examples_directory():
    """The other way `make content` could reach it: a recipe line of its own.

    The scripts are not the whole of the target -- a `cp` or an `rm` in the
    Makefile would write to `content/examples/` without any script mentioning
    it -- so the recipe is read too. Only the `content:` target's own lines,
    since the rest of the Makefile has no business being constrained by this.
    """
    lines = (REPO / "Makefile").read_text().splitlines()
    start = next(i for i, line in enumerate(lines) if line.startswith("content:"))
    recipe = []
    for line in lines[start + 1:]:
        if line and not line.startswith(("\t", " ")):
            break
        recipe.append(line)
    assert recipe, "could not find the content: target's recipe"

    found = _names_the_examples_directory("\n".join(recipe))
    assert found == [], f"the content: target now names the examples directory: {found}"
