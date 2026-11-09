"""Per-browser session ids: minted, validated, and mapped to directories.

No FastAPI. Path building is pure; `sweep` and the two functions that
throttle it are the only ones that touch the filesystem. The sid is also a
recovery key a historian may type back in, so it is 16 lowercase hex
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


SWEEP_STAMP = ".last-sweep"


def sweep_due(sessions_dir: Path, *, interval_seconds: float, now: float) -> bool:
    """Has `interval_seconds` passed since the last sweep was marked?

    The clock lives in the filesystem, not in the process: under CGI every
    request is a fresh interpreter, so a timestamp in memory is always unset
    and would throttle nothing. It is the stamp's MTIME, not its contents:
    there is nothing to parse and nothing to corrupt.

    Wall clock, not `time.monotonic()`: the stamp outlives the process, and
    monotonic time is measured from boot, so a stored value means nothing
    after a restart. The cost is a host whose clock steps: a stamp dated in
    the future would otherwise suppress every sweep for as long as the skew
    lasts, so a negative age reads as due.

    Due when the stamp is absent or unreadable: the sweep is housekeeping
    that must still happen on a fresh deployment, and `mark_swept` is what
    keeps an unwritable stamp from meaning a walk per request.
    """
    try:
        age = now - (sessions_dir / SWEEP_STAMP).stat().st_mtime
    except OSError:
        return True
    return not 0 <= age < interval_seconds


def mark_swept(sessions_dir: Path, *, now: float) -> bool:
    """Record `now` as the moment of the last sweep; False if it could not be.

    The caller stamps BEFORE sweeping and skips the walk when this returns
    False, so a sessions directory that cannot hold the stamp costs one
    refused write per mint rather than a full walk per mint. `now` is passed
    in rather than taken from the clock here so that the value compared by
    `sweep_due` is the one the caller already read.

    Creates `sessions_dir`: the first mint of a new deployment sweeps before
    it makes the directory it is about to mint into.
    """
    try:
        sessions_dir.mkdir(parents=True, exist_ok=True)
        stamp = sessions_dir / SWEEP_STAMP
        stamp.touch(exist_ok=True)
        # A `touch` that lands and a `utime` that does not is reported as
        # failure, and leaves a stamp dated now, so the caller skips this
        # walk AND the next interval is suppressed as well. Deliberate, and
        # not to be "fixed" into retrying: both halves fail towards sweeping
        # less, which is the only safe direction near a historian's
        # in-progress tour.
        os.utime(stamp, (now, now))
    except OSError:
        return False
    return True


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

    A stale `<sid>.incoming` is reclaimed too, on the short window: it is the
    staging copy of an import (`bundle._swap_in`) that did not finish, so it
    holds no reachable work. A `<sid>.outgoing` is deliberately NEVER touched:
    it holds the tour an import was replacing, which is worth a human looking
    inside before it goes. Both names fail `valid_sid`, so they are matched
    here explicitly, and only when the stem is itself a valid sid.

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
            stem, dot, suffix = entry.name.partition(".")
            is_incoming = dot == "." and suffix == "incoming" and valid_sid(stem)
            if not (valid_sid(entry.name) or is_incoming):
                continue
            if entry.is_symlink() or not entry.is_dir():
                continue
            path = Path(entry.path)
            newest = _newest_mtime(path)
            if newest is None:
                continue
            if is_incoming:
                days = without_tour_days
            else:
                days = with_tour_days if (path / "tour.json").is_file() else without_tour_days
            if now - newest <= days * _DAY:
                continue
            shutil.rmtree(path, ignore_errors=True)
        except OSError:
            pass
        except Exception as exc:  # noqa: BLE001 - housekeeping must never reach a request
            # Type only, never .exception(): messages and tracebacks can carry a sid.
            _log.error("session sweep failed on one entry: %s", type(exc).__name__)
        if not os.path.lexists(entry.path):
            removed.append(entry.name)
    return removed
