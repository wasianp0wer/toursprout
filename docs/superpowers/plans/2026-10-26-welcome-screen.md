# Welcome Screen Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Opening the app with nothing in the session presents a front door — create, import, or open an example — instead of a failure message, and a tour can be closed to get back to it.

**Architecture:** `''` becomes a small eager entry component that probes `GET /api/session` and resolves three ways: navigate to `/edit`, render a lazy welcome screen, or reveal the viewer it already mounted. Both new ingestion paths (examples, loose files) stage a bundle server-side and hand it to the existing `read_bundle`, so there is exactly one import allowlist, one staging-and-swap, one set of warnings.

**Tech Stack:** FastAPI + pydantic (backend, pytest), Angular 22 standalone components with signals (frontend, Vitest + jsdom).

**Spec:** [`docs/superpowers/specs/2026-10-26-welcome-screen-design.md`](../specs/2026-10-26-welcome-screen-design.md)

## Global Constraints

- **Node 24 only**, at `/Users/maddiepersonal/.local/share/fnm/node-versions/v24.21.0/installation/bin`. The Makefile pins it; ambient `node` is v25 and Angular 22 rejects it.
- **Angular's build cache stays disabled** or `ng build` SIGABRTs with no output.
- **`UV_CACHE_DIR`** must point inside the repo or every `uv` command fails.
- **Never `urllib`** — `httpx` everywhere. (No new network code here, but the rule holds.)
- **TDD, no exceptions:** failing test first, watch it fail, then implement.
- **Media ingestion uses `bundle._check_media_file`, never `media_store.store_media`.** `store_media` renames to `<slug>-<contenthash><ext>` and flattens directories, which would break all nine Fairfax media ids and `media/pano/`.
- **Every new mutating route takes `dependencies=[Depends(_reject_cross_site)]`.**
- **Commits:** let git use its own config. Never pass `-c user.email=...`.
- **No browser runs in this sandbox.** Verification is pytest + Vitest/jsdom. Every new surface gets a `docs/UNVERIFIED.md` entry (Task 8).
- Acceptance figures for the Fairfax example, observed and recorded in `HANDOFF.md`: `stopCount` 6, `mediaCount` 15, `orphanCount` 6.

## Review Focus

Five failure modes the spec implies but which no task's happy path exercises. Each line's test is added to the task named.

1. **A `.zip` that is not a tour bundle** (a random archive, or a bundle whose `tour.json` fails validation). The author must get the backend's own message and the open tour must be exactly as it was. → Task 3.
2. **`manifest.json` among dropped files.** This is the landmine the whole feature exists to remove: it must be skipped with a notice naming it, never a refusal that rejects the whole drop. → Task 6.
3. **Closing while autosave has a PUT in flight.** The PUT lands on a dead session and 409s; "Save failed" must not appear after a successful close. → Task 7.
4. **`GET /api/session` answering 200 with HTML**, which is what a static host with SPA rewriting does. Must be treated as "no backend" (published site), not crash or show a welcome screen to the public. → Task 5.
5. **Opening an example, or creating a new tour, while one is already open.** The backend 409s; the author must see a readable message and the working directory must be untouched. → Task 2 (backend), Task 6 (message).

---

### Task 1: Closing a session

**Files:**
- Modify: `backend/app/session.py` (`Session.new`, add `Session.close`)
- Modify: `backend/app/main.py` (new route beside `get_session`)
- Test: `backend/tests/test_session.py`, `backend/tests/test_session_api.py`

**Interfaces:**
- Consumes: `Session`, `SessionConflict` from `backend/app/session.py`.
- Produces: `Session.close() -> None`, raising `SessionConflict` when nothing is open. Route `DELETE /api/session` returning `{"open": false}`.

- [ ] **Step 1: Write the failing tests**

```python
# test_session.py
def test_close_removes_the_working_directory(tmp_path):
    session = Session(tmp_path / "work")
    session.new("A tour")
    session.close()
    assert not session.is_open
    assert session.summary() == {"open": False}

def test_close_refuses_when_nothing_is_open(tmp_path):
    with pytest.raises(SessionConflict):
        Session(tmp_path / "work").close()

# test_session_api.py
def test_delete_session_closes_the_open_tour(client):
    client.post("/api/session/new", json={"title": "A tour"})
    res = client.delete("/api/session")
    assert res.status_code == 200
    assert res.json() == {"open": False}
    assert client.get("/api/session").json() == {"open": False}

def test_delete_session_409s_when_nothing_is_open(client):
    assert client.delete("/api/session").status_code == 409

def test_delete_session_refuses_cross_site(client):
    res = client.delete("/api/session", headers={"Sec-Fetch-Site": "cross-site"})
    assert res.status_code == 403
```

- [ ] **Step 2: Run them to verify they fail**

