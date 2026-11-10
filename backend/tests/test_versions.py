"""The declared Python floor and the interpreter CI tests on must agree.

This pins consistency, which is the one thing checkable from the files alone.
It does NOT prove the code runs on 3.12: that is what the CI job on the
pinned version, and the host itself, are for.

The check reads EVERY workflow rather than one by name, which is the lesson of
how it last went wrong. It used to read `deploy.yml`, because that was the
workflow which built, tested and shipped. When shipping moved to
`deploy/deploy.sh` -- the host's firewall drops GitHub's runner addresses --
`deploy.yml` became manual-only and `ci.yml` became the workflow that gates
every push. The guard kept passing, still watching the pin in the workflow that
no longer runs, while the pin that mattered was free to drift from the floor and
from the host. Nothing was red. Iterating the directory is what makes a third
workflow covered by default instead of covered if someone remembers.
"""

from __future__ import annotations

import re
import tomllib
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
BACKEND = REPO / "backend"
WORKFLOWS = REPO / ".github/workflows"

# Anchored to a whole, uncommented line: a commented-out example or a second
# job's pin must not be able to satisfy, or silently shadow, the one a job
# really uses.
PIN = re.compile(r'^\s*python-version:\s*"(\d+\.\d+)"\s*$', re.MULTILINE)


def _pins() -> dict[str, list[str]]:
    """Every workflow that pins a Python version, by filename."""
    found = {}
    for path in sorted(WORKFLOWS.glob("*.yml")) + sorted(WORKFLOWS.glob("*.yaml")):
        pins = PIN.findall(path.read_text())
        if pins:
            found[path.name] = pins
    return found


def test_every_workflow_tests_on_the_interpreter_the_floor_names():
    """The host runs one interpreter and CI tests on another unless these move
    together. They did not, which is why the floor was lowered: it said 3.13
    and the host offers 3.12.15.
    """
    floor = tomllib.loads((BACKEND / "pyproject.toml").read_text())["project"]["requires-python"]
    pins = _pins()

    assert pins, (
        f"no workflow under {WORKFLOWS} pins a python-version, so nothing here is "
        "checking anything -- either the pin moved or this test has stopped finding it"
    )
    for name, found in pins.items():
        assert len(found) == 1, f"{name}: expected exactly one python-version pin, found {found}"
        pin = found[0]
        assert floor == f">={pin}", f"{name} tests on {pin}, requires-python says {floor}"
        # The version measured on the host (3.12.15). Bumping it is deliberate,
        # and it is bumped in every workflow, pyproject.toml and the host's
        # virtualenv together or not at all.
        assert pin == "3.12", f"{name} pins {pin}, and the host offers 3.12.15"


def test_the_workflow_that_gates_every_push_is_one_of_them():
    """Named on purpose, and the one place this file knows a filename.

    The test above would pass if `ci.yml` lost its setup-python step entirely,
    or were renamed, leaving `deploy.yml`'s manual-only pin as the only one
    found -- which is exactly the state that went unnoticed before. So the
    workflow that actually runs on every push is required to be in the set. If
    it is renamed, this assertion failing is the reminder to say so here; that
    is noisier than silence and is meant to be.
    """
    assert "ci.yml" in _pins(), (
        "ci.yml does not pin a python-version. It is the workflow that runs on every "
        "push and pull request, so it is the pin that has to match the floor; if it "
        "has been renamed, update this test to the new name."
    )
