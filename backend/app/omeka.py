"""Omeka Classic import: parse the REST API's JSON into what the editor shows.

The parsing half is pure: those functions take data already in hand (a
decoded record, an `httpx.Response`) and return plain dicts or raise
`ToolError` with the HTTP status the route should use. The fetching half
(after "fetching" below) makes the GETs: every hop through the address guard,
redirects by hand, and every request inside the route's deadline. The
messages are the author-facing text from the spec's error table, plain, with
no Markdown.
"""

from __future__ import annotations

import re
import time
from html import unescape
from html.parser import HTMLParser
from typing import Annotated
from urllib.parse import urlsplit

import httpx
from pydantic import BaseModel, Field, StringConstraints

from .media_store import ALLOWED_TYPES, MediaError, sniff
from .net_guard import PRIVATE, UNREACHABLE, GuardRefused, Resolver, check_public_url
from .tools import ToolError, _describe

AUDIO_TYPES = frozenset(t for t in ALLOWED_TYPES if t.startswith("audio/"))

# A pasted page address carries the public theme's or the admin's path after
# the install root; the first of these segments marks where the root ends.
_PAGE_PATH = re.compile(r"/(?:items|collections|exhibits|admin|files)(?:/|$)")


class OmekaSearchRequest(BaseModel):
    siteUrl: str = Field(max_length=2000)
    query: Annotated[str, StringConstraints(strip_whitespace=True, min_length=1,
                                            max_length=300)]
    page: int = Field(default=1, ge=1, le=1000)


class OmekaFilesRequest(BaseModel):
    siteUrl: str = Field(max_length=2000)
    itemId: int = Field(ge=1)


class OmekaImportRequest(OmekaFilesRequest):
    fileId: int = Field(ge=1)
    title: str = Field(default="", max_length=300)


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


# --- fetching -----------------------------------------------------------------

# Under CGI each request is one process and the host may kill a long one, so
# every Omeka route finishes within OMEKA_ROUTE_BUDGET: the route computes
# `deadline = time.monotonic() + OMEKA_ROUTE_BUDGET` once and passes it down.
OMEKA_REQUEST_TIMEOUT = 10.0
OMEKA_ROUTE_BUDGET = 30.0
OMEKA_DOWNLOAD_BUDGET = 25.0
OMEKA_ATTEMPTS = 2
MAX_REDIRECTS = 5
# An API answer is a page of JSON records; anything this big is not one.
OMEKA_API_MAX_BYTES = 8 * 1024 * 1024

_REDIRECTS = (301, 302, 303, 307, 308)


class _Unreachable(ToolError):
    """A transport failure: the unreachable 502, which a download retries."""


def _too_slow(host: str) -> ToolError:
    return ToolError(504, f"The Omeka site at {host} took too long to answer. "
                          "Try again, or try a smaller file.")


def _transport_error(exc: httpx.HTTPError, request: httpx.Request,
                     deadline: float) -> ToolError:
    host = request.url.host
    cause: BaseException | None = exc
    while cause is not None:
        if isinstance(cause, GuardRefused):
            return ToolError(400, PRIVATE.format(host=host))
        cause = cause.__cause__
    # A timeout that was what was left of the budget, not the per-request
    # limit, or that fired at the deadline, is the budget running out.
    read = (request.extensions.get("timeout") or {}).get("read")
    capped = read is not None and read < OMEKA_REQUEST_TIMEOUT
    if isinstance(exc, httpx.TimeoutException) and (
            capped or time.monotonic() >= deadline):
        return _too_slow(host)
    return _Unreachable(502, UNREACHABLE.format(host=host, reason=_describe(exc)))


def _get(client: httpx.Client, url: str, *, params: dict | None = None,
         deadline: float, resolve: Resolver, stream: bool = False,
         accept: str = "application/json") -> httpx.Response:
    """GET `url`, following up to MAX_REDIRECTS redirects by hand so that
    check_public_url sees every hop. Each request's timeout is the smaller of
    OMEKA_REQUEST_TIMEOUT and what is left of `deadline`. Returns the first
    response that is not a redirect; with `stream=True` its body is unread
    and the caller closes it."""
    current = check_public_url(httpx.URL(url, params=params), resolve=resolve)
    for _hop in range(MAX_REDIRECTS + 1):
        host = current.host
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            raise _too_slow(host)
        timeout = min(OMEKA_REQUEST_TIMEOUT, remaining)
        request = client.build_request("GET", current, headers={"Accept": accept},
                                       timeout=timeout)
        try:
            resp = client.send(request, stream=True, follow_redirects=False)
        except httpx.HTTPError as exc:
            raise _transport_error(exc, request, deadline) from exc
        location = resp.headers.get("location")
        if resp.status_code in _REDIRECTS and location:
            resp.close()
            current = check_public_url(current.join(location), resolve=resolve)
            continue
        if stream:
            return resp
        try:
            body = _read_capped(resp, OMEKA_API_MAX_BYTES, deadline, ToolError(
                502, f"The Omeka site at {host} sent an answer too large to read."))
        finally:
            resp.close()
        return httpx.Response(resp.status_code, headers=resp.headers, content=body,
                              request=request)
    raise ToolError(502, f"The Omeka site at {current.host} redirected too many times.")


