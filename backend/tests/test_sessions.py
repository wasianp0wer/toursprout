from __future__ import annotations

import os
import shutil

import pytest

from app.sessions import (
    SWEEP_STAMP,
    mark_swept,
    new_sid,
    session_dir,
    sweep,
    sweep_due,
    valid_sid,
)


def test_new_sid_is_sixteen_hex_characters():
    sid = new_sid()
    assert len(sid) == 16 and all(c in "0123456789abcdef" for c in sid)

def test_new_sid_does_not_repeat():
    assert len({new_sid() for _ in range(100)}) == 100

@pytest.mark.parametrize("bad", [
    "", ".", "..", "../etc", "a/b", "a\\b", "%2e%2e", "A" * 16, "abc",
    "0123456789abcdef0", "0123456789abcde", "0123456789abcdeg", " 0123456789abcdef",
    "0123456789abcdef\n", "0123456789abcde\x00", "٠" * 16,
])
def test_valid_sid_refuses(bad):
    assert valid_sid(bad) is False

def test_session_dir_is_a_child_of_sessions_dir(tmp_path):
    sid = new_sid()
    assert session_dir(tmp_path, sid) == tmp_path / sid

@pytest.mark.parametrize("bad", ["..", "a/b", ""])
def test_session_dir_refuses_before_touching_the_filesystem(tmp_path, bad):
    with pytest.raises(ValueError):
        session_dir(tmp_path, bad)
    assert list(tmp_path.iterdir()) == []


# --- sweep -----------------------------------------------------------------

DAY = 86400
NOW = 1_800_000_000.0


def _make(root, sid, *, tour, age_days, files=("config.json",)):
    d = root / sid
    d.mkdir(parents=True)
    names = list(files) + (["tour.json"] if tour else [])
    for name in names:
        (d / name).write_text("{}")
        os.utime(d / name, (NOW - age_days * DAY,) * 2)
    os.utime(d, (NOW - age_days * DAY,) * 2)
    return d


def _sweep(root):
    return sweep(root, without_tour_days=1, with_tour_days=90, now=NOW)


def test_sweep_removes_only_the_stale(tmp_path):
    fresh = _make(tmp_path, "a" * 16, tour=False, age_days=0.5)
    stale = _make(tmp_path, "b" * 16, tour=False, age_days=2)
    assert _sweep(tmp_path) == ["b" * 16]
    assert fresh.exists()
    assert not stale.exists()


def test_sweep_gives_a_tour_the_long_window(tmp_path):
    kept = _make(tmp_path, "a" * 16, tour=True, age_days=89)
    gone = _make(tmp_path, "b" * 16, tour=True, age_days=91)
    assert _sweep(tmp_path) == ["b" * 16]
    assert kept.exists()
    assert not gone.exists()


def test_sweep_does_not_give_a_directory_without_a_tour_the_long_window(tmp_path):
    _make(tmp_path, "a" * 16, tour=False, age_days=30)
    assert _sweep(tmp_path) == ["a" * 16]


def test_sweep_measures_the_newest_file_not_the_directory(tmp_path):
    d = _make(tmp_path, "a" * 16, tour=True, age_days=200, files=("config.json", "x.json"))
    (d / "media").mkdir()
    recent = d / "media" / "photo.jpg"
    recent.write_text("x")
    os.utime(recent, (NOW - DAY * 5,) * 2)
    os.utime(d, (NOW - 200 * DAY,) * 2)
    assert _sweep(tmp_path) == []
    assert d.exists()


def test_sweep_ignores_what_is_not_a_session_directory(tmp_path):
    stray_file = tmp_path / ("a" * 16)
    stray_file.write_text("x")
    os.utime(stray_file, (NOW - 500 * DAY,) * 2)
    other = tmp_path / "not-a-sid"
    other.mkdir()
    os.utime(other, (NOW - 500 * DAY,) * 2)
    assert _sweep(tmp_path) == []
    assert stray_file.exists() and other.exists()


def _staging(root, name, *, age_days):
    d = root / name
    d.mkdir()
    f = d / "tour.json"
    f.write_text("{}")
    for p in (f, d):
        os.utime(p, (NOW - age_days * DAY,) * 2)
    return d


def test_sweep_reclaims_a_stale_incoming_with_a_valid_sid_stem(tmp_path):
    d = _staging(tmp_path, "a" * 16 + ".incoming", age_days=2)
    assert _sweep(tmp_path) == ["a" * 16 + ".incoming"]
    assert not d.exists()


def test_sweep_reclaims_a_stale_incoming_on_the_short_window_despite_a_tour_json(tmp_path):
    d = _staging(tmp_path, "a" * 16 + ".incoming", age_days=30)
    assert (d / "tour.json").exists()
    assert _sweep(tmp_path) == ["a" * 16 + ".incoming"]


def test_sweep_keeps_a_fresh_incoming_so_a_running_import_survives(tmp_path):
    d = _staging(tmp_path, "a" * 16 + ".incoming", age_days=0.5)
    assert _sweep(tmp_path) == []
    assert d.exists()


