# Media and Acquisition Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the editor create content — upload files, record audio, and call the Python acquisition scripts as tools — so a tour can be authored end to end.

**Architecture:** One upload endpoint owns every byte that enters the working directory, naming files server-side from content rather than from the client. Four tool endpoints re-home the existing scripts' knowledge; three reach the network and are tested against captured shapes with `httpx.MockTransport`, the fourth (narration) is local. The editor creates overlays only through the existing pure document ops.

**Tech Stack:** Python 3.14, FastAPI, pydantic, httpx, pytest. Angular 22 (signals, standalone), TypeScript, Vitest. macOS `say` for narration.

**Spec:** `docs/superpowers/specs/2026-10-25-media-and-acquisition-design.md`
**Umbrella:** `docs/superpowers/specs/2026-10-12-authoring-application-overview.md`
**Prior:** `2026-10-12-schema-v2-design.md`, `2026-10-12-bundle-and-publish-design.md`, `2026-10-13-editing-core-design.md`

## Global Constraints

- All commands run through `make`, which pins Node 24. **Never call `npx`/`ng` directly** — ambient `node` is v25 and Angular 22 rejects it. Angular's build cache must stay disabled.
- **Never use `urllib`** — it truncates through the egress proxy about one time in ten. `httpx` everywhere.
- **No browser can launch in this sandbox.** No Playwright, no `make e2e`, no microphone, no permission prompt.
- Use `$TMPDIR`, never `/tmp`.
- **Do not add a persistent egress allowlist to `.claude/settings.json`.** The project's standing rule. Live access to `graph.mapillary.com`, `overpass-api.de` and `www.loc.gov` is authorised **per command** and **only** for Task 6's verification run; every test uses mocked transports.
- **Do not `git add` anything under `.superpowers/`** — gitignored scratch.
- Baseline: **197 pytest, 426 Vitest**, lint clean. Bundle budget: no editor symbols in any eager chunk; eager **raw** bytes must not grow; explain any compressed movement.
- JSON is camelCase on the wire, snake_case in Python. `Strict` models are `extra="forbid"`.
- `headingDeg` is derived from where the panorama actually stands, never guessed. The gate is `panoramaFixForStop`, keyed on `imageId`.
- Let git use its own config. Do **not** pass `-c user.email=...`. Commits end with `Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>`.

## Review Focus

1. **An upload whose name is hostile** — `../../etc/passwd`, an absolute path, a name that collides with an existing file. The client must never choose the stored name. → Task 1.
2. **An executable or HTML disguised with an image extension.** Type must be decided by sniffing content, not by the supplied name, because the published site serves `tour-data/` from the author's own origin. → Task 1.
3. **Accumulation.** Many uploads, each under the per-file cap, filling the disk. Nothing currently bounds the working directory's total. → Task 1.
4. **An upstream tool that errors, hangs, or returns a shape that has changed.** Each must surface a useful message and time out, never a 500 or a hung editor. → Task 4.
5. **`MediaRecorder` absent, or microphone permission denied.** Must degrade to a clear message, not a dead button. → Task 3.

---

### Task 1: The media upload endpoint

The second untrusted input this application has. Built and tested before anything calls it.

**Files:**
- Create: `backend/app/media_store.py`
- Create: `backend/tests/test_media_store.py`
- Modify: `backend/app/main.py` (one route), `backend/app/session.py` (orphan count)
- Modify: `backend/tests/test_session_api.py`

**Interfaces:**
- Produces: `app.media_store.MediaError`, `ALLOWED_TYPES: dict[str, str]` (sniffed type → extension), `MAX_FILE_BYTES`, `MAX_TOTAL_BYTES`, `store_media(work: Path, data: bytes, original_name: str) -> str` (returns the `mediaId`), `orphan_ids(work: Path, tour: Tour) -> list[str]`; and `POST /api/session/media`.

- [ ] **Step 1: Write the failing tests**

Create `backend/tests/test_media_store.py`. The core properties:

