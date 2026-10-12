# Session handoff

State as of 2026-10-12, commit `821617a`. Verified by running `make check`,
not from memory.

## What this is

A digital-humanities prototype: a virtual historical walking tour of Old Town
Fairfax, Virginia, told over real street-level panoramas with text, archival
photography and narration anchored to points in the world.

It is a proof of concept. No editor interface, no multi-tour authoring, one
hand-authored tour. The **schema** is the part meant to survive into the real
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
- **Alignment mode.** `?align=1` nudges the selected rephoto by keyboard and
  emits anchor JSON to paste into content.

Tests: **119 backend (pytest), 196 frontend (Vitest)**, lint and production
build clean via `make check`. Bundle 2.04 MB raw / 348 kB transferred.

## Running it

```sh
make serve     # builds frontend, serves API + bundle on :8000
make check     # lint + both suites + production build
make content   # regenerate panoramas, images, narration, tour JSON
```

**Restart the backend after `make content`.** Tours are seeded into SQLite at
startup, so a running server keeps serving the old tour — this looked like the
frontend ignoring changes more than once.

`?diag=1` exposes `window.__tour` and `window.__rephoto` and logs renderer
boundaries. `?align=1` enables alignment mode.

## Architecture, and why

| Layer | Choice | Why |
| --- | --- | --- |
| Map geometry, place identity | OpenStreetMap / Overpass | OSM has **no** street-level imagery |
| Street-level imagery | Mapillary, CC-BY-SA 4.0 | the only open 360 source with Fairfax coverage |
| Panorama viewer | mapillary-js 4.1.2 | stale (2023) but the only viewer for its format; contained behind `PanoramaViewer` |
| Rephoto rendering | three.js 0.134 via `addCustomRenderer` | tags cannot carry an image texture |
| Minimap | **Leaflet 1.9** | see below |
| Backend | FastAPI, pydantic, SQLite | pydantic models are the single source of truth for the schema |

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
   hand in commit `de48b0d` but not finished. Use `?align=1`; it needs eyes on
   a browser.
2. **Rephotography is demonstrated at one stop.** Targeted searching found
   essentially no Old Town Fairfax imagery for the other five — only the
   courthouse and, possibly, Earp's Ordinary (HABS). Local collections (Fairfax
   Museum, Virginia Room) are the gap to fill. `fetch_rephotos.py` takes a date
   preference so one site can layer several eras.
3. **The historical text is unreviewed.** Written for the prototype, not
   sourced. It lives in `content/source/stops.json` so it can be corrected
   without touching code.
4. **The Marr Monument editorial question is unresolved.** It stands 14.6 m
   from the courthouse, so one ground-arrow step moves the tour to it. It was
   folded into the courthouse stop and then restored to a stop of its own; the
   repo is currently six stops and self-consistent.
5. **Courthouse narration is long** (~660 kB, about a minute) since it is the
   richest stop. Splitting it would need overlay-level narration, which
   `make_narration.py` does not do.

## Conventions used

- **TDD throughout**: failing test first, watch it fail, then implement. Every
  bug fixed this session landed with a test reproducing it.
- **Superpowers skills**: brainstorming before features, writing-plans for
  specs, systematic-debugging for bugs. Specs and plans are in
  `docs/superpowers/`.
- **Commits**: let git use its own config. Do **not** pass
  `-c user.email=...`; that overrode the user's identity earlier in the
  session and had to be rebased.