def test_sweep_keeps_a_stale_outgoing_because_it_holds_a_replaced_tour(tmp_path):
    d = _staging(tmp_path, "a" * 16 + ".outgoing", age_days=500)
    assert _sweep(tmp_path) == []
    assert d.exists()


def test_sweep_leaves_an_incoming_whose_stem_is_not_a_sid(tmp_path):
    odd = _staging(tmp_path, "not-a-sid.incoming", age_days=500)
    short = _staging(tmp_path, "abc.incoming", age_days=500)
    assert _sweep(tmp_path) == []
    assert odd.exists() and short.exists()


def test_sweep_of_a_missing_sessions_dir_is_empty(tmp_path):
    assert _sweep(tmp_path / "nope") == []


@pytest.mark.skipif(os.geteuid() == 0, reason="root can read anything")
def test_sweep_survives_a_directory_it_cannot_read(tmp_path):
    locked = _make(tmp_path, "a" * 16, tour=True, age_days=500)
    stale = _make(tmp_path, "b" * 16, tour=False, age_days=5)
    locked.chmod(0)
    try:
        assert _sweep(tmp_path) == ["b" * 16]
        assert locked.exists()
        assert not stale.exists()
    finally:
        locked.chmod(0o700)


def test_sweep_survives_a_directory_vanishing_mid_sweep(tmp_path, monkeypatch):
    _make(tmp_path, "a" * 16, tour=False, age_days=5)
    real = shutil.rmtree

    def vanish(path, *a, **kw):
        real(path)
        raise FileNotFoundError(path)

    monkeypatch.setattr(shutil, "rmtree", vanish)
    assert _sweep(tmp_path) == ["a" * 16]


def test_sweep_does_not_report_what_it_failed_to_remove(tmp_path, monkeypatch):
    d = _make(tmp_path, "a" * 16, tour=False, age_days=5)
    monkeypatch.setattr(shutil, "rmtree", lambda *a, **kw: None)
    assert _sweep(tmp_path) == []
    assert d.exists()


def test_sweep_keeps_a_directory_mid_save_with_a_fresh_temp_file(tmp_path):
    d = _make(tmp_path, "a" * 16, tour=False, age_days=30)
    tmp = d / ".tour.json.tmp"
    tmp.write_text("{}")
    os.utime(tmp, (NOW - 60,) * 2)
    assert _sweep(tmp_path) == []
    assert d.exists()


def test_sweep_keeps_a_directory_dated_in_the_future(tmp_path):
    d = _make(tmp_path, "a" * 16, tour=False, age_days=-10)
    assert _sweep(tmp_path) == []
    assert d.exists()


# --- the sweep's throttle, which lives on a file ---------------------------


def test_sweep_is_due_when_nothing_has_swept_yet(tmp_path):
    assert sweep_due(tmp_path, interval_seconds=3600, now=NOW) is True


def test_sweep_is_not_due_again_within_the_interval(tmp_path):
    assert mark_swept(tmp_path, now=NOW) is True
    assert sweep_due(tmp_path, interval_seconds=3600, now=NOW + 60) is False
    assert sweep_due(tmp_path, interval_seconds=3600, now=NOW + 3600) is True


def test_a_stamp_dated_in_the_future_does_not_suppress_the_sweep(tmp_path):
    """A host whose clock steps back would otherwise never sweep again."""
    assert mark_swept(tmp_path, now=NOW + DAY) is True
    assert sweep_due(tmp_path, interval_seconds=3600, now=NOW) is True


def test_marking_creates_the_sessions_dir_it_stamps(tmp_path):
    assert mark_swept(tmp_path / "sessions", now=NOW) is True
    assert (tmp_path / "sessions" / SWEEP_STAMP).stat().st_mtime == NOW


def test_marking_an_existing_stamp_moves_it_forward(tmp_path):
    assert mark_swept(tmp_path, now=NOW - DAY) is True
    assert mark_swept(tmp_path, now=NOW) is True
    assert (tmp_path / SWEEP_STAMP).stat().st_mtime == NOW


def test_marking_reports_failure_instead_of_raising(tmp_path):
    (tmp_path / "blocked").write_text("I am a file, not a directory")
    assert mark_swept(tmp_path / "blocked", now=NOW) is False


def test_the_stamps_name_cannot_be_mistaken_for_a_session():
    """`sweep` skips it on `not is_dir()` whatever it is called, so this is
    the invariant that actually carries weight: `test_session_cookie.py`'s
    `session_dirs` helper tells the stamp from a session by this predicate
    and nothing else, so a stamp named like a sid would be counted as one.
    """
    assert valid_sid(SWEEP_STAMP) is False


def test_the_stamp_is_not_a_session_and_is_never_swept(tmp_path):
    """It lives in sessions_dir and is older than every window."""
    assert mark_swept(tmp_path, now=NOW - 400 * DAY) is True
    _make(tmp_path, "b" * 16, tour=False, age_days=400)
    assert _sweep(tmp_path) == ["b" * 16]
    assert (tmp_path / SWEEP_STAMP).exists()
