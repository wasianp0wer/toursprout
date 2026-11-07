# Hosted Tester Deployment Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Put the authoring editor behind a password-protected URL on Reclaim shared hosting, with each historian's open tour isolated from the others' and surviving every deploy.

**Architecture:** The single global `Session` becomes one per browser, keyed by an opaque `sid` cookie that doubles as a written-down recovery key, rooted in a `sessions_dir` outside the deploy tree. Three acquisition tools that cannot reach the internet from the host are removed or moved into the browser. The app reaches Passenger through an `a2wsgi` bridge, and GitHub Actions builds and rsyncs it.

**Tech Stack:** FastAPI, pydantic-settings, Angular 22, Vitest, a2wsgi, Passenger/CloudLinux, GitHub Actions.

**Spec:** `docs/superpowers/specs/2026-11-06-hosted-tester-deployment-design.md`

## Global Constraints

- Base is `main` at `1c70812`, with schema v3 merged. `SCHEMA_VERSION = 3`; `migration.migrate(doc)` is the entry point; the panorama field is `cachedMediaId`, not v2's `cachedPath`.
- **Node 24.** Angular 22 rejects Node 25 and the ambient `node` is v25. Go through `make`, or prepend `/Users/maddiepersonal/.local/share/fnm/node-versions/v24.21.0/installation/bin` to `PATH`.
- **`export UV_CACHE_DIR=/Users/maddiepersonal/phd/clio-wired/.uv-cache`** before any bare `uv` call, or it repopulates a different cache. The Makefile sets it.
- **There is no `conftest.py` in this repo**, deliberately. Each backend test file defines its own `client` fixture; copy `backend/tests/test_session_api.py:16-24`. `create_app(cfg)` is always passed positionally, and `with TestClient(...)` is mandatory because `app.state` is populated in the lifespan (which Task 6 removes — see that task).
- Backend tests isolate by `Settings(content_dir=tmp_path, ...)`. After Task 6, also `sessions_dir=tmp_path / "sessions"`.
- Frontend specs import explicitly from `vitest` (no globals), locate elements by `data-*` attributes only, stub services with `vi.fn()` in component specs and `HttpTestingController` in service specs. Copy the `q`/`qa`/`settle`/`type`/`click` helpers from `frontend/src/app/editor/inspector-pane.spec.ts`.
- `ruff` line length is 100.
- Cookie attributes, everywhere they are set: `HttpOnly`, `Secure`, `SameSite=Lax`, `Max-Age` one year (31536000).
- The Mapillary token is allowed to reach the browser; it already does, through `config.json`.
- The app deploys to a **subdomain root**. Do not introduce an API-base prefix; absolute `/api/...` URLs stay as they are.
- **Commands — this work happens in a git worktree at `.claude/worktrees/hosted-deploy` on branch `feature/hosted-tester-deployment`, where `make` DOES NOT WORK.** The Makefile points `UV_CACHE_DIR` at the worktree, so `uv` tries to build a fresh environment, needs the network, and fails; this project does not get a network allowlist. Borrow the main checkout's environment instead. All four commands, verbatim:

  ```sh
  V=/Users/maddiepersonal/phd/clio-wired/backend/.venv
  N=/Users/maddiepersonal/.local/share/fnm/node-versions/v24.21.0/installation/bin

  # backend tests (whole suite, or one test)
  cd backend && $V/bin/python -m pytest -q
  cd backend && $V/bin/python -m pytest tests/test_x.py::test_y -q
  # lint
  cd backend && $V/bin/ruff check app tests ../content/scripts
  # frontend tests (whole suite, or one spec)
  cd frontend && PATH=$N:$PATH npx ng test --watch=false
  cd frontend && PATH=$N:$PATH npx ng test --watch=false --include='**/core/x.spec.ts'
  # build
  cd frontend && PATH=$N:$PATH npx ng build
  ```

  Where this plan says "run `make check`", run all four of lint, backend tests, frontend tests and build, using these commands. `frontend/node_modules` in the worktree is a symlink to the main checkout's; do not delete or reinstall it. Never run `uv run`, `uv sync`, `npm install` or `make` from the worktree — each will fail on the network and may leave a partial `backend/.venv` or `.uv-cache` behind, which should be deleted if it appears.
- Baseline at the start of this work, in the worktree: **451 backend tests passing, 608 frontend tests passing**, lint clean, build clean. Tasks 2 and 3 deliberately lower those counts by deleting tests; every other task should hold or raise them.

## Review Focus

Input classes the spec implies that no task's own happy-path tests would exercise. Each has its test assigned to the task that owns the code.

1. **Two browsers at once.** A second client with no cookie must get its own empty session, never the first client's open document or media. → Task 6.
2. **A live cookie naming a directory that is gone** (swept, or deleted by hand on the host). Must read as "no tour open", never a 500. → Task 6.
3. **A hostile or malformed `sid`** — `..`, `a/b`, `""`, 300 characters, a URL-encoded separator. Must be refused before the filesystem is touched. → Task 5.
4. **A concurrent cookieless first load.** `entry-page.ts` fires `/api/session` and two `tour-data/*` requests in parallel; they must not create three session directories. → Task 6.
5. **A recovery key that is unknown or malformed.** Must report that plainly, not silently open a new blank tour that the historian mistakes for their lost one. → Task 7.

---

### Task 1: The editor loads the viewer config

Fixes a latent bug and unblocks Task 4. `ConfigStore.set()` has exactly one caller, `viewer/viewer-page.ts:37`, so on `/edit` the token is `''` (`edit-panorama-pane.ts:98` attaches mapillary-js with it) and `tileUrl()` is `''` (`edit-map-pane.ts:82` guards, so the map has no basemap).

**Files:**
- Modify: `frontend/src/app/editor/editor-page.ts` (`init()` at :70, `openDocument()` at :92)
- Test: `frontend/src/app/editor/editor-page.spec.ts`

