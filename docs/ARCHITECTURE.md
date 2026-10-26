# Architecture

How the parts fit, what each layer is forbidden to do, and the three journeys
a piece of data takes. Read this in one sitting; then use
[`CHANGING-THINGS.md`](CHANGING-THINGS.md) to find where a given change goes.
The reasoning behind the non-obvious calls lives in the decision records
(`docs/decisions/`), which this document points at instead of repeating.

The one-sentence version: **a tour is a document** (`tour.json` plus a
`media/` directory), the **editor** changes that document through pure
functions and saves it whole, and the **viewer** reads it from files beside
the page, which is why a published tour needs no server.

## The parts

```
 browser                                   FastAPI (backend/app)            disk
 ───────                                   ─────────────────────            ────
 entry    EntryPage ──GET /api/session──►  session.summary()
            no answer → reveal the viewer in place (published site)
            open:true → /edit       open:false → WelcomePage (lazy)

 welcome  WelcomePage ─POST import / import-files / examples / new──────►  bundle.py,
                                                                          loose_import.py,
                                                                          examples.py
                                                                             │
 viewer   ViewerPage ──GET tour-data/*──►  StaticFiles mount ────────────►  content/work/
                                           (/tour-data)                      ├─ bundle.json
 editor   EditorPage                                                         ├─ tour.json
   surfaces ─► document-ops ─► EditorStore ─► Autosave                       ├─ config.json
                                    │            │                           └─ media/
                                    │            └──PUT /api/session/tour──► Session.write_tour
                                    └── ToolsApi / SessionApi ─/api/…──────► tools.py, media_store.py
   CloseDialog ──GET export, then DELETE /api/session──────────────────────► Session.close
```

### Backend (`backend/app/`)

| Module | Owns |
| --- | --- |
| `models.py` | The schema, and the single source of truth for it: `Tour`, `Stop`, `Overlay` and its three axes (`kind`, `anchor`, `display`), the `Credit` union, `DISPLAY_MODES_BY_KIND`, `SCHEMA_VERSION`. See ADR 0001. |
| `migration.py` | `migrate_v1_to_v2`: pure dict-in, dict-out. Stays in the tree because exported bundles in the wild are still v1. |
| `session.py` | The open document: a working directory (`content/work/`, from `config.py`). `Session.write_tour` validates then swaps atomically; `Session.new`, `replace_from`, `write_config`, `summary`. |
| `media_store.py` | The **upload** door into `media/`: sniffing, `ALLOWED_TYPES`, the content-hashed id, size caps, `orphan_ids`. It is not the only door — import has its own, and the two are not interchangeable. See "Media comes in by two doors" below. |
| `bundle.py` | The `.zip` form of the document: `write_bundle`, `read_bundle`, `stage_bundle_root`, and everything that makes importing an untrusted archive safe. `_check_media_file` is the import allowlist — see "Media comes in by two doors" below. `missing_media` is shared with export. |
| `loose_import.py` | `stage_loose_bundle`: a loose `tour.json` plus its media parts, zipped into an ordinary bundle. It validates every path and then hands off, so a loose drop gets the same allowlist, migration, orphan warnings and atomic swap as a `.zip`. Nothing here writes to the working directory. |
| `examples.py` | The tours that ship with the application: `list_examples`, `open_example`. An example is a directory under `content/examples/` holding `example.json` (id from the directory name, plus title, description, `document`, `mediaDir`) and a frozen `tour.json`. Opening one stages a bundle and hands it to `Session.replace_from`, so it is an import; it copies and never mutates the example. |
| `publish.py` | `build_site`: the built Angular app plus the working directory under `tour-data/`, zipped. |
| `tools.py` | The acquisition tools (panorama search, place search, archive search, archive image fetch, narration) as functions over an injectable `httpx.Client`. ADR 0004. |
| `main.py` | `create_app`: the routes, the `/tour-data` mount, the SPA fallback, the cross-site guard (`_reject_cross_site`), and `_viewer_config`. Routing and HTTP status mapping only; the work is in the modules above. |
| `config.py` | `Settings`: Mapillary token, `content_dir`, `frontend_dist`. |

