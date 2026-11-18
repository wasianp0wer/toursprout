# Publish-time mark Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A published site knows it is published, so it never probes `/api`;
the authoring host awaits `/api/session` without a 2-second race.

**Architecture:** `publish.py` injects one attribute, `data-published`, into
the `<html>` element of the `index.html` it copies into the zip — the on-disk
`dist/index.html` is untouched, so the authoring host is unmarked. `EntryPage`
reads `document.documentElement.dataset` synchronously at boot: marked → reveal
the viewer at once, no probe; unmarked → await `/api/session` and route on the
answer, with a generous fallback to the viewer only so an unpublished bundle on
a dead host degrades rather than hangs.

**Tech Stack:** FastAPI/pydantic backend, Angular 22 frontend, pytest, Vitest.

**Spec:** this reverses the "one byte-identical bundle, probe once" decision in
`docs/ARCHITECTURE.md` *Routing: who is asking*. The author approved the
reversal on 2026-11-17 with the trade stated: a hand-copied, unpublished
`dist/` on a static host waits up to the fallback before showing the tour.
Why: the deployed authoring host (Reclaim, behind Cloudflare and a proxy)
answers `/api/session` in 12–73 s measured, so a 2 s probe always timed out and
the host was unusable for authoring. A cold CGI request of this app takes 0.2 s
locally; the latency is the host's.

## Global Constraints

- **The viewer never calls `/api`.** Unchanged, and still pinned by
  `tour-api.spec.ts` *"reads everything from tour-data/ and never touches
  /api"*. On a marked page, `EntryPage` must not call `/api` either.
- **`publish.py` gains a text substitution, not document knowledge.** It
  still imports only `zipfile` and `Path` plus what the substitution needs;
  it must not parse `tour.json`.
- **The on-disk `dist/index.html` is never modified.** The mark exists only
  inside the zip. `_SpaFiles` keeps serving the unmarked file to the host.
- **The contract between the two tasks is exactly:** attribute name
  `data-published`, present with no value, on the `<html>` element. Presence
  is the signal (`'published' in document.documentElement.dataset`).
- **Fallback for the unmarked path:** `AUTHORING_HOST_FALLBACK_MS = 30_000`,
  after which the viewer is revealed. A refused connection or a 200-of-HTML
  still reveals the viewer immediately, as today — only the *deadline* goes.
- **`make check` green at the end of every task.** Commits end with
  `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`.

## Review Focus

1. A marked page must make **zero** `/api` requests — not a fast one, none.
   → Task 2 asserts no request was issued at all.
2. An unmarked page whose backend answers in, say, 5 s (past the old 2 s)
   must still reach `/edit`. → Task 2.
3. The substitution must be anchored to the `<html` tag and applied once; a
   bundle whose `index.html` already carries the mark must not get it twice.
   → Task 1.
4. The on-disk `dist/index.html` must be byte-identical before and after a
   publish. → Task 1.
5. `publish.py` must still refuse when `dist/index.html` is missing, in the
   existing words. → Task 1 (existing test keeps passing).

---

### Task 1: `publish.py` marks the zip's `index.html`

**Files:**
- Modify: `backend/app/publish.py`
- Test: `backend/tests/test_publish.py`

**Interfaces:**
- Consumes: nothing.
- Produces: the zip's `index.html` has `data-published` on its `<html>` tag.
  Expose the substitution as `mark_published(html: str) -> str`, pure, so the
  test can pin idempotence without building a zip.

- [ ] **Step 1: Write the failing tests** in `backend/tests/test_publish.py`

```python
def test_the_published_index_is_marked_and_the_built_one_is_not(ready):
    """The mark is how a published page knows not to probe /api. It lives
    only in the zip: the on-disk dist/index.html serves the authoring host,
    which must stay unmarked so it awaits the backend."""
    before = (ready.dist / "index.html").read_bytes()
    build_site(ready.session, ready.dist, ready.out)
    with zipfile.ZipFile(ready.out) as z:
        html = z.read("index.html").decode()
    assert re.search(r"<html[^>]*\bdata-published\b", html)
    assert (ready.dist / "index.html").read_bytes() == before

def test_mark_published_is_anchored_and_idempotent():
    assert mark_published('<html lang="en">x') == '<html lang="en" data-published>x'
    once = mark_published('<html lang="en">x')
    assert mark_published(once) == once
    assert mark_published("<p>no html tag</p>") == "<p>no html tag</p>"
```

