from __future__ import annotations

import mimetypes
import os
import shutil
import tempfile
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import Depends, FastAPI, HTTPException, Request, Response, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from starlette.exceptions import HTTPException as StarletteHTTPException

from .bundle import BundleError, missing_media, write_bundle
from .config import Settings
from .config import settings as default_settings
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

    @app.get("/api/session")
    def get_session() -> dict:
        return app.state.session.summary()

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
    async def import_bundle(file: UploadFile) -> dict:
        session = app.state.session
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
    app.mount("/tour-data",
              StaticFiles(directory=cfg.work_dir, check_dir=False),
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
