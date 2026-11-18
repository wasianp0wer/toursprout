# Task 1 report: publish.py marks the zip's index.html

## Implemented
- `mark_published(html: str) -> str` in `backend/app/publish.py`: pure; regex `<html\b([^>]*)>` (case-insensitive) on the first `<html` tag; inserts ` data-published` after the existing attributes; no-op if that tag already has the attribute or no tag exists.
- `build_site` writes the dist-root `index.html` via `zf.writestr(mark_published(text))`; everything else still `zf.write`. Nested `index.html` files are untouched. On-disk dist is never written.
- No `tour.json` parsing; only `re` added.

## TDD
- RED: `cd backend && uv run pytest tests/test_publish.py -q` -> collection error `ImportError: cannot import name 'mark_published' from 'app.publish'`.
- First implementation had an offset bug (group offsets are absolute; inserted after the tag). The attribute-bearing test caught it (`-container><head> data-published`); fixed.
- GREEN: `uv run ruff check app tests ../content/scripts && uv run pytest -q` -> `All checks passed!`, `718 passed, 2 warnings`.

## Tests added (test_publish.py)
zip index marked and on-disk bytes identical; only root index marked; bare + idempotent + no-tag; attribute-bearing (`data-beasties-container`), bare `<html>`, second `<html>` untouched.
Fixture used as a tuple, `session, dist, out = ready`.

## Files
backend/app/publish.py, backend/tests/test_publish.py. Frontend and content/ untouched.

## Self-review
Ruff import-sort needed one `--fix` (blank lines) - clean now. Known limits: a literal `>` inside an `<html>` attribute value would mis-anchor (not realistic for Angular output); `<html .../>` self-closing form not handled specially.

## Concerns
None.