**Interfaces:**
- Consumes: `TourApi.getConfig(): Promise<AppConfig>` (`core/tour-api.ts:45`), `ConfigStore.set(config: AppConfig): void` (`core/config-store.ts:10`)
- Produces: a populated `ConfigStore` on the `/edit` route, which Task 4 reads via `ConfigStore.mapillaryToken()`

- [ ] **Step 1: Write the failing test**

```ts
it('loads the viewer config so the map and panorama panes have a token', async () => {
  // getConfig stubbed to resolve { mapillaryToken: 'MLY|t', tileUrl: 'https://tiles/{z}/{x}/{y}.png', attribution: [] }
  expect(TestBed.inject(ConfigStore).mapillaryToken()).toBe('MLY|t');
  expect(TestBed.inject(ConfigStore).tileUrl()).toBe('https://tiles/{z}/{x}/{y}.png');
});

it('still opens the document when the config request fails', async () => {
  // getConfig stubbed to reject; getTour resolves a tour
  expect(TestBed.inject(ConfigStore).mapillaryToken()).toBe('');
  // the editor is still usable: the outline shows the tour's stops
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd frontend && npx ng test --watch=false --include='**/editor/editor-page.spec.ts'`
Expected: FAIL — token is `''`

- [ ] **Step 3: Fetch the config in `openDocument()` in `frontend/src/app/editor/editor-page.ts`**

Fetch config alongside the tour and pass it to `ConfigStore.set`. A failed config must not block the document from opening — the editor is useful without a basemap, so catch and continue.

- [ ] **Step 4: Run to verify both tests pass**

Run: the same command. Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add frontend/src/app/editor/editor-page.ts frontend/src/app/editor/editor-page.spec.ts
git commit -m "Give the editor its viewer config, so the map and panorama have a token"
```

---

### Task 2: Remove narration

macOS `say` exists on neither the Linux host nor the testers' Windows laptops. Microphone recording, already in `editor/recorder.ts`, is the only narration path afterwards.

**Files:**
- Modify: `backend/app/main.py` (delete route at :510-525), `backend/app/tools.py`, `backend/tests/test_tools.py`
- Modify: `frontend/src/app/core/tools-api.ts`, `frontend/src/app/core/tools-api.spec.ts`, `frontend/src/app/editor/outline-pane.ts`, `frontend/src/app/editor/outline-pane.html`, `frontend/src/app/editor/outline-pane.spec.ts`, `frontend/src/app/editor/document-ops.ts`, `frontend/src/app/editor/document-ops.spec.ts`

**Interfaces:**
- Produces: `ToolsApi` without `narrate`; `document-ops` without `narrationSource`

Delete from `backend/app/tools.py`: `SAY_TIMEOUT` (:49), `FFMPEG_TIMEOUT` (:50), `SAY` (:61), `VOICE` (:62), `FFMPEG` (:63), `NARRATION_CREDIT` (:64-68), `_run` (:358), `synthesize` (:370), `clean_text` (:398), `NarrateRequest` (:439), and the now-unused `import subprocess`, `import tempfile`, `from pathlib import Path`.

Delete from the frontend: `ToolsApi.narrate` (`tools-api.ts:71`), `NarrationResult` (:36), `OutlinePane.narration` (:270), `narrate()` (:280), `runNarrate()` (:293), the `'narrate'` arm of `submitDefaults()` (:123), `'narrate'` from the `PromptKind` union (:12), the `data-narrate` button (`outline-pane.html:15`), and `narrationSource` (`document-ops.ts:588`).

Keep: `busy`, `mediaError`, `error`, `targetStopId`, `addUploaded`, `createFromMedia`, `refusalMessage`, `submitDefaults` — all shared with Add image, Add audio and Record audio.

- [ ] **Step 1: Delete the narration tests first, then run the suites to see them gone**

Remove from `backend/tests/test_tools.py`: the `"narrate"` entry in `TOOLS` (:107-113) and `test_narrate_stores_real_audio` (:304), `test_narrate_text_that_looks_like_a_flag` (:322), `test_narrate_needs_an_open_tour` (:328), `test_narrate_validates_text` (:333), `test_narrate_missing_say_is_502` (:340). Remove the narration cases from `tools-api.spec.ts` and the narration half of `describe('archive search and narration')` in `outline-pane.spec.ts:425`, and the `narrationSource` cases and import from `document-ops.spec.ts`.

Run: `cd backend && uv run pytest -q` and `make frontend-test`
Expected: PASS, with a lower test count. Record both counts.

- [ ] **Step 2: Write the test that pins narration's absence**

```python
def test_narrate_route_is_gone(client):
    assert client.post("/api/tools/narrate", json={"text": "hello"}).status_code == 404
