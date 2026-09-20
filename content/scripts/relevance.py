"""Relevance scoring for archive search results.

Archive search is fuzzy: a query for the Fairfax courthouse cheerfully returns
Alexandria, Chantilly and Reston. Attaching one of those to a Fairfax stop
under a Library of Congress credit is a provenance error, so a result has to
earn its place by naming its subject.
"""

from __future__ import annotations

import sys
import time


def _as_text(value: object) -> str:
    if isinstance(value, list):
        return " ".join(str(v) for v in value)
    return str(value or "")


def score_title(title: object, required: list[str], excluded: list[str]) -> float:
    """Return 0.0 if the title is rejected, otherwise a positive score."""
    text = _as_text(title).lower()
    if not text.strip():
        return 0.0
    if any(term.lower() in text for term in excluded):
        return 0.0
    hits = sum(1 for term in required if term.lower() in text)
    if hits != len(required):
        return 0.0
    # Among titles that match every term, the shorter one is more specific.
    return hits + 1.0 / (1.0 + len(text))


def best_match(items: list[dict], required: list[str], excluded: list[str]) -> dict | None:
    best, best_score = None, 0.0
    for item in items:
        if not item.get("image_url"):
            continue
        score = score_title(item.get("title", ""), required, excluded)
        if score > best_score:
            best, best_score = item, score
    return best


def get_json_with_retry(client, url: str, params: dict, attempts: int = 5) -> dict:
    """GET JSON, retrying transport failures.

    loc.gov returns large payloads and the local egress proxy intermittently
    closes the connection mid-body (RemoteProtocolError). A single attempt is
    not enough to tell "no results" from "the connection dropped", and
    conflating those two silently drops content.
    """
    last = None
    for attempt in range(attempts):
        try:
            response = client.get(url, params=params)
            response.raise_for_status()
            return response.json()
        except Exception as exc:  # noqa: BLE001 - retry on any transport failure
            last = f"{type(exc).__name__}: {exc}"
            if attempt < attempts - 1:
                time.sleep(1.5 * (attempt + 1))
    raise RuntimeError(f"{url} failed after {attempts} attempts: {last}")


def get_bytes_with_retry(client, url: str, attempts: int = 5) -> bytes | None:
    """Download binary content, retrying transport failures.

    Returning None here must mean "not available", never "the connection
    dropped once" — otherwise media silently vanishes from the tour.
    """
    for attempt in range(attempts):
        try:
            response = client.get(url)
            if response.status_code == 200:
                return response.content
            if response.status_code < 500:
                return None
        except Exception as exc:  # noqa: BLE001 - retry on any transport failure
            if attempt == attempts - 1:
                print(f"  giving up on {url}: {type(exc).__name__}", file=sys.stderr)
        if attempt < attempts - 1:
            time.sleep(1.5 * (attempt + 1))
    return None
