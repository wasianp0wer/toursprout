# Handoff

Last consolidated 2026-10-26, on branch `feature/authoring-app`. Figures below
were taken from running `make check`, not from memory. The first half of this
file is the present; everything from "History" down is dated and kept because
its landmines still bite.

## What this is

A digital-humanities prototype turned authoring application: a virtual
historical walking tour of Old Town Fairfax, Virginia, told over real
street-level Mapillary panoramas, with archival photography draped into the
scene (three.js), a Leaflet minimap, and narration. The tour is a portable
document (`tour.json` plus `media/`), authored in an editor at `/edit` and
publishable as a backend-free static site. The **schema** is the part meant
to survive into a real framework.

For how the parts fit, read [`ARCHITECTURE.md`](ARCHITECTURE.md). For where a
given change goes, read [`CHANGING-THINGS.md`](CHANGING-THINGS.md). For why the
non-obvious calls were made, see the records in `docs/decisions/`
(start at its `README.md`). This file does not repeat them.

## Current state

**Tests:** 407 backend (pytest), 598 frontend (Vitest); lint and production
build clean via `make check`. Eager bundle 2.15 MB raw / 372.02 kB transferred;
the editor is a lazy chunk, 102.13 kB raw / 23.77 kB transferred, and the
welcome screen is another, 11.62 kB raw / 3.81 kB transferred.

Two warnings in that run predate this branch and are not yours to chase: the
backend suite reports two deprecations from inside starlette and fastapi
(`httpx` with `starlette.testclient`, and the `anyio.abc.BlockingPortal`
alias), and `ng build` warns that `leaflet`, used by `edit-map-pane.ts`, is
not ESM and may cause optimization bailouts.

**The editor and the welcome screen have never been seen in a browser.** No
browser can launch in the development sandbox, so the editor, its microphone
recording, its acquisition tools and the whole front door — drop zone, close
dialog and all — have *never* been seen running. Their verification is the
jsdom suite plus the backend tests, which prove the logic, not the pixels. The
viewer predates the editor and was probably worked on with a browser in
earlier sessions (the hand alignment in `de48b0d` was probably tuned by eye),
but that is an inference from a landmine note, not a recorded fact; this
environment cannot reproduce or re-check any of it.

The checklist for the first browser session, in the order to do it, is
[`UNVERIFIED.md`](UNVERIFIED.md).

**What exists:**

- **A front door** (`/`). `''` is no longer the viewer: it is a small eager
  `EntryPage` that probes `GET /api/session` with a 2 s deadline and resolves
  three ways. Request failed, a 200 that is not a session summary (what a
  static host with SPA rewriting answers), or the deadline → render the
  **viewer in place**, no navigation, which is the published-site case.
  `{open: true}` → go to `/edit`. `{open: false}` → the welcome screen, a
  lazy chunk. The viewer is mounted from the first paint and merely hidden
  while the probe runs, so its `tour-data/` fetches are already in flight and
  a published visitor pays no extra round trip. See `ARCHITECTURE.md`,
  "Routing: who is asking".
- **Welcome screen** (the `{open: false}` branch of `/`). The only screen that
  can get a tour into the session, and there are four ways: drop or browse to
  a `.zip` bundle; drop or browse to a loose `tour.json` with its `media`
  folder (the document must be named exactly `tour.json`); start an empty
  tour from a title; or open an example in one click. Guide links are present
  and inert by the author's decision. With no examples configured the example
  block is absent, which is the state every author but this one is in.