```

```ts
it('offers no narrate button', async () => {
  expect(q('[data-narrate]')).toBeNull();
});
```

- [ ] **Step 3: Run to verify they fail**

Expected: FAIL — the route answers 409/422 rather than 404, and the button is present.

- [ ] **Step 4: Delete the route, the `tools.py` names and the frontend members listed above**

- [ ] **Step 5: Run the full gate**

Run: `make check`
Expected: all green. `make content` must still work — `content/scripts/make_narration.py` is self-contained and untouched.

- [ ] **Step 6: Commit**

```bash
git commit -am "Drop synthesised narration: say exists on neither the host nor Windows"
```

---

### Task 3: Remove archive search and fetch

`www.loc.gov` returns 403 to the host through Cloudflare. Rephotography is unaffected: historians download from loc.gov themselves and upload through `POST /api/session/media`.

**Files:**
- Modify: `backend/app/main.py` (routes at :482-489 and :491-508), `backend/app/tools.py`, `backend/tests/test_tools.py`
- Modify: `frontend/src/app/core/tools-api.ts` + spec, `frontend/src/app/editor/outline-pane.ts` + `.html` + `.css` + spec, `frontend/src/app/editor/document-ops.ts` + spec

Delete from `backend/app/tools.py`: `LOC_SEARCH` (:32), `LOC_TIMEOUT` (:42), `DEFAULT_EXCLUDED_PLACES` (:58), `_first` (:261), `_as_text` (:267), `score_title` (:273), `_text_field` (:287), `_creator` (:297), `_rights` (:308), `_image_url` (:316), `search_archive` (:321), `ArchiveRequest` (:420), `ArchiveFetchRequest` (:434), `FETCH_ATTEMPTS`/`FETCH_TIMEOUT`/`FETCH_DEADLINE` (:453-455), `MAX_REDIRECTS` (:457), `check_archive_url` (:460), `_too_big` (:484), `_get_capped` (:488), `fetch_archive_image` (:516), and the `from .media_store import MAX_FILE_BYTES, MediaError, sniff` import (:27).

**Knock-on:** with Task 4 also removing `find_panoramas`, `_get_json` (:114) and `RETRY_PAUSE` (:52) lose their last callers — `find_places` posts to Overpass directly. Delete them in whichever of Tasks 3 or 4 lands second, and check with `ruff` rather than by eye.

`backend/tests/test_relevance.py` imports `score_title` from `content/scripts/relevance.py` via a `sys.path.insert`, **not** from `app.tools`. It must pass untouched; if it fails, the wrong `score_title` was deleted.

Delete from the frontend: `ToolsApi.archiveSearch` (:61), `archiveFetch` (:66), `ArchiveResult` (:25); `OutlinePane`'s whole `// --- archive search ---` section (:311-378) and the `ArchiveResult` import (:7); `outline-pane.html`'s `data-archive-open` button (:16) and the `@if (archiveOpen())` block (:33-59); the `.archive`, `.archive-results` and `.rights` rules in `outline-pane.css`; `archiveCredit` (`document-ops.ts:572`).

- [ ] **Step 1: Delete the archive tests, run both suites, record the counts**

From `backend/tests/test_tools.py`: the `"archive-search"` and `"archive-fetch"` entries in `TOOLS`, the `LOC` fixture (:72-86), `test_archive_search_parses_and_filters` (:267), `test_archive_search_no_match_is_empty_not_an_error` (:296), `JPEG` (:359), `fast_retry` (:363), every `test_archive_fetch_*`, and `"archive-search"` from the parametrize lists of `test_timeout_is_502_with_message` (:124), `test_garbage_body_is_502` (:134) and `test_upstream_5xx_is_502` (:141). From the frontend: the archive cases in `tools-api.spec.ts`, the archive half of `outline-pane.spec.ts:425`, and `archiveCredit`'s cases and import in `document-ops.spec.ts`.

- [ ] **Step 2: Write the tests that pin their absence**

```python
@pytest.mark.parametrize("tool", ["archive-search", "archive-fetch"])
def test_archive_routes_are_gone(client, tool):
    assert client.post(f"/api/tools/{tool}", json={}).status_code == 404
```

```ts
it('offers no archive search', async () => {
  expect(q('[data-archive-open]')).toBeNull();
});
```

- [ ] **Step 3: Run to verify they fail**

- [ ] **Step 4: Delete the routes, the `tools.py` names and the frontend members listed above**

- [ ] **Step 5: Run the full gate, and confirm the right `score_title` survived**

Run: `make check`, then `cd backend && uv run pytest tests/test_relevance.py -q`
Expected: all green, `test_relevance.py` passing unmodified.

- [ ] **Step 6: Commit**

```bash
git commit -am "Drop in-editor archive search: loc.gov refuses the host"
```

---

### Task 4: Panorama search moves into the browser

`graph.mapillary.com` is unreachable from the host — DNS resolves to `31.13.80.8` and the SYN is dropped. The browser reaches it already, because `mapillary-js` renders every panorama from there.

**Files:**
- Create: `frontend/src/app/core/mapillary-search.ts`, `frontend/src/app/core/mapillary-search.spec.ts`
- Modify: `frontend/src/app/editor/inspector-pane.ts` (`findPanoramas()` at :149), `frontend/src/app/core/tools-api.ts` (delete `panoramas` at :52), `frontend/src/app/editor/inspector-pane.spec.ts`, `frontend/src/app/core/tools-api.spec.ts`
- Modify: `backend/app/main.py` (delete route at :462-471), `backend/app/tools.py`, `backend/tests/test_tools.py`

**Interfaces:**
- Consumes: `ConfigStore.mapillaryToken(): string` (populated by Task 1); `PanoramaCandidate` (`core/tools-api.ts:5-15`), which must keep its field names and move to `core/mapillary-search.ts` since `ToolsApi` loses its last panorama member
- Produces:
  - `export function bboxAround(lng: number, lat: number, radiusM: number): string`
  - `export function haversineM(lng1: number, lat1: number, lng2: number, lat2: number): number`
  - `export function rankCandidates(images: unknown[], lng: number, lat: number, panoOnly: boolean, limit: number): PanoramaCandidate[]`
  - `@Injectable({providedIn:'root'}) class MapillarySearch { panoramas(lng: number, lat: number, radiusM?: number): Promise<PanoramaCandidate[]> }`
- `InspectorPane.usePanorama` and `selectPanorama` are untouched: `PanoramaCandidate` already structurally satisfies `PanoramaChoice`.

Values to carry over exactly from the deleted Python:

