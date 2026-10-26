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
 viewer   ViewerPage ──GET tour-data/*──►  StaticFiles mount ────────────►  content/work/
                                           (/tour-data)                      ├─ bundle.json
 editor   EditorPage                                                         ├─ tour.json
   surfaces ─► document-ops ─► EditorStore ─► Autosave                       ├─ config.json
                                    │            │                           └─ media/
                                    │            └──PUT /api/session/tour──► Session.write_tour
                                    └── ToolsApi / SessionApi ─/api/…──────► tools.py, media_store.py
```

### Backend (`backend/app/`)

| Module | Owns |
| --- | --- |
| `models.py` | The schema, and the single source of truth for it: `Tour`, `Stop`, `Overlay` and its three axes (`kind`, `anchor`, `display`), the `Credit` union, `DISPLAY_MODES_BY_KIND`, `SCHEMA_VERSION`. See ADR 0001. |
| `migration.py` | `migrate_v1_to_v2`: pure dict-in, dict-out. Stays in the tree because exported bundles in the wild are still v1. |
| `session.py` | The open document: a working directory (`content/work/`, from `config.py`). `Session.write_tour` validates then swaps atomically; `Session.new`, `replace_from`, `write_config`, `summary`. |
| `media_store.py` | The only door bytes enter `media/` through: sniffing, `ALLOWED_TYPES`, the content-hashed id, size caps, `orphan_ids`. |
| `bundle.py` | The `.zip` form of the document: `write_bundle`, `read_bundle`, and everything that makes importing an untrusted archive safe. `missing_media` is shared with export. |
| `publish.py` | `build_site`: the built Angular app plus the working directory under `tour-data/`, zipped. |
| `tools.py` | The acquisition tools (panorama search, place search, archive search, archive image fetch, narration) as functions over an injectable `httpx.Client`. ADR 0004. |
| `main.py` | `create_app`: the routes, the `/tour-data` mount, the SPA fallback, the cross-site guard (`_reject_cross_site`), and `_viewer_config`. Routing and HTTP status mapping only; the work is in the modules above. |
| `config.py` | `Settings`: Mapillary token, `content_dir`, `frontend_dist`. |

### Frontend (`frontend/src/app/`)

| Folder | Owns |
| --- | --- |
| `core/` | Shared by viewer and editor. `tour.models.ts` (TypeScript mirror of the schema), `tour-api.ts` (`TourApi`: reads `tour-data/`), `tour-store.ts` (`TourStore`: the viewer's walking state), `arrival.ts`, `geo.ts`, `credit.ts`, `config-store.ts`. Also the two **editor-only** HTTP clients, `session-api.ts` and `tools-api.ts`, which live here but are never used by the viewer. |
| `viewer/` | `viewer-page.ts` (`ViewerPage`): loads config and tour, composes `map/`, `panorama/`, `stop/`. Route `''` (and `**`). |
| `map/`, `stop/` | The viewer's minimap (`map-pane.ts`, `route.ts`) and stop panel (`stop-panel.ts`). |
| `panorama/` | Everything that touches mapillary-js or three.js, behind the `PanoramaViewer` interface (`panorama-viewer.ts`) and the `PANORAMA_VIEWER` token. `in-world-placement.ts`, `camera-sync.ts` and `edge-picker.ts` are the pure parts; `fake-viewer.ts` is the test double. Used by both the viewer and the editor. |
| `editor/` | Route `edit`. `document-ops.ts` (pure document transforms), `editor-store.ts` (`EditorStore`: draft, selection, undo, dirty), `autosave.ts` (`Autosave`), and the surfaces: `outline-pane.ts`, `inspector-pane.ts`, `edit-map-pane.ts`, `edit-panorama-pane.ts`, assembled by `editor-page.ts`. Pure helpers: `footprint.ts`, `nudge.ts`; `recorder.ts` wraps `MediaRecorder`. ADR 0003. |

`app.routes.ts` is the whole router: `''` and `**` are `ViewerPage`, loaded
eagerly; `edit` is `EditorPage`, lazy, so visitors never download editor code.

## Three flows

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

There is no "am I published?" check anywhere. One set of URLs is the whole
reason a published site needs no backend. `config.json` is written by the
backend on startup, `new` and `import` (`Session.write_config`, from
`_viewer_config`); it is derived state, not part of the document, and is not
in an exported bundle. The Mapillary token it carries is a public client
token and does travel with a published site.

Run the whole thing with `make serve` (FastAPI serves the API, `/tour-data`
and the built app on :8000). `ng serve`'s proxy (`frontend/proxy.conf.json`)
forwards only `/api`, so under it `tour-data/` is not reachable.

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