- **Viewer** (`/view`, and `/` on a published site). Six stops, all working:
  Historic Courthouse, Marr Monument,
  Old Town Hall, Ratcliffe-Allison-Pozer House, Fairfax Museum, City Hall.
  Ground arrows navigate image by image; the arrow toward the next stop is
  highlighted (mapillary-js `highlightId`). Arriving at a stop's designated
  panorama moves the tour there; proximity (30 m) is the fallback for street
  images belonging to no stop. The courthouse carries two Library of Congress
  photographs (1863 with Union cavalry, c.1918 arcade) as three.js planes in
  the world, each with an opacity slider; a stop opens with the first ghosted
  in and the rest hidden. The Leaflet minimap has numbered pins and a route
  polyline; the current stop is gold and drawn on top; clicking a pin moves the
  tour. The viewer loads everything from `tour-data/` beside the page, with no
  `/api` call. `/view` exists because `/` now goes to the editor whenever a
  tour is open; `**` still resolves to the viewer for `index.html` under
  `<base href="./">`.
- **Editor** (`/edit`). Four surfaces over one draft: outline, numeric
  inspector, editable map, editable panorama; undo; debounced autosave through
  the session API. It names the tour, writes stop text, places media, uploads
  images and audio, records narration from the microphone, and has four
  acquisition tools (panoramas, places, archive search/fetch, narration) backed
  by `backend/app/tools.py`. Its top bar carries *Preview* (a plain link to
  `/view`, so a full page load) beside Export and Publish. It no longer has a
  "no tour is open" empty state — the welcome screen owns creating a tour, so
  `/edit` with nothing open navigates to `/`.
