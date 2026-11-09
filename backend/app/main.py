from __future__ import annotations

import logging
import mimetypes
import os
import shutil
import stat as stat_module
import tempfile
import time
from concurrent.futures import ThreadPoolExecutor
from dataclasses import asdict
from email.utils import parsedate
from pathlib import Path
from typing import Annotated, Any

import httpx
from fastapi import (
    Body,
    Depends,
    FastAPI,
    Form,
    HTTPException,
    Request,
    Response,
    UploadFile,
)
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from starlette.datastructures import Headers, MutableHeaders
from starlette.exceptions import HTTPException as StarletteHTTPException
from starlette.staticfiles import NotModifiedResponse

from . import tools
from .bundle import (
    BundleError,
    missing_media,
    write_bundle,
)
from .config import Settings
from .config import settings as default_settings
from .examples import ExampleError, list_examples, open_example
from .loose_import import stage_loose_bundle
from .media_store import MediaError, store_media
from .publish import PublishError, build_site
from .session import Session, SessionConflict
from .sessions import (
    COOKIE_MAX_AGE,
    SID_COOKIE,
    mark_swept,
    new_sid,
    session_dir,
    sweep,
    sweep_due,
    valid_sid,
)

# `FileResponse` (which answers the tour-data route below) and `StaticFiles`
# (which serves the built frontend) both guess content types
# from Python's stdlib `mimetypes` table, which disagrees with browsers for
# two extensions this tour actually ships: `.m4a` comes back as
# "audio/mp4a-latm" — an RTP/SDP payload name, not a browser-recognised
# container — instead of "audio/mp4", and `.wav` comes back as
# "audio/x-wav" instead of "audio/wav". media.py's hand-rolled table pinned
# exactly these two overrides for the prototype's entire life; restore them
# at import time so deleting that table doesn't silently change what a
# browser actually plays through THIS process. Do not remove this as
# "redundant with stdlib defaults" — it exists because the stdlib defaults
# are wrong for these two extensions.
#
# This only fixes the type for requests this FastAPI process answers — i.e.
# the editor. A published static site has no FastAPI process; whatever
# static host serves it may well answer `.m4a` with the same wrong stdlib
# value (confirmed: Python's own `http.server` does). That used to be a live
# bug, because `<audio [src]>` in stop-panel.ts had no `type` attribute to
# fall back on. It no longer is: the viewer's `<audio><source [type]>` now
# supplies the browser-correct type itself, derived from the mediaId's
# extension (`audioType` in tour-api.ts), so playback on a published site
# does not depend on this override at all. See
# docs/decisions/0002-the-tour-is-a-portable-document.md.
mimetypes.add_type("audio/mp4", ".m4a")
mimetypes.add_type("audio/wav", ".wav")

# Raster tiles carry the OSM usage policy; acceptable at prototype volume.
TILE_URL = "https://tile.openstreetmap.org/{z}/{x}/{y}.png"

ATTRIBUTION = [
    {"text": "Map data (c) OpenStreetMap contributors",
     "url": "https://www.openstreetmap.org/copyright", "license": "ODbL"},
    {"text": "Street-level imagery (c) Mapillary contributors",
     "url": "https://www.mapillary.com", "license": "CC-BY-SA-4.0"},
]


def _reject_cross_site(request: Request) -> None:
    """Defence in depth against CSRF on the mutating session routes.

    A `multipart/form-data` POST (what `/api/session/import` takes) — and
    the plain POST/PUT the other two mutating routes take — is a CORS-simple
    request: the browser does not preflight it, so the origin allowlist in
    `CORSMiddleware` above never runs before the request's side effect, only
    before its response reaches the page that issued it. Concretely: any
    page the author's browser has open while this backend is running on
    localhost could POST a replacement bundle to `/api/session/import`
    without the author ever knowing, and CORS would not have stopped it.

    Browsers that implement Fetch Metadata send `Sec-Fetch-Site`, and
    `cross-site` means the request was issued by a page on some other
    origin, not this application's own frontend. Refusing exactly that
    value, and nothing else, is the point: the header's ABSENCE must not be
    treated as cross-site, because older browsers and every non-browser
    client (curl, httpx, this test suite) never send it at all, and this is
    not an authentication mechanism — there is no login here — it is one
    more layer for a tool that otherwise has none.
    """
    if request.headers.get("sec-fetch-site") == "cross-site":
        raise HTTPException(
            status_code=403, detail="cross-site requests are not allowed"
        )