Run: `cd backend && uv run pytest tests/test_session.py tests/test_session_api.py -k close_or_delete -v` (adjust `-k` to the names above)
Expected: FAIL — `Session` has no attribute `close`.

- [ ] **Step 3: Implement `Session.close`**

Extract the `if self.path.exists(): shutil.rmtree(self.path)` that `new()` already performs into a private `_discard(self) -> None`, and have both `new()` and `close()` call it — the spec requires one implementation of removal, not two. `close()` raises `SessionConflict` with a message in the voice of the existing one (`"nothing is open"`) before discarding.

- [ ] **Step 4: Implement the route**

`DELETE /api/session` in `create_app`, with `dependencies=[Depends(_reject_cross_site)]`. Map `SessionConflict` to `HTTPException(409, str(exc))`, matching how `new_session` already does it. Return `session.summary()`.

- [ ] **Step 5: Run the full backend suite**

Run: `cd backend && uv run pytest -q`
Expected: PASS, 320 + 5 tests.

- [ ] **Step 6: Commit**

```bash
git add backend/app/session.py backend/app/main.py backend/tests/test_session.py backend/tests/test_session_api.py
git commit -m "Let a session be closed on purpose"
```

---

### Task 2: Examples, and the frozen Fairfax example

**Files:**
- Create: `backend/app/examples.py`
- Create: `content/examples/fairfax-old-town/example.json`
- Create: `content/examples/fairfax-old-town/tour.json` (frozen copy of `content/tours/fairfax-old-town.json`)
- Modify: `backend/app/bundle.py` (rename `_MEDIA_EXTENSIONS` → `MEDIA_EXTENSIONS`, update its two uses)
- Modify: `backend/app/main.py` (two routes)
- Test: `backend/tests/test_examples.py`

**Fixtures — there is no `conftest.py` in this repo.** Each test file defines its own `client` fixture; copy `test_session_api.py`'s, which builds `Settings(content_dir=tmp_path, frontend_dist=tmp_path / "nodist", mapillary_token="test-token")`. That means `content_dir` is a temp directory with **no `content/examples/` in it**, so:
- Generic behaviour (listing, unknown id, traversal, conflict, manifest filtering) is tested against a **synthetic** example written into `tmp_path` by a fixture. Fast and hermetic.
- The Fairfax acceptance figures are tested in **one** test whose `content_dir` is the repository's real `content/` directory, resolved as `Path(__file__).resolve().parents[2] / "content"`. `test_content.py` already reads real repo content this way, so this is an established pattern, not a new one. That test opens into a `tmp_path` working directory — never the repo's `content/work/`.

**Interfaces:**
- Consumes: `Session.replace_from(zip_path) -> list[str]`, `BundleError`, `MEDIA_EXTENSIONS` from `bundle.py`; `Settings.content_dir`.
- Produces:
  - `class ExampleError(Exception)`
  - `@dataclass(frozen=True) class Example: id: str; title: str; description: str`
  - `list_examples(cfg: Settings) -> list[Example]` — sorted by `id`; returns `[]` when `content/examples/` is absent.
  - `open_example(session: Session, cfg: Settings, example_id: str) -> list[str]` — returns `read_bundle`'s warnings. Raises `KeyError` for an unknown id, `ExampleError` for a malformed example.
  - Routes `GET /api/session/examples` → `{"examples": [{"id","title","description"}]}`; `POST /api/session/examples/{example_id}` → `{**summary, "warnings": [...]}`.

**Why it is built this way:** `open_example` stages a bundle in a temp directory and calls `session.replace_from`, so validation, the media allowlist, atomic staging-and-swap, the bundle-version check and the warning list are all the existing `read_bundle` and are not reimplemented.

- [ ] **Step 1: Create the frozen example content**

```bash
mkdir -p content/examples/fairfax-old-town
cp content/tours/fairfax-old-town.json content/examples/fairfax-old-town/tour.json
```

`example.json`:

```json
{
  "id": "fairfax-old-town",
  "title": "Old Town Fairfax",
  "description": "Six stops through Old Town Fairfax, Virginia, with two Library of Congress photographs draped at the courthouse.",
  "document": "tour.json",
  "mediaDir": "../../media"
}
```

`document` and `mediaDir` are relative to the example's own directory and must resolve inside `cfg.content_dir`; `open_example` raises `ExampleError` if either escapes it.

**Decision taken here, not in the spec:** the *document* is frozen (it is the file `make content` rewrites and the thing that drifts per `HANDOFF.md` item 2), while `mediaDir` points at the shared `content/media/`. Freezing the media too would duplicate 4.4 MB of JPEG and M4A in git for no drift protection, since the pipeline regenerates those files byte-stably under the same names. Nothing in `make content` writes to `content/examples/`, so the document is structurally safe without a Makefile change.

- [ ] **Step 2: Write the failing tests**

