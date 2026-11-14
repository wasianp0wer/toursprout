"""One reader for the name arrays in frontend/src/app/core/theme.ts.

Two regexes over one file is the drift the vocabulary tests exist to prevent,
so every test that needs a list of names from theme.ts reads it here.
"""
from __future__ import annotations

import re
from pathlib import Path

THEME_TS = (Path(__file__).resolve().parents[2] / "frontend" / "src" / "app"
            / "core" / "theme.ts")


def names_in(array_name: str) -> list[str]:
    """The strings in `const <array_name> = ['a', 'b'] as const;`, in order.

    This relies on theme.ts writing each array on one line with single quotes,
    as document-ops.ts does for IMAGE_EXTS. A formatter that wraps the array or
    switches the quotes makes this fail loudly rather than return a short list.
    """
    match = re.search(rf"const {array_name} = \[([^\]]*)\]", THEME_TS.read_text())
    assert match, f"{array_name} not found as a one-line array in {THEME_TS}"
    return re.findall(r"'([^']+)'", match.group(1))


def interface_fields(interface_name: str) -> list[str]:
    """Field names of `export interface <interface_name> { ... }` in theme.ts."""
    match = re.search(rf"export interface {interface_name} \{{(.*?)\n\}}",
                      THEME_TS.read_text(), re.DOTALL)
    assert match, f"interface {interface_name} not found in {THEME_TS}"
    return re.findall(r"^\s+(\w+)\??:", match.group(1), re.MULTILINE)