- `bboxAround`: `dlat = radiusM / 111320`, `dlng = radiusM / (111320 * Math.cos(lat * Math.PI / 180))`, returned as `` `${lng-dlng},${lat-dlat},${lng+dlng},${lat+dlat}` `` — **west,south,east,north**, which is Mapillary's order and the reverse of the Overpass bbox in `find_places`.
- `haversineM`: `r = 6371000`, the standard formula at `tools.py:153-158`.
- Request: `GET https://graph.mapillary.com/images` with `access_token`, `bbox`, `limit=500`, and `fields=id,computed_geometry,geometry,is_pano,captured_at,compass_angle,thumb_256_url`.
- Defaults from `PanoramaRequest`: `radiusM` 50 (max 500), `panoOnly` true, `limit` 20.
- `rankCandidates` maps each image to `{imageId: String(id), lng, lat, isPano, capturedAt, compassAngle, thumbUrl, distanceM}` where `distanceM` is `haversineM` rounded to 1 decimal, sorts by `(!isPano, distanceM)`, and trims to `limit`.

- [ ] **Step 1: Write the failing tests for the pure functions**

```ts
it('builds a west,south,east,north bbox', () => {
  const [w, s, e, n] = bboxAround(-77.307, 38.845, 50).split(',').map(Number);
  expect(w).toBeLessThan(-77.307); expect(e).toBeGreaterThan(-77.307);
  expect(s).toBeLessThan(38.845); expect(n).toBeGreaterThan(38.845);
});

it('measures a known distance', () => {
  expect(haversineM(-77.307, 38.845, -77.307, 38.8459)).toBeCloseTo(100, 0);
});

it('takes the camera position, never the query point', () => {
  const [c] = rankCandidates(
    [{ id: 7, computed_geometry: { coordinates: [-77.30, 38.84] },
       geometry: { coordinates: [-1, -1] }, is_pano: true }], -77.307, 38.845, true, 20);
  expect(c.lng).toBe(-77.30); expect(c.lat).toBe(38.84);
  expect(c.imageId).toBe('7');
});

it('falls back to geometry when computed_geometry is absent', () => { /* ... */ });
it('skips images with no geometry or no id rather than throwing', () => { /* ... */ });
it('puts true panoramas before flat images, then nearest first', () => { /* ... */ });
it('drops flat images when panoOnly', () => { /* ... */ });
it('trims to the limit', () => { /* ... */ });
```

- [ ] **Step 2: Run to verify they fail**

Run: `cd frontend && npx ng test --watch=false --include='**/core/mapillary-search.spec.ts'`
Expected: FAIL — module not found

- [ ] **Step 3: Implement `bboxAround`, `haversineM`, `rankCandidates` and `MapillarySearch` in `frontend/src/app/core/mapillary-search.ts`**

`MapillarySearch.panoramas` reads the token from `ConfigStore`, throws an `Error` whose message says a Mapillary token is not configured when it is empty (mirroring the 400 the deleted route raised), and otherwise fetches and returns `rankCandidates(...)`. Use `HttpClient` with `firstValueFrom`, matching `ToolsApi`'s style, so the spec can drive it with `HttpTestingController`.

- [ ] **Step 4: Run to verify they pass**

- [ ] **Step 5: Add the request-shape test**

```ts
it('asks Mapillary directly, with the token and the panorama fields', async () => {
  const req = http.expectOne((r) => r.url === 'https://graph.mapillary.com/images');
  expect(req.request.params.get('access_token')).toBe('MLY|t');
  expect(req.request.params.get('fields')).toContain('computed_geometry');
  expect(req.request.params.get('limit')).toBe('500');
});

it('explains itself when no token is configured', async () => { /* rejects, message names the token */ });
```

- [ ] **Step 6: Rewire `InspectorPane.findPanoramas()` to `MapillarySearch`**

Inject `MapillarySearch` and call it in place of `this.tools.panoramas(...)` at `inspector-pane.ts:153`. Leave `searching`, `toolError`, `found`, `search()`, `candidates` and the whole places path untouched — they are shared.

Update `inspector-pane.spec.ts`'s `describe('InspectorPane: placing a stop')` to provide `{ provide: MapillarySearch, useValue: { panoramas } }` alongside the existing `ToolsApi` stub, which keeps `places`.

- [ ] **Step 7: Delete `ToolsApi.panoramas`, the backend route and its Python**

From `backend/app/tools.py`: `MAPILLARY_IMAGES` (:31), `MAPILLARY_TIMEOUT` (:41), `bbox_around` (:147), `haversine_m` (:153), `find_panoramas` (:161), `PanoramaRequest` (:409). From `backend/tests/test_tools.py`: the `"panoramas"` entry in `TOOLS` and `"panoramas"` from the three parametrize lists. Add:

```python
def test_panoramas_route_is_gone(client):
    assert client.post("/api/tools/panoramas", json={"lng": 0, "lat": 0}).status_code == 404
```

Then delete whichever of `_get_json` and `RETRY_PAUSE` Task 3 left behind, and confirm with `ruff`.

- [ ] **Step 8: Run the full gate**

Run: `make check`
Expected: all green. `make content` still works — `probe_coverage.py` has its own `bbox_around` and `haversine_m`.

- [ ] **Step 9: Commit**

```bash
git commit -am "Search Mapillary from the browser: the host cannot reach it"
```

---

### Task 5: `sid` minting and validation

Pure, no FastAPI. Owns Review Focus item 3.

**Files:**
- Create: `backend/app/sessions.py`, `backend/tests/test_sessions.py`

**Interfaces:**
- Produces:
  - `SID_COOKIE: str = "tour_sid"`
  - `COOKIE_MAX_AGE: int = 31536000`
  - `def new_sid() -> str`
  - `def valid_sid(sid: str) -> bool`
  - `def session_dir(sessions_dir: Path, sid: str) -> Path` — raises `ValueError(sid)` when `valid_sid` is false

The `sid` is also the recovery key a historian may copy by hand, so: `secrets.token_hex(8)` — 16 lowercase hex characters, 64 bits, unguessable and retypeable. `valid_sid` accepts exactly 16 characters from `[0-9a-f]` and nothing else, which subsumes the `examples.py:149` guard (`value in ("", ".", "..") or value != Path(value).name`) without relying on it.

- [ ] **Step 1: Write the failing tests**

