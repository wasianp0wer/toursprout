"""The declared Python floor and the interpreter CI tests on must agree.

This pins consistency, which is the one thing checkable from the files alone.
It does NOT prove the code runs on 3.12: that is what the CI job on the
pinned version, and the host itself, are for.
"""

from __future__ import annotations

import re
import tomllib
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
BACKEND = REPO / "backend"


def test_the_deploy_tests_on_the_interpreter_the_floor_names():
    """The host runs one interpreter and CI tests on another unless these two
    move together. They did not, which is why this branch exists: the floor
    said 3.13 and the host offers 3.12.15.
    """
    floor = tomllib.loads((BACKEND / "pyproject.toml").read_text())["project"]["requires-python"]
    workflow = (REPO / ".github/workflows/deploy.yml").read_text()
    # Anchored to a whole, uncommented line, and required to occur exactly
    # once: a commented-out example or a second job's pin must not be able to
    # satisfy (or silently shadow) the one the deploy job really uses. Zero
    # matches fails here with a message rather than crashing on None.
    pins = re.findall(r'^\s*python-version:\s*"(\d+\.\d+)"\s*$', workflow, re.MULTILINE)
    assert len(pins) == 1, f"expected exactly one python-version pin, found {pins}"
    assert floor == f">={pins[0]}"
    # The version measured on the host (3.12.15). Bumping it is deliberate.
    assert pins[0] == "3.12"
