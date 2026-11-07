from __future__ import annotations

from pathlib import Path

from pydantic import Field
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

    # How long an untouched session directory is kept before it is swept.
    # Two windows, because two kinds of directory: one with no tour.json holds
    # no authored work and no recovery key anyone was shown (a cookieless
    # request, or a creating route that failed, mints one that nothing can
    # reach), so it goes quickly. One with a tour.json may have its recovery
    # key on paper, so it is kept long.
    session_retention_days_without_tour: int = Field(default=1, gt=0)
    session_retention_days_with_tour: int = Field(default=90, gt=0)


settings = Settings()