```python
def test_the_client_never_chooses_the_stored_name(tmp_path):
    work = _work(tmp_path)
    media_id = store_media(work, JPEG_BYTES, "../../etc/passwd.jpg")
    assert "/" not in media_id and ".." not in media_id
    assert (work / "media" / media_id).is_file()
    assert not (tmp_path.parent / "etc").exists()


def test_the_extension_comes_from_the_content_not_the_name(tmp_path):
    work = _work(tmp_path)
    media_id = store_media(work, JPEG_BYTES, "payload.html")
    assert media_id.endswith(".jpg")


def test_html_disguised_as_an_image_is_refused(tmp_path):
    with pytest.raises(MediaError, match="not an allowed"):
        store_media(_work(tmp_path), b"<!doctype html><script>x()</script>", "photo.jpg")


def test_identical_content_yields_one_id_and_one_file(tmp_path):
    work = _work(tmp_path)
    a = store_media(work, JPEG_BYTES, "one.jpg")
    b = store_media(work, JPEG_BYTES, "two.jpg")
    assert a == b
    assert len(list((work / "media").iterdir())) == 1


def test_different_content_with_the_same_name_does_not_collide(tmp_path):
    work = _work(tmp_path)
    a = store_media(work, JPEG_BYTES, "photo.jpg")
    b = store_media(work, OTHER_JPEG_BYTES, "photo.jpg")
    assert a != b
    assert len(list((work / "media").iterdir())) == 2


def test_an_oversized_file_is_refused(tmp_path): ...
def test_exceeding_the_directory_total_is_refused(tmp_path): ...
def test_each_allowed_type_round_trips(tmp_path): ...     # parametrized
def test_the_id_is_a_readable_slug_plus_a_hash(tmp_path): ...
def test_orphan_ids_lists_media_no_overlay_references(tmp_path): ...
def test_orphan_ids_is_empty_when_everything_is_referenced(tmp_path): ...
```

Build the byte fixtures from real magic numbers — a minimal JPEG starts `\xff\xd8\xff`, a PNG `\x89PNG\r\n\x1a\n`. Do not use `imghdr` (removed in 3.13); sniff the prefixes yourself in a small table, which is also what makes the allowlist readable.

- [ ] **Step 2: Run them and watch them fail**

Run: `cd backend && uv run pytest tests/test_media_store.py -q`
Expected: `ModuleNotFoundError: No module named 'app.media_store'`.

- [ ] **Step 3: Implement**

Create `backend/app/media_store.py`:

