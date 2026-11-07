from __future__ import annotations

from pathlib import Path

from pydantic_settings import BaseSettings, SettingsConfigDict

BACKEND_DIR = Path(__file__).resolve().parent.parent
REPO_DIR = BACKEND_DIR.parent


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=BACKEND_DIR / ".env", extra="ignore")

    mapillary_token: str = ""
    content_dir: Path = REPO_DIR / "content"
    frontend_dist: Path = REPO_DIR / "frontend" / "dist" / "frontend" / "browser"

    # One directory per browser session, named by its sid, and deliberately
    # OUTSIDE the deploy tree. This replaces `work_dir`, which was
    # `content/work` — inside the repository, where an `rsync` deploy would
    # overwrite or truncate a historian's in-progress tour. `$HOME` survives
    # a deploy; the repository checkout does not. Override as `SESSIONS_DIR`
    # in `backend/.env` when the host puts writable storage elsewhere.
    #
    # Created lazily, when a session is first minted: nothing makes this
    # directory at import or startup, so a request that mints nothing leaves
    # no trace on disk.
    sessions_dir: Path = Path.home() / ".clio-wired" / "sessions"


settings = Settings()
