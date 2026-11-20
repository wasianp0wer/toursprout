"""Omeka Classic import: parse the REST API's JSON into what the editor shows.

This half is pure: every function takes data that is already in hand (a
decoded record, an `httpx.Response`) and returns plain dicts or raises
`ToolError` with the HTTP status the route should use. The messages are the
author-facing text from the spec's error table, plain, with no Markdown.
"""

from __future__ import annotations

import re
from html import unescape
from html.parser import HTMLParser
from urllib.parse import urlsplit

import httpx

from .media_store import ALLOWED_TYPES
from .tools import ToolError

AUDIO_TYPES = frozenset(t for t in ALLOWED_TYPES if t.startswith("audio/"))

# A pasted page address carries the public theme's or the admin's path after
# the install root; the first of these segments marks where the root ends.
_PAGE_PATH = re.compile(r"/(?:items|collections|exhibits|admin|files)(?:/|$)")


def omeka_base(raw: str) -> str:
    """The site's root from whatever the author pasted: scheme added, query,
    fragment and a trailing page path dropped, an install subpath kept."""
    raw = raw.strip()
    if "://" not in raw:
        raw = "https://" + raw
    parts = urlsplit(raw)
    path = parts.path
    m = _PAGE_PATH.search(path)
    if m:
        path = path[: m.start()]
    return f"{parts.scheme}://{parts.netloc}{path.rstrip('/')}"


def _host(base: str) -> str:
    return urlsplit(base).netloc


class _TextOnly(HTMLParser):
    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.parts: list[str] = []

    def handle_data(self, data: str) -> None:
        self.parts.append(data)


def _plain(value: str, html: bool) -> str:
    if html:
        p = _TextOnly()
        p.feed(value)
        p.close()
        value = "".join(p.parts)
    else:
        value = unescape(value) if "&" in value and "<" in value else value
    return value.strip()


def dublin_core(element_texts: list) -> dict[str, str]:
    """Element name -> plain text for the Dublin Core set. Repeats are joined
    with "; ", HTML values lose their markup, blanks are dropped."""
    values: dict[str, list[str]] = {}
    for et in element_texts or []:
        if (et.get("element_set") or {}).get("name") != "Dublin Core":
            continue
        text = _plain(et.get("text") or "", bool(et.get("html")))
        if text:
            values.setdefault(et["element"]["name"], []).append(text)
    return {name: "; ".join(vs) for name, vs in values.items()}


def item_summary(item: dict, base: str) -> dict | None:
    """One search-result row, or None for an item with no files (nothing to
    import from it)."""
    count = (item.get("files") or {}).get("count", 0)
    if not count:
        return None
    dc = dublin_core(item.get("element_texts"))
    return {
        "itemId": item["id"],
        "itemUrl": f"{base}/items/show/{item['id']}",
        "title": dc.get("Title", ""),
        "description": dc.get("Description"),
        "creator": dc.get("Creator"),
        "date": dc.get("Date"),
        "rights": dc.get("Rights"),
        "fileCount": count,
    }


def _kind(f: dict) -> str | None:
    """image or audio when the editor can take the file, else None. An image
    is only usable through its fullsize derivative (always a JPEG), so one
    without it is not."""
    mime = f.get("mime_type") or ""
    urls = f.get("file_urls") or {}
    if mime.startswith("image/") and urls.get("fullsize"):
        return "image"
    if mime in AUDIO_TYPES and urls.get("original"):
        return "audio"
    return None


def download_url(f: dict) -> str | None:
    kind = _kind(f)
    urls = f["file_urls"]
    if kind == "image":
        return urls["fullsize"]
    if kind == "audio":
        return urls["original"]
    return None


def file_summary(f: dict) -> dict:
    kind = _kind(f)
    mime = f.get("mime_type") or "unknown"
    reason = None
    if kind is None:
        what = "PDF" if mime == "application/pdf" else mime
        reason = f"{what} files can't be added to a tour"
    dc = dublin_core(f.get("element_texts"))
    return {
        "fileId": f["id"],
        "kind": kind,
        "filename": f.get("original_filename") or f.get("filename"),
        "thumbUrl": (f.get("file_urls") or {}).get("thumbnail"),
        "importable": kind is not None,
        "reason": reason,
        "title": dc.get("Title"),
        "creator": dc.get("Creator"),
        "rights": dc.get("Rights"),
    }


def site_from_response(resp: httpx.Response, base: str) -> dict:
    """Identify the site from its `GET {base}/api/site` response, or raise
    the ToolError the spec's table gives for that failure."""
    host = _host(base)
    status = resp.status_code
    try:
        body = resp.json()
    except ValueError:
        body = None
    message = body.get("message") if isinstance(body, dict) else None

    if status == 403 and message == "API is disabled":
        raise ToolError(
            409,
            f"The Omeka site at {host} has its API turned off. Someone with an "
            "administrator login can turn it on: in the Omeka admin, go to "
            "Settings → API, tick Enable API access, and save. Then search again.",
        )
    if status in (401, 403):
        why = f" ({message})" if message else ""
        raise ToolError(
            409,
            f"The Omeka site at {host} refused the request{why}. It may only "
            "allow signed-in access, which this import does not support.",
        )
    if status >= 500:
        raise ToolError(
            502, f"The Omeka site at {host} had an error ({status}). Try again in a minute."
        )
    if status == 200 and isinstance(body, dict) and isinstance(body.get("title"), str):
        return {"base": base, "title": body["title"].strip() or host}
    raise ToolError(
        404,
        f"There is no Omeka Classic site at {base}. Check the address is the "
        "site's home page, for example https://example.org or "
        "https://example.org/omeka. (Omeka S sites are not supported yet.)",
    )