### Frontend (`frontend/src/app/`)

| Folder | Owns |
| --- | --- |
| `core/` | Shared by viewer and editor. `tour.models.ts` (TypeScript mirror of the schema), `tour-api.ts` (`TourApi`: reads `tour-data/`), `tour-store.ts` (`TourStore`: the viewer's walking state), `arrival.ts`, `geo.ts`, `credit.ts`, `config-store.ts`. Also the two **editor-only** HTTP clients, `session-api.ts` and `tools-api.ts`, which live here but are never used by the viewer. |
| `entry/` | Route `''`. `entry-page.ts` (`EntryPage`): the three-way decision below, and `SESSION_PROBE_TIMEOUT_MS`. Eager, and deliberately small. Its CSS is load-bearing — read the comment in `entry-page.css` before changing it. |
| `welcome/` | The front door, a lazy chunk reached only from `EntryPage`. `welcome-page.ts` (`WelcomePage`) and `dropped-files.ts`, which is the pure part: `readDroppedFiles` walks a dropped directory with `webkitGetAsEntry`, and `sortDrop` files each part under `media/`, keeps its nesting, and filters what a tour cannot contain. |
| `viewer/` | `viewer-page.ts` (`ViewerPage`): loads config and tour, composes `map/`, `panorama/`, `stop/`. Routes `view` and `**`, and mounted in place by `EntryPage` at `''`. |
| `map/`, `stop/` | The viewer's minimap (`map-pane.ts`, `route.ts`) and stop panel (`stop-panel.ts`). |
| `panorama/` | Everything that touches mapillary-js or three.js, behind the `PanoramaViewer` interface (`panorama-viewer.ts`) and the `PANORAMA_VIEWER` token. `in-world-placement.ts`, `camera-sync.ts` and `edge-picker.ts` are the pure parts; `fake-viewer.ts` is the test double. Used by both the viewer and the editor. |
| `editor/` | Route `edit`. `document-ops.ts` (pure document transforms), `editor-store.ts` (`EditorStore`: draft, selection, undo, dirty), `autosave.ts` (`Autosave`), `close-dialog.ts` (the guard in front of deleting the working copy), and the surfaces: `outline-pane.ts`, `inspector-pane.ts`, `edit-map-pane.ts`, `edit-panorama-pane.ts`, assembled by `editor-page.ts`. Pure helpers: `footprint.ts`, `nudge.ts`; `recorder.ts` wraps `MediaRecorder`. ADR 0003. |

`app.routes.ts` is the whole router: `''` is `EntryPage` and `view` and `**`
are `ViewerPage`, all three eager; `edit` is `EditorPage` and the welcome
screen is a `@defer` block inside `EntryPage`, both lazy, so visitors download
neither.

### Routing: who is asking

Three audiences arrive at `/`. A member of the public opening a published tour
must get the tour. An author with a tour open should land in the editor. An
author with nothing open needs somewhere to import a bundle or open an
example, and is the only one of the three who may ever see the welcome
screen — a published site that asked its visitors to import a `.zip` would
have leaked the author's workbench, which is the failure `EntryPage` exists to
prevent.

A published site has no backend, so whether `/api/session` answers is the only
signal that separates the two worlds. `EntryPage` therefore probes it once:

| What the probe says | What happens |
| --- | --- |
| The request failed, or answered 200 with something that is not a session summary, or did not answer inside `SESSION_PROBE_TIMEOUT_MS` (2 s) | Reveal `ViewerPage` **in place**. No navigation, so the published URL is untouched. |
| `{"open": true, …}` | Navigate to `/edit`. |
| `{"open": false}` | Render the welcome screen, its own lazy chunk. |

Three things about that are deliberate and are easy to undo by accident.

- **A 200 is not proof of a backend.** A static host with SPA rewriting
  answers every unknown path with `index.html`, so the body's *shape* is
  checked (`isSessionSummary`: an object with a boolean `open`) and not just
  the status. The cost of believing a 200 is showing the workbench to the
  public.
- **The viewer is mounted before the probe resolves, not after.** It is in the
  DOM from the first paint and merely hidden, so its `tour-data/` fetches are
  issued concurrently with the probe and the published visitor pays no extra
  round trip — which is the same promise `''` kept by being `ViewerPage`
  outright. It is hidden rather than shown because in an authoring checkout
  with nothing open those fetches 404, and the viewer's "no tour is open"
  message must not flash in front of an author on their way to `/edit`.
- **Hidden means `visibility`, never `display`.** `.viewer-slot[hidden]` sets
  `display: block; visibility: hidden; pointer-events: none`, and the
  `display: block` is there to override the UA stylesheet's
  `[hidden] { display: none }` by hand. With no layout box the viewer's
  `tour-data/` fetches — which usually win the race against the probe — would
  have `MapPane` initialise Leaflet against a 0×0 container, and **nothing in
  `frontend/src` calls `invalidateSize` or watches for a resize**, so the map
  would stay grey after the reveal. `entry-page.spec.ts` reads the CSS as text
  and fails if `display: none` appears in that rule or if `display: block` and
  `visibility: hidden` do not, because jsdom computes no layout and cannot
  catch this any other way.

`view` exists because `/` now goes to the editor whenever a tour is open, so
without it the viewer is unreachable with a backend up; the editor's *Preview*
is a plain `<a href="/view">` and the full page load is the point. `**` is
still `ViewerPage` and not `EntryPage`, because the only URL that reaches it
is `index.html` under `<base href="./">` on a static host — a published site
by construction.

## Four flows

### 1. A tour is read

The viewer asks for three kinds of URL, all **relative to the page**:

```
tour-data/config.json      Mapillary token, tile URL, attribution
tour-data/tour.json        the document
tour-data/media/<mediaId>  photographs and audio
```

`ViewerPage.bootstrap` fetches the first two through `TourApi`
(`core/tour-api.ts`) and hands the tour to `TourStore.load`; `TourApi.mediaUrl`
builds the third. Nothing else in the viewer fetches anything of its own.

The same code serves two very different hosts:

- **In the editor**, FastAPI mounts the working directory at `/tour-data`
  (`_mount_tour_data` in `main.py`), so those URLs resolve to
  `content/work/…`. `EditorPage` loads its draft through the same `TourApi`.
- **In a published site**, `tour-data/` is simply a folder beside
  `index.html` (`<base href="./">` in `frontend/src/index.html` is what makes
  the URLs relative).

There is no "am I published?" check anywhere **in the viewer**. One set of URLs
is the whole reason a published site needs no backend. `EntryPage` does ask
the question, once, at `''` — see "Routing: who is asking" above — but it asks
it on the viewer's behalf and the viewer is never told the answer: it loads
from `tour-data/` either way. `config.json` is written by the
backend on startup and by every way a tour gets in — `new`, `import`,
`import-files`, `examples` (`Session.write_config`, from
`_viewer_config`); it is derived state, not part of the document, and is not
in an exported bundle. The Mapillary token it carries is a public client
token and does travel with a published site.

Run the whole thing with `make serve` (FastAPI serves the API, `/tour-data`
and the built app on :8000). `ng serve`'s proxy (`frontend/proxy.conf.json`)
forwards both `/api` and `/tour-data`, so the dev server reaches the open
tour as well. It forwarded only `/api` until the viewer was first run by
hand, which made every `tour-data/` fetch 404 under `ng serve` alone.

### 2. An edit reaches disk

```
surface (component)
   └─► store.apply(t => op(t, …))          op = a pure function from document-ops.ts
          └─► EditorStore: new draft, undo snapshot pushed, `dirty` becomes true
                 └─► Autosave's effect, debounced 500 ms (AUTOSAVE_DEBOUNCE_MS)
                        └─► SessionApi.putTour(draft)      PUT /api/session/tour, WHOLE document
                               └─► Session.write_tour: Tour.model_validate, then
                                   write to a sibling temp file, os.replace
```

Points worth knowing before you touch any of it:

- **Ops never mutate and signal refusal by returning the same reference.**
  `EditorStore.apply` treats `next === current` as "not an edit": no undo
  entry, no dirty flag, no save. A throwing op (`LastStopError`) records a
  message and changes nothing.
- **The whole document is sent every time, and the server validates before
  writing.** An invalid document is never written (so `tour.json` on disk is
  always schema-valid), and the `os.replace` swap means a crash lands on the
  old file or the new one, never a mix (so it always parses). A 422 surfaces
  as `Autosave.message`; the draft is untouched and the next edit retries.
- **At most one PUT is on the wire** (`Autosave.inFlight` / `queued`), so two
  versions cannot resolve out of order.
- **`PUT` does not migrate.** `write_tour` validates against the current
  schema only. Migration happens on import (`bundle._validate_tree`) and when
  the backend itself reads (`Session.tour`).
- **Media is uploaded before the document changes.** A new photograph goes
  `POST /api/session/media` → `store_media` → the server returns a `mediaId`
  → only then does the surface call `addMediaOverlay`. A refused upload
  therefore never touches the draft. Archive downloads and narration follow
  the same shape (`/api/tools/archive-fetch`, `/api/tools/narrate`).
- **Editor-only state stays out of the document.** `EditorStore` holds the
  panorama position, the manual-heading flags and the pending creator/licence
  answer; none is ever saved. ADR 0003.

### 3. A site is published

`GET /api/session/publish` → `build_site` (`publish.py`) zips:

```
<the built Angular app, frontend/dist/frontend/browser/…>   at the zip root
<the working directory, content/work/…>                      under tour-data/
```

That is all it is. Because flow 1 reads `tour-data/…` relative to the page,
unzipping onto any static host produces a working tour with no further step.
The `tour-data/` prefix is not cosmetic: Angular already emits a `media/`
directory for Leaflet's marker images, and tour media at the root would
collide with it (`test_leaflet_media_and_tour_media_do_not_collide`).
`build_site` refuses (409 from the route) when nothing is open or when
`make build` has not been run.

Note what publishing copies: **every non-dotfile in the working directory**.
That is why the import allowlist in `bundle.py` is strict: whatever is in the
working directory ends up served from the author's own origin. See ADR 0002.

Export (`GET /api/session/export`, `write_bundle`) is the same idea without the
application: `bundle.json`, `tour.json`, `media/`, with `config.json` and
dotfiles left out, and a 409 if the tour references media that is missing.

### 4. A tour gets in, and gets out again

Four ways in, and they converge:

```
a .zip                 POST /api/session/import        ─┐
a loose tour.json      POST /api/session/import-files  ─┤ stage a bundle zip
  plus its media         (loose_import)                 ├► Session.replace_from
a shipped example      POST /api/session/examples/{id} ─┘   (read_bundle: allowlist,
  (examples)                                                 migration, warnings,
                                                             staged atomic swap)
an empty tour          POST /api/session/new           ──► Session.new (skeleton)
```

`replace_from` is the whole of it: the three import paths differ only in how
they assemble a zip, so none of them repeats a validation, an allowlist, a
migration or the swap. That is why adding a fifth way in means producing a
bundle zip and handing it over, and not writing to the working directory —
see entry 9 in [`CHANGING-THINGS.md`](CHANGING-THINGS.md).

Out again is `DELETE /api/session` → `Session.close` → `_discard`, which is
the only code that removes the working directory (`Session.new(force=True)`
shares it). It refuses with 409 when nothing is open rather than agreeing with
a caller whose idea of the session is stale. The frontend half is ordered and
the order matters: autosave is stopped **before** the `DELETE`, because a
`PUT` already on the wire would land on a dead session, come back 409 and put
"Save failed" on screen over a close that worked; the draft store is cleared
**after**, because `EditorStore` is `providedIn: 'root'` and outlives the page.

## What each layer may not do

These constraints are the architecture. The file list above can be rediscovered
by reading; these cannot. Each says what enforces it, and where enforcement is
only convention, it says so.

**The viewer never calls `/api`.** A published site has no backend, so any
`/api` call in the viewer is a broken site. Everything the viewer needs comes
through `TourApi` from `tour-data/`. Pinned by the spec *"reads everything from
tour-data/ and never touches /api"* in `core/tour-api.spec.ts`, which proves it
for `TourApi`. What keeps the rest of the viewer honest is structural: only
`editor/`, `session-api.ts` and `tools-api.ts` mention `/api` or inject
`SessionApi`/`ToolsApi`, and the viewer's folders (`viewer/`, `map/`, `stop/`,
`panorama/`) import neither. No test asserts that; a new import would not fail
one.