```python
"""Every byte that enters a working directory comes through here.

This is the application's second untrusted input, after bundle import, and
unlike import it is a file write driven by a name the client chose. So the
client does not get to choose the name: the stored id is derived from the
content and a slug of the original stem, and the extension comes from
sniffing the bytes rather than from what the upload claimed.

That one decision removes path traversal, overwrite-by-guessing, and
extension smuggling together — a published site serves `tour-data/` from the
author's own origin, so an `.html` that got through here would be served from
it.
"""

from __future__ import annotations

import hashlib
import re
from pathlib import Path

from .models import Tour

# Sniffed prefix -> (canonical type, extension). Sniffing rather than trusting
# the extension is the point; `imghdr` was removed in Python 3.13, and a short
# explicit table is clearer than a dependency anyway.
_MAGIC: list[tuple[bytes, str, str]] = [
    (b"\xff\xd8\xff", "image/jpeg", ".jpg"),
    (b"\x89PNG\r\n\x1a\n", "image/png", ".png"),
    (b"RIFF", "image/webp", ".webp"),          # refined below
    (b"ID3", "audio/mpeg", ".mp3"),
    (b"OggS", "audio/ogg", ".ogg"),
    (b"\x1a\x45\xdf\xa3", "audio/webm", ".webm"),
]

MAX_FILE_BYTES = 64 * 1024 * 1024
MAX_TOTAL_BYTES = 1024 * 1024 * 1024


class MediaError(Exception):
    """An upload was refused. The message is shown to the author."""


def sniff(data: bytes) -> tuple[str, str]:
    """Return (type, extension) or raise. RIFF and ISO-BMFF need a second
    look: both are containers whose real type is a few bytes further in."""
    if data[:4] == b"RIFF" and data[8:12] == b"WEBP":
        return "image/webp", ".webp"
    if data[:4] == b"RIFF" and data[8:12] == b"WAVE":
        return "audio/wav", ".wav"
    if data[4:8] == b"ftyp":
        brand = data[8:12]
        if brand[:3] in (b"M4A", b"mp4", b"iso"):
            return "audio/mp4", ".m4a"
    for prefix, kind, ext in _MAGIC:
        if prefix != b"RIFF" and data.startswith(prefix):
            return kind, ext
    raise MediaError(
        "that file is not an allowed image or audio type "
        "(JPEG, PNG, WebP, MP4/M4A, MP3, WAV, WebM or Ogg)"
    )


def store_media(work: Path, data: bytes, original_name: str) -> str:
    if len(data) > MAX_FILE_BYTES:
        raise MediaError(
            f"that file is {len(data)} bytes; the limit is {MAX_FILE_BYTES}"
        )
    _kind, ext = sniff(data)

    media_dir = work / "media"
    media_dir.mkdir(parents=True, exist_ok=True)

    total = sum(p.stat().st_size for p in media_dir.rglob("*") if p.is_file())
    if total + len(data) > MAX_TOTAL_BYTES:
        raise MediaError(
            "this tour's media would exceed "
            f"{MAX_TOTAL_BYTES} bytes; remove something first"
        )

    digest = hashlib.sha256(data).hexdigest()[:10]
    media_id = f"{_slug(original_name)}-{digest}{ext}"
    path = media_dir / media_id
    # Same content, same id: an author re-uploads the same photograph
    # constantly, and writing it twice would be a lie about two media.
    if not path.exists():
        path.write_bytes(data)
    return media_id


def _slug(name: str) -> str:
    """A readable stem, from the name only. Never a path: the id is joined to
    media/ and must not be able to leave it."""
    stem = Path(name).stem
    slug = re.sub(r"[^a-z0-9]+", "-", stem.lower()).strip("-")
    return slug[:48] or "media"


def orphan_ids(work: Path, tour: Tour) -> list[str]:
    """Media no overlay references. A warning, never a deletion: an author
    mid-edit routinely has media not yet placed."""
    media_dir = work / "media"
    if not media_dir.is_dir():
        return []
    present = {p.name for p in media_dir.rglob("*") if p.is_file()}
    referenced = {o.media_id for s in tour.stops for o in s.overlays if o.media_id}
    return sorted(present - referenced)
```

Then the route in `main.py`, mirroring the import endpoint's shape — spool, guard the temp file's whole lifetime, convert `MediaError` to a **400**, and apply the existing `Sec-Fetch-Site` cross-site rejection. Add `orphanCount` to `Session.summary()`.

- [ ] **Step 4: Verify and commit**

Run: `make backend-test && make lint`. Frontend is untouched and stays green.

