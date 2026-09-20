from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "content" / "scripts"))

from relevance import best_match, score_title

REQUIRED = ["fairfax", "court"]
EXCLUDED = ["alexandria", "chantilly", "lorton", "reston"]


def test_matching_title_scores_above_zero():
    assert score_title("Fairfax Court House, Va.", REQUIRED, EXCLUDED) > 0


def test_title_missing_a_required_term_is_rejected():
    assert score_title("Old Town Hall, Virginia", REQUIRED, EXCLUDED) == 0.0


def test_title_naming_an_excluded_place_is_rejected():
    """This is the actual bug: an Alexandria photo labelled as Fairfax."""
    assert score_title(
        "Alexandria Market House & City Hall, Fairfax Street", REQUIRED, EXCLUDED
    ) == 0.0


def test_matching_is_case_insensitive():
    assert score_title("FAIRFAX COURT HOUSE", REQUIRED, EXCLUDED) > 0


def test_empty_title_is_rejected():
    assert score_title("", REQUIRED, EXCLUDED) == 0.0


def test_none_title_is_rejected():
    assert score_title(None, REQUIRED, EXCLUDED) == 0.0


def test_shorter_matching_title_is_more_specific():
    short = score_title("Fairfax Court House", REQUIRED, EXCLUDED)
    long = score_title(
        "Fairfax Court House and the surrounding countryside in Virginia, a view",
        REQUIRED, EXCLUDED)
    assert short > long


def test_best_match_picks_the_highest_scoring_item():
    items = [
        {"title": "Virginia countryside", "image_url": ["a.jpg"]},
        {"title": "Fairfax Court House, Va.", "image_url": ["b.jpg"]},
    ]
    assert best_match(items, REQUIRED, EXCLUDED)["title"] == "Fairfax Court House, Va."


def test_best_match_skips_items_without_an_image():
    items = [{"title": "Fairfax Court House", "image_url": []}]
    assert best_match(items, REQUIRED, EXCLUDED) is None


def test_best_match_returns_none_when_nothing_is_relevant():
    items = [{"title": "Alexandria City Hall", "image_url": ["a.jpg"]}]
    assert best_match(items, REQUIRED, EXCLUDED) is None


def test_best_match_handles_list_valued_titles():
    """The LoC API sometimes returns a list where a string is expected."""
    items = [{"title": ["Fairfax Court House"], "image_url": ["a.jpg"]}]
    assert best_match(items, REQUIRED, EXCLUDED) is not None


def test_best_match_on_empty_input():
    assert best_match([], REQUIRED, EXCLUDED) is None


def test_no_required_terms_still_rejects_excluded_places():
    assert score_title("Alexandria City Hall", [], EXCLUDED) == 0.0
