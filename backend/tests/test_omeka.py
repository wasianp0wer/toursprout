"""Omeka Classic parsing: pure functions, checked against responses captured
live from a real site (tests/fixtures/omeka/)."""

from __future__ import annotations

import json
from pathlib import Path

import httpx
import pytest

from app.net_guard import BAD_URL
from app.omeka import (
    AUDIO_TYPES,
    download_url,
    dublin_core,
    file_summary,
    item_summary,
    omeka_base,
    site_from_response,
)
from app.tools import ToolError

FIX = Path(__file__).parent / "fixtures" / "omeka"
BASE = "https://omeka.madelynharrington.net"


def load(name):
    return json.loads((FIX / name).read_text())


ITEMS = load("items.json")


def text(value, name="Title", html=False, set_name="Dublin Core"):
    return {
        "html": html,
        "text": value,
        "element_set": {"name": set_name},
        "element": {"name": name},
    }


@pytest.mark.parametrize(
    "raw,base",
    [
        ("omeka.madelynharrington.net", "https://omeka.madelynharrington.net"),
        ("https://omeka.madelynharrington.net/", "https://omeka.madelynharrington.net"),
        ("https://omeka.madelynharrington.net/items/show/7", "https://omeka.madelynharrington.net"),
        ("https://example.org/omeka/items/browse?tags=x#top", "https://example.org/omeka"),
        ("https://example.org/omeka/admin/items", "https://example.org/omeka"),
        ("http://example.org/omeka/collections/show/2", "http://example.org/omeka"),
        ("  https://example.org/exhibits/show/fairfax  ", "https://example.org"),
    ],
)
def test_omeka_base(raw, base):
    assert omeka_base(raw) == base


def test_dublin_core_from_live_item():
    dc = dublin_core(ITEMS[0]["element_texts"])
    assert dc["Title"] == "Larry Speakes discusses AIDS at a press conference in 1982"
    assert dc["Creator"] == "Ronald Reagan White House"
    assert dc["Rights"] == "Public domain"


def test_dublin_core_strips_html_and_trims():
    dc = dublin_core([text("<p>The <em>cupola</em> &amp; dome </p>", "Description", html=True)])
    assert dc == {"Description": "The cupola & dome"}


def test_dublin_core_joins_repeats_and_ignores_other_sets():
    dc = dublin_core(
        [
            text("A", "Creator"),
            text("  ", "Creator"),
            text("B", "Creator"),
            text("Sound", "Original Format", set_name="Item Type Metadata"),
        ]
    )
    assert dc == {"Creator": "A; B"}


def test_item_summary_live_item_3_has_no_rights():
    s = item_summary(ITEMS[2], BASE)
    assert s["itemUrl"] == f"{BASE}/items/show/3"
    assert s["itemId"] == 3
    assert s["rights"] is None and s["title"] == "Medieval Cats"
    assert s["fileCount"] == 1


def test_item_summary_trims_trailing_space():
    assert item_summary(ITEMS[3], BASE)["title"] == "Egyptian Cat Statuette"


def test_item_summary_none_without_files():
    item = {**ITEMS[0], "files": {"count": 0}}
    assert item_summary(item, BASE) is None


def test_item_summary_missing_title_is_empty_string():
    item = {**ITEMS[0], "element_texts": []}
    s = item_summary(item, BASE)
    assert s["title"] == "" and s["creator"] is None and s["date"] is None


def test_file_summary_image_png_uses_jpeg_fullsize():
    f = load("files-3.json")[0]
    s = file_summary(f)
    assert s["kind"] == "image" and s["importable"] and s["reason"] is None
    assert s["fileId"] == 3
    assert s["thumbUrl"] == f["file_urls"]["thumbnail"]
    url = download_url(f)
    assert "/fullsize/" in url and url.endswith(".jpg")


def test_file_summary_audio_mp3():
    f = load("files-1.json")[0]
    s = file_summary(f)
    assert s["kind"] == "audio" and s["importable"]
    assert s["thumbUrl"] is None
    assert download_url(f) == f["file_urls"]["original"]
    assert "audio/mpeg" in AUDIO_TYPES


def test_file_summary_jpeg():
    f = load("files-2.json")[0]
    s = file_summary(f)
    assert s["kind"] == "image" and s["importable"]


def test_file_summary_pdf_not_importable():
    f = {**load("files-3.json")[0], "mime_type": "application/pdf"}
    s = file_summary(f)
    assert s["importable"] is False and s["kind"] is None
    assert s["reason"] == "PDF files can't be added to a tour"
    assert download_url(f) is None


def test_file_summary_image_without_fullsize_not_importable():
    f = load("files-3.json")[0]
    f = {**f, "mime_type": "image/tiff", "file_urls": {**f["file_urls"], "fullsize": None}}
    s = file_summary(f)
    assert s["importable"] is False and s["kind"] is None
    assert "image/tiff" in s["reason"]
    assert download_url(f) is None


