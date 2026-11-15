"""The typefaces: every pairing an author can pick resolves to shipped faces."""
from __future__ import annotations

import json
import re
from pathlib import Path

from tests.theme_vocabulary import names_in

REPO = Path(__file__).resolve().parents[2]


def test_every_type_pairing_has_its_faces_declared():
    """A pairing an author can choose must resolve to a family we ship."""
    css = (REPO / "frontend/src/styles.css").read_text()
    for pairing in names_in("TYPE_PAIRINGS"):
        # Unprefixed on purpose: the editor's live preview carries the attribute too.
        assert f"[data-type-pairing='{pairing}']" in css


def _declared_families(css: str) -> set[str]:
    return set(re.findall(r"@font-face\s*\{[^}]*?font-family:\s*'([^']+)'", css))


def test_every_family_a_pairing_names_is_declared_or_a_system_face():
    """A typo like 'EB Garammond' would silently render as the fallback."""
    css = (REPO / "frontend/src/styles.css").read_text()
    declared = _declared_families(css)
    system = {"Georgia", "Times New Roman"}
    named = set()
    for pairing in names_in("TYPE_PAIRINGS"):
        rule = re.search(rf"\[data-type-pairing='{pairing}'\]\s*\{{([^}}]*)\}}", css)
        assert rule, pairing
        named |= set(re.findall(r"'([^']+)'", rule.group(1)))
    assert declared, "no @font-face found"
    for family in named:
        assert family in declared | system, family


def test_every_declared_family_ships_its_licence():
    css = (REPO / "frontend/src/styles.css").read_text()
    for family in _declared_families(css):
        slug = family.replace(" ", "").lower()
        assert (REPO / f"frontend/src/assets/fonts/OFL-{slug}.txt").exists(), family


def test_the_font_licences_reach_the_build_output():
    """src/assets only ships what a url() pulls in, and nothing resolves a
    url() to a text file, so the licence needs its own assets entry."""
    assets = json.loads((REPO / "frontend/angular.json").read_text()) \
        ["projects"]["frontend"]["architect"]["build"]["options"]["assets"]
    assert any("fonts" in json.dumps(a) for a in assets)
    assert list((REPO / "frontend/src/assets/fonts").glob("OFL-*.txt"))