def _part_size(part: UploadFile) -> int:
    """How many bytes a multipart part holds.

    `UploadFile.size` is what the parser counted and is typed `int | None`,
    so it is not something to arithmetic over unchecked. When it is missing,
    measure the spooled file instead of either trusting a zero (which would
    waive the cap) or assuming the worst (which would refuse a drop the
    author could perfectly well have made). Seeking a `SpooledTemporaryFile`
    reads nothing and the position is put back, so the staging that follows
    still sees the stream at the start.
    """
    if part.size is not None:
        return part.size
    here = part.file.tell()
    try:
        return part.file.seek(0, os.SEEK_END)
    finally:
        part.file.seek(here)


def _not_modified(request_headers: Headers, response_headers: MutableHeaders) -> bool:
    """Whether the client already has this exact file.

    The same two comparisons `StaticFiles.is_not_modified` makes, written
    out here because the tour-data route answers from `FileResponse`
    directly and no longer has a `StaticFiles` instance to ask.

    `If-None-Match` wins outright when it is present, and `If-Modified-Since`
    is then ignored, which is what RFC 9110 §13.1.3 requires: a browser
    holding both sends both, and the etag is the stronger of the two. The
    header is a comma-separated list, and `W/` marks a weak validator —
    which for a whole file is the same file, so the prefix is stripped
    rather than treated as a mismatch.
    """
    if_none_match = request_headers.get("if-none-match")
    if if_none_match:
        etag = response_headers.get("etag")
        return etag is not None and etag in [
            tag.strip().removeprefix("W/") for tag in if_none_match.split(",")
        ]
    if_modified_since = parsedate(request_headers.get("if-modified-since", ""))
    last_modified = parsedate(response_headers.get("last-modified", ""))
    return (
        if_modified_since is not None
        and last_modified is not None
        and if_modified_since >= last_modified
    )


def _viewer_config(cfg: Settings) -> dict:
    """What the viewer needs, identical in the editor and in a published site.

    The Mapillary token travels with a published site. It is a public client
    token — mapillary-js runs in the browser and cannot use anything else — so
    this is not a leak, though it looks like one.
    """
    return {"mapillaryToken": cfg.mapillary_token, "tileUrl": TILE_URL,
            "attribution": ATTRIBUTION}


# --- which session a request is about ------------------------------------
#
# There used to be one `Session` on `app.state`, which on shared hosting
# meant one open tour for all six historians and the last save winning.
# These two dependencies are what replaced it. The minting boundary between
# them is deliberate and is the whole of spec §6.1's first decision:
#
#   mint (resolve, or create and set the cookie):
#       GET  /api/session                  — the frontend's first call
#       POST /api/session/new              — \
#       POST /api/session/examples/{id}    —  | the four routes that create
#       POST /api/session/import           —  | a tour out of nothing
#       POST /api/session/import-files     — /
#   resolve only (answer from whatever is there, or refuse):
#       DELETE /api/session, PUT /api/session/tour, POST /api/session/media,
#       GET /api/session/export, GET /api/session/publish, GET /tour-data/*
#
# Not every route may mint, because `entry-page.ts` mounts the viewer
# eagerly: a first page load fires `tour-data/config.json`,
# `tour-data/tour.json` and `/api/session` CONCURRENTLY. Two of those three
# are tour-data, which never mints, so that burst still creates exactly one
# directory and races no `Set-Cookie` headers.
#
# The four creating routes mint because the alternative is unsafe, not
# because it is convenient. They have to write the new tour somewhere, and
# without a cookie there is nowhere safe: a fixed placeholder directory is
# the collision this whole task exists to prevent, and a session directory
# whose sid was never sent back is a historian's tour written where their
# browser can never reach it again. They are never part of the first-load
# burst — they are user-initiated from the welcome screen, after
# `/api/session` has answered and set the cookie — so they mint only as a
# fallback, and `docs/HANDOFF.md` documents exactly that fallback for an
# author working from a terminal with no browser. `_reject_cross_site`
# guards all four, so minting on a POST opens no door that `GET
# /api/session` did not already open.


def _session_for(cfg: Settings, sid: str | None) -> Session | None:
    """The session `sid` names, or None when it names nothing usable.

    `sid` is the `str` Starlette parsed out of the Cookie header, never raw
    header bytes: `valid_sid` raises `TypeError` on `bytes` rather than
    returning False, so handing it bytes would be a 500, not a refusal.

    The sid is never logged. `session_dir` raises `ValueError(sid)`, which
    puts caller-controlled text into an exception message; logging that
    value would be a log-injection path, so it is checked here and the
    value is simply dropped.
    """
    if sid is None or not valid_sid(sid):
        return None
    return Session(session_dir(cfg.sessions_dir, sid))


