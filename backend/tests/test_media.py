from __future__ import annotations

from pathlib import Path

import pytest

from app.media import RangeNotSatisfiable, guess_media_type, parse_range


def test_no_header_means_full_body():
    assert parse_range(None, 1000) is None


def test_empty_header_means_full_body():
    assert parse_range("", 1000) is None


def test_simple_closed_range():
    assert parse_range("bytes=0-499", 1000) == (0, 499)


def test_open_ended_range_runs_to_last_byte():
    assert parse_range("bytes=500-", 1000) == (500, 999)


def test_suffix_range_returns_final_n_bytes():
    assert parse_range("bytes=-200", 1000) == (800, 999)


def test_suffix_larger_than_file_clamps_to_whole_file():
    assert parse_range("bytes=-5000", 1000) == (0, 999)


def test_end_beyond_eof_is_clamped():
    assert parse_range("bytes=900-5000", 1000) == (900, 999)


def test_start_beyond_eof_is_unsatisfiable():
    with pytest.raises(RangeNotSatisfiable):
        parse_range("bytes=1000-", 1000)


def test_reversed_range_is_unsatisfiable():
    with pytest.raises(RangeNotSatisfiable):
        parse_range("bytes=500-100", 1000)


def test_zero_length_file_range_is_unsatisfiable():
    with pytest.raises(RangeNotSatisfiable):
        parse_range("bytes=0-", 0)


def test_zero_length_suffix_is_unsatisfiable():
    with pytest.raises(RangeNotSatisfiable):
        parse_range("bytes=-0", 1000)


def test_non_byte_units_are_ignored():
    """RFC 9110: unrecognised units mean serve the whole representation."""
    assert parse_range("items=0-10", 1000) is None


def test_malformed_header_is_ignored():
    assert parse_range("bytes=abc", 1000) is None


def test_header_without_separator_is_ignored():
    assert parse_range("bytes=500", 1000) is None


def test_multipart_ranges_fall_back_to_full_body():
    """Multipart responses are out of scope; serving the whole file is legal."""
    assert parse_range("bytes=0-99,200-299", 1000) is None


def test_whole_file_range():
    assert parse_range("bytes=0-999", 1000) == (0, 999)


def test_single_byte_range():
    assert parse_range("bytes=5-5", 1000) == (5, 5)


@pytest.mark.parametrize("name,expected", [
    ("a.m4a", "audio/mp4"),
    ("a.mp3", "audio/mpeg"),
    ("a.jpg", "image/jpeg"),
    ("a.JPG", "image/jpeg"),
    ("a.png", "image/png"),
    ("a.unknown", "application/octet-stream"),
])
def test_media_type_detection(name, expected):
    assert guess_media_type(Path(name)) == expected
