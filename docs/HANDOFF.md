# Session handoff

State as of 2026-10-13, commit `e44633c`. Verified by running `make check`,
not from memory.

## What this is

A digital-humanities prototype: a virtual historical walking tour of Old Town
Fairfax, Virginia, told over real street-level panoramas with text, archival
photography and narration anchored to points in the world.

It is a proof of concept. (As of this session: no editor interface, no
multi-tour authoring, one hand-authored tour; the editor has since landed, see
below.) The **schema** is the part meant to survive into the real
framework.

## Current state

Six stops, all working: Historic Courthouse, Marr Monument, Old Town Hall,
Ratcliffe-Allison-Pozer House, Fairfax Museum, City Hall.

- **Walkable.** Ground arrows navigate image by image. The arrow leading to the
  next stop is highlighted via mapillary-js's `highlightId`. Arriving at a
  stop's designated panorama moves the tour there; proximity (30 m) is the
  fallback for street images belonging to no stop.
- **Then/now.** The courthouse carries two Library of Congress photographs
  (1863 with Union cavalry, c.1918 arcade) rendered as three.js planes standing
  in the world. Each has its own opacity slider; a stop opens with the first
  ghosted in and the rest hidden.
- **Map.** Leaflet minimap with numbered pins and a route polyline. Current
  stop is gold and drawn on top. Clicking a pin moves the tour.
- **Alignment mode (since removed).** `?align=1` nudged the selected rephoto by
  keyboard and emitted anchor JSON to paste into content. It was retired when
  the editor landed; `/edit` replaces it. See
  `docs/decisions/0003-the-editor-is-three-surfaces-on-one-state.md`.

Tests (at that commit): **173 backend (pytest), 213 frontend (Vitest)**, lint
and production build clean via `make check`. Bundle 2.04 MB raw / 348.40 kB
transferred.

Since the state above was written, sub-project 2 (tasks 1-4, this branch)
turned the tour into a portable document: the open tour is now an unpacked
working directory (`content/work/`) that the backend writes through to
immediately, a session API opens, edits, exports and publishes it as a
`.zip`, and the viewer loads everything from `tour-data/` with no `/api` call
at all. The read-only API, the SQLite database behind it, and `media.py`'s
hand-rolled Range handling (superseded by `StaticFiles`) are gone. See
`docs/decisions/0002-the-tour-is-a-portable-document.md` for why, including
the one place this departs from the agreed design.

Since then, sub-project 3a (the editing core) added the editor at `/edit`:
an outline, a numeric inspector, an editable map and an editable panorama
over one draft, with undo and debounced autosave through the session API.
`?align=1` and `frontend/src/app/align/` are gone. Current figures, from
`make check`: **197 backend (pytest), 397 frontend (Vitest)**; eager bundle
2.13 MB raw / 371.45 kB transferred; the editor is a lazy chunk, 75.99 kB raw
/ 17.95 kB transferred. See
`docs/decisions/0003-the-editor-is-three-surfaces-on-one-state.md` for why it
is built this way, including the heading-derivation gate. None of the editor
has been seen in a browser.