**Components never contain document logic.** No browser runs in this
development environment, so anything inside a component's template or event
handler cannot be verified. Every change to the tour is therefore a pure
function in `document-ops.ts`, tested without Angular, and a component's job
is `store.apply(t => op(t, …))`. Geometry is likewise pulled out
(`footprint.ts`, `nudge.ts`, `in-world-placement.ts`, `route.ts`). This holds
for *transforming* the document. The honest exception is *sequencing*:
`outline-pane.ts` orchestrates upload-then-apply, and it infers why an op
refused (`refusalMessage`) by re-checking preconditions the op already
checked. That is workflow, not a document rule, but it is the nearest place
document knowledge could leak, so keep new rules in `document-ops.ts`.

**The client never names a stored media file.** The stored id is a slug of the
original name plus a content hash, chosen by `store_media`; the extension comes
from sniffing the bytes, not from the upload's claimed name or type. That one
rule removes path traversal, overwrite-by-guessing and extension smuggling
together (ADR 0004). The client sends bytes and receives a `mediaId`; it only
ever *reads* ids (`TourApi.mediaUrl`, `mediaKindOf`). Imported bundles are held
to the same definition (`bundle._check_media_file`), so the upload path is not
the only one policed.

**Media comes in by two doors, and they are not interchangeable.** Both decide
what counts as media, both sniff the bytes, and swapping one for the other
breaks a tour quietly.

