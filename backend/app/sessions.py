"""Per-browser session ids: minted, validated, and mapped to directories.

No FastAPI. Path building is pure; `sweep` is the one function that touches
the filesystem. The sid is also a recovery key a historian may type back in, so it is 16 lowercase hex
characters (64 bits). It names a directory, so it is validated before use.
"""

from __future__ import annotations

import logging
import os
import re
import secrets
import shutil
import time
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


_log = logging.getLogger(__name__)
_DAY = 86400


def _newest_mtime(path: Path) -> float | None:
    """Newest mtime of `path` or anything under it; None if any of it is unreadable.

    A directory's own mtime only moves when an entry is added or removed, not
    when a file inside is rewritten, so the files are what is measured. None
    (rather than a partial answer) lets the caller leave alone a directory it
    could not fully see, since an unseen file might be the recent one.
    """
    failed = False

    def onerror(_exc: OSError) -> None:
        nonlocal failed
        failed = True

    try:
        newest = path.stat().st_mtime
        for root, dirs, files in os.walk(path, onerror=onerror):
            for name in dirs + files:
                try:
                    newest = max(newest, os.lstat(os.path.join(root, name)).st_mtime)
                except OSError:
                    failed = True
    except OSError:
        return None
    return None if failed else newest


def sweep(
    sessions_dir: Path,
    *,
    without_tour_days: float,
    with_tour_days: float,
    now: float | None = None,
) -> list[str]:
    """Delete abandoned session directories; return the sids removed.

    Two windows. A directory with no `tour.json` holds no authored work and
    no recovery key anyone was shown, so it goes after `without_tour_days`.
    One with a `tour.json` may have its key on paper, so it gets
    `with_tour_days`. The test is the file itself, not `Session.is_open`:
    `session.py` imports from this package's layer, and a plain `is_file`
    keeps this module free of it and says exactly what the policy depends on.

    Never raises: anything unreadable, or gone mid-sweep, is skipped.
    """
    removed: list[str] = []
    now = time.time() if now is None else now
    try:
        entries = list(os.scandir(sessions_dir))
    except OSError:
        return removed
    for entry in entries:
        try:
            if not valid_sid(entry.name) or entry.is_symlink() or not entry.is_dir():
                continue
            path = Path(entry.path)
            newest = _newest_mtime(path)
            if newest is None:
                continue
            days = with_tour_days if (path / "tour.json").is_file() else without_tour_days
            if now - newest <= days * _DAY:
                continue
            shutil.rmtree(path, ignore_errors=True)
        except OSError:
            pass
        except Exception:  # noqa: BLE001 - housekeeping must never reach a request
            _log.exception("session sweep failed on one entry")
        if not os.path.lexists(entry.path):
            removed.append(entry.name)
    return removed
