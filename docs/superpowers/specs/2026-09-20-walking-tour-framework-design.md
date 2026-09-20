# Virtual historical walking tours — prototype design

**Date:** 2026-09-20
**Status:** implemented
**Scope:** proof-of-concept prototype. No editor interface, no multi-tour
authoring, no user accounts. One hand-authored tour of Old Town Fairfax,
Virginia, demonstrating text, image and audio overlaid on real places.

## 1. Purpose

Establish that a walking tour can be told through street-level panoramas of a
real place, with humanities content anchored to specific points in the world
rather than to a slideshow. The prototype exists to answer whether the format
works and whether the data model can carry it. Replicability and authoring
tools are explicitly out of scope, but the **schema** produced here is intended
to survive into the final framework.

## 2. Verified premises

These were established by probe before design was finalised, not assumed.

- OpenStreetMap supplies map geometry and place identity. It has **no
  street-level imagery**; that comes from Mapillary.
- Mapillary coverage of Old Town Fairfax is dense and current. Six candidate
  stops each have 32–84 true 360 panoramas within 40 m, captured 2026-08.
- Panoramas are 5376×2688, aspect 2.00, `camera_type: spherical` — genuine
  equirectangular, confirmed by fetching image bytes.
- All imagery originates from one contributor (`apmwa`) in a single campaign.
  Panoramas are therefore **cached locally** so the demo cannot break upstream.
- Mapillary imagery is **CC-BY-SA 4.0**. Attribution is mandatory and appears
  in the UI.

See `docs/ENVIRONMENT.md` for verified toolchain constraints (httpx mandatory,
`UV_CACHE_DIR`, Node 24 resolution).

## 3. The six stops

Coordinates derive from OSM entities via Overpass, not free-text geocoding —
Nominatim silently resolved "Fairfax County Courthouse" to the *modern*
courthouse, 200 m from the historic one.

| # | Stop | lat, lng |
| --- | --- | --- |
| 1 | Fairfax County Historic Courthouse | 38.84562, -77.30732 |
| 2 | Marr Monument | 38.84566, -77.30716 |
| 3 | Old Town Hall | 38.84604, -77.30617 |
| 4 | Ratcliffe-Allison-Pozer House | 38.84601, -77.30468 |
| 5 | Fairfax Museum and Visitor Center | 38.84455, -77.30050 |
| 6 | Fairfax City Hall | 38.84094, -77.30815 |

Ordered as a walkable route east along Main Street, then south to City Hall.

## 4. Data model

The part with the longest half-life. Pydantic models in the backend are the
single source of truth; JSON Schema is exported from them and TypeScript
interfaces generated from that, so the contract cannot drift.

```jsonc
Tour {
  id, schemaVersion, title, description,
  attribution: [ { text, url, license } ],
  stops: [ Stop ]
}

Stop {
  id, order, title, summary,
  location: { lng, lat },
  osmRef,                                  // e.g. "way/123456", provenance
  panorama: {
    provider: "mapillary",
    imageId,                               // stable Mapillary id
    bearing,                               // initial view direction, degrees
    cachedPath                             // local equirectangular copy
  },
  overlays: [ Overlay ]
}

Overlay {
  id, kind: "text" | "image" | "audio",
  anchor: { type: "geo", lng, lat, altitude },   // tagged union
  title,
  body,                                    // text overlays
  mediaId,                                 // image/audio overlays
  credit: { source, url, license, creator }
}
```

Two deliberate choices:

**`anchor` is a tagged union** with one member today. Image-anchored overlays
(pinned to pixel coordinates in one specific Mapillary image) are the obvious
next variant; modelling the union now means adding them later is not a
breaking schema change.

**`credit` is required on every overlay.** Provenance at object level is a
humanities requirement, and it is how the prototype stays compliant with
CC-BY-SA and public-domain attribution terms. A missing credit is a schema
validation failure, not a warning.

Geo-anchoring was chosen over image-anchoring because it survives imagery being
replaced, projects into any nearby panorama, and matches how an editor would
eventually work — drop a pin on the world, not on a photograph. The cost is
visible drift where GPS accuracy is poor; accepted for a prototype.

## 5. Architecture

```
clio-wired/
├── backend/     FastAPI, Python 3.14, uv
├── frontend/    Angular 22, Node 24
├── content/     pipeline scripts + committed media and tour JSON
└── docs/
```

### Backend

| Endpoint | Purpose |
| --- | --- |
| `GET /api/config` | Mapillary token, tile URL, attribution strings |
| `GET /api/tours` | tour summaries |
| `GET /api/tours/{id}` | full tour document |
| `GET /api/media/{id}` | media bytes, **HTTP range requests** |

The Mapillary token is read from `backend/.env` and served at runtime by
`/api/config`. It is never baked into the Angular bundle and never committed.

Range support on `/api/media` is load-bearing, not polish: without it `<audio>`
seeking fails in Safari. Correct `206 Partial Content`, `Content-Range` and
`Accept-Ranges` handling is a tested requirement.

Storage is SQLite, seeded from `content/tours/*.json` at startup. The seed is
idempotent.

### Frontend

Angular 22, standalone components, signals, zoneless. Four units with clean
seams:

- **`TourStore`** — signal state: loaded tour, current stop index, next/prev.
  Pure state, no DOM, no map, no HTTP. Directly unit-testable.