- `bundle._check_media_file` is the **import** door. It sniffs and
  extension-checks and **preserves file names and nested directories**. It is
  reached by `read_bundle`, and therefore by `POST /api/session/import`,
  `POST /api/session/import-files` (through `loose_import.stage_loose_bundle`)
  and `POST /api/session/examples/{id}` (through `examples.open_example`).
- `media_store.store_media` is the **upload** door. It deliberately
  **renames** every file to `<slug>-<contenthash><ext>` and writes it flat
  into `media/`, which is what makes the "client never names a file" rule
  above true. It is reached by `POST /api/session/media` and by the two tools
  that produce a file (`archive-fetch`, `narrate`).

**Every path that brings a whole tour in uses the import door. Never
`store_media`.** The repository's own tour is the case that proves why: it
references media by exact name (`court-1863.jpg`) and six panoramas by nested
path (`"cachedPath": "media/pano/pano-historic-courthouse.jpg"`). Routed
through `store_media`, all nine of those `mediaId`s would be renamed and
`pano/` flattened under six new names, and the document would point at files
that no longer exist under the names it uses —
so the session's figures would not match and export would 409 on missing
media instead. `test_opening_the_fairfax_example_matches_the_recorded_figures`
in `backend/tests/test_examples.py` pins `stopCount` 6, `mediaCount` 15,
`orphanCount` 6 and the surviving names and paths precisely so that this
refactor fails loudly. The two lists also differ in content: import allows
`.jpeg`, `ALLOWED_TYPES` does not.

