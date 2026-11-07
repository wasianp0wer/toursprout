"""Per-browser session ids: minted, validated, and mapped to directories.

Pure: no FastAPI, no filesystem access beyond building paths. The sid is
also a recovery key a historian may type back in, so it is 16 lowercase hex
characters (64 bits). It names a directory, so it is validated before use.
"""

from __future__ import annotations

import re
import secrets
from pathlib import Path

SID_COOKIE = "tour_sid"
COOKIE_MAX_AGE = 31536000

_SID_PATTERN = re.compile(r"[0-9a-f]{16}")


def new_sid() -> str:
    return secrets.token_hex(8)


def valid_sid(sid: str) -> bool:
    return _SID_PATTERN.fullmatch(sid) is not None


def session_dir(sessions_dir: Path, sid: str) -> Path:
    if not valid_sid(sid):
        raise ValueError(sid)
    return sessions_dir / sid