def current_session(request: Request) -> Session:
    """The session this request's cookie names. Resolves; never mints.

    Raises nothing when there is no session: it returns a `Session` rooted
    at a directory that does not exist, so `is_open` is false and each
    route's existing guard refuses in the words it already used — a
    cookieless `PUT /api/session/tour` gets its 409 "no tour is open", not a
    new session.

    That not-there path is a fresh sid rather than one fixed placeholder,
    and the difference matters: a placeholder would be a single directory
    that every cookieless caller shares, which is the collision this task
    exists to remove. This path is never created and never sent back in a
    cookie, so nothing can land in it or be read out of it.

    It goes through `session_dir` like every other path, rather than being
    joined by hand: `session_dir` is the one place that knows how a sid
    becomes a directory, and a second spelling here would quietly stop
    agreeing with it the day that layout changes.
    """
    cfg: Settings = request.app.state.cfg
    session = _session_for(cfg, request.cookies.get(SID_COOKIE))
    if session is None:
        return Session(session_dir(cfg.sessions_dir, new_sid()))
    return session


def _set_sid_cookie(response: Response, sid: str) -> None:
    response.set_cookie(
        SID_COOKIE, sid, max_age=COOKIE_MAX_AGE, path="/",
        # HttpOnly: no frontend code reads the sid, so script has no reason
        # to see it. Lax, not Strict: a historian following a link to their
        # own tour must arrive already attached to it.
        #
        # Secure unconditionally, rather than from `request.url.scheme`.
        # The host serves HTTPS, and Chrome and Firefox accept a Secure
        # cookie on `http://localhost`, so `ng serve` still works. Deriving
        # it from the scheme looks more accommodating and is the worse
        # trade: the host's Apache terminates TLS and then starts the CGI
        # process, so the scheme this process sees can be "http" on a
        # request the browser made over HTTPS, and the flag would then be
        # dropped in production — exactly where it matters — to spare a
        # local-development inconvenience. (ADR 0006 gave Passenger as the
        # reason; ADR 0007 corrects it. The decision is unchanged, and the
        # scheme is still not to be trusted here.)
        httponly=True, secure=True, samesite="lax",
    )


SWEEP_INTERVAL_SECONDS = 3600
_now = time.time  # a seam, so tests move the clock instead of sleeping


def _sweep_once(cfg: Settings) -> None:
    """Reclaim abandoned sessions, on a mint, at most once per interval.

    Throttled, not per request: minting is the hot path of every first page
    load and a sweep walks every session directory. Throttled on a FILE, not
    in `app.state`: this process answers one request and exits, so an
    in-memory timestamp is unset on every request and would throttle
    nothing — a full walk per cookieless mint, which is the stat storm the
    throttle exists to prevent. The stamp outlives the process, so the clock
    has to be a wall clock; `sessions.sweep_due` carries the reasoning.

    It runs BEFORE the new directory is made, so it never visits it. The
    stamp is written first, so a failing sweep is not retried on the next
    request, and a stamp that cannot be written skips the walk rather than
    repeating it per request. `sweep` does not raise; the guard here is for
    the settings lookup and anything unforeseen.
    """
    now = _now()
    if not sweep_due(cfg.sessions_dir, interval_seconds=SWEEP_INTERVAL_SECONDS, now=now):
        return
    if not mark_swept(cfg.sessions_dir, now=now):
        return
    try:
        sweep(
            cfg.sessions_dir,
            without_tour_days=cfg.session_retention_days_without_tour,
            with_tour_days=cfg.session_retention_days_with_tour,
        )
    except Exception as exc:  # noqa: BLE001 - housekeeping must never reach a request
        # Type only, never .exception(): messages and tracebacks can carry a sid.
        logging.getLogger(__name__).error("session sweep failed: %s", type(exc).__name__)


def mint_session(request: Request, response: Response) -> Session:
    """`current_session`, except that an absent session is created here.

    Minting writes `config.json` — the viewer's Mapillary token and tile
    URL. The lifespan used to write it at startup; `a2wsgi` never runs the
    ASGI lifespan, so it is written when the session is made instead. The
    routes that replace the working directory afterwards re-write it,
    because `Session.new` and `replace_from` both swap the whole directory.

    An existing, well-formed cookie is resolved and left alone: the sid is
    also the recovery key a historian may have written down, so a visit
    must not rotate it. A cookie whose DIRECTORY has since gone is still
    resolved, not re-minted, for the same reason — it reads as closed.
    """
    cfg: Settings = request.app.state.cfg
    session = _session_for(cfg, request.cookies.get(SID_COOKIE))
    if session is not None:
        return session
    _sweep_once(cfg)
    sid = new_sid()
    session = Session(session_dir(cfg.sessions_dir, sid))
    session.write_config(_viewer_config(cfg))
    _set_sid_cookie(response, sid)
    return session