Adapt to the `ready` fixture's actual attribute names — read the fixture
first.

- [ ] **Step 2: Run them to verify they fail**

Run: `cd backend && uv run pytest tests/test_publish.py -q`
Expected: FAIL — `mark_published` not defined; no `data-published` in the zip.

- [ ] **Step 3: Implement `mark_published(html: str) -> str` and use it in `build_site`**

In the `dist` loop, when `path.name == "index.html"` at the dist root, write
`mark_published(text)` via `zf.writestr` instead of `zf.write`. A single
regex on the first `<html` tag; no-op if already marked or if no tag.

- [ ] **Step 4: Verify**

Run: `cd backend && uv run ruff check app tests ../content/scripts && uv run pytest -q`
Expected: PASS, ruff clean.

- [ ] **Step 5: Commit**

```bash
git add backend/app/publish.py backend/tests/test_publish.py
git commit -m "Mark a published index.html so it never probes /api"
```

---

### Task 2: `EntryPage` reads the mark; the host awaits

**Files:**
- Modify: `frontend/src/app/entry/entry-page.ts`
- Test: `frontend/src/app/entry/entry-page.spec.ts`

**Interfaces:**
- Consumes: the contract above.
- Produces: `AUTHORING_HOST_FALLBACK_MS = 30_000` replaces
  `SESSION_PROBE_TIMEOUT_MS`; `isPublishedPage(doc: Document): boolean`
  exported for the test.

- [ ] **Step 1: Write the failing tests** in `entry-page.spec.ts`

```ts
it('reveals the viewer at once on a published page and never calls /api', () => {
  document.documentElement.setAttribute('data-published', '');
  mount();
  expect(decision()).toBe('published');
  httpTesting.expectNone(/\/api/);          // none — not a fast one
});
it('awaits a slow backend on the authoring host instead of giving up', async () => {
  // unmarked; answer after 5 s of fake time, past the old 2 s deadline
  mount(); vi.advanceTimersByTime(5_000); flush({ open: true });
  expect(navigatedTo).toBe('/edit');
});
it('still treats a refused connection or a 200 of HTML as no backend', …);
it('falls back to the viewer only after AUTHORING_HOST_FALLBACK_MS', …);
```

Rename or replace `treats a probe timeout as no backend` — its premise is gone.
Clear the `data-published` attribute in `afterEach`; jsdom's document persists
between tests.

- [ ] **Step 2: Run to verify they fail**

Run: `cd frontend && npx ng test --watch=false`
Expected: FAIL — `/api` still requested on a marked page; a 5 s answer still
reveals the viewer.

- [ ] **Step 3: Implement**

`isPublishedPage(doc)` → `'published' in doc.documentElement.dataset`. In the
constructor: if published, `decision.set('published')` and return without
probing. Otherwise `probe()` as today but with `AUTHORING_HOST_FALLBACK_MS`.
Keep the `gone` guard and the lazy-chunk fallback exactly as they are.

- [ ] **Step 4: Verify**

Run: `make check`
Expected: `All checks passed!`.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/app/entry
git commit -m "Trust the publish-time mark; await the backend on the host"
```

---

### Task 3: Write it down

**Files:**
- Modify: `docs/ARCHITECTURE.md` (*Routing: who is asking*), `docs/UNVERIFIED.md`
  (20–22 superseded, say why; add the hand-copy trade as a new check),
  `docs/CHANGING-THINGS.md` entry 7, `docs/HANDOFF.md`, and a short ADR
  `docs/decisions/0010-a-published-page-knows-it-is-published.md` indexed in
  `docs/decisions/README.md`.

- [ ] Record the reversal and the reason (the measured host latency), the
  contract, the trade, and that the viewer still never calls `/api`.
- [ ] `make check`; commit `Say that a published page knows it is published`.
