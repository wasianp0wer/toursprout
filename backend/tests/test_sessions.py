from __future__ import annotations

import pytest

from app.sessions import new_sid, session_dir, valid_sid


def test_new_sid_is_sixteen_hex_characters():
    sid = new_sid()
    assert len(sid) == 16 and all(c in "0123456789abcdef" for c in sid)

def test_new_sid_does_not_repeat():
    assert len({new_sid() for _ in range(100)}) == 100

@pytest.mark.parametrize("bad", [
    "", ".", "..", "../etc", "a/b", "a\\b", "%2e%2e", "A" * 16, "abc",
    "0123456789abcdef0", "0123456789abcde", "0123456789abcdeg", " 0123456789abcdef",
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
