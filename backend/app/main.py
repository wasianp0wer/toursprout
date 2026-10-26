from __future__ import annotations

import mimetypes
import os
import shutil
import tempfile
from contextlib import asynccontextmanager
from dataclasses import asdict
from pathlib import Path
from typing import Annotated

from fastapi import (
    Depends,
    FastAPI,
    Form,
    HTTPException,
    Request,
    Response,
    UploadFile,
)
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from starlette.exceptions import HTTPException as StarletteHTTPException

from . import media_store, tools
from .bundle import (
    MAX_ENTRIES,
    MAX_TOTAL_BYTES,
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

# `StaticFiles` (used by the tour-data mount below) guesses content types
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


def _viewer_config(cfg: Settings) -> dict:
    """What the viewer needs, identical in the editor and in a published site.

    The Mapillary token travels with a published site. It is a public client
    token — mapillary-js runs in the browser and cannot use anything else — so
    this is not a leak, though it looks like one.
    """
    return {"mapillaryToken": cfg.mapillary_token, "tileUrl": TILE_URL,
            "attribution": ATTRIBUTION}


def create_app(settings_override: Settings | None = None) -> FastAPI:
    cfg = settings_override or default_settings

    @asynccontextmanager
    async def lifespan(app: FastAPI):
        app.state.cfg = cfg
        app.state.session = Session(cfg.work_dir)
        if app.state.session.is_open:
            app.state.session.write_config(_viewer_config(cfg))
        yield

    app = FastAPI(title="clio-wired", lifespan=lifespan)
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
            if declared > media_store.MAX_FILE_BYTES + 1024 * 1024:
                return Response(
                    content='{"detail":"that upload is too large"}',
                    status_code=413, media_type="application/json",
                )
        return await call_next(request)

    @app.get("/api/session")
    def get_session() -> dict:
        return app.state.session.summary()

    @app.delete("/api/session", dependencies=[Depends(_reject_cross_site)])
    def close_session() -> dict:
        session = app.state.session
        try:
            session.close()
        except SessionConflict as exc:
            raise HTTPException(status_code=409, detail=str(exc)) from exc
        return session.summary()

    @app.post("/api/session/new", dependencies=[Depends(_reject_cross_site)])
    def new_session(body: dict) -> dict:
        title = (body.get("title") or "Untitled tour").strip() or "Untitled tour"
        force = bool(body.get("force", False))
        session = app.state.session
        try:
            session.new(title, force=force)
        except SessionConflict as exc:
            raise HTTPException(status_code=409, detail=str(exc)) from exc
        session.write_config(_viewer_config(app.state.cfg))
        return session.summary()

    @app.get("/api/session/examples")
    def get_examples() -> dict:
        # Cannot fail: `list_examples` skips an example it cannot read, so the
        # welcome screen renders its shelf (empty, if that is the truth) rather
        # than an error. A malformed example is refused by the POST below,
        # where the author asked for that one by name.
        return {"examples": [asdict(e) for e in list_examples(app.state.cfg)]}

    @app.post("/api/session/examples/{example_id}",
              dependencies=[Depends(_reject_cross_site)])
    def import_example(example_id: str) -> dict:
        session = app.state.session
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
            warnings = open_example(session, app.state.cfg, example_id)
        except KeyError as exc:
            raise HTTPException(
                status_code=404, detail=f"there is no example {example_id!r}"
            ) from exc
        except (ExampleError, BundleError) as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc
        session.write_config(_viewer_config(app.state.cfg))
        return {**session.summary(), "warnings": warnings}

    @app.put("/api/session/tour", dependencies=[Depends(_reject_cross_site)])
    def put_tour(doc: dict) -> dict:
        session = app.state.session
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
        file: UploadFile, force: Annotated[bool, Form()] = False
    ) -> dict:
        session = app.state.session
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
            warnings = session.replace_from(staged)
        except BundleError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc
        finally:
            staged.unlink(missing_ok=True)
        session.write_config(_viewer_config(app.state.cfg))
        return {**session.summary(), "warnings": warnings}

    @app.post("/api/session/import-files", dependencies=[Depends(_reject_cross_site)])
    def import_files(files: list[UploadFile]) -> dict:
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
        session = app.state.session
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
        if len(files) > MAX_ENTRIES:
            raise HTTPException(
                status_code=400,
                detail=(
                    f"too many files in the drop: {len(files)}, "
                    f"limit {MAX_ENTRIES}"
                ),
            )
        total = sum(_part_size(f) for f in files)
        if total > MAX_TOTAL_BYTES:
            raise HTTPException(
                status_code=400,
                detail=(
                    f"that drop is too large: {total} bytes, "
                    f"limit {MAX_TOTAL_BYTES}"
                ),
            )
        fd, tmp_name = tempfile.mkstemp(suffix=".zip")
        os.close(fd)
        staged = Path(tmp_name)
        try:
            stage_loose_bundle([(f.filename or "", f.file) for f in files], staged)
            warnings = session.replace_from(staged)
        except BundleError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc
        except OSError as exc:
            raise HTTPException(
                status_code=400, detail=f"could not save the upload: {exc}"
            ) from exc
        finally:
            staged.unlink(missing_ok=True)
        session.write_config(_viewer_config(app.state.cfg))
        return {**session.summary(), "warnings": warnings}

    @app.post("/api/session/media", dependencies=[Depends(_reject_cross_site)])
    def upload_media(file: UploadFile) -> dict:
        # Plain `def`, so FastAPI runs this in the threadpool: a 64 MB copy,
        # a hash and directory scans must not stall the event loop (map
        # tiles, audio range requests). That is also what makes the lock in
        # `store_media` load-bearing: threadpool handlers genuinely overlap,
        # whereas `async` handlers happened to serialise each other.
        session = app.state.session
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
            if staged.stat().st_size > media_store.MAX_FILE_BYTES:
                raise HTTPException(
                    status_code=400,
                    detail=(
                        "that file is over the "
                        f"{media_store.MAX_FILE_BYTES} byte limit"
                    ),
                )
            try:
                media_id = store_media(
                    session.path, staged.read_bytes(), file.filename or ""
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

    @app.post("/api/tools/panoramas", dependencies=[Depends(_reject_cross_site)])
    def tool_panoramas(body: tools.PanoramaRequest) -> dict:
        try:
            with _tool_client(tools.MAPILLARY_TIMEOUT) as c:
                found = tools.find_panoramas(
                    c, app.state.cfg.mapillary_token, body.lng, body.lat,
                    body.radiusM, body.panoOnly, body.limit)
        except tools.ToolError as exc:
            raise HTTPException(status_code=exc.status, detail=exc.message) from exc
        return {"candidates": found}

    @app.post("/api/tools/places", dependencies=[Depends(_reject_cross_site)])
    def tool_places(body: tools.PlacesRequest) -> dict:
        try:
            with _tool_client(tools.OVERPASS_TIMEOUT) as c:
                found = tools.find_places(c, body.lng, body.lat, body.radiusM, body.name)
        except tools.ToolError as exc:
            raise HTTPException(status_code=exc.status, detail=exc.message) from exc
        return {"places": found}

    @app.post("/api/tools/archive-search", dependencies=[Depends(_reject_cross_site)])
    def tool_archive_search(body: tools.ArchiveRequest) -> dict:
        try:
            with _tool_client(tools.LOC_TIMEOUT) as c:
                found = tools.search_archive(c, body.query, body.terms, body.excludePlaces)
        except tools.ToolError as exc:
            raise HTTPException(status_code=exc.status, detail=exc.message) from exc
        return {"results": found}

    @app.post("/api/tools/archive-fetch", dependencies=[Depends(_reject_cross_site)])
    def tool_archive_fetch(body: tools.ArchiveFetchRequest) -> dict:
        session = app.state.session
        if not session.is_open:
            raise HTTPException(
                status_code=409,
                detail="no tour is open; call POST /api/session/new first",
            )
        try:
            tools.check_archive_url(body.imageUrl)  # before any client is built
            with _tool_client(tools.FETCH_TIMEOUT) as c:
                data = tools.fetch_archive_image(c, body.imageUrl)
            media_id = store_media(session.path, data, body.title or "archive")
        except tools.ToolError as exc:
            raise HTTPException(status_code=exc.status, detail=exc.message) from exc
        except MediaError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc
        return {**session.summary(), "mediaId": media_id}

    @app.post("/api/tools/narrate", dependencies=[Depends(_reject_cross_site)])
    def tool_narrate(body: tools.NarrateRequest) -> dict:
        session = app.state.session
        if not session.is_open:
            raise HTTPException(
                status_code=409,
                detail="no tour is open; call POST /api/session/new first",
            )
        try:
            audio = tools.synthesize(body.text)
            media_id = store_media(session.path, audio, "narration")
        except tools.ToolError as exc:
            raise HTTPException(status_code=exc.status, detail=exc.message) from exc
        except MediaError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc
        return {**session.summary(), "mediaId": media_id, "credit": tools.NARRATION_CREDIT}

    @app.get("/api/session/export")
    def export_bundle() -> Response:
        session = app.state.session
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
    def publish_site() -> Response:
        session = app.state.session
        with tempfile.TemporaryDirectory() as tmp:
            out = Path(tmp) / "site.zip"
            try:
                build_site(session.path, Path(app.state.cfg.frontend_dist), out)
            except PublishError as exc:
                raise HTTPException(status_code=409, detail=str(exc)) from exc
            data = out.read_bytes()
        name = f"{session.tour().id}-site.zip"
        return Response(
            content=data, media_type="application/zip",
            headers={"Content-Disposition": f'attachment; filename="{name}"'},
        )

    _mount_tour_data(app, cfg)
    _mount_frontend(app, cfg)
    return app


def _mount_tour_data(app: FastAPI, cfg: Settings) -> None:
    """Serve the working directory at the same relative path a published site
    uses, so the viewer has exactly one set of URLs and no deployment
    detection. StaticFiles handles Range, which the narration audio needs.

    `check_dir=False` because the working directory legitimately does not
    exist until a tour is opened; requests 404 until it does.
    """
    cfg.work_dir.mkdir(parents=True, exist_ok=True)
    # nosniff is defence in depth for a polyglot file that slipped past the
    # upload sniffing. It is a belt for the editor only: a published static
    # host sets its own headers, so it guarantees nothing for the site.
    class _NoSniffStaticFiles(StaticFiles):
        async def get_response(self, path: str, scope):
            response = await super().get_response(path, scope)
            response.headers["X-Content-Type-Options"] = "nosniff"
            return response

    app.mount("/tour-data",
              _NoSniffStaticFiles(directory=cfg.work_dir, check_dir=False),
              name="tour-data")


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