```python
def test_new_sid_is_sixteen_hex_characters():
    sid = new_sid()
    assert len(sid) == 16 and all(c in "0123456789abcdef" for c in sid)

def test_new_sid_does_not_repeat():
    assert len({new_sid() for _ in range(100)}) == 100

@pytest.mark.parametrize("bad", [
    "", ".", "..", "../etc", "a/b", "a\\b", "%2e%2e", "A" * 16, "abc",
    "0123456789abcdef0", "0123456789abcde", "0123456789abcdeg", " 0123456789abcdef",
])
def test_valid_sid_refuses(bad):
    assert valid_sid(bad) is False

def test_session_dir_is_a_child_of_sessions_dir(tmp_path):
    sid = new_sid()
    assert session_dir(tmp_path, sid) == tmp_path / sid

@pytest.mark.parametrize("bad", ["..", "a/b", ""])
def test_session_dir_refuses_before_touching_the_filesystem(tmp_path, bad):
    with pytest.raises(ValueError):
        session_dir(tmp_path, bad)
    assert list(tmp_path.iterdir()) == []
```

- [ ] **Step 2: Run to verify they fail**

Run: `cd backend && uv run pytest tests/test_sessions.py -q`
Expected: FAIL — module not found

- [ ] **Step 3: Implement the four names in `backend/app/sessions.py`**

- [ ] **Step 4: Run to verify they pass**

- [ ] **Step 5: Commit**

```bash
git add backend/app/sessions.py backend/tests/test_sessions.py
git commit -m "Add session ids: minted, validated, and usable as a recovery key"
```

---

### Task 6: Cookie-keyed sessions

The core change. Owns Review Focus items 1, 2 and 4.

**Files:**
- Modify: `backend/app/config.py`, `backend/app/main.py` (lifespan :138-144, all 11 `/api/session/*` routes, `_mount_tour_data` :580-600)
- Modify: every backend test file that constructs `Settings` — `test_session_api.py`, `test_static.py`, `test_api.py`, `test_tools.py`, `test_loose_import.py`, `test_examples.py`
- Test: `backend/tests/test_session_cookie.py` (new)

**Interfaces:**
- Consumes: Task 5's `SID_COOKIE`, `COOKIE_MAX_AGE`, `new_sid`, `valid_sid`, `session_dir`
- Produces:
  - `Settings.sessions_dir: Path`, default `Path.home() / ".clio-wired" / "sessions"`, overridable as `SESSIONS_DIR` in `backend/.env`
  - `def current_session(request: Request) -> Session` — a FastAPI dependency that **resolves only**; raises nothing for an absent session, returning a `Session` on a path that may not exist (`is_open` is then false)
  - `def mint_session(request: Request, response: Response) -> Session` — resolves, or mints when there is no usable cookie, setting the cookie and writing `config.json`
- `Settings.work_dir` is removed. Nothing outside tests reads it after this task.

Four decisions this task implements, from spec §6.1:

1. **`/api/session` and the four creating routes mint; everything else resolves or fails.** `mint_session` goes on `GET /api/session`, `POST /api/session/new`, `POST /api/session/examples/{id}`, `POST /api/session/import` and `POST /api/session/import-files`. `current_session` (resolve-only) goes on `DELETE /api/session`, `PUT /api/session/tour`, `POST /api/session/media`, `GET /api/session/export` and `GET /api/session/publish` — so a cookieless `PUT /api/session/tour` gets the existing 409 "no tour is open", not a new session. `/tour-data` never mints.

   The creating routes are included because a route that creates a tour but cannot mint has nowhere safe to write it: a fixed placeholder is the collision anti-goal restated, and an un-cookied `sid` path puts the tour where the author's browser can never reach it. It would also break `docs/HANDOFF.md:172`'s documented `curl -X POST .../api/session/new` first call. The concurrency rationale still holds — two of the three first-load requests are `/tour-data`, which never mints, and the creating routes are user-initiated after `/api/session` has answered. `_reject_cross_site` already guards all four, so minting on a POST opens no new attack path.
2. **`/tour-data` stops being a static mount.** Replace `_mount_tour_data` with a route — `@app.get("/tour-data/{path:path}")` — that resolves the session from the cookie and serves from inside it. It must keep `X-Content-Type-Options: nosniff` and Range support (`main.py:583` records the narration audio as needing Range; recorded audio needs it as much). `FileResponse` provides Range; set the header explicitly. Refuse any `path` that escapes the session directory, using `Path.resolve()` and `is_relative_to`, as `examples.py:182-194`'s `_inside` does. No cookie, or an unknown `sid`, is **404** — never a mint.
3. **The viewer config is written at mint time.** `main.py:142` writes it in the lifespan; with sessions created on demand, `mint_session` calls `session.write_config(_viewer_config(cfg))` instead. The routes that already re-write it after mutating (`new_session` :199, `import_example` :234, `import_bundle` :314, `import_files` :399) keep doing so.
4. **The lifespan goes.** `a2wsgi` never runs it (Task 10), so `app.state.cfg = cfg` moves into `create_app`'s body and `app.state.session` disappears. Removing the lifespan entirely is deliberate: a lifespan that silently does not run under Passenger is worse than none. Tests may keep `with TestClient(...)`; it simply stops being load-bearing.

- [ ] **Step 1: Write the failing isolation tests**