def _with_recovery_key(session: Session) -> dict:
    """The session summary, plus the key to get back to it.

    The directory name IS the sid (`session_dir` is the only thing that
    builds it), and the sid is the recovery key by design, so the key is read
    off the path rather than threaded through from the cookie. A closed
    session has none: there is nothing to recover, and handing out a key for
    an empty directory would invite someone to write down nothing.
    """
    summary = session.summary()
    if summary["open"]:
        summary["recoveryKey"] = session.path.name
    return summary


CurrentSession = Annotated[Session, Depends(current_session)]
MintedSession = Annotated[Session, Depends(mint_session)]


def create_app(settings_override: Settings | None = None) -> FastAPI:
    cfg = settings_override or default_settings

    app = FastAPI(title="clio-wired")
    # In `create_app`'s body rather than a lifespan: `a2wsgi` never runs the
    # ASGI lifespan, and state that silently does not get set behind the CGI
    # bridge (`app/cgi.py`) is worse than state that was never deferred.
    # `app.state.cfg` is what the two session dependencies above read.
    app.state.cfg = cfg
    app.add_middleware(
        CORSMiddleware,
        allow_origins=["http://localhost:4200"],
        # The session routes are mutating (POST/PUT/DELETE), so a browser
        # preflights them; GET-only would refuse every one of them.
        allow_methods=["GET", "POST", "PUT", "DELETE"],
        allow_headers=["*"],
    )

    @app.get("/api/health")
    def health() -> dict:
        return {"status": "ok"}

    @app.middleware("http")
    async def _limit_media_upload(request: Request, call_next):
        """Refuse an obviously oversized media upload from its declared
        Content-Length before the multipart parser spools it. Slack covers
        the multipart framing. A client that omits or lies about the length
        still hits the exact check in the route."""
        if request.url.path == "/api/session/media":
            try:
                declared = int(request.headers.get("content-length", "0"))
            except ValueError:
                declared = 0
            if declared > cfg.max_media_file_bytes + 1024 * 1024:
                return Response(
                    content='{"detail":"that upload is too large"}',
                    status_code=413, media_type="application/json",
                )
        return await call_next(request)

    @app.get("/api/session")
    def get_session(session: MintedSession) -> dict:
        return _with_recovery_key(session)

    @app.post("/api/session/reattach", dependencies=[Depends(_reject_cross_site)])
    def reattach_session(request: Request, response: Response,
                         body: Annotated[Any, Body()] = None) -> dict:
        """Point this browser at an existing tour, by its recovery key.

        Neither session dependency fits: this route must not mint (an
        unknown key opens nothing), and its job is to REPLACE what the cookie
        names. So it reads the cookie itself.

        An open tour is refused first, before the key is even looked at: the
        only thing a reattach does to the caller is drop the cookie that
        reaches their current session, and that is the one tour the caller
        may not be able to get back. Neither refusal below echoes the key,
        and nothing here logs it.
        """
        mine = _session_for(cfg, request.cookies.get(SID_COOKIE))
        if mine is not None and mine.is_open:
            raise HTTPException(
                status_code=409,
                detail="a tour is already open; export it first, or close it "
                       "before using a recovery key",
            )
        key = body.get("key") if isinstance(body, dict) else None
        if not isinstance(key, str) or not valid_sid(key):
            raise HTTPException(status_code=400, detail="that is not a recovery key")
        target = Session(session_dir(cfg.sessions_dir, key))
        if not target.is_open:
            raise HTTPException(
                status_code=404, detail="there is no tour with that recovery key"
            )
        _set_sid_cookie(response, key)
        return _with_recovery_key(target)

    @app.delete("/api/session", dependencies=[Depends(_reject_cross_site)])
    def close_session(session: CurrentSession) -> dict:
        try:
            session.close()
        except SessionConflict as exc:
            raise HTTPException(status_code=409, detail=str(exc)) from exc
        return session.summary()

    @app.post("/api/session/new", dependencies=[Depends(_reject_cross_site)])
    def new_session(body: dict, session: MintedSession) -> dict:
        title = (body.get("title") or "Untitled tour").strip() or "Untitled tour"
        force = bool(body.get("force", False))
        try:
            session.new(title, force=force)
        except SessionConflict as exc:
            raise HTTPException(status_code=409, detail=str(exc)) from exc
        session.write_config(_viewer_config(cfg))
        return session.summary()

    @app.get("/api/session/examples")
    def get_examples() -> dict:
        # Cannot fail: `list_examples` skips an example it cannot read, so the
        # welcome screen renders its shelf (empty, if that is the truth) rather
        # than an error. A malformed example is refused by the POST below,
        # where the author asked for that one by name.
        return {"examples": [asdict(e) for e in list_examples(cfg)]}

    @app.post("/api/session/examples/{example_id}",
              dependencies=[Depends(_reject_cross_site)])
    def import_example(example_id: str, session: MintedSession) -> dict:
        # Guarded before anything is staged, for the same reason `Session.new`
        # refuses: opening an example replaces the working directory, and the
        # author's only copy of an unexported tour is in it.
        if session.is_open:
            raise HTTPException(
                status_code=409,
                detail=(
                    "a tour is already open; export it first, or close it "
                    "before opening an example"
                ),
            )
        try:
            warnings = open_example(session, cfg, example_id)
        except KeyError as exc:
            raise HTTPException(
                status_code=404, detail=f"there is no example {example_id!r}"
            ) from exc
        except (ExampleError, BundleError) as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc
        session.write_config(_viewer_config(cfg))
        return {**session.summary(), "warnings": warnings}

    @app.put("/api/session/tour", dependencies=[Depends(_reject_cross_site)])
    def put_tour(doc: dict, session: CurrentSession) -> dict:
        if not session.is_open:
            raise HTTPException(
                status_code=409,
                detail="no tour is open; call POST /api/session/new first",
            )
        try:
            session.write_tour(doc)
        except ValueError as exc:
            raise HTTPException(status_code=422, detail=str(exc)) from exc
        return session.summary()

    @app.post("/api/session/import", dependencies=[Depends(_reject_cross_site)])
    async def import_bundle(
        file: UploadFile, session: MintedSession,
        force: Annotated[bool, Form()] = False,
    ) -> dict:
        # Guarded before the upload is spooled, and the last of the four ways
        # in to be: replacing the working directory throws away the author's
        # only copy of an unexported tour, which is why `Session.new`, the
        # examples route and the loose-file route all refuse here.
        #
        # This one was left for longest because it is inherited, which was
        # the wrong test of whether it mattered: `WelcomePage.ingest` sends
        # every single-`.zip` drop to this route, and a packaged bundle is
        # the first thing the drop zone's own text offers. A stale welcome
        # screen in a second tab therefore destroyed the first tab's tour
        # through the most prominent control on the screen.
        #
        # `force` is `Session.new`'s flag and its bargain: the remaining ways
        # to lose an open document all require saying so on purpose. It
        # travels as a form field rather than a query parameter because the
        # body is already multipart for the file, so it costs the caller
        # nothing but one more `-F`, and because that keeps the intent inside
        # the request body with the thing it applies to. The welcome screen
        # deliberately never sends it: that screen is shown only when nothing
        # is open, so a conflict there means its view of the session is stale
        # and refusing is the whole point.
        if session.is_open and not force:
            raise HTTPException(
                status_code=409,
                detail=(
                    "a tour is already open; export it first, or pass force "
                    "to discard it"
                ),
            )
        # Spool to disk with a genuine streaming copy: `UploadFile.file` is
        # the underlying spooled file FastAPI already parsed the upload into,
        # and `copyfileobj` moves it to our own temp file in chunks rather
        # than materialising the whole archive as one `bytes` object first —
        # the caps in bundle.py are about what is INSIDE the zip, and a
        # bundle with media is tens of megabytes, which must never be held
        # in memory all at once.
        #
        # The temp file's lifetime is guarded from the moment it is
        # created — `mkstemp` plus this `try` — rather than from inside a
        # `with` block, so a failure during the copy itself (disk full, I/O
        # error) still unlinks the file and surfaces as an ordinary 400
        # instead of leaking the file and crashing the route as a 500.
        fd, tmp_name = tempfile.mkstemp(suffix=".zip")
        staged = Path(tmp_name)
        try:
            with os.fdopen(fd, "wb") as tmp:
                shutil.copyfileobj(file.file, tmp)
        except OSError as exc:
            staged.unlink(missing_ok=True)
            raise HTTPException(
                status_code=400, detail=f"could not save the upload: {exc}"
            ) from exc
        try:
            warnings = session.replace_from(
                staged,
                max_bytes=cfg.max_bundle_bytes,
                max_entries=cfg.max_bundle_entries,
            )
        except BundleError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc
        finally:
            staged.unlink(missing_ok=True)
        session.write_config(_viewer_config(cfg))
        return {**session.summary(), "warnings": warnings}

    @app.post("/api/session/import-files", dependencies=[Depends(_reject_cross_site)])
    def import_files(files: list[UploadFile], session: MintedSession) -> dict:
        # A loose `tour.json` plus its media, for the author whose tour is
        # not zipped (the repository's own is not). Each part's filename is
        # its path relative to the bundle root. Staged into the same kind of
        # temp zip as `import_bundle` and handed to the same `replace_from`,
        # so nothing is validated twice or differently; the temp-file
        # discipline is that route's, except that the staging helper opens
        # the destination itself, so the mkstemp fd is closed straight away.
        #
        # Plain `def`, so FastAPI runs this in the threadpool, for the reason
        # spelled out on `upload_media` below: `stage_loose_bundle` copies
        # every part into a staging tree and then deflates the lot, which for
        # a real media folder is seconds to minutes. On the event loop that
        # stalls every other request this process serves — the `tour-data/`
        # media the editor is displaying included — while the welcome screen
        # shows "Opening…" with nothing to cancel. Nothing here awaits:
        # `UploadFile.file` is a synchronous `SpooledTemporaryFile`, which is
        # what the staging helper wants anyway.
        # Guarded before anything is staged, exactly as `import_example` is
        # and for the identical reason: this replaces the working directory,
        # and the author's only copy of an unexported tour is in it. The
        # welcome screen is reached only when nothing is open, but a *stale*
        # welcome screen in a second tab is ordinary, and there the drop zone
        # must refuse for the same reason its two neighbouring controls do.
        if session.is_open:
            raise HTTPException(
                status_code=409,
                detail=(
                    "a tour is already open; export it first, or close it "
                    "before importing"
                ),
            )
        # The caps, off the parts list, before a byte is written. Starlette
        # has already spooled every part by the time this handler runs, but
        # staging would then copy them ALL into a temp tree and deflate that
        # into a zip — roughly twice the drop's size in $TMPDIR, on the
        # machine whose working directory is the author's only copy — only
        # for `read_bundle` to apply these same two limits and refuse. The
        # zip route refuses from the archive's metadata for the same reason
        # (`bundle.py:_check_safe`); this is the loose route's equivalent.
        #
        # These are an early-out, not the enforcement — `read_bundle` still
        # counts real bytes as it extracts, and still has the last word. See
        # `_part_size` for why a part's declared size is not simply summed.
        #
        # `>=`, not `>`: `stage_bundle_root` adds a `bundle.json` beside the
        # `tour.json`, so N parts become an archive of N + 1 entries. At
        # exactly `max_bundle_entries` a `>` test passed the drop through and
        # `read_bundle` then refused it at 5001 — which is the expensive
        # refusal this check exists to avoid, at the one count where it was
        # still reachable.
        if len(files) >= cfg.max_bundle_entries:
            raise HTTPException(
                status_code=400,
                detail=(
                    f"too many files in the drop: {len(files)}, "
                    f"limit {cfg.max_bundle_entries - 1} (the bundle's own "
                    "bundle.json takes the last of the "
                    f"{cfg.max_bundle_entries} entries an archive may hold)"
                ),
            )
        total = sum(_part_size(f) for f in files)
        if total > cfg.max_bundle_bytes:
            raise HTTPException(
                status_code=400,
                detail=(
                    f"that drop is too large: {total} bytes, "
                    f"limit {cfg.max_bundle_bytes}"
                ),
            )
        fd, tmp_name = tempfile.mkstemp(suffix=".zip")
        os.close(fd)
        staged = Path(tmp_name)
        try:
            stage_loose_bundle([(f.filename or "", f.file) for f in files], staged)
            warnings = session.replace_from(
                staged,
                max_bytes=cfg.max_bundle_bytes,
                max_entries=cfg.max_bundle_entries,
            )
        except BundleError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc
        except OSError as exc:
            raise HTTPException(
                status_code=400, detail=f"could not save the upload: {exc}"
            ) from exc
        finally:
            staged.unlink(missing_ok=True)
        session.write_config(_viewer_config(cfg))
        return {**session.summary(), "warnings": warnings}

    @app.post("/api/session/media", dependencies=[Depends(_reject_cross_site)])
    def upload_media(file: UploadFile, session: CurrentSession) -> dict:
        # Plain `def`, so FastAPI runs this in the threadpool: a 64 MB copy,
        # a hash and directory scans must not stall the event loop (map
        # tiles, audio range requests). That is also what makes the lock in
        # `store_media` load-bearing: threadpool handlers genuinely overlap,
        # whereas `async` handlers happened to serialise each other.
        if not session.is_open:
            raise HTTPException(
                status_code=409,
                detail="no tour is open; call POST /api/session/new first",
            )
        # Same discipline as import: spool to disk, guard the temp file from
        # the moment it exists. NOTE the per-file cap is checked AFTER the
        # copy: Starlette's multipart parser has already spooled the whole
        # upload before this handler runs, so a mid-copy cap would not help.
        # The early protection is the Content-Length check in
        # `_limit_media_upload` below; this check is the exact, authoritative
        # one (Content-Length can be absent or chunked).
        fd, tmp_name = tempfile.mkstemp(suffix=".upload")
        staged = Path(tmp_name)
        try:
            try:
                with os.fdopen(fd, "wb") as tmp:
                    shutil.copyfileobj(file.file, tmp)
            except OSError as exc:
                raise HTTPException(
                    status_code=400, detail=f"could not save the upload: {exc}"
                ) from exc
            if staged.stat().st_size > cfg.max_media_file_bytes:
                raise HTTPException(
                    status_code=400,
                    detail=(
                        "that file is over the "
                        f"{cfg.max_media_file_bytes} byte limit"
                    ),
                )
            try:
                media_id = store_media(
                    session.path,
                    staged.read_bytes(),
                    file.filename or "",
                    max_file_bytes=cfg.max_media_file_bytes,
                    max_session_bytes=cfg.max_session_media_bytes,
                )
            except MediaError as exc:
                raise HTTPException(status_code=400, detail=str(exc)) from exc
        finally:
            staged.unlink(missing_ok=True)
        return {**session.summary(), "mediaId": media_id}

    # --- acquisition tools -------------------------------------------------
    # Plain `def`s: blocking httpx/subprocess calls belong in the threadpool.
    # `app.state.http_transport` is None in production; tests install a
    # MockTransport there so nothing in the suite touches the network.

    def _tool_client(timeout: float):
        return tools.make_client(getattr(app.state, "http_transport", None), timeout)

    @app.get("/api/diagnostics/egress")
    def egress_diagnostic() -> dict:
        # Asks the application itself, from its own user context, which
        # outside hosts it can reach: a cPanel shell is not the process that
        # serves requests, and the egress measurements in ADR 0007 were all
        # taken in that shell. Any HTTP response (even 403) proves the
        # network path;
        # only an exception means blocked. One host failing must never hide
        # the rest, so each is probed independently and in parallel.
        urls = [tools.MAPILLARY_PROBE_URL, tools.LOC_PROBE_URL, *tools.OVERPASS_MIRRORS]

        def probe(c: httpx.Client, url: str) -> tuple[str, dict]:
            host = httpx.URL(url).host
            try:
                return host, {"status": c.get(url).status_code}
            except Exception as exc:  # noqa: BLE001 - report, never raise
                return host, {"error": tools._describe(exc)}

        with (_tool_client(tools.EGRESS_TIMEOUT) as c,
              ThreadPoolExecutor(max_workers=len(urls)) as pool):
            results = list(pool.map(lambda u: probe(c, u), urls))
        return {"hosts": dict(results)}

    @app.post("/api/tools/places", dependencies=[Depends(_reject_cross_site)])
    def tool_places(body: tools.PlacesRequest) -> dict:
        try:
            with _tool_client(tools.OVERPASS_TIMEOUT) as c:
                found = tools.find_places(c, body.lng, body.lat, body.radiusM, body.name)
        except tools.ToolError as exc:
            raise HTTPException(status_code=exc.status, detail=exc.message) from exc
        return {"places": found}

    @app.get("/api/session/export")
    def export_bundle(session: CurrentSession) -> Response:
        if not session.is_open:
            raise HTTPException(status_code=409, detail="no tour is open")
        # `_validate_tree` enforces "every referenced mediaId exists in
        # media/" on import; nothing enforced it on export, so an author's
        # save artefact could be invalid and they would learn only when they
        # tried to reopen it. A 409 here reuses the status this API already
        # uses for "this request cannot succeed against the current state"
        # (see the two guards above and `/api/session/publish` below),
        # rather than introducing a second way to report the same class of
        # problem.
        missing = missing_media(session.path)
        if missing:
            raise HTTPException(
                status_code=409,
                detail=(
                    "the open tour references media that is missing: "
                    + ", ".join(missing)
                ),
            )
        with tempfile.TemporaryDirectory() as tmp:
            out = Path(tmp) / "tour.zip"
            write_bundle(session.path, out)
            data = out.read_bytes()
        name = f"{session.tour().id}.zip"
        return Response(
            content=data, media_type="application/zip",
            headers={"Content-Disposition": f'attachment; filename="{name}"'},
        )

    @app.get("/api/session/publish")
    def publish_site(session: CurrentSession) -> Response:
        with tempfile.TemporaryDirectory() as tmp:
            out = Path(tmp) / "site.zip"
            try:
                build_site(session.path, Path(cfg.frontend_dist), out)
            except PublishError as exc:
                raise HTTPException(status_code=409, detail=str(exc)) from exc
            data = out.read_bytes()
        name = f"{session.tour().id}-site.zip"
        return Response(
            content=data, media_type="application/zip",
            headers={"Content-Disposition": f'attachment; filename="{name}"'},
        )

    # Registered BEFORE the frontend mount, which is a catch-all: an
    # unmatched tour-data path must 404 rather than be swallowed into the
    # SPA's index.html fallback.
    @app.api_route("/tour-data/{path:path}", methods=["GET", "HEAD"],
                   name="tour-data")
    def tour_data(path: str, request: Request, session: CurrentSession) -> Response:
        """Serve this session's directory at the same relative path a
        published site uses, so the viewer has exactly one set of URLs and no
        deployment detection.

        This was a `StaticFiles` mount of one global working directory, which
        on shared hosting served every historian every other historian's
        media. It resolves the session from the cookie instead, and NEVER
        mints: no cookie, or a cookie naming a session that is not there, is
        a 404. Minting here would mean the eager viewer's two `tour-data/`
        fetches each made a session on the first page load.

        `FileResponse` keeps two of the three things the mount gave for
        free: Range (the narration audio needed it; the historians' own
        recorded audio needs it as much) and a content type from
        `mimetypes`, including the two overrides pinned at the top of this
        module. The third, 304 revalidation, it does NOT keep, so it is
        restored by hand below. nosniff is set by hand too; it is defence in
        depth for a polyglot file that slipped past the upload sniffing, and
        a belt for the editor only, since a published static host sets its
        own headers.
        """
        found = None
        try:
            # Resolved and checked before anything is opened, the way
            # `examples.py`'s `_inside` does it. `session.path / path` is
            # `/etc/passwd` outright when `path` is absolute, because
            # pathlib discards the left side — so this guard, not the URL
            # shape, is what refuses that. The session directories are
            # siblings, so it is also what stops `../<other sid>/tour.json`.
            root = session.path.resolve()
            target = (session.path / path).resolve()
            if target.is_relative_to(root):
                # Stat ONCE, and hand the result to `FileResponse`, the way
                # the `StaticFiles` mount did. Deciding with `is_file()` and
                # letting `FileResponse` stat again left a window in which a
                # file removed between the two turned into a `RuntimeError`
                # — a 500 where the author should have had this 404.
                st = target.stat()
                if stat_module.S_ISREG(st.st_mode):
                    found = (target, st)
        except (OSError, ValueError):
            # A path pathlib or the filesystem will not even look at (an
            # embedded NUL, a component past NAME_MAX), or one that has just
            # stopped existing. A 404, not a 500.
            found = None
        if found is None:
            raise HTTPException(status_code=404)
        target, st = found

        response = FileResponse(target, stat_result=st,
                                headers={"X-Content-Type-Options": "nosniff"})
        # `FileResponse` advertises `ETag` and `Last-Modified` but ignores
        # the validators a client sends back, so every editor reload
        # re-transferred every panorama and audio clip in the tour. The
        # `StaticFiles` mount answered 304 here. Advertising a validator and
        # then ignoring it is silent waste, and this deploys to shared
        # hosting with CPU and bandwidth limits.
        if _not_modified(request.headers, response.headers):
            # Starlette's own 304, so the header whitelist is the one the
            # mount used; nosniff is re-added because the mount's wrapper
            # put it on its 304s too, even though a bodyless response has
            # nothing to sniff.
            not_modified = NotModifiedResponse(response.headers)
            not_modified.headers["X-Content-Type-Options"] = "nosniff"
            return not_modified
        return response

    _mount_frontend(app, cfg)
    return app


