"""SQLite persistence.

Tour documents are stored whole as validated JSON rather than shredded across
relational tables. The prototype only ever reads entire tours, and keeping the
document intact means `app.models` stays the single source of truth.
"""

from __future__ import annotations

import json
import sqlite3
from pathlib import Path

from pydantic import ValidationError

from .models import Tour, TourSummary

SCHEMA = """
CREATE TABLE IF NOT EXISTS tours (
    id         TEXT PRIMARY KEY,
    title      TEXT NOT NULL,
    document   TEXT NOT NULL,
    stop_count INTEGER NOT NULL
);
"""


def connect(path: Path | str) -> sqlite3.Connection:
    conn = sqlite3.connect(str(path))
    conn.row_factory = sqlite3.Row
    return conn


def init_schema(conn: sqlite3.Connection) -> None:
    conn.executescript(SCHEMA)
    conn.commit()


def seed_from_dir(conn: sqlite3.Connection, tours_dir: Path) -> int:
    """Load every tour JSON file into the database. Safe to run on every boot."""
    count = 0
    for path in sorted(Path(tours_dir).glob("*.json")):
        raw = json.loads(path.read_text())
        try:
            tour = Tour.model_validate(raw)
        except ValidationError as exc:
            raise ValueError(f"{path.name} is not a valid tour: {exc}") from exc
        conn.execute(
            "INSERT INTO tours (id, title, document, stop_count) VALUES (?, ?, ?, ?) "
            "ON CONFLICT(id) DO UPDATE SET "
            "title=excluded.title, document=excluded.document, stop_count=excluded.stop_count",
            (tour.id, tour.title, tour.model_dump_json(by_alias=True), len(tour.stops)),
        )
        count += 1
    conn.commit()
    return count


def load_tour(conn: sqlite3.Connection, tour_id: str) -> Tour | None:
    row = conn.execute("SELECT document FROM tours WHERE id = ?", (tour_id,)).fetchone()
    return Tour.model_validate_json(row["document"]) if row else None


def list_tours(conn: sqlite3.Connection) -> list[TourSummary]:
    rows = conn.execute(
        "SELECT id, title, document, stop_count FROM tours ORDER BY id").fetchall()
    out = []
    for row in rows:
        doc = json.loads(row["document"])
        out.append(TourSummary.model_validate({
            "id": row["id"],
            "title": row["title"],
            "description": doc.get("description", ""),
            "stopCount": row["stop_count"],
        }))
    return out