```python
def test_lists_the_fairfax_example(cfg):
    ids = [e.id for e in list_examples(cfg)]
    assert "fairfax-old-town" in ids

def test_lists_nothing_when_there_are_no_examples(tmp_path):
    assert list_examples(Settings(content_dir=tmp_path)) == []

def test_opening_the_example_matches_the_recorded_figures(session, cfg):
    open_example(session, cfg, "fairfax-old-town")
    summary = session.summary()
    assert summary["stopCount"] == 6
    assert summary["mediaCount"] == 15
    assert summary["orphanCount"] == 6

def test_opening_the_example_preserves_names_and_nested_paths(session, cfg):
    open_example(session, cfg, "fairfax-old-town")
    media = session.path / "media"
    assert (media / "court-1863.jpg").is_file()
    assert (media / "narration-historic-courthouse.m4a").is_file()
    assert (media / "pano" / "pano-historic-courthouse.jpg").is_file()

def test_opening_the_example_excludes_the_media_manifest(session, cfg):
    open_example(session, cfg, "fairfax-old-town")
    assert not (session.path / "media" / "manifest.json").exists()

def test_opening_the_example_warns_about_unreferenced_panoramas(session, cfg):
    warnings = open_example(session, cfg, "fairfax-old-town")
    assert len(warnings) == 6
    assert all("is not referenced by any overlay" in w for w in warnings)

def test_unknown_example_raises(session, cfg):
    with pytest.raises(KeyError):
        open_example(session, cfg, "no-such-example")

@pytest.mark.parametrize("bad", ["../../../etc", "..", "a/b", ""])
def test_example_id_cannot_escape_the_examples_directory(session, cfg, bad):
    with pytest.raises((KeyError, ExampleError)):
        open_example(session, cfg, bad)

def test_opening_the_example_leaves_the_source_media_untouched(session, cfg):
    before = sorted(p.name for p in (cfg.content_dir / "media").iterdir())
    open_example(session, cfg, "fairfax-old-town")
    assert sorted(p.name for p in (cfg.content_dir / "media").iterdir()) == before
```

Route tests in the same file, using the existing `client` fixture:

```python
def test_get_examples_route(client):
    body = client.get("/api/session/examples").json()
    assert any(e["id"] == "fairfax-old-town" for e in body["examples"])
    assert all({"id", "title", "description"} <= e.keys() for e in body["examples"])

def test_post_example_opens_it(client):
    res = client.post("/api/session/examples/fairfax-old-town")
    assert res.status_code == 200
    body = res.json()
    assert body["stopCount"] == 6 and body["mediaCount"] == 15
    assert len(body["warnings"]) == 6

def test_post_example_409s_when_a_tour_is_already_open(client):
    client.post("/api/session/new", json={"title": "A tour"})
    res = client.post("/api/session/examples/fairfax-old-town")
    assert res.status_code == 409
    assert client.get("/api/session").json()["title"] == "A tour"

def test_post_unknown_example_404s(client):
    assert client.post("/api/session/examples/nope").status_code == 404

def test_post_example_refuses_cross_site(client):
    res = client.post("/api/session/examples/fairfax-old-town",
                      headers={"Sec-Fetch-Site": "cross-site"})
    assert res.status_code == 403
```

- [ ] **Step 3: Run them to verify they fail**

Run: `cd backend && uv run pytest tests/test_examples.py -v`
Expected: FAIL — no module `examples`.

- [ ] **Step 4: Rename `_MEDIA_EXTENSIONS` to `MEDIA_EXTENSIONS` in `bundle.py`**

Keep its comment. Update its two references in that file. Nothing else reads it yet.

- [ ] **Step 5: Implement `backend/app/examples.py`**

`list_examples` reads each `content/examples/*/example.json`, skipping a directory with no manifest. `open_example`:

1. resolve the example directory from `example_id`; reject an id that is not a single path component, or whose directory is missing, before touching the filesystem further;
2. in a `tempfile.TemporaryDirectory`, build a bundle root: copy `document` to `tour.json`, write `bundle.json` as `{"bundleVersion": BUNDLE_VERSION, "tourId": <the document's own "id">}`, and copy `mediaDir`'s tree to `media/` **keeping relative paths**, copying only files whose `suffix.lower()` is in `MEDIA_EXTENSIONS` — this is the filter that drops `manifest.json` rather than letting `read_bundle` refuse it;
3. zip that root and call `session.replace_from(zip_path)`, returning its warnings.

Let `SessionConflict`, `BundleError` and `ExampleError` propagate; the route maps them.

- [ ] **Step 6: Implement the two routes**