```bash
git add backend/app/media_store.py backend/app/main.py backend/app/session.py backend/tests
git commit -m "$(cat <<'EOF'
Add the media upload endpoint

The client does not choose the stored name: the id is a slug plus a
content hash, and the extension comes from sniffing the bytes. That one
decision removes traversal, overwrite-by-guessing and extension
smuggling together, which matters because a published site serves
tour-data/ from the author's own origin.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 2: Uploading from the editor, and overlays that carry media

**Files:** `frontend/src/app/core/session-api.ts` (an `uploadMedia` method), `frontend/src/app/editor/document-ops.ts` (`addMediaOverlay`, relax `legalKindsFor`), the outline and inspector panes, plus specs.

- Add image / add audio stop being disabled: choosing a file uploads it and creates the overlay with the returned `mediaId`, anchored at its stop, with an `original` credit from the tour's `defaults`.
- **Implement 3a's unmet invariant**: when the tour has no `defaults`, ask once for a creator and licence and write them to the tour, rather than silently falling back to `Unknown` / `All rights reserved`.
- A refused upload leaves the document untouched and shows the backend's message.
- Kind changes still route through `setOverlayKind`, never `updateOverlay`.

- [ ] Write the failing tests, run, implement, run, commit.

---

### Task 3: Recording audio

**Files:** `frontend/src/app/editor/recorder.ts` + spec, a control in the inspector or outline, `frontend/src/app/core/tour-api.ts` (`audioType` gains WebM and Ogg).

- `MediaRecorder` to a Blob, uploaded through Task 2's path on stop.
- **Both degradation paths must be real:** `MediaRecorder` undefined, and `getUserMedia` rejecting. Each shows a clear message; neither leaves a dead button. These are the only parts of recording that can be tested here, so they carry the task.
- Put the format reality in the UI, not only the docs: a tour recorded in Chromium carries WebM, which Safari cannot play.

- [ ] Write the failing tests, run, implement, run, commit.

---

### Task 4: The acquisition tools

**Files:** `backend/app/tools.py`, `backend/tests/test_tools.py`, routes in `main.py`.

Four endpoints. Lift the query logic from the existing scripts rather than
reinventing it — `probe_coverage.py` and `fetch_rephotos.py` already encode
which queries return usable results.

| Endpoint | Reaches | Returns |
| --- | --- | --- |
| `POST /api/tools/panoramas` | `graph.mapillary.com` | candidates with **`imageId`, `lng`, `lat`**, captured-at, thumb URL |
| `POST /api/tools/places` | `overpass-api.de` + mirrors | name, `osmRef`, centre point |
| `POST /api/tools/archive-search` | `www.loc.gov` | title, date, thumbnail, full-image URL, rights |
| `POST /api/tools/narrate` | nothing — local `say` | stores the audio via `store_media` and returns the `mediaId` |

Every one: an explicit timeout; upstream failure surfaced as a useful message
and a 4xx/502 rather than a 500; `httpx`, never `urllib`.

**The panorama tool must return each candidate's real position.** The editor's
heading gate is keyed to it, and 3a proved that using the stop's location
instead gives a 178-degree error on the real tour.

Tests use `httpx.MockTransport` with captured shapes. Narration is local and
is tested for real — `say -v Samantha -o …` works in this sandbox.

- [ ] Write the failing tests, run, implement, run, commit.

---

### Task 5: The tools in the editor

**Files:** the inspector/outline panes, a panorama picker, specs.

- **Stop editing**: the stop's `location` becomes editable, and a panorama
  picker searches near it and sets `panorama.imageId`. Selecting a candidate
  must also publish its position so `panoramaFixForStop` opens — this is what
  finally makes a newly added stop usable.
- Archive search inserts a found photograph by uploading it with a `sourced`
  credit built from the result's rights metadata.
- Narrate turns a stop's or overlay's text into an audio overlay.
- Every tool failure shows its message; none leaves the document half-changed.

- [ ] Write the failing tests, run, implement, run, commit.

---

### Task 6: Verify live, retire the pipeline, record the decisions

- [ ] **Step 1: The one authorised live run**

Against the real services, **per command**, not via settings:

```
allowed_domains: ["graph.mapillary.com"]        # panoramas, near Old Town Fairfax
allowed_domains: ["overpass-api.de"]            # places
allowed_domains: ["www.loc.gov"]                # archive search
```

Confirm each captured shape matches reality and the parsers hold. **Record the
actual responses' shape in the report.** If a shape has drifted, fix the parser
and the mock together — the mock is only worth anything if it matches.

This is the only evidence that any of this works against the real world. Do
not skip it, and do not quietly substitute a mocked run.

- [ ] **Step 2: Retire the pipeline — only after the author confirms**

`content/source/stops.json`, the `make content` target, and `build_tour.py`'s
document generation go. `content/media/` and `content/tours/` stay.

This closes HANDOFF outstanding item 2: once the document is the only source,
the `de48b0d` drift has nothing to drift from. **It is the point of no return
for the old workflow, so stop and ask before doing it.** If the answer has not
arrived, leave the pipeline and its warning in place and say so.

- [ ] **Step 3: `docs/decisions/0004-…`, and the sweep**

Cover: why the client never names an uploaded file; why recording keeps the
browser's native format and what that costs across browsers; why the scripts
became tools rather than being rewritten; why the panorama tool returns
positions; and what the live verification actually showed.

Sweep `README.md`, `docs/HANDOFF.md`, `docs/ENVIRONMENT.md` for the retired
pipeline and stale counts. Update HANDOFF items 1 and 2 to their true state.

- [ ] **Step 4: Verify and commit.** `make check` green.