SITE_MESSAGES = {
    "disabled": "The Omeka site at omeka.example has its API turned off. Someone with an administrator login can turn it on: in the Omeka admin, go to Settings → API, tick Enable API access, and save. Then search again.",
    "notomeka": "There is no Omeka Classic site at https://omeka.example. Check the address is the site's home page, for example https://example.org or https://example.org/omeka. (Omeka S sites are not supported yet.)",
}
EX = "https://omeka.example"


def test_site_live():
    resp = httpx.Response(200, json=load("site.json"))
    assert site_from_response(resp, BASE) == {
        "base": BASE,
        "title": "Madelyn's Interests and Exhibits",
    }


def test_site_api_disabled():
    resp = httpx.Response(403, json={"message": "API is disabled"})
    with pytest.raises(ToolError) as e:
        site_from_response(resp, EX)
    assert e.value.status == 409 and e.value.message == SITE_MESSAGES["disabled"]


def test_site_other_403():
    resp = httpx.Response(403, json={"message": "Invalid key."})
    with pytest.raises(ToolError) as e:
        site_from_response(resp, EX)
    assert e.value.status == 409
    assert "Invalid key." in e.value.message and "signed-in access" in e.value.message


def test_site_404():
    with pytest.raises(ToolError) as e:
        site_from_response(httpx.Response(404), EX)
    assert e.value.status == 404 and e.value.message == SITE_MESSAGES["notomeka"]


def test_site_html_200_is_not_omeka():
    resp = httpx.Response(
        200, text="<html>Just a moment...</html>", headers={"content-type": "text/html"}
    )
    with pytest.raises(ToolError) as e:
        site_from_response(resp, EX)
    assert e.value.status == 404 and e.value.message == SITE_MESSAGES["notomeka"]


def test_site_5xx():
    with pytest.raises(ToolError) as e:
        site_from_response(httpx.Response(503), EX)
    assert e.value.status == 502
    assert e.value.message == "The Omeka site at omeka.example had an error (503). Try again in a minute."


def test_site_blank_title_falls_back_to_host():
    resp = httpx.Response(200, json={"title": "  ", "omeka_version": "3.2.1"})
    assert site_from_response(resp, "https://example.org/omeka")["title"] == "example.org"


@pytest.mark.parametrize("value,plain", [
    ("<p>First para.</p><p>Second para.</p>", "First para.\nSecond para."),
    ("One<br>two<br/>three", "One\ntwo\nthree"),
    ("<ul><li>A</li><li>B</li></ul>", "A\nB"),
    ("<div>Top</div>tail", "Top\ntail"),
    ("<p>Hi<script>alert('x')</script><style>p { color: red }</style> there</p>", "Hi there"),
    ("<p>  Spread\n   over\tlines  </p>\n\n<p></p>", "Spread over lines"),
])
def test_dublin_core_html_blocks_and_scripts(value, plain):
    assert dublin_core([text(value, "Description", html=True)]) == {"Description": plain}


CF_MESSAGE = (
    "The Omeka site at omeka.example is behind Cloudflare, which challenged the "
    "editor's server as a bot. Whoever manages the site's Cloudflare account can "
    "allow it: add a rule letting this server's address reach /api/* and /files/* "
    "without a challenge. Then try again."
)


@pytest.mark.parametrize("status,headers", [
    (403, {"cf-mitigated": "challenge", "server": "cloudflare",
           "content-type": "text/html; charset=UTF-8"}),
    (503, {"cf-mitigated": "challenge"}),
    (403, {"server": "cloudflare", "content-type": "text/html"}),
    (503, {"server": "cloudflare", "content-type": "text/html; charset=UTF-8"}),
])
def test_site_cloudflare_challenge(status, headers):
    resp = httpx.Response(status, text="<html>Just a moment...</html>", headers=headers)
    with pytest.raises(ToolError) as e:
        site_from_response(resp, EX)
    assert e.value.status == 409 and e.value.message == CF_MESSAGE


def test_site_cloudflare_json_403_is_not_a_challenge():
    """Omeka's own 403 passed through Cloudflare keeps its message."""
    resp = httpx.Response(403, json={"message": "API is disabled"},
                          headers={"server": "cloudflare"})
    with pytest.raises(ToolError) as e:
        site_from_response(resp, EX)
    assert e.value.message == SITE_MESSAGES["disabled"]


@pytest.mark.parametrize("raw", ["http://[::1", "https://[bad/omeka"])
def test_omeka_base_malformed_is_400(raw):
    with pytest.raises(ToolError) as e:
        omeka_base(raw)
    assert e.value.status == 400 and e.value.message == BAD_URL