**Nothing in `make content` writes to `content/examples/`.** The shipped
example is a frozen committed snapshot, which is what keeps its figures
reproducible while `content/source/stops.json` and the seed tour drift
(`HANDOFF.md`, Outstanding item 2). Its `mediaDir` points at the shared
`content/media/`, because the pipeline regenerates those files under the same
names; it is the document that drifts, so it is the document that is frozen.
No test enforces the separation — it holds because no script under
`content/scripts/` names the directory.

**A heading is never set without the panorama gate.** An in-world photograph's
`headingDeg` must be derived from where the camera really stood, never from
`stop.location` (the building, not the camera; wrong by up to 178 degrees) and
never typed blind. The gate is `panoramaFixForStop(stop, fix)` in
`document-ops.ts`: it returns the fix only if `fix.imageId` equals the stop's
`panorama.imageId`, so a lagging panorama pane cannot supply the previous
image's position. Switching to `inWorld` (`setOverlayMode`), re-deriving
(`deriveOverlayHeading`) and the manual override (`setOverlayHeadingManual`)
all pass through it, and a refused heading means no change at all. **Caveat:**
the gate is enforced by those ops, not by the type system. `setInWorldField`
and `updateOverlay` will still write a `headingDeg` if a caller passes one.
No component does today; keep it that way.