Since then, sub-project 3b added media and acquisition: uploads and
microphone recording into the open tour (`backend/app/media_store.py`), and
four tools (panoramas, places, archive search/fetch, narration) in
`backend/app/tools.py`, wired into the editor. Current figures, from
`make check`: **302 backend (pytest), 521 frontend (Vitest)**. The tools were
then run once against the live Mapillary, Overpass and loc.gov services, which
found that the loc.gov parser read `creator` and `rights` fields that do not
exist at the top level of a result; fixed. See
`docs/decisions/0004-media-comes-in-by-content-and-tools-wrap-the-scripts.md`.
Still unverified: recorded audio against the sniffer in a real browser
(Safari's MP4 brand is the risk), a real loc.gov redirect through
`archive-fetch`, and Overpass mirrors other than `overpass-api.de`, which
answered in 34-42 s from this machine against a 15 s client timeout. The
frontend `IMAGE_EXTS`/`AUDIO_EXTS` lists mirror the backend allowlist by hand
with no test tying them together.

## Running it

```sh
make serve     # builds frontend, serves API + bundle on :8000
make check     # lint + both suites + production build
make content   # regenerate panoramas, images, narration, tour JSON
```

The editor lives at <http://localhost:8000/edit> once `make serve` is running
and a tour is open in the session (see the `curl` sequence below for opening
the real one). Edits autosave to the working directory.

`make content` only regenerates `content/tours/fairfax-old-town.json`; nothing
reads that file into the open session automatically (that bridge is sub-project
3's job), so there is no SQLite seeding left to restart the backend over. To
open, save and ship the tour the editor will drive through the session API
directly. `PUT` and `POST` bodies are JSON, so every command that sends one
needs the content-type header — `curl -d` alone sends
`application/x-www-form-urlencoded`, which FastAPI hands to pydantic as raw
bytes and pydantic refuses with a 422 (`{"type":"dict_type",...}`):

```sh
curl -X POST localhost:8000/api/session/new \
  -H 'Content-Type: application/json' -d '{"title": "A tour"}'      # start empty
curl -X POST localhost:8000/api/session/import -F file=@tour.zip    # open a bundle
curl -X PUT localhost:8000/api/session/tour \
  -H 'Content-Type: application/json' -d @tour.json                 # write the document
curl localhost:8000/api/session/export -o tour.zip                  # save it out as a zip
curl localhost:8000/api/session/publish -o site.zip                 # a backend-free static site
```

Every edit above writes straight through to `content/work/`; there is no
explicit save. See `docs/decisions/0002-the-tour-is-a-portable-document.md`
for why "save" works this way instead of writing back to an opened file.

`POST /api/session/new` refuses with 409 if a tour is already open — export
it first, or pass `{"force": true}` in the body to discard it on purpose.
`PUT /api/session/tour` refuses with 409 if nothing is open yet. All three
mutating routes (`new`, `tour`, `import`) also refuse a request whose
`Sec-Fetch-Site` header is `cross-site`, as one more layer against another
page quietly POSTing to this backend while it happens to be running; `curl`
never sends that header, so none of this is visible from the command line.

### Opening the existing six-stop tour

Nothing above, and nothing elsewhere in the repo, actually gets the
hand-authored Old Town Fairfax tour into the application — there is no
bundle of it checked in, and no command that makes one. `content/tours/
fairfax-old-town.json` is the document; `content/media/` is its media,
committed alongside it but never copied anywhere by any script. The working
sequence, run from the repo root with the backend already up
(`make serve`):

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
have.

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

`?diag=1` exposes `window.__tour` and `window.__inWorld` and logs renderer
boundaries.

## Architecture, and why

| Layer | Choice | Why |
| --- | --- | --- |
| Map geometry, place identity | OpenStreetMap / Overpass | OSM has **no** street-level imagery |
| Street-level imagery | Mapillary, CC-BY-SA 4.0 | the only open 360 source with Fairfax coverage |
| Panorama viewer | mapillary-js 4.1.2 | stale (2023) but the only viewer for its format; contained behind `PanoramaViewer` |
| Rephoto rendering | three.js 0.134 via `addCustomRenderer` | tags cannot carry an image texture |
| Minimap | **Leaflet 1.9** | see below |
| Backend | FastAPI, pydantic | pydantic models are the single source of truth for the schema |

**MapLibre was removed.** Under Angular's esbuild build, maplibre-gl 6.10
renders raster tiles but **no GeoJSON source ever finishes loading** — no error
on the map's error channel or the worker's, reproducing on a fresh map with an
empty style and one point. Ruled out: worker URL, glyph-less symbol layer,
layer order, container sizing, projected positions. Leaflet suits this minimap
better anyway (raster basemap, one polyline, six pins) and cut 850 kB.

Stop bearings and rephoto headings are **derived** in `build_tour.py` from
where each panorama actually stands. All six hand-authored bearings were wrong,
one by 138°, which put the subject behind the viewer. Never reintroduce a
guessed bearing.

Schema v2 added `backend/app/migration.py`, which upgrades a v1 tour document
to v2 on every read path so only v2 exists above the parsing boundary, and
`backend/tests/fixtures/fairfax-old-town-v1.json`, a frozen v1 snapshot that
must never be refreshed — it is what proves the migration is lossless. See
`docs/decisions/0001-three-axes-for-overlays.md` for why the schema split this
way.

## Environment landmines

`docs/ENVIRONMENT.md` is the full list and is worth reading before debugging
anything. The ones that cost the most time:

- **Never use `urllib`** — it truncates through the egress proxy (~1 in 10).
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
  a **stale frame** — this produced two wrong root-cause conclusions.
- **`geodeticToEnu` altitude is absolute**, not height above ground.
- **`setCenter` takes basic image coordinates**, not compass bearings.

## Outstanding

1. **Rephoto alignment is unfinished.** The anchors are estimates, improved by
   hand in commit `de48b0d` but not finished. The tool for finishing it is now
   the editor at `/edit` (`?align=1` is gone): select the photograph, drag it
   on the map, then adjust height, size and opacity in the panorama pane and
   inspector, with the heading derived from the panorama's real position.
   What remains is the author's: someone has to do that in a browser and look
   at the result. Nothing in the editor has been seen rendering, and this
   cannot be closed from an environment where no browser runs.
2. **`content/source/stops.json` has silently drifted from the shipped
   document, and nobody here can safely fix it.** Commit `de48b0d`
   ("adjustment") hand-edited the rephoto anchors directly in
   `content/tours/fairfax-old-town.json` to improve the alignment of the two
   courthouse photographs, but `stops.json` — what `build_tour.py` actually
   reads — was never updated to match. The next `make content` silently
   reverts that alignment work. Worse, a reviewer independently recomputed the
   derived heading from the hand-tuned anchor positions and got 105.0 and
   147.2 degrees, where the shipped document currently stores 113 for both, so
   the stored heading is already inconsistent with its own anchor position.
   `build_tour.py` and the Makefile's `content:` target both warn about this,
   but the underlying choice is still open: either sync `stops.json` to the
   hand-tuned coordinates (which would also change the derived headings to
   105.0/147.2), or let the editor take ownership of the document and retire
   `stops.json` entirely. Sub-project 3 has landed — the editor can now name a
   tour, write stop text, place media and publish — so retiring it is
   technically possible, but the choice is still open and gated on the
   author's explicit confirmation. Nobody has made that call —
   the alignment was tuned by eye in a browser, and no browser can run in this
   environment, so nobody here can see whether either change improves or
   breaks it.
3. **Rephotography is demonstrated at one stop.** Targeted searching found
   essentially no Old Town Fairfax imagery for the other five — only the
   courthouse and, possibly, Earp's Ordinary (HABS). Local collections (Fairfax
   Museum, Virginia Room) are the gap to fill. `fetch_rephotos.py` takes a date
   preference so one site can layer several eras.
4. **The historical text is unreviewed.** Written for the prototype, not
   sourced. It lives in `content/source/stops.json` so it can be corrected
   without touching code.
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

## Conventions used

- **TDD throughout**: failing test first, watch it fail, then implement. Every
  bug fixed this session landed with a test reproducing it.
- **Superpowers skills**: brainstorming before features, writing-plans for
  specs, systematic-debugging for bugs. Specs and plans are in
  `docs/superpowers/`.
- **Commits**: let git use its own config. Do **not** pass
  `-c user.email=...`; that overrode the user's identity earlier in the
  session and had to be rebased.