- **Close tour** (the editor's top bar). The only way back to the front door,
  and it is guarded, because the working directory is the only copy that
  exists: the dialog names the tour, its stop count and its media count, says
  closing deletes the working copy, and will not arm *Close and delete* until
  the author has either downloaded `tour.zip` or ticked the acknowledgement.
  The download is a `fetch` of `GET /api/session/export` as a blob, so the
  transfer resolving is the proof that releases the gate and `blob.size` is
  the size shown. An export that 409s (the document references media the
  archive has not got) is reported and does **not** block the close — the
  acknowledgement is still the way out, so nobody is trapped in a tour they
  cannot leave. Closing then runs, in this order: stop autosave → `DELETE
  /api/session` → clear the draft store → navigate to `/`. Autosave first,
  because a `PUT` already on the wire lands on a dead session and 409s, and
  "Save failed" over a close that worked is the misleading message this branch
  exists to remove.
- **Session API.** The open tour is an unpacked working directory
  (`content/work/`, git-ignored) that every edit writes through to; there is no
  explicit save. A session API opens, edits, closes, exports and publishes it
  as a `.zip`. The whole surface:

  ```
  GET    /api/session                      {"open": false} or a summary
  DELETE /api/session                      discard the working copy; 409 if nothing is open
  POST   /api/session/new                  {"title": …}; 409 unless {"force": true}
  GET    /api/session/examples             {"examples": [{id, title, description}]}
  POST   /api/session/examples/{id}        409 if open, 404 unknown, 400 malformed
  POST   /api/session/import               form field `file`, one .zip
  POST   /api/session/import-files         form field `files`; each part's FILENAME is
                                           its bundle-relative path (media/pano/x.jpg)
  PUT    /api/session/tour                 the whole document; 409 if nothing is open
  POST   /api/session/media                one upload, through store_media
  GET    /api/session/export               the .zip; 409 on missing media
  GET    /api/session/publish              a backend-free static site
  ```
- **Shipped examples.** `content/examples/<id>/` holds `example.json` (title,
  description, `document`, `mediaDir`) and a frozen `tour.json`;
  `backend/app/examples.py` stages it as a bundle and hands it to
  `Session.replace_from`, so opening one is an import and reuses every
  guarantee import already makes. The one entry today is
  `content/examples/fairfax-old-town/`, whose `mediaDir` points at the shared
  `content/media/`. **Opening an example copies; it never mutates the
  example**, and nothing in `make content` writes to `content/examples/` —
  pinned by two tests in `backend/tests/test_content.py` that read the scripts
  and the Makefile's `content:` recipe as text and fail if either names that
  directory.
- **Publish.** `GET /api/session/publish` returns a static site (built app plus
  the working directory under `tour-data/`).
- **Content pipeline.** `make content` still generates the seed tour
  `content/tours/fairfax-old-town.json` from `content/source/stops.json`. It is
  independent of the editor. It has **not** been retired; see Outstanding
  item 2.

## Running it

```sh
make serve     # builds frontend, serves API + bundle on :8000
make check     # lint + both suites + production build
make content   # regenerate panoramas, images, narration, tour JSON
make e2e       # Playwright; cannot run inside the sandbox
```

With `make serve` running, open <http://localhost:8000/> and the application
sorts out where you belong: the welcome screen if nothing is open, the editor
if something is. <http://localhost:8000/view> is the viewer, which `/` no
longer reaches while a tour is open. Edits autosave to the working directory.

`make content` only regenerates `content/tours/fairfax-old-town.json`; nothing
reads that file into the open session automatically, so there is no SQLite
seeding left to restart the backend over. The welcome screen at `/` is the
normal way to open a tour; everything below is the same thing without a
browser, which is the only way to do it in this development sandbox. `PUT` and
`POST` bodies are JSON, so every command that sends one needs the
content-type header: `curl -d` alone sends
`application/x-www-form-urlencoded`, which FastAPI hands to pydantic as raw
bytes and pydantic refuses with a 422 (`{"type":"dict_type",...}`):

```sh
curl -X POST localhost:8000/api/session/new \
  -H 'Content-Type: application/json' -d '{"title": "A tour"}'      # start empty
curl -X POST localhost:8000/api/session/import -F file=@tour.zip    # open a bundle
curl localhost:8000/api/session/examples                            # what examples exist
curl -X POST localhost:8000/api/session/examples/fairfax-old-town   # open one, media and all
curl -X PUT localhost:8000/api/session/tour \
  -H 'Content-Type: application/json' -d @tour.json                 # write the document
curl localhost:8000/api/session/export -o tour.zip                  # save it out as a zip
curl localhost:8000/api/session/publish -o site.zip                 # a backend-free static site
curl -X DELETE localhost:8000/api/session                           # discard the working copy
```

`DELETE /api/session` is what the editor's *Close tour* calls. It deletes
`content/work/` and there is no undo: export first. It refuses with 409 when
nothing is open, which is deliberate — a caller asking to close nothing has a
stale idea of the session, and saying so beats agreeing with it.

Loose files go to a second import route, which is what the welcome screen's
drop zone uses. Each part's *filename* is its path inside the bundle, so
nested media keeps its directory:

```sh
curl -X POST localhost:8000/api/session/import-files \
  -F 'files=@content/tours/fairfax-old-town.json;filename=tour.json' \
  -F 'files=@content/media/court-1863.jpg;filename=media/court-1863.jpg' \
  -F 'files=@content/media/pano/pano-historic-courthouse.jpg;filename=media/pano/pano-historic-courthouse.jpg'
```

The document has to arrive as `tour.json`; the route refuses the whole drop
over a part it does not recognise, a hidden (dot-prefixed) path component, or
the same bundle path twice. The welcome screen filters those out *before*
posting — which is the whole point of the loose-file path, since
`content/media/` holds a `manifest.json` beside the photographs — and names
what it left out. `curl` does not filter, so it is the caller's job here.

Every edit above writes straight through to `content/work/`. See
`docs/decisions/0002-the-tour-is-a-portable-document.md` for why "save" works
this way instead of writing back to an opened file.

`POST /api/session/new` refuses with 409 if a tour is already open: export it
first, or pass `{"force": true}` in the body to discard it on purpose.
`PUT /api/session/tour` refuses with 409 if nothing is open yet. The mutating
routes also refuse a request whose `Sec-Fetch-Site` header is `cross-site`, as
one more layer against another page quietly POSTing to this backend while it
happens to be running; `curl` never sends that header, so none of this is
visible from the command line.

`?diag=1` on the viewer exposes `window.__tour` and `window.__inWorld` and logs
renderer boundaries.

### Opening the existing six-stop tour

**Open <http://localhost:8000/> and click *Old Town Fairfax* under "Open an
example".** That is the whole procedure now. The six-stop hand-authored tour
is a shipped example (`content/examples/fairfax-old-town/`), and opening it
creates the session, writes the document and copies the media through the
import allowlist in one request — the `curl` and `cp` sequence below, done
server-side and atomically, with `manifest.json` excluded rather than copied
and later refused.

Verified against a live backend (a throwaway one on a temp `CONTENT_DIR`, so
the author's own `content/work/` was never touched):
`POST /api/session/examples/fairfax-old-town` returns `"stopCount": 6`,
`"mediaCount": 15`, `"orphanCount": 6` and six informational warnings, one per
panorama (`media/pano/pano-<stop>.jpg is not referenced by any overlay`), and
`GET /api/session/export` then returns the same 4.5&nbsp;MB zip as before
(4,536,271 bytes). The equivalent loose import — `tour.json` plus every
image and audio file under `content/media/`, posted to
`/api/session/import-files` — was run against the same backend and returns
the same three figures and the same six warnings. The *drop zone* that would
do that from a browser is a separate matter and is unverified
(`UNVERIFIED.md` entry 14). A backend test
(`test_opening_the_fairfax_example_matches_the_recorded_figures`) pins all
three figures and the surviving names and `media/pano/` paths, so a future
refactor that routed examples through the upload path fails loudly.

#### The headless fallback

**Kept because this development sandbox has no browser**, so the paragraph
above cannot be run here; it is not a second bootstrap procedure, it is the
same one without a window. Run from the repo root with `make serve` up:

```sh
curl -X POST localhost:8000/api/session/examples/fairfax-old-town
```

That one line replaces everything below it, and the rest of this section is
kept only to explain what it does and what used to go wrong. The long way,
which is still what to reach for with a tour that is *not* a shipped example:

```sh
curl -X POST localhost:8000/api/session/new \
  -H 'Content-Type: application/json' -d '{"title": "Old Town Fairfax"}'

curl -X PUT localhost:8000/api/session/tour \
  -H 'Content-Type: application/json' -d @content/tours/fairfax-old-town.json

# Copy the media, but not manifest.json. *.jpg and *.m4a are the three
# archival photographs and the six narration clips; pano/ is the cached
# panoramas the stops' cachedPath fields point at.
cp content/media/*.jpg content/media/*.m4a content/work/media/
cp -R content/media/pano content/work/media/

curl localhost:8000/api/session/export -o fairfax-old-town.zip
```

**The copy step is not optional and nothing else performs it.** Without it,
`GET /api/session` reports `"mediaCount": 0`, every photograph and narration
clip the viewer tries to load 404s, and the bundle `export` produces is one
`import` later refuses — the document references media the archive doesn't
have. The example route exists because this step was forgotten, and the
welcome screen exists because this whole section was the only way in.

**Do not copy `content/media/manifest.json`, and do not use
`cp content/media/*`.** That glob sweeps the manifest in, and import refuses
it: `media/` may hold only the image and audio types uploads accept, because
the published site serves `tour-data/` from the author's own origin and
anything else there (an `.html`, say) would run as executable content.
Import holds bundled media to the same allowlist uploads face. The refusal is
correct; the earlier version of this procedure was wrong. The glob also
skips `pano/` (a directory), which is why `pano/` is copied separately.

This was run end to end against a live backend with `curl` (not
`TestClient`, not from memory) to write this section:

- After the `PUT`, `GET /api/session` reports `"stopCount": 6` and
  `"mediaCount": 0` — the document is in, the media is not.
- After the two `cp` commands (both exit 0), it reports `"mediaCount": 15`
  (three photographs, six narration clips, six panoramas) and
  `"orphanCount": 6`.
- `GET /api/session/export` returns a 4.5&nbsp;MB zip (4,536,271 bytes).
- Re-importing that zip (`curl -X POST localhost:8000/api/session/import -F
  file=@fairfax-old-town.zip`) returns 200, `"stopCount": 6`,
  `"mediaCount": 15`, and six warnings, one per panorama: `media/pano/
  pano-<stop>.jpg is not referenced by any overlay`. These are informational.
  The panoramas are cached copies named by `cachedPath`, not overlay images,
  and the importer keeps them.
- For contrast, the old `cp content/media/*` sequence reported
  `"mediaCount": 10` and exported 2.6&nbsp;MB, and re-importing it failed with
  400 `bundle contains a file that is not an allowed image or audio type:
  media/manifest.json`.

## Architecture, at a glance

| Layer | Choice | Why |
| --- | --- | --- |
| Map geometry, place identity | OpenStreetMap / Overpass | OSM has **no** street-level imagery |
| Street-level imagery | Mapillary, CC-BY-SA 4.0 | the only open 360 source with Fairfax coverage |
| Panorama viewer | mapillary-js 4.1.2 | stale (2023) but the only viewer for its format; contained behind `PanoramaViewer` |
| Rephoto rendering | three.js 0.134 via `addCustomRenderer` | tags cannot carry an image texture |
| Minimap | **Leaflet 1.9** | see Dead ends |
| Backend | FastAPI, pydantic | pydantic models are the single source of truth for the schema |

The full picture is in [`ARCHITECTURE.md`](ARCHITECTURE.md).

## Environment landmines

`docs/ENVIRONMENT.md` is the full list and is worth reading before debugging
anything. The ones that cost the most time:

- **Never use `urllib`**: it truncates through the egress proxy (~1 in 10).
  `httpx` everywhere.
- **`UV_CACHE_DIR`** must point inside the repo or every uv command fails.
- **Node 24** at `/Users/maddiepersonal/.local/share/fnm/node-versions/v24.21.0/installation/bin`;
  ambient `node` is v25, which Angular 22 rejects. The Makefile pins it.
- **Angular's build cache must stay disabled** or `ng build` SIGABRTs with no
  output at all.
- **No browser can launch in this sandbox.** Playwright specs exist but cannot
  run here; the jsdom integration suite carries the verification weight.
- **mapillary-js renders on demand.** Changing custom content does nothing
  until `triggerRerender()`. A screenshot taken after mutating the scene shows
  a **stale frame**; this produced two wrong root-cause conclusions.
- **`geodeticToEnu` altitude is absolute**, not height above ground.
- **`setCenter` takes basic image coordinates**, not compass bearings.
- **Never reintroduce a guessed bearing.** Stop bearings and rephoto headings
  are **derived** in `build_tour.py` (and by the editor) from where each
  panorama actually stands. All six hand-authored bearings were wrong, one by
  138 degrees, which put the subject behind the viewer.
- **The v1 fixture is frozen.** `backend/tests/fixtures/fairfax-old-town-v1.json`
  must never be refreshed; it is what proves `backend/app/migration.py` is
  lossless. Migration upgrades v1 to v2 on every read path so only v2 exists
  above the parsing boundary (ADR 0001).

## Dead ends

**MapLibre was removed.** Under Angular's esbuild build, maplibre-gl 6.10
renders raster tiles but **no GeoJSON source ever finishes loading**: no error
on the map's error channel or the worker's, reproducing on a fresh map with an
empty style and one point. Ruled out: worker URL, glyph-less symbol layer,
layer order, container sizing, projected positions. Leaflet suits this minimap
better anyway (raster basemap, one polyline, six pins) and cut 850 kB. Do not
go back without a new idea.

## Outstanding

Every item below is still true as of 2026-10-26. None has been closed.

1. **Rephoto alignment is unfinished.** The anchors are estimates, improved by
   hand in commit `de48b0d` but not finished. The tool for finishing it is the
   editor at `/edit`: select the photograph, drag it on the map, then adjust
   height, size and opacity in the panorama pane and inspector, with the
   heading derived from the panorama's real position. What remains is the
   author's: someone has to do that in a browser and look at the result.
   Nothing in the editor has been seen rendering, and this cannot be closed
   from an environment where no browser runs.
2. **`content/source/stops.json` has silently drifted from the shipped
   document. This is the author's decision, and it is open.** Commit `de48b0d`
   ("adjustment") hand-edited the rephoto anchors directly in
   `content/tours/fairfax-old-town.json` to improve the alignment of the two
   courthouse photographs, but `stops.json`, which is what `build_tour.py`
   actually reads, was never updated to match. The next `make content` silently
   reverts that alignment work. Worse, a reviewer independently recomputed the
   derived heading from the hand-tuned anchor positions and got 105.0 and
   147.2 degrees, where the shipped document currently stores 113 for both, so
   the stored heading is already inconsistent with its own anchor position.
   `build_tour.py` and the Makefile's `content:` target both warn about this.
   The choice: either sync `stops.json` to the hand-tuned coordinates (which
   would also change the derived headings to 105.0/147.2), or let the editor
   take ownership of the document and retire `stops.json` entirely. The editor
   is now able to take ownership whenever the author says so; until they do,
   **the content pipeline stays**, and so does the drift. The shipped example
   does **not** resolve this and is not affected by it:
   `content/examples/fairfax-old-town/tour.json` is a frozen committed
   snapshot (identical in content to the seed tour today, but its own file),
   and nothing in `make content` writes to `content/examples/` — which is now
   a test rather than a coincidence (`test_content.py`). That is why
   the example's recorded figures stay reproducible whatever the pipeline
   does — and it is also one more copy of the document to keep in mind when
   this item is finally decided. Nobody here can
   judge either change by eye, because the alignment was probably tuned in a browser
   (an inference, see above) and none can run in this environment.
3. **Rephotography is demonstrated at one stop.** Targeted searching found
   essentially no Old Town Fairfax imagery for the other five, only the
   courthouse and, possibly, Earp's Ordinary (HABS). Local collections (Fairfax
   Museum, Virginia Room) are the gap to fill. `fetch_rephotos.py` takes a date
   preference so one site can layer several eras.
4. **The historical text is unreviewed.** Written for the prototype, not
   sourced. It lives in `content/source/stops.json` so it can be corrected
   without touching code (and, if item 2 is resolved toward the editor, in the
   document itself).
5. **The Marr Monument editorial question is unresolved.** It stands 14.6 m
   from the courthouse, so one ground-arrow step moves the tour to it. It was
   folded into the courthouse stop and then restored to a stop of its own; the
   repo is currently six stops and self-consistent.
6. **Courthouse narration is long** (~660 kB, about a minute) since it is the
   richest stop. Splitting it would need overlay-level narration, which
   `make_narration.py` does not do.
7. **Schema v2 changed two things on screen at the courthouse stop, and
   nobody has decided whether to keep them.** The overlay list badge now
   reads `IMAGE` instead of `REPHOTO` for the two draped photographs, and
   selecting one now also shows an `<img>` thumbnail in the panel on top of
   the ghosted plane in the panorama (stop-panel.ts's `@switch` on `kind`
   hits the `'image'` case that v1's `'rephoto'` kind fell through). Both
   are arguably improvements; see the Costs section of
   `docs/decisions/0001-three-axes-for-overlays.md`. Current behaviour is
   pinned by tests in `stop-panel.spec.ts` so the choice stays explicit.
8. **Unverified, from sub-project 3b (media and acquisition):**
   - Recorded audio against the sniffer in a real browser. The MP4 brand is
     the risk, in Safari and also in Chromium, whose recorder prefers MP4 where
     `isTypeSupported` allows (`UNVERIFIED.md` entries 8 and 9).
   - A real loc.gov redirect through `archive-fetch`.
   - Overpass mirrors other than `overpass-api.de`, which answered in 34-42 s
     from this machine against a 15 s client timeout.

   `UNVERIFIED.md` gives the check that closes each. (The frontend
   `IMAGE_EXTS`/`AUDIO_EXTS` lists are mirrored by hand but are now tied to
   the backend allowlist by a test in `backend/tests/test_media_store.py`.)

   The tools were run once against the live Mapillary, Overpass and loc.gov
   services, which found that the loc.gov parser read `creator` and `rights`
   fields that do not exist at the top level of a result; fixed. See
   `docs/decisions/0004-media-comes-in-by-content-and-tools-wrap-the-scripts.md`.

9. **Two document rules are enforced by their callers, not by the pure
   layer.** `setInWorldField` normalises and writes `headingDeg` without
   consulting `panoramaFixForStop`, and `updateOverlay` spreads a
   `Partial<Overlay>` verbatim, so either would accept a heading ungated. The
   gate lives in `setOverlayMode`, `deriveOverlayHeading` and
   `setOverlayHeadingManual`, which do call it first. **No component reaches
   the ungated path today** — every pane was checked, and they pass only
   `widthM`, `heightM`, `opacity`, `title` and `body` — so this is a latent
   hazard, not a live bug. `setOverlayKind` has the same shape: no
   precondition check in the pure layer.

   It matters because a derived heading was once wrong by 178.4°, and
   refusing rather than guessing is the project's one inviolable rule. The
   cheap fix is to narrow `setInWorldField`'s patch type so it cannot carry
   `headingDeg`, and give the gated ops a private writer. Found while writing
   `ARCHITECTURE.md`, which is also where the other six enforcement gaps that
   pass found are listed.

## Conventions used

- **TDD throughout**: failing test first, watch it fail, then implement. Every
  bug fixed landed with a test reproducing it.
- **Superpowers skills**: brainstorming before features, writing-plans for
  specs, systematic-debugging for bugs. Specs and plans are in
  `docs/superpowers/`.
- **Commits**: let git use its own config. Do **not** pass
  `-c user.email=...`; that overrode the user's identity earlier and had to be
  rebased.

## History

Dated, oldest first. Kept because it explains where the landmines came from.

### 2026-10-13 (commit `e44633c`): the prototype

A proof of concept: no editor interface, no multi-tour authoring, one
hand-authored tour. Six stops, walkable, courthouse rephotos, minimap, and an
alignment mode (`?align=1`) that nudged the selected rephoto by keyboard and
emitted anchor JSON to paste into content. Tests then: 173 backend, 213
frontend. Bundle 2.04 MB raw / 348.40 kB transferred. `?align=1` was retired
when the editor landed; `/edit` replaces it (ADR 0003).

### Sub-project 1: schema v2

Added `backend/app/migration.py` and the frozen v1 fixture (see the landmine
above). ADR 0001 explains why the schema split into three axes.

### Sub-project 2: the tour as a portable document

The open tour became an unpacked working directory (`content/work/`) the
backend writes through to; a session API opens, edits, exports and publishes it
as a `.zip`; the viewer loads everything from `tour-data/` with no `/api` call.
The read-only API, the SQLite database behind it, and `media.py`'s hand-rolled
Range handling (superseded by `StaticFiles`) were removed. ADR 0002, including
the one place it departs from the agreed design.

### Sub-project 3a: the editing core

The editor at `/edit`; `?align=1` and `frontend/src/app/align/` removed.
Figures then: 197 backend, 397 frontend; eager bundle 2.13 MB raw / 371.45 kB
transferred; editor chunk 75.99 kB raw / 17.95 kB transferred. ADR 0003,
including the heading-derivation gate.

### Sub-project 3b: media and acquisition

Uploads and microphone recording (`backend/app/media_store.py`) and four tools
(`backend/app/tools.py`) wired into the editor. Figures then: 302 backend, 521
frontend. Live-service findings are under Outstanding item 8. ADR 0004.

### 2026-10-26: bootstrap procedure corrected

The "Opening the existing six-stop tour" procedure under Running it was first
written before the media allowlist existed. The allowlist (commit `54c39cd`)
broke it; it was re-run against a live backend and corrected (commit
`0978c57`). Its figures are observed, not estimated.

### Sub-project 4: documentation

`ARCHITECTURE.md`, `CHANGING-THINGS.md`, `UNVERIFIED.md`, and this file
consolidated so the current state comes first and history after. Writing the
architecture map turned up seven places where the code did not hold to what
the architecture claimed; all seven are recorded in those documents rather
than smoothed over, and the one that matters most is in Outstanding item 9.
A comment pass added six why-comments and corrected ten stale ones, most of
them sprint-relative phrases ("Task 3", "this sub-project") that meant
nothing to a reader arriving later. Figures then: 320 backend, 528 frontend.

### 2026-10-26: the viewer was run for the first time

The author started the backend and the viewer reported *"Could not reach the
tour service. Is the backend running on port 8000?"* while the backend was
up and answering. The viewer never calls `/api`: it fetches
`tour-data/config.json` and `tour-data/tour.json`, and both 404'd because the
working directory was empty — no session had been created. The message named
the one fix that could not work.

Two defects, both fixed in commit `53f57ca`:

- The bootstrap catch reported every failure as an unreachable backend. A 404
  now says no tour is open and points here; a dead connection still names the
  port.
- `frontend/proxy.conf.json` forwarded only `/api`, so under `ng serve` the
  viewer's two `tour-data/` fetches 404 whatever the backend is doing. It now
  forwards `/tour-data` as well. This had been recorded as a known gap in
  `ARCHITECTURE.md` before it was ever hit.

The editor carried the same defect and was fixed in the same way a moment
later (commit follows): `/edit` reported an unreachable backend while
`/api/session` was answering, because the session said a tour was open and
`tour-data/tour.json` then 404'd. That 404 was the proxy gap again — the dev
server reads `proxy.conf.json` once at startup, so a server started before
the fix keeps the old config. Restarting `ng serve` is the fix, and the
message now says so.

Figures after: 320 backend, 530 frontend.

**This is the first thing a real run found, and it was a message that sent
the reader to the wrong place.** `UNVERIFIED.md` exists for exactly this; its
first entry is still the right place to start. (It was "the editor loads at
all" when this was written; the front door below put a new entry in front of
it.)

### Sub-project 5: the front door

The run above left the honest message "no tour is open", which was an
improvement and still not usable: the application had no way to get data into
itself, and everything that put a tour in the session was a `curl` transcribed
out of this file. So `''` stopped being the viewer and became a decider.

What landed: a three-way `EntryPage` at `''`; a lazy welcome screen with a
drop zone, a *New empty tour* box and a shelf of examples; `DELETE
/api/session`, `GET /api/session/examples`, `POST /api/session/examples/{id}`
and `POST /api/session/import-files`; the Fairfax tour as a frozen committed
example under `content/examples/`; a guarded *Close tour* in the editor, with
the blob download that releases its gate; a *Preview* link; and an explicit
`view` route. The editor's "no tour is open" empty state was removed, so there
is one front door and not two.

Two things worth keeping in mind afterwards:

- **The eager bundle barely moved** — 2.13 MB raw / 371.39 kB transferred
  before, 2.15 MB / 372.02 kB after — because the welcome screen is its own
  11.62 kB chunk and a published visitor never fetches it. That was the
  constraint the whole routing design was built around.
- **A published visitor now pays a probe.** It is issued concurrently with
  the viewer's own `tour-data/` fetches, so a refused connection costs
  nothing measurable; a host that *black-holes* `/api/session` instead costs
  the full 2 s deadline, as a blank page. That is a deliberate trade and it is
  written down in `UNVERIFIED.md` entries 20 to 22 rather than left to be
  rediscovered.

Figures after: 407 backend, 598 frontend. The last two of those arrived with
this documentation pass rather than the feature: writing down "`make content`
leaves `content/examples/` alone" turned out to be a claim nothing enforced,
so `test_content.py` now enforces it.

The front door has never been seen in a browser either, so it arrives with
thirteen new `UNVERIFIED.md` entries, and the welcome screen is now that
document's entry 1 — it is how you get a tour open before checking anything
else.