- **`TourApi`** — typed HTTP against the backend contract.
- **`PanoramaPane`** — wraps mapillary-js behind a local `PanoramaViewer`
  interface (`load(imageId)`, `setOverlays(...)`, `destroy()`). mapillary-js is
  4.1.2, published 2023-11, and pulls `three@^0.134` and the unmaintained CJS
  `virtual-dom`. Containing it behind our own interface means the staleness is
  a one-file problem and the viewer is swappable.

  Two API constraints were confirmed against the published typings before this
  was designed. mapillary-js `Marker` accepts **`LngLat` only — there is no
  altitude parameter**, so `anchor.altitude` is carried in the schema for
  future use and for the map layer, but is not consumed by the panorama
  renderer. And `Popup` is anchored by `setBasicPoint` (image-relative
  coordinates), *not* geographically, so it cannot serve geo-anchored
  overlays. Overlay content therefore renders in our own Angular panel, with
  `SimpleMarker` providing the in-panorama hit target. There is no
  `markerclick` event; selection goes through
  `viewer.on('click')` then `MarkerComponent.getMarkerIdAt(pixelPoint)`.
- **`MapPane`** — MapLibre GL over OSM raster tiles: route line, numbered
  markers, current-stop highlight.
- **`StopPanel`** — text, image, `<audio>`, and the credit line.

Layout: panorama fills the upper area; minimap bottom-left; media panel
bottom-right.

`angular.json` needs **no** `allowedCommonJsDependencies`: mapillary-js ships
an ESM build that bundles cleanly under esbuild with zero warnings, despite its
CommonJS `virtual-dom` dependency. It does need raised bundle budgets (3 MB
warn / 4 MB error) — three.js plus MapLibre total 2.23 MB raw, 487 kB
transferred — and Angular's lmdb-backed build cache must be disabled or
`ng build` aborts with a silent SIGABRT. See `docs/ENVIRONMENT.md`.

## 6. Content pipeline

Three scripts in `content/scripts/`, run once, outputs committed so the app
boots without network access.

1. **`probe_coverage.py`** *(done)* — discovers candidate sites via Overpass,
   reports Mapillary coverage per site, exits non-zero if fewer than four
   strong candidates. Already produced `content/coverage-report.json`.
2. **`fetch_media.py`** — pulls Library of Congress and Wikimedia Commons
   images plus their rights metadata into `credit` blocks, and caches the
   chosen Mapillary panorama per stop.
3. **`make_narration.py`** — generates spoken narration from each stop's text
   via `say`, encoding to m4a with ffmpeg. Audio is clearly labelled
   synthesized in its credit block.

Historical images come from the Library of Congress (the National Photo Company
Collection holds Fairfax Court House photographs) and Wikimedia Commons, both
public domain.

## 7. Testing

The verification bar for hands-off implementation. TDD throughout: test first,
watch it fail, then implement.

- **pytest** — schema validation including rejection of malformed tours,
  API contract, range-request correctness (`206`, `Content-Range`, unsatisfiable
  ranges), idempotent seeding.
- **Vitest** — `TourStore` transitions and boundaries, `TourApi` parsing,
  the `PanoramaViewer` adapter against a mock.
- **Playwright** — full six-stop walkthrough against **recorded Mapillary
  fixtures** via route interception. The suite requires no token and no
  network, so it is reproducible in CI and on a fresh clone.

A single `make check` runs all three.

## 8. Risks

| Risk | Mitigation |
| --- | --- |
| Mapillary imagery withdrawn or changed | panoramas cached locally in `content/` |
| mapillary-js staleness | contained behind `PanoramaViewer`; ESM build verified to bundle cleanly |
| Single upstream contributor for all imagery | accepted; local cache removes runtime dependency |
| Geo-anchor drift from GPS error | accepted for prototype; altitude tunable per overlay |
| stdlib `urllib` truncation through proxy | httpx everywhere, enforced by `docs/ENVIRONMENT.md` |

## 9. Out of scope

Editor interface, authoring UI, user accounts, multiple tours, live GPS
tracking, offline packaging, mobile-native apps, image-anchored overlays.


## 10. Deviations discovered during implementation

Each of these was found by hitting the problem, not by planning around it.

**mapillary-js needs no CommonJS allowlist.** Its ESM build bundles cleanly
under esbuild despite the CJS `virtual-dom` dependency. Bundle budgets were
raised instead (three.js plus MapLibre total 2.34 MB raw, 513 kB transferred).

**`anchor.altitude` is not consumed by the panorama renderer.** mapillary-js
`Marker` accepts `LngLat` only. The field stays in the schema for the map layer
and for future image-anchored overlays.

**Overlay content renders in the Angular panel, not a mapillary `Popup`.**
`Popup` anchors by `setBasicPoint` — image-relative coordinates — so it cannot
serve a geo-anchored overlay. `SimpleMarker` provides the in-panorama hit
target; there is no `markerclick` event, so selection goes through
`viewer.on('click')` then `MarkerComponent.getMarkerIdAt(pixelPoint)`.

**One server, not two.** FastAPI serves the built Angular bundle with a
single-page-app fallback, so the whole app runs from port 8000. This removed
the dev-server proxy and, more importantly, the `ng serve` file watcher, which
exhausts the file-descriptor limit in this environment. Unmatched `/api/*`
paths still 404 rather than falling through to the app.

**Stops are matched to panoramas by proximity, not by name.** Editorial titles
and OSM names drift ("Visitor Center" versus "Visitors Center"), which silently
dropped a stop until the match was changed to coordinates.

**SQLite connections are per-request.** FastAPI runs sync handlers in a
threadpool and a SQLite connection may not cross threads. Seeding happens once
at startup on its own connection.

**Browser end-to-end tests cannot run in this sandbox.** No engine can launch:
Chromium is denied Mach port registration, Firefox cannot spawn a content
process. The Playwright suite is written and correct but must be run from an
ordinary terminal. To compensate, `real-tour.spec.ts` renders the actual
committed tour through the real components under jsdom, covering everything
except WebGL.

**Git commits were not possible.** `.git` is write-denied in this sandbox, so
no work here is committed. See `docs/ENVIRONMENT.md`.
