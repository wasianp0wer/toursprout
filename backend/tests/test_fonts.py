"""The typefaces: every pairing an author can pick resolves to shipped faces."""
from __future__ import annotations

import json
from pathlib import Path

from tests.theme_vocabulary import names_in

REPO = Path(__file__).resolve().parents[2]


def test_every_type_pairing_has_its_faces_declared():
    """A pairing an author can choose must resolve to a family we ship."""
    css = (REPO / "frontend/src/styles.css").read_text()
    for pairing in names_in("TYPE_PAIRINGS"):
        assert f"app-viewer-page[data-type-pairing='{pairing}']" in css


def test_the_font_licences_reach_the_build_output():
    """src/assets only ships what a url() pulls in, and nothing resolves a
    url() to a text file, so the licence needs its own assets entry."""
    assets = json.loads((REPO / "frontend/angular.json").read_text()) \
        ["projects"]["frontend"]["architect"]["build"]["options"]["assets"]
    assert any("fonts" in json.dumps(a) for a in assets)
    assert list((REPO / "frontend/src/assets/fonts").glob("OFL-*.txt"))
