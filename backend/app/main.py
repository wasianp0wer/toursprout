from __future__ import annotations

from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI, HTTPException, Request, Response
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from starlette.exceptions import HTTPException as StarletteHTTPException

from .config import Settings
from .config import settings as default_settings
from .db import connect, init_schema, list_tours, load_tour, seed_from_dir
from .media import RangeNotSatisfiable, guess_media_type, parse_range

# Raster tiles carry the OSM usage policy; acceptable at prototype volume.
TILE_URL = "https://tile.openstreetmap.org/{z}/{x}/{y}.png"

ATTRIBUTION = [
    {"text": "Map data (c) OpenStreetMap contributors",
     "url": "https://www.openstreetmap.org/copyright", "license": "ODbL"},
    {"text": "Street-level imagery (c) Mapillary contributors",
     "url": "https://www.mapillary.com", "license": "CC-BY-SA-4.0"},
]


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
            return await super().get_response(path, scope)
        except StarletteHTTPException as exc:
            # An unmatched API path is an error, not a deep link. Falling back
            # there would turn a 404 into a 200 page and hide real mistakes.
            if exc.status_code == 404 and not path.startswith("api/"):
                return await super().get_response("index.html", scope)
            raise


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
