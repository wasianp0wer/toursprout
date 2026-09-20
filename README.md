# clio-wired

A prototype for a digital-humanities framework that tells historical walking
tours over real street-level imagery. This proof of concept is a six-stop tour
of Old Town Fairfax, Virginia, with text, archival photography and narration
anchored to points in the world and overlaid on 360° panoramas.

It is a prototype: there is no editor interface, no authoring UI, and one
hard-authored tour. The **schema** is the part meant to survive.

## What it is made of

| Layer | Choice |
| --- | --- |
| Map geometry and place identity | OpenStreetMap (Overpass, raster tiles) |
| Street-level imagery | Mapillary, CC-BY-SA 4.0 |
| Archival photography | Library of Congress, public domain |
| Narration | macOS speech synthesis, labelled as synthetic |
| Backend | FastAPI, pydantic, SQLite, Python 3.14 |
| Frontend | Angular 22, MapLibre GL 6, mapillary-js 4 |

OpenStreetMap has no street-level imagery of its own; that is what Mapillary
supplies. All six stops were chosen by probing actual Mapillary coverage
before any content was written — see `content/scripts/probe_coverage.py` and
`content/coverage-report.json`.

## Prerequisites

- **Node 24** — Angular 22 rejects Node 25. The Makefile pins the path.
- **uv** with `UV_CACHE_DIR` set (the Makefile does this).
- **A Mapillary token** in `backend/.env` as `MAPILLARY_TOKEN=MLY|...`.
  Needed only to regenerate content; the committed tour runs without it.

Read `docs/ENVIRONMENT.md` before debugging anything. It records several
non-obvious constraints that each cost real time to find.

## Running it

```sh
make serve      # builds the frontend, serves everything on :8000
```

Then open <http://localhost:8000>. FastAPI serves both the API and the built
Angular bundle, so there is one process and no proxy.

## Tests

```sh
make check      # lint + 86 backend tests + 50 frontend tests + production build
```

Browser end-to-end tests exist in `frontend/tests/e2e/` but **cannot run inside
the Claude Code sandbox** — no browser engine can launch there. Run them from
an ordinary terminal:

```sh
make e2e
```

## Regenerating content

```sh
make content
```

This probes Mapillary coverage, caches a panorama per stop, fetches archival
images with their rights metadata, synthesizes narration, and assembles
`content/tours/fairfax-old-town.json` — validating it against the pydantic
schema before writing.

## Provenance

Every overlay carries a required `credit` block naming source, URL, licence and
creator; a missing credit is a schema validation failure. Mapillary imagery is
CC-BY-SA 4.0 and attributed in the interface. Narration is synthesized and
labelled as such.

**The historical text is a draft written for this prototype and has not been
reviewed.** It lives in `content/source/stops.json` so it can be corrected
without touching code.

## Documents

- `docs/superpowers/specs/2026-09-20-walking-tour-framework-design.md` — design
- `docs/superpowers/plans/2026-09-20-walking-tour-prototype.md` — implementation plan
- `docs/ENVIRONMENT.md` — verified environment constraints
