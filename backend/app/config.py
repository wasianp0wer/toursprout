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

    @property
    def work_dir(self) -> Path:
        return self.content_dir / "work"


settings = Settings()