def _api_list(client: httpx.Client, base: str, path: str, params: dict, *,
              deadline: float, resolve: Resolver) -> tuple[httpx.Response, list]:
    resp = _get(client, f"{base}/api/{path}", params=params,
                deadline=deadline, resolve=resolve)
    if resp.status_code != 200:
        site_from_response(resp, base)  # raises the table's error for the status
    host = _host(base)
    try:
        data = resp.json()
    except ValueError as exc:
        raise ToolError(502, f"The Omeka site at {host} returned something "
                             "that is not JSON.") from exc
    if not isinstance(data, list):
        raise ToolError(502, f"The Omeka site at {host} returned an unexpected response.")
    return resp, data


def get_site(client: httpx.Client, base: str, *, deadline: float,
             resolve: Resolver) -> dict:
    resp = _get(client, f"{base}/api/site", deadline=deadline, resolve=resolve)
    return site_from_response(resp, base)


def search_items(client: httpx.Client, base: str, query: str, page: int, *,
                 deadline: float, resolve: Resolver) -> dict:
    """One page of the site's search. Items with no files are left out of
    `results`; `total` is Omeka's count, which includes them."""
    resp, items = _api_list(client, base, "items", {"search": query, "page": page},
                            deadline=deadline, resolve=resolve)
    declared = resp.headers.get("Omeka-Total-Results", "").strip()
    results = [s for s in (item_summary(i, base) for i in items) if s is not None]
    return {"total": int(declared) if declared.isdigit() else 0,
            "page": page, "results": results}


def list_files(client: httpx.Client, base: str, item_id: int, *, deadline: float,
               resolve: Resolver) -> list[dict]:
    _resp, files = _api_list(client, base, "files", {"item": item_id},
                             deadline=deadline, resolve=resolve)
    return files


def _read_capped(resp: httpx.Response, max_bytes: int, deadline: float,
                 too_big: ToolError) -> bytes:
    """The body, abandoned as soon as it passes `max_bytes` (raising
    `too_big`), so a huge answer never sits whole in memory; a declared
    Content-Length over the cap is refused before a byte is read. The
    per-request timeout bounds each read only, so `deadline` bounds the
    whole."""
    request = resp.request
    host = request.url.host
    declared = resp.headers.get("content-length", "")
    if declared.isdigit() and int(declared) > max_bytes:
        raise too_big
    # httpcore takes the body's read timeout from the request once, when the
    # body starts, so cut it to what is left of the budget now: the headers
    # may have used most of it.
    remaining = deadline - time.monotonic()
    if remaining <= 0:
        raise _too_slow(host)
    timeouts = dict(request.extensions.get("timeout") or {})
    timeouts["read"] = min(OMEKA_REQUEST_TIMEOUT, remaining)
    request.extensions["timeout"] = timeouts
    body = bytearray()
    try:
        for chunk in resp.iter_bytes():
            body += chunk
            if len(body) > max_bytes:
                raise too_big
            if time.monotonic() > deadline:
                raise _too_slow(host)
    except httpx.HTTPError as exc:
        raise _transport_error(exc, resp.request, deadline) from exc
    return bytes(body)


def fetch_file(client: httpx.Client, url: str, kind: str, *, deadline: float,
               resolve: Resolver, max_bytes: int) -> bytes:
    """Download an Omeka file (fetch_archive_image reborn). Streamed and
    capped at `max_bytes`; one retry on a transport failure or 5xx, none on
    4xx; every attempt and redirect hop inside OMEKA_DOWNLOAD_BUDGET and the
    route's `deadline`. The body must sniff as `kind` ("image" or "audio"),
    whatever its Content-Type says."""
    deadline = min(deadline, time.monotonic() + OMEKA_DOWNLOAD_BUDGET)
    failure: ToolError | None = None
    for _attempt in range(OMEKA_ATTEMPTS):
        try:
            resp = _get(client, url, deadline=deadline, resolve=resolve,
                        stream=True, accept="*/*")
        except _Unreachable as exc:
            failure = exc
            continue
        host, status = resp.request.url.host, resp.status_code
        try:
            if status == 200:
                body = _read_capped(resp, max_bytes, deadline, ToolError(
                    502, f"The file on {host} is larger than the "
                         f"{max_bytes // (1024 * 1024)} MB limit."))
        except _Unreachable as exc:
            failure = exc
            continue
        finally:
            resp.close()
        if status == 200:
            try:
                sniffed, _ext = sniff(body)
            except MediaError:
                sniffed = ""
            if not sniffed.startswith(f"{kind}/"):
                raise ToolError(502, f"The Omeka site at {host} sent something "
                                     f"that is not an {kind} file.")
            return body
        if status < 500:
            raise ToolError(502, f"The Omeka site at {host} has no file at that "
                                 f"address (HTTP {status}).")
        failure = ToolError(502, f"The Omeka site at {host} had an error ({status}). "
                                 "Try again in a minute.")
    assert failure is not None
    raise failure