```python
def test_two_clients_get_their_own_tours(cfg):
    a, b = TestClient(create_app(cfg)), TestClient(create_app(cfg))
    a.post("/api/session/new", json={"title": "Alice"})
    assert a.get("/api/session").json()["title"] == "Alice"
    assert b.get("/api/session").json() == {"open": False}
    b.post("/api/session/new", json={"title": "Bob"})
    assert a.get("/api/session").json()["title"] == "Alice"

def test_a_cookie_is_set_on_first_contact(client):
    r = client.get("/api/session")
    assert valid_sid(r.cookies[SID_COOKIE])

def test_the_cookie_is_httponly_secure_lax_and_long_lived(client):
    header = client.get("/api/session").headers["set-cookie"]
    assert "HttpOnly" in header and "Secure" in header
    assert "SameSite=lax" in header.lower() and f"Max-Age={COOKIE_MAX_AGE}" in header

def test_a_cookie_whose_directory_is_gone_reads_as_closed(client, cfg):
    client.post("/api/session/new", json={"title": "T"})
    shutil.rmtree(cfg.sessions_dir)
    assert client.get("/api/session").json() == {"open": False}   # not a 500

def test_a_forged_sid_is_refused(client):
    client.cookies.set(SID_COOKIE, "../../etc")
    assert client.get("/api/session").status_code in (200, 400)
    assert client.get("/api/session").json()["open"] is False

def test_one_browser_one_session_directory(client, cfg):
    client.get("/api/session"); client.get("/api/session"); client.get("/api/session")
    assert len(list(cfg.sessions_dir.iterdir())) == 1

def test_tour_data_does_not_mint(client, cfg):
    assert client.get("/tour-data/tour.json").status_code == 404
    assert not cfg.sessions_dir.exists() or list(cfg.sessions_dir.iterdir()) == []

def test_tour_data_serves_only_this_sessions_media(cfg):
    # Alice uploads; Bob must 404 on Alice's mediaId
    ...

def test_tour_data_refuses_a_traversal_path(client):
    client.post("/api/session/new", json={"title": "T"})
    assert client.get("/tour-data/../../../etc/passwd").status_code in (403, 404)

def test_tour_data_sends_nosniff_and_accepts_a_range(client):
    ...
```

- [ ] **Step 2: Run to verify they fail**

Run: `cd backend && uv run pytest tests/test_session_cookie.py -q`
Expected: FAIL — `sessions_dir` does not exist; both clients share one tour

- [ ] **Step 3: Add `Settings.sessions_dir` and remove `work_dir` in `backend/app/config.py`**

- [ ] **Step 4: Add `current_session` and `mint_session` in `backend/app/main.py`, and convert all 11 session routes**

Each route replaces `session = app.state.session` with `session: Session = Depends(current_session)` — `get_session` uses `mint_session`. Keep every existing guard, status code and message exactly: the 409s at :186, :197, :216, :241, :258, :338, :415, :531, the 422 at :248, the 404 at :229, the 413 middleware at :160-176, and `dependencies=[Depends(_reject_cross_site)]` wherever it is today.

- [ ] **Step 5: Replace the `/tour-data` mount with the per-session route**

- [ ] **Step 6: Move `app.state.cfg` into `create_app`'s body and delete the lifespan**

- [ ] **Step 7: Update every test fixture to pass `sessions_dir`**

Add `sessions_dir=tmp_path / "sessions"` to each `Settings(...)` in the six test files named above. Tests that reached `Session(cfg.work_dir)` directly (`test_examples.py:63`) take an explicit path instead.

- [ ] **Step 8: Run the full gate**

Run: `make check`
Expected: all green, including the 451 pre-existing backend tests.

- [ ] **Step 9: Commit**

```bash
git commit -am "Key the session on a cookie, so two historians cannot collide"
```

---

### Task 7: The recovery key

A cookie dies with cleared browsing data or a new laptop; the directory then lives on disk, unreachable. Owns Review Focus item 5.

**Files:**
- Modify: `backend/app/main.py`, `frontend/src/app/core/session-api.ts`, `frontend/src/app/editor/editor-page.ts` + `.html` (or the pane the implementer judges right — see below)
- Test: `backend/tests/test_session_cookie.py`, `frontend/src/app/core/session-api.spec.ts`

**Interfaces:**
- Produces:
  - `GET /api/session` gains `"recoveryKey": <sid>` to its summary when a session exists
  - `POST /api/session/reattach` taking `{"key": "<sid>"}`, setting the cookie and returning the summary; **404** `"there is no tour with that recovery key"` for an unknown key, **400** `"that is not a recovery key"` for a malformed one
  - `SessionApi.reattach(key: string): Promise<SessionSummary>`
  - `SessionSummary` gains `recoveryKey?: string`

Reattaching must not destroy what is open: if the caller already has an open tour, refuse with **409**, reusing the wording pattern of the existing "export it first" conflicts. Where the key is shown and where it is typed is the implementer's call; it must be visible without opening a dialog, and copyable.

- [ ] **Step 1: Write the failing tests**

```python
def test_the_summary_carries_the_recovery_key(client):
    client.post("/api/session/new", json={"title": "T"})
    assert valid_sid(client.get("/api/session").json()["recoveryKey"])

def test_reattaching_reopens_the_same_tour(cfg):
    a = TestClient(create_app(cfg))
    a.post("/api/session/new", json={"title": "Lost"})
    key = a.get("/api/session").json()["recoveryKey"]
    b = TestClient(create_app(cfg))
    assert b.post("/api/session/reattach", json={"key": key}).json()["title"] == "Lost"
    assert b.get("/api/session").json()["title"] == "Lost"

def test_an_unknown_key_is_404_and_opens_nothing(client):
    r = client.post("/api/session/reattach", json={"key": "0123456789abcdef"})
    assert r.status_code == 404
    assert client.get("/api/session").json()["open"] is False

@pytest.mark.parametrize("bad", ["", "..", "a/b", "nope"])
def test_a_malformed_key_is_400(client, bad):
    assert client.post("/api/session/reattach", json={"key": bad}).status_code == 400

def test_reattaching_refuses_to_discard_an_open_tour(client, cfg):
    ...  # 409, and the open tour is still the one open

def test_reattach_is_refused_cross_site(client):
    ...  # 403, per the existing convention in test_tools.py:116
```

- [ ] **Step 2: Run to verify they fail**

- [ ] **Step 3: Add `recoveryKey` to the summary and implement `POST /api/session/reattach` in `backend/app/main.py`**