**Nothing outside `panorama/` imports mapillary-js or three.** mapillary-js was
last published in 2023 and is expected to be replaced. Everything goes through
`PanoramaViewer`. Verified by search: only `mapillary-viewer.ts`,
`in-world-renderer.ts` and `camera-sync.ts` import them. Leaflet is imported by
`map/map-pane.ts` and `editor/edit-map-pane.ts` only.

**`models.py` is the schema; `tour.json` changes only through `Session`.**
The TypeScript interfaces mirror it by hand. `Session.write_tour` is the only
writer of `tour.json` in the app (import writes the migrated copy during its
staged swap), and it validates first.

**Every mutating route refuses a cross-site request.** `_reject_cross_site`
(Fetch Metadata `Sec-Fetch-Site: cross-site`) is a `Depends` on each POST/PUT
route, because those are CORS-simple requests that a hostile page could
otherwise fire at localhost. It is defence in depth, not authentication; there
is no login. A new mutating route must add it by hand.

## Where the tests stand in for a browser

Nothing visual is ever seen here, so the project's answer is to keep
behaviour in pure code and to pin duplicated rules mechanically. Two rules are
duplicated across Python and TypeScript, and a backend test reads the
TypeScript source and fails when the copies drift:

- the display-mode table: `DISPLAY_MODES_BY_KIND` in `models.py` vs
  `document-ops.ts` (`test_the_frontend_mode_table_matches_this_one`,
  `backend/tests/test_models.py`);
- the media extensions: `ALLOWED_TYPES` in `media_store.py` vs `IMAGE_EXTS` /
  `AUDIO_EXTS` in `document-ops.ts`
  (`test_the_frontend_extension_lists_match_the_allowed_types`,
  `backend/tests/test_media_store.py`).

Copy that pattern for any new duplicated rule; it is cheaper than a document
that goes stale. Not everything is covered: `tour.models.ts` is a hand-kept
mirror of `models.py` with **no** drift test (it is checked only by the
TypeScript compiler wherever a type is used), and the media-type rule has
copies the extension test does not see. Both are spelled out in
[`CHANGING-THINGS.md`](CHANGING-THINGS.md).

## Content pipeline

`content/scripts/` (`make content`) still generates the committed seed tour
`content/tours/fairfax-old-town.json` from `content/source/stops.json`. It is
independent of the editor, shares only the schema (`build_tour.py` imports
`SCHEMA_VERSION` and `Tour` from `app.models`), and its hand-edits are not read
back. The acquisition tools in `tools.py` were lifted from these scripts rather
than rewritten (ADR 0004). Caution: `stops.json` has drifted from the hand-tuned committed tour, so `make content` would revert the hand alignment; whether to retire the pipeline is the author's open call (`HANDOFF.md`, Outstanding item 2).

## Decision records

| Record | Read it for |
| --- | --- |
| [0001](decisions/0001-three-axes-for-overlays.md) | Why `kind`, `anchor` and `display` are independent, and the display-mode table. |
| [0002](decisions/0002-the-tour-is-a-portable-document.md) | Why the tour is a bundle + working directory, why publishing is a copy, and the bundle's safety rules. |
| [0003](decisions/0003-the-editor-is-three-surfaces-on-one-state.md) | Why pure ops over one store, whole-document undo and autosave. |
| [0004](decisions/0004-media-comes-in-by-content-and-tools-wrap-the-scripts.md) | Why the client never names a file, and why the scripts became endpoints. |
