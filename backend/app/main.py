from __future__ import annotations

import tempfile
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI, HTTPException, Request, Response, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from starlette.exceptions import HTTPException as StarletteHTTPException

from .bundle import BundleError, write_bundle
from .config import Settings
from .config import settings as default_settings
from .db import connect, init_schema, list_tours, load_tour, seed_from_dir
from .media import RangeNotSatisfiable, guess_media_type, parse_range
from .session import Session

# Raster tiles carry the OSM usage policy; acceptable at prototype volume.
TILE_URL = "https://tile.openstreetmap.org/{z}/{x}/{y}.png"

ATTRIBUTION = [
    {"text": "Map data (c) OpenStreetMap contributors",
     "url": "https://www.openstreetmap.org/copyright", "license": "ODbL"},
    {"text": "Street-level imagery (c) Mapillary contributors",
     "url": "https://www.mapillary.com", "license": "CC-BY-SA-4.0"},
]


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
        # Seed once at startup with a connection local to this thread, then
        # close it. Routes open their own connection per request: FastAPI runs
        # sync handlers in a threadpool, and a SQLite connection may not cross
        # threads.
        conn = connect(cfg.database_path)
        init_schema(conn)
        if cfg.tours_dir.exists():
            seed_from_dir(conn, cfg.tours_dir)
        conn.close()
        app.state.cfg = cfg
        app.state.session = Session(cfg.work_dir)
        if app.state.session.is_open:
            app.state.session.write_config(_viewer_config(cfg))
        yield

    app = FastAPI(title="clio-wired", lifespan=lifespan)
    app.add_middleware(
        CORSMiddleware,
        allow_origins=["http://localhost:4200"],
        allow_methods=["GET"],
        allow_headers=["*"],
    )

    @app.get("/api/health")
    def health() -> dict:
        return {"status": "ok"}

    @app.get("/api/config")
    def get_config() -> dict:
        return {
            "mapillaryToken": app.state.cfg.mapillary_token,
            "tileUrl": TILE_URL,
            "attribution": ATTRIBUTION,
        }

    @app.get("/api/tours")
    def get_tours() -> list[dict]:
        conn = connect(app.state.cfg.database_path)
        try:
            return [t.model_dump(by_alias=True) for t in list_tours(conn)]
        finally:
            conn.close()

    @app.get("/api/tours/{tour_id}")
    def get_tour(tour_id: str) -> dict:
        conn = connect(app.state.cfg.database_path)
        try:
            tour = load_tour(conn, tour_id)
        finally:
            conn.close()
        if tour is None:
            raise HTTPException(status_code=404, detail="tour not found")
        return tour.model_dump(by_alias=True)

    @app.get("/api/media/{media_id}")
    def get_media(media_id: str, request: Request) -> Response:
        path = _resolve_media(app.state.cfg.media_dir, media_id)
        if path is None:
            raise HTTPException(status_code=404, detail="media not found")

        size = path.stat().st_size
        media_type = guess_media_type(path)

        try:
            byte_range = parse_range(request.headers.get("range"), size)
        except RangeNotSatisfiable:
            return Response(
                status_code=416,
                headers={"Content-Range": f"bytes */{size}", "Accept-Ranges": "bytes"},
            )

        if byte_range is None:
            return FileResponse(path, media_type=media_type,
                                headers={"Accept-Ranges": "bytes"})

        start, end = byte_range
        return Response(
            content=_read_slice(path, start, end),
            status_code=206,
            media_type=media_type,
            headers={
                "Content-Range": f"bytes {start}-{end}/{size}",
                "Content-Length": str(end - start + 1),
                "Accept-Ranges": "bytes",
            },
        )

    @app.get("/api/session")
    def get_session() -> dict:
        return app.state.session.summary()

    @app.post("/api/session/new")
    def new_session(body: dict) -> dict:
        title = (body.get("title") or "Untitled tour").strip() or "Untitled tour"
        session = app.state.session
        session.new(title)
        session.write_config(_viewer_config(app.state.cfg))
        return session.summary()

    @app.put("/api/session/tour")
    def put_tour(doc: dict) -> dict:
        try:
            app.state.session.write_tour(doc)
        except ValueError as exc:
            raise HTTPException(status_code=422, detail=str(exc)) from exc
        return app.state.session.summary()

    @app.post("/api/session/import")
    async def import_bundle(file: UploadFile) -> dict:
        session = app.state.session
        # Spool to disk rather than holding the archive in memory: the caps in
        # bundle.py are about what is INSIDE the zip, and a bundle with media
        # is tens of megabytes.
        with tempfile.NamedTemporaryFile(suffix=".zip", delete=False) as tmp:
            tmp.write(await file.read())
            staged = Path(tmp.name)
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
        with tempfile.TemporaryDirectory() as tmp:
            out = Path(tmp) / "tour.zip"
            write_bundle(session.path, out)
            data = out.read_bytes()
        name = f"{session.tour().id}.zip"
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


def _resolve_media(media_dir: Path, media_id: str) -> Path | None:
    """A media id is a bare filename. Anything path-like is refused."""
    if not media_id or "/" in media_id or "\\" in media_id or ".." in media_id:
        return None
    path = (media_dir / media_id).resolve()
    if not path.is_file() or media_dir.resolve() not in path.parents:
        return None
    return path


def _read_slice(path: Path, start: int, end: int) -> bytes:
    with path.open("rb") as fh:
        fh.seek(start)
        return fh.read(end - start + 1)


app = create_app()