Guard it with `dependencies=[Depends(_reject_cross_site)]` like every other mutating session route.

- [ ] **Step 4: Run to verify they pass**

- [ ] **Step 5: Add `SessionApi.reattach` with its spec, and surface the key and the input in the editor**

- [ ] **Step 6: Run the full gate and commit**

```bash
git commit -am "Show a recovery key, and let a historian type it back"
```

---

### Task 8: The session sweep

**Files:**
- Modify: `backend/app/sessions.py`, `backend/app/config.py`, `backend/app/main.py`
- Test: `backend/tests/test_sessions.py`

**Interfaces:**
- Produces: `def sweep(sessions_dir: Path, max_age_days: int) -> list[str]` returning the removed sids; `Settings.session_retention_days: int = 90`

90 days is generous on purpose: a recovery key may be on paper, and spec §6.1 requires that a tour with a written-down key not be deleted out from under it. Age is measured from the newest mtime anywhere inside the directory, not the directory's own mtime, which does not change when a file inside it is rewritten.

When the sweep runs is the implementer's call; a cheap option is opportunistically inside `mint_session`, at most once per process. It must never raise into a request.

- [ ] **Step 1: Write the failing tests**

```python
def test_sweep_removes_only_the_stale(tmp_path):
    ...  # fresh survives, stale is returned and gone

def test_sweep_measures_the_newest_file_not_the_directory(tmp_path):
    ...  # old dir mtime, recent file inside → survives

def test_sweep_ignores_a_file_that_is_not_a_session_directory(tmp_path):
    ...

def test_sweep_survives_a_directory_it_cannot_read(tmp_path):
    ...  # returns, does not raise
```

- [ ] **Step 2–4: Run (fail), implement `sweep`, run (pass)**

- [ ] **Step 5: Wire it in, then run the full gate and commit**

```bash
git commit -am "Reclaim abandoned sessions, after long enough for a paper key"
```

---

### Task 9: Resource caps become settings

Six concurrent sessions plus abandoned ones multiply caps sized for one author with a local disk.

**Files:**
- Modify: `backend/app/config.py`, `backend/app/media_store.py` (`MAX_FILE_BYTES` :49, `MAX_TOTAL_BYTES` :50), `backend/app/bundle.py` (`MAX_TOTAL_BYTES` :38)
- Test: `backend/tests/test_media_store.py`, `backend/tests/test_session_api.py`

**Interfaces:**
- Produces: `Settings.max_file_bytes`, `Settings.max_session_bytes`, `Settings.max_bundle_bytes`, with the current values as defaults so nothing changes until the host's `.env` lowers them

Keep the module-level constants as the defaults the settings fall back to. `main.py:160-176`'s middleware and `test_session_api.py:578` both reach `media_store.MAX_FILE_BYTES` as a **module attribute** so `monkeypatch.setattr` works; that mechanism must keep working, so read the setting where the request is handled rather than rebinding the module constant.

`bundle.MAX_TOTAL_BYTES` is imported by name at `main.py:28` and is a different value from `media_store`'s identically named constant (512 MiB vs 1 GiB). Do not merge them.

- [ ] **Step 1: Write the failing test**

```python
def test_a_lower_session_cap_is_enforced(tmp_path):
    cfg = Settings(..., max_session_bytes=1024)
    ...  # the second upload is 400, message names the limit
```

- [ ] **Step 2–4: Run (fail), add the settings and read them at the enforcement points, run (pass)**

- [ ] **Step 5: Full gate and commit**

```bash
git commit -am "Make the media and bundle caps settings, for a shared disk"
```

---

### Task 10: Passenger entry point and the egress diagnostic

**Files:**
- Create: `passenger_wsgi.py` (repo root), `backend/requirements.txt` (generated, committed)
- Modify: `backend/pyproject.toml`, `backend/app/main.py`
- Test: `backend/tests/test_wsgi.py` (new)

**Interfaces:**
- Produces: `application` — the WSGI callable; `GET /api/diagnostics/egress`

`passenger_wsgi.py` wraps `app.main.app` in `a2wsgi.ASGIMiddleware`. Add `a2wsgi` to `[project.dependencies]`. Export the lock to `backend/requirements.txt` (`uv export --no-hashes --no-dev`) and commit it, because the host's Passenger virtualenv installs with `pip`, not `uv`.

`GET /api/diagnostics/egress` attempts `graph.mapillary.com`, `www.loc.gov` and each Overpass mirror with a short timeout and returns a status or an error string per host. Spec §7 calls for this to be the first thing deployed, so a block surfaces on day one rather than when a historian clicks *find panoramas*. It makes no outbound call unless asked, so it costs nothing at rest; it needs no auth beyond the directory password that fronts the whole site.

**Do not change `requires-python`** unless the host's *Setup Python App* version has been confirmed by then (spec §7 item 2). If it has, lower it to that version and add that version to the CI matrix in Task 11. If it has not, leave `>=3.13` and say so in the commit message — the app will not boot on an older interpreter, and a silent lowering would hide that.

- [ ] **Step 1: Write the failing tests**

```python
def test_the_wsgi_callable_serves_a_request():
    from passenger_wsgi import application
    with TestClient(application) as c:          # WSGITransport
        assert c.get("/api/health").json() == {"status": "ok"}

def test_app_state_exists_without_a_lifespan():
    # create_app(cfg).state.cfg is set without entering a lifespan —
    # this is what a2wsgi's lack of lifespan support would otherwise break
    assert create_app(cfg).state.cfg is cfg

def test_egress_diagnostic_reports_per_host(client):
    ...  # mocked transport; every host appears in the body with a status
```

- [ ] **Step 2–4: Run (fail), implement, run (pass)**

- [ ] **Step 5: Full gate and commit**

```bash
git commit -am "Serve through Passenger, and report what the host can reach"
```

---

### Task 11: The deploy workflow