def _mount_frontend(app: FastAPI, cfg: Settings) -> None:
    """Serve the built Angular bundle, if there is one.

    Mounted last so every /api route takes precedence. html=True gives the
    single-page app its deep-link fallback to index.html. The backend must
    still boot when the frontend has not been built, so a missing directory is
    simply skipped.
    """
    dist = Path(cfg.frontend_dist)
    if not dist.is_dir():
        return
    app.mount("/", _SpaFiles(directory=dist, html=True), name="frontend")


class _SpaFiles(StaticFiles):
    """StaticFiles that serves index.html for unknown paths.

    The single-page app owns its own routes, so a deep link must reach the app
    rather than 404. StaticFiles only falls back for directory paths, not for
    arbitrary ones.
    """

    async def get_response(self, path: str, scope):
        try:
            response = await super().get_response(path, scope)
            return self._with_cache_headers(response, path)
        except StarletteHTTPException as exc:
            # An unmatched API path is an error, not a deep link. Falling back
            # there would turn a 404 into a 200 page and hide real mistakes.
            if exc.status_code == 404 and not path.startswith("api/"):
                fallback = await super().get_response("index.html", scope)
                return self._with_cache_headers(fallback, "index.html")
            raise

    @staticmethod
    def _with_cache_headers(response, path: str):
        """Keep HTML fresh; let content-hashed assets cache.

        index.html names hashed bundles, so a cached copy pins the whole app to
        an old build — which silently served stale JavaScript during
        development, making changes look like they had not been applied.
        """
        if path.endswith(".html") or path in ("", "."):
            response.headers["Cache-Control"] = "no-cache, must-revalidate"
        return response


app = create_app()