In `create_app`. `GET /api/session/examples` is read-only and takes no guard. `POST /api/session/examples/{example_id}` takes `dependencies=[Depends(_reject_cross_site)]`, refuses with 409 when `session.is_open` (message in the voice of `Session.new`'s conflict: export first, or close the tour), maps `KeyError` → 404, `ExampleError`/`BundleError` → 400, then calls `session.write_config(_viewer_config(app.state.cfg))` exactly as `import_bundle` does and returns `{**session.summary(), "warnings": warnings}`.

- [ ] **Step 7: Run the suite**

Run: `cd backend && uv run pytest -q`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add backend/app/examples.py backend/app/bundle.py backend/app/main.py backend/tests/test_examples.py content/examples
git commit -m "Open an example tour in one request"
```

---

### Task 3: Loose-file import

**Files:**
- Modify: `backend/app/main.py` (one route)
- Create: `backend/app/loose_import.py`
- Test: `backend/tests/test_loose_import.py`

**Interfaces:**
- Consumes: `MEDIA_EXTENSIONS`, `BundleError`, `Session.replace_from`.
- Produces: `stage_loose_bundle(parts: list[tuple[str, BinaryIO]], dest_zip: Path) -> None` in `loose_import.py`, where each part is `(relative_path, stream)`. Raises `BundleError` for a path that is unsafe or for a missing `tour.json`. Route `POST /api/session/import-files` → `{**summary, "warnings": [...]}`, same shape as `/api/session/import`.

**Why a separate route rather than zipping in the browser:** it keeps one allowlist and one warning list on the server and keeps a zip writer out of the eager frontend bundle.

- [ ] **Step 1: Write the failing tests**

```python
def test_imports_a_document_with_flat_media(client, jpeg_bytes):
    res = client.post("/api/session/import-files", files=[
        ("files", ("tour.json", minimal_tour_json(), "application/json")),
        ("files", ("media/photo.jpg", jpeg_bytes, "image/jpeg")),
    ])
    assert res.status_code == 200
    assert res.json()["mediaCount"] == 1

def test_preserves_nested_media_paths(client, jpeg_bytes):
    client.post("/api/session/import-files", files=[
        ("files", ("tour.json", minimal_tour_json(), "application/json")),
        ("files", ("media/pano/p.jpg", jpeg_bytes, "image/jpeg")),
    ])
    assert (work_dir() / "media" / "pano" / "p.jpg").is_file()

def test_refuses_a_drop_with_no_tour_json(client, jpeg_bytes):
    res = client.post("/api/session/import-files", files=[
        ("files", ("media/photo.jpg", jpeg_bytes, "image/jpeg")),
    ])
    assert res.status_code == 400
    assert "tour.json" in res.json()["detail"]

@pytest.mark.parametrize("bad", ["../escape.jpg", "/abs.jpg", "media/../../x.jpg",
                                 "media/./x.jpg", "notmedia/x.jpg"])
def test_refuses_unsafe_or_unexpected_paths(client, jpeg_bytes, bad):
    res = client.post("/api/session/import-files", files=[
        ("files", ("tour.json", minimal_tour_json(), "application/json")),
        ("files", (bad, jpeg_bytes, "image/jpeg")),
    ])
    assert res.status_code == 400

def test_refuses_a_disallowed_media_type(client):
    res = client.post("/api/session/import-files", files=[
        ("files", ("tour.json", minimal_tour_json(), "application/json")),
        ("files", ("media/evil.html", b"<h1>hi</h1>", "text/html")),
    ])
    assert res.status_code == 400

def test_refuses_cross_site(client):
    res = client.post("/api/session/import-files",
                      files=[("files", ("tour.json", minimal_tour_json(), "application/json"))],
                      headers={"Sec-Fetch-Site": "cross-site"})
    assert res.status_code == 403
```

**Review Focus item 1** — a bad archive leaves the open tour alone. Add to this task, against the existing zip route since that is where a `.zip` arrives:

```python
def test_a_non_bundle_zip_is_refused_and_leaves_the_open_tour(client, tmp_path):
    client.post("/api/session/new", json={"title": "Keep me"})
    junk = tmp_path / "junk.zip"
    with zipfile.ZipFile(junk, "w") as zf:
        zf.writestr("readme.txt", "not a tour")
    with junk.open("rb") as fh:
        res = client.post("/api/session/import", files={"file": ("junk.zip", fh, "application/zip")})
    assert res.status_code == 400
    assert client.get("/api/session").json()["title"] == "Keep me"
```

- [ ] **Step 2: Run them to verify they fail**

Run: `cd backend && uv run pytest tests/test_loose_import.py -v`
Expected: FAIL — 404 on the route; the non-bundle-zip test may already pass, which is fine and worth knowing.

- [ ] **Step 3: Implement `stage_loose_bundle`**

For each part: reject a path that is absolute, contains `..` or `.` as a component, or whose first component is neither `tour.json` (single component) nor `media`. Stream each into the matching location under a staging root with `shutil.copyfileobj`, never materialising a file in memory. Require a `tour.json`. Write `bundle.json` with `BUNDLE_VERSION` and the document's own `id`. Zip the root to `dest_zip`.

- [ ] **Step 4: Implement the route**

Mirror `import_bundle`'s temp-file discipline exactly, including the `mkstemp`-plus-`try` lifetime guard and the `finally: staged.unlink(missing_ok=True)`. `files: list[UploadFile]`; each part's `filename` is its path relative to the bundle root. Map `BundleError` → 400. Call `session.write_config(_viewer_config(app.state.cfg))` on success and return `{**session.summary(), "warnings": warnings}`.

- [ ] **Step 5: Run the suite**

Run: `cd backend && uv run pytest -q`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add backend/app/loose_import.py backend/app/main.py backend/tests/test_loose_import.py
git commit -m "Import a tour from loose files, not only a zip"
```

---

### Task 4: Session API client

**Files:**
- Modify: `frontend/src/app/core/session-api.ts`
- Test: `frontend/src/app/core/session-api.spec.ts`

**Interfaces:**
- Produces, on `SessionApi`:
  - `close(): Promise<SessionSummary>` → `DELETE /api/session`
  - `listExamples(): Promise<ExampleSummary[]>` → `GET /api/session/examples`, returning `body.examples`
  - `openExample(id: string): Promise<ImportResult>` → `POST /api/session/examples/{id}`
  - `importBundle(file: File): Promise<ImportResult>` → `POST /api/session/import`, form field `file`
  - `importFiles(parts: LoosePart[]): Promise<ImportResult>` → `POST /api/session/import-files`, each appended as form field `files` with the part's `path` as the filename
  - `exportBundle(): Promise<Blob>` → `GET /api/session/export` with `responseType: 'blob'`
- Also produces the types `ExampleSummary { id: string; title: string; description: string }`, `LoosePart { path: string; file: File }`, `ImportResult extends SessionSummary { warnings?: string[] }`, and adds `orphanCount?: number` to `SessionSummary`.
- Every rejection carries a human message, via the existing `uploadMessage(err)` helper — rename it to `sessionMessage` since it now serves more than uploads, and keep its behaviour.

- [ ] **Step 1: Write the failing tests**

One test per method asserting the method, URL and request body, plus:

```ts
it('surfaces the backend detail when opening an example conflicts', async () => {
  const p = api.openExample('fairfax-old-town');
  http.expectOne('/api/session/examples/fairfax-old-town')
      .flush({ detail: 'a tour is already open' }, { status: 409, statusText: 'Conflict' });
  await expect(p).rejects.toThrow('a tour is already open');
});

it('sends each loose part under its relative path', () => {
  api.importFiles([{ path: 'media/pano/p.jpg', file: new File([''], 'p.jpg') }]);
  const body = http.expectOne('/api/session/import-files').request.body as FormData;
  expect((body.getAll('files')[0] as File).name).toBe('media/pano/p.jpg');
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `cd frontend && npx vitest run src/app/core/session-api.spec.ts`
Expected: FAIL — methods are not functions.

- [ ] **Step 3: Implement the methods**

- [ ] **Step 4: Run to verify they pass**

Run: `cd frontend && npx vitest run src/app/core/session-api.spec.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/app/core/session-api.ts frontend/src/app/core/session-api.spec.ts
git commit -m "Teach the session client to close, import and list examples"
```

---

### Task 5: The entry page and routing

**Files:**
- Create: `frontend/src/app/entry/entry-page.ts`, `entry-page.html`, `entry-page.css`
- Create: `frontend/src/app/entry/entry-page.spec.ts`
- Modify: `frontend/src/app/app.routes.ts`
- Modify: `frontend/src/app/app.spec.ts`

**Interfaces:**
- Consumes: `SessionApi.get()`; `ViewerPage`; `WelcomePage` (Task 6) by dynamic import.
- Produces: `EntryPage` with `protected readonly decision = signal<'probing' | 'published' | 'welcome'>('probing')`, and `export const SESSION_PROBE_TIMEOUT_MS = 2000`. Task 6 relies only on `WelcomePage` being reachable from here.

**The mechanism, which the tests pin:** `entry-page.html` renders `<app-viewer-page>` inside a wrapper whenever `decision()` is `'probing'` or `'published'`, with the wrapper `hidden` while probing. So the viewer mounts and starts its own `tour-data/` fetches *immediately*, concurrently with the probe, and a published-site visitor pays no extra round trip. When the probe says a tour is open the component navigates to `/edit`; when it says nothing is open the `@if` drops the viewer and `@defer` loads the welcome screen as its own chunk.

- [ ] **Step 1: Write the failing tests**

```ts
it('starts the viewer bootstrap without waiting for the probe', async () => {
  TestBed.createComponent(EntryPage).detectChanges();
  // Both viewer fetches are in flight while /api/session is still pending.
  http.expectOne('tour-data/config.json');
  http.expectOne('tour-data/tour.json');
  http.expectOne('/api/session');
});

it('reveals the viewer when there is no backend', async () => { /* probe .error(); assert wrapper not hidden, no navigation */ });

it('treats a 200 of HTML as no backend', async () => {
  // Review Focus 4: a static host with SPA rewriting answers /api/session with index.html.
  // flush('<!doctype html>', { headers: { 'Content-Type': 'text/html' } }) -> decision() === 'published'
});

it('treats a probe timeout as no backend', async () => {
  // vi.useFakeTimers(); advance past SESSION_PROBE_TIMEOUT_MS without flushing; decision() === 'published'
});

it('navigates to /edit when a tour is open', async () => { /* flush { open: true }; assert Router.navigate called with ['/edit'] */ });

it('shows the welcome screen when nothing is open', async () => { /* flush { open: false }; assert decision() === 'welcome' and the viewer is gone */ });
```

In `app.spec.ts`, replace `routes '' to the viewer` with `routes '' to the entry page` (expect `EntryPage`, then satisfy the three requests above), and add `routes 'view' to the viewer`. Leave the wildcard tests as they are.

- [ ] **Step 2: Run to verify they fail**

Run: `cd frontend && npx vitest run src/app/entry src/app/app.spec.ts`
Expected: FAIL — no `EntryPage`.

- [ ] **Step 3: Implement `EntryPage`**

Probe with `firstValueFrom(this.http.get('/api/session').pipe(timeout(SESSION_PROBE_TIMEOUT_MS)))` via `SessionApi.get()` — add the `timeout` there if that is tidier, but the constant lives in `entry-page.ts`. Any rejection, and any 200 whose body is not an object with a boolean `open`, resolves to `'published'`.

- [ ] **Step 4: Rewrite `app.routes.ts`**

`''` → `EntryPage` (eager), `'view'` → `ViewerPage` (eager, before the wildcard), `'edit'` → lazy as now, `'**'` → `ViewerPage` last. Update the file's header comment: it currently explains why `''` is the eagerly-loaded viewer, and that reasoning now belongs to `EntryPage` mounting the viewer immediately.

- [ ] **Step 5: Run to verify they pass**

Run: `cd frontend && npx vitest run`
Expected: PASS (the welcome `@defer` block can reference `WelcomePage` only once Task 6 exists — if that blocks, land the `@defer` in Task 6 and assert `decision()` here).

- [ ] **Step 6: Commit**

```bash
git add frontend/src/app/entry frontend/src/app/app.routes.ts frontend/src/app/app.spec.ts
git commit -m "Let / decide between the viewer, the editor and a front door"
```

---

### Task 6: The welcome screen

**Files:**
- Create: `frontend/src/app/welcome/welcome-page.ts`, `welcome-page.html`, `welcome-page.css`
- Create: `frontend/src/app/welcome/welcome-page.spec.ts`
- Modify: `frontend/src/app/entry/entry-page.html` (the `@defer` block)

**Interfaces:**
- Consumes: `SessionApi.listExamples/openExample/importBundle/importFiles/newTour`; `Router`.
- Produces: `WelcomePage`. No other task consumes it.

**Layout (spec: left two-thirds, right third):** a drop zone as the largest element, accepting a `.zip` or a loose `tour.json` plus its media folder, with a browse link; below it *New empty tour* (one title field) and one button per example; right, a standing column of guide links — Getting started, Stops and narration, Placing a photograph, Finding panoramas, Publishing your tour — styled as links, inert, under a note that they are not written yet. With no examples configured no example button appears, and the screen must still read correctly.

Test hooks: `[data-drop-zone]`, `[data-browse]`, `[data-new-title]`, `[data-new-tour]`, `[data-example="<id>"]`, `[data-guides]`, `[data-skipped]`, `[data-error]`.

- [ ] **Step 1: Write the failing tests**

```ts
it('offers a button per example and opens one', async () => { /* flush examples; click [data-example="fairfax-old-town"]; expectOne POST; assert navigate(['/edit']) */ });

it('reads correctly with no examples configured', async () => { /* flush { examples: [] }; assert no [data-example], [data-drop-zone] and [data-new-tour] present */ });

it('creates a new tour from a title and goes to the editor', async () => { /* ... */ });

it('sends a dropped .zip to the bundle route', async () => { /* drop a File named tour.zip; expectOne '/api/session/import' */ });

it('sends dropped loose files with their relative paths', async () => {
  // Files carrying webkitRelativePath 'media/pano/p.jpg' reach /api/session/import-files
  // with that path as the part filename.
});

it('skips files that are not image or audio and names them', async () => {
  // Review Focus 2 — the manifest.json landmine, in the UI this time.
  // Drop tour.json + photo.jpg + manifest.json:
  //   the POST carries only tour.json and photo.jpg,
  //   and [data-skipped] names manifest.json.
});

it('shows the backend message when opening an example conflicts', async () => {
  // Review Focus 5: flush 409 { detail: ... }; [data-error] contains it.
});

it('shows the backend message when an import is refused', async () => { /* 400 detail in [data-error] */ });
```

- [ ] **Step 2: Run to verify they fail**

Run: `cd frontend && npx vitest run src/app/welcome`
Expected: FAIL — no `WelcomePage`.

- [ ] **Step 3: Implement `WelcomePage`**

Filtering is the frontend's job and is the point of Review Focus 2: partition the dropped files by extension, send the rest, and report what was skipped by name.

**Do not edit `IMAGE_EXTS` or `AUDIO_EXTS` in `document-ops.ts`.** `backend/tests/test_media_store.py::test_the_frontend_extension_lists_match_the_allowed_types` parses that file and asserts those two lists equal `ALLOWED_TYPES`'s values exactly; adding `.jpeg` to `IMAGE_EXTS` breaks it. Instead export from `document-ops.ts`:

```ts
export const DROPPABLE_MEDIA_EXTS = [...IMAGE_EXTS, '.jpeg', ...AUDIO_EXTS];
```

derived rather than a third hand-written copy, with `.jpeg` present because the *import* allowlist (`bundle.MEDIA_EXTENSIONS`) accepts it while the upload table does not. Add a tie-test in `test_media_store.py` next to the existing one, asserting `DROPPABLE_MEDIA_EXTS` equals `bundle.MEDIA_EXTENSIONS`, so the two cannot drift either. A single dropped `.zip` goes to `importBundle`; anything else goes to `importFiles` with each file's `webkitRelativePath || name` rewritten to sit under `media/`, except a file named `tour.json`, which goes to the root. Read a dropped directory with `webkitGetAsEntry`, falling back to `webkitRelativePath` on the input's `FileList`. On success, `router.navigate(['/edit'])`.

- [ ] **Step 4: Wire the `@defer` block in `entry-page.html`**

- [ ] **Step 5: Run the frontend suite and confirm the welcome screen is its own chunk**

Run: `cd frontend && npx vitest run` then `make build`
Expected: tests PASS; the build output lists a lazy chunk for the welcome screen and the eager bundle has not grown meaningfully from 2.13 MB raw / 371.39 kB transferred. Record both figures in the commit message.

- [ ] **Step 6: Commit**

```bash
git add frontend/src/app/welcome frontend/src/app/entry/entry-page.html
git commit -m "Give the app a front door"
```

---

### Task 7: Closing a tour from the editor

**Files:**
- Create: `frontend/src/app/editor/close-dialog.ts`, `close-dialog.css`, `close-dialog.spec.ts`
- Modify: `frontend/src/app/editor/editor-page.ts`, `editor-page.html`, `editor-page.spec.ts`
- Modify: `frontend/src/app/editor/autosave.ts` — **confirmed: it has `start()` but no `stop()`.** Add `stop(): void` that clears `this.timer`, destroys the `EffectRef` `start()` created, and resets status to `'idle'` and message to `null`.
- Modify: `frontend/src/app/editor/editor-store.ts` — **confirmed: it has `load()` but no `clear()`.** Add `clear(): void` resetting the draft, selection and undo history.

**Why both are required, not optional:** `EditorStore`, `Autosave` and `TourStore` are all `@Injectable({ providedIn: 'root' })`, so they survive navigation away from `/edit`. Without an explicit stop and clear, closing a tour leaves a live autosave effect PUTting a stale draft at a session that no longer exists. That is exactly Review Focus 3.

**Interfaces:**
- Consumes: `SessionApi.exportBundle/close`; `EditorStore`; `Autosave`; `Router`.
- Produces: `CloseDialog` with outputs `closed` (the author confirmed; the parent performs teardown) and `cancelled`. Test hooks `[data-close-tour]`, `[data-close-dialog]`, `[data-download]`, `[data-size]`, `[data-acknowledge]`, `[data-confirm-close]`, `[data-keep-working]`, `[data-export-failed]`.

**Three things this task must get right, all from the spec:**
1. The dialog names the tour, its stop count and its media count, and says the tour only exists here.
2. *Download tour.zip* fetches the export **as a blob** — an `<a download>` click gives no completion signal and nothing reports the size without building the archive. The resolved blob's `size` is shown in `[data-size]` and releases the gate. `[data-confirm-close]` stays disabled until either that resolves or `[data-acknowledge]` is ticked. The editor's existing top-bar `[data-export]` link is left exactly as it is.
3. If the export 409s (the document references missing media), the dialog says so in `[data-export-failed]` and falls back to the acknowledge path — close is **not** refused, because refusing would trap the author in a tour they cannot leave.

- [ ] **Step 1: Write the failing tests**

```ts
// close-dialog.spec.ts
it('names the tour and what is in it', () => { /* title, 6 stops, 15 media in the text */ });
it('keeps close disabled until the bundle is downloaded', async () => {
  // [data-confirm-close].disabled true; click [data-download]; flush a Blob;
  // [data-size] shows its size; disabled false.
});
it('keeps close disabled until the author acknowledges instead', () => { /* tick [data-acknowledge] */ });
it('falls back to acknowledging when the export cannot be built', async () => {
  // flush 409 { detail: 'tour.json references media...' };
  // [data-export-failed] carries the detail; [data-acknowledge] still releases the gate.
});
it('emits cancelled from Keep working', () => { /* ... */ });

// editor-page.spec.ts
it('offers Close tour and Preview in the header', () => { /* [data-close-tour], [data-preview] href '/view' */ });
it('navigates to / when nothing is open', async () => {
  // Replaces the old empty-state test: flush { open: false }; assert navigate(['/'])
  // and that [data-empty] no longer exists.
});
it('stops autosave and navigates to / after a confirmed close', async () => {
  // Review Focus 3: with a dirty draft, confirm close; expectOne DELETE /api/session;
  // assert autosave stopped, store cleared, navigate(['/']), and no [data-autosave-error].
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `cd frontend && npx vitest run src/app/editor`
Expected: FAIL — no `CloseDialog`; the empty-state test fails as written against the old template.

- [ ] **Step 3: Implement `CloseDialog`**

- [ ] **Step 4: Change `EditorPage`**

Delete the `[data-empty]` section from the template and `startNewTour`/`newTitle`/`starting` from the component — the welcome screen owns creating a tour now. When the session reports nothing open, `router.navigate(['/'])` instead of rendering an empty state. Add `[data-preview]` (`<a href="/view">`) and `[data-close-tour]` to the header beside Export and Publish. Confirming the dialog must, in this order: stop autosave, `DELETE /api/session`, clear the draft store, navigate to `/`. Stopping autosave first is what Review Focus 3 is about — a PUT in flight against a session about to be deleted lands as a 409 and would paint "Save failed" over a successful close.

- [ ] **Step 5: Run to verify they pass**

Run: `cd frontend && npx vitest run`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add frontend/src/app/editor
git commit -m "Let the author close a tour and get back to the front door"
```

---

### Task 8: Documentation

**Files:**
- Modify: `docs/HANDOFF.md`, `docs/UNVERIFIED.md`, `docs/ARCHITECTURE.md`, `docs/CHANGING-THINGS.md`

- [ ] **Step 1: `HANDOFF.md`**

Replace "Opening the existing six-stop tour" with a short section saying the welcome screen at `/` does this in one click, keeping the `curl` and `cp` sequence below it, explicitly labelled as the headless fallback it actually is. Update "What exists" for the front door, the close control and `/view`. Update the test and bundle figures from the final `make check`.

- [ ] **Step 2: `UNVERIFIED.md`**

Move entries 2 and 9 from `http://localhost:8000/` to `http://localhost:8000/view` — after this change `/` goes to the editor whenever a tour is open, and entry 2 is one of the two recommended starting points for the first browser session. Add entries for: a real drag onto the drop zone; the loose-file path with the repository's own `content/tours/fairfax-old-town.json` and `content/media/` (the `media/pano/` nesting is the thing to check); the example button's resulting session figures; and the close dialog's gating, including the export-409 fallback.

- [ ] **Step 3: `ARCHITECTURE.md` and `CHANGING-THINGS.md`**

Record the three-way routing decision at `''` and why the viewer mounts before the probe resolves; the two-allowlist hazard and the rule that ingestion uses `bundle._check_media_file`; and where a new way of getting a tour in belongs.

- [ ] **Step 4: Run the full check**

Run: `make check`
Expected: lint clean, both suites pass, production build clean. Record the figures.

- [ ] **Step 5: Commit**

```bash
git add docs
git commit -m "Document the front door"
```

---

## Self-Review Notes

**Spec coverage.** Routing → 5. Welcome screen and layout B → 6. Examples, generic and frozen → 2. Loose-file import with relative paths → 3 (+4 for the client). Guarded close, blob download, export-409 fallback → 7. Editor empty state removed, teardown → 7. Preview link and `/view` → 5 (route) and 7 (link). `UNVERIFIED.md` entries 2 and 9 → 8. Published-site concurrency test → 5. Example acceptance figures → 2. Eager-bundle check → 6. Close route sharing removal with `new(force=True)` → 1.

**Known ordering risk.** Task 5's `@defer` block references `WelcomePage`, which Task 6 creates. Task 5's step 5 says to land the `@defer` in Task 6 if that blocks; Task 5 is still independently testable through `decision()`.

**Left to the builder:** all visual detail, drop-zone hover and error states, the exact copy of the guide link labels beyond the five names given, and whether `SessionApi.get()` or `EntryPage` owns the rxjs `timeout` operator.