**Files:**
- Create: `.github/workflows/deploy.yml`

There is no `.github/` directory today. Triggers: push to `main`, and `workflow_dispatch` with a `target` input defaulting to the production path, so the pipeline can be rehearsed against a staging directory before any historian has the password (spec §6.5).

Steps: Node 24 and `ng build`; the host's Python with `ruff check` and `pytest`; `pip install -r backend/requirements.txt` into the host's virtualenv; `rsync` over SSH of `backend/`, `frontend/dist/frontend/browser` and `content/` **excluding `content/work`**; write `.env` from secrets; `touch tmp/restart.txt`.

Never pass `--delete` in a way that can reach `sessions_dir`. Keeping it outside the synced tree is the first defence and not deleting is the second — spec §5 makes a deploy that destroys a historian's tour a failure condition.

Secrets: `SSH_PRIVATE_KEY`, `DEPLOY_HOST`, `DEPLOY_USER`, `DEPLOY_PATH`, `MAPILLARY_TOKEN`. A failing test or lint stops the deploy.

- [ ] **Step 1: Write the workflow**

- [ ] **Step 2: Verify it parses and the build job runs**

Run: `gh workflow view deploy.yml` if `gh` is authenticated, otherwise `python -c "import yaml,sys; yaml.safe_load(open('.github/workflows/deploy.yml'))"`.
The deploy job cannot be verified from here; it is the first entry in Task 12's runbook, with a stop-and-report point.

- [ ] **Step 3: Commit**

```bash
git add .github/workflows/deploy.yml
git commit -m "Build, test and ship to the host on a push to main"
```

---

### Task 12: Documentation

**Files:**
- Create: `docs/DEPLOY.md`, `docs/FOR-HISTORIANS.md`
- Modify: `docs/UNVERIFIED.md`, `docs/ARCHITECTURE.md`, `README.md`, `docs/HANDOFF.md`, `docs/CHANGING-THINGS.md`

**`docs/HANDOFF.md` is load-bearing and currently broken as printed.** Its curl flow at lines 168-180 is the supported no-browser path, and it was the deciding evidence for the minting boundary in Task 6. Every `curl` invocation is a fresh cookieless client, so `new` followed by `export` now mints twice and 409s. Each line needs `-c cookies.txt -b cookies.txt` (or equivalent) so the session cookie persists across invocations, and the file should say in one line why that is needed now. Verify the corrected flow by actually running it against a local server rather than reasoning about it.

**`docs/CHANGING-THINGS.md:470`** still points at `Settings.work_dir`, which no longer exists — it is `sessions_dir` plus a per-session directory now.

`docs/DEPLOY.md` is the spec §6.6 runbook: numbered host-side steps, each saying what the author should see and what to paste back if they see something else. Cover creating the Python app, setting the Python version, Directory Privacy, AutoSSL, the first rsync, `tmp/restart.txt`, where session directories live, how to back them up, and how to read the Passenger log. First step is the egress diagnostic from Task 10.

`docs/FOR-HISTORIANS.md`: the URL, the shared password, their recovery key and what it is for, how to record narration with the microphone **and where to report it if that fails** — it has never run in a real browser and ships that way by the author's decision — how to find a photograph at loc.gov and upload it, how to cite it by hand now that the editor no longer fills in title, date, photographer and rights, and how to export a `.zip` to email back.

`docs/UNVERIFIED.md` currently lists the editor, welcome screen, drop zone, close dialog and microphone recorder as never seen in a browser. The author has viewed the editor and the welcome screen and believes the drop zone was exercised; correct it to match, and leave the close dialog and the recorder listed.

`docs/ARCHITECTURE.md` and `README.md` describe one global session and the acquisition tools that are now gone. Update both.

- [ ] **Step 1: Write the docs**

- [ ] **Step 2: Check every factual claim against the code**

Each file path, route, cap and command named in the docs must exist. Run `make check` once more.

- [ ] **Step 3: Commit**

```bash
git add docs README.md
git commit -m "Document deploying this, and using it as a historian"
```

---

## Self-Review

**Spec coverage.** §6.1 → Tasks 5, 6, 7, 8. §6.2 → Task 2. §6.3 → Task 10 (gated on §7's unanswered item). §6.4 → Task 10. §6.5 → Task 11. §6.6 → Task 12. §6.7 → Task 9. §6.8 (access control) → Task 12's runbook; it is cPanel configuration with no code, so it has no task of its own. §6.9 → Tasks 1 and 4. §6.10 → Task 3. §6.11 → Task 12. §9 and §10 are deferred by the spec and have no tasks. The one addition the spec does not name is Task 1, which fixes the bug that blocks §6.9.

**Gaps deliberately left.** `requires-python` and the Overpass mirrors both wait on spec §7 answers; Task 10 says what to do either way rather than guessing.

**Type consistency.** `PanoramaCandidate` keeps its field names and moves from `core/tools-api.ts` to `core/mapillary-search.ts`; `selectPanorama` and `PanoramaChoice` are untouched, which is why the move is safe. `sessions_dir` is the one name used across Tasks 5, 6, 8, 9 and 11. `valid_sid`/`new_sid`/`session_dir`/`sweep` are used in Tasks 6, 7 and 8 exactly as Task 5 and 8 declare them. `bundle.MAX_TOTAL_BYTES` and `media_store.MAX_TOTAL_BYTES` are different values and stay separate.

**Review Focus coverage.** Item 1 → Task 6 Step 1 `test_two_clients_get_their_own_tours`. Item 2 → `test_a_cookie_whose_directory_is_gone_reads_as_closed`. Item 3 → Task 5's parametrized refusals plus `test_session_dir_refuses_before_touching_the_filesystem`. Item 4 → `test_one_browser_one_session_directory` and `test_tour_data_does_not_mint`. Item 5 → Task 7's `test_an_unknown_key_is_404_and_opens_nothing` and `test_a_malformed_key_is_400`.
