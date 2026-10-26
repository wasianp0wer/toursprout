# clio-wired

A prototype for a digital-humanities framework that tells historical walking
tours over real street-level imagery. This proof of concept is a six-stop tour
of Old Town Fairfax, Virginia, with text, archival photography and narration
anchored to points in the world and overlaid on 360° panoramas.

It is a prototype: there is an authoring editor at `/edit`, but it has never been
seen in a browser, and there is one hand-authored tour. The **schema** is the
part meant to survive.

## What it is made of

| Layer | Choice |
| --- | --- |
| Map geometry and place identity | OpenStreetMap (Overpass, raster tiles) |
| Street-level imagery | Mapillary, CC-BY-SA 4.0 |
| Archival photography | Library of Congress, public domain |
| Narration | macOS speech synthesis, labelled as synthetic |
| Backend | FastAPI, pydantic, Python 3.14 |
| Frontend | Angular 22, Leaflet 1.9, mapillary-js 4 |

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

## Walking and comparing

**Walk it.** Ground arrows in the panorama are real navigation: the one leading
toward the next stop is highlighted, and following it walks the street image by
image. Come within 30 m of a stop and the tour advances itself. A green
destination marker shows where the next stop is when the arrow is out of view.
`Next` and `Previous` still skip instantly if you would rather not walk.

**Compare then and now.** The Fairfax County Historic Courthouse carries two
Library of Congress photographs — 1863, with Union cavalry and a soldier in the
cupola, and about 1918 — standing in the world where the building is. Each photograph gets its own slider in the stop panel, fading between it and
the present view. A stop opens with the first photograph ghosted in and the
rest hidden, so several semi-transparent images do not overlap into a muddle —
drag one down and another up to compare eras one at a time.

Rephotography is demonstrated at the courthouse because that is where the
archive actually is. Targeted searching found essentially no Old Town Fairfax
imagery for the other five stops; the mechanism is general, the content is not.

**Aligning a photograph.** Georeferencing by eye needs a browser. Open the
editor at <http://localhost:8000/edit> with a tour open in the session: the
map places the photograph on the ground and sets its heading, the panorama
shows how it sits in the real view, and the inspector sets every value
numerically. Edits autosave about half a second after the last change, while the editor
is open; the header reads "All changes saved" once one has landed and "Save
failed" if the backend rejected it (the draft is kept, and the next edit
retries). The heading is always derived from where the
panorama actually stands, never typed in blind, because every hand-guessed
bearing in this project's history was wrong, one by 138 degrees; the editor
refuses to derive one until the panorama has loaded. **The committed anchors
are estimates, improved by hand in commit `de48b0d` but not finished** —
further alignment needs someone at a browser. The old `?align=1` mode is gone.

## Tests

```sh
make check      # lint + 197 backend tests + 426 frontend tests + production build
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

Every overlay carries a required `credit` block: a `sourced` credit names
where the material came from (source, URL, licence), and an `original` credit
covers the author's own recordings and photographs, which have no URL to give
(creator, licence). A missing credit is a schema validation failure. Mapillary
imagery is CC-BY-SA 4.0 and attributed in the interface. Narration is
synthesized and labelled as such.

**The historical text is a draft written for this prototype and has not been
reviewed.** It lives in `content/source/stops.json` so it can be corrected
without touching code.

## Documents

- `docs/superpowers/specs/2026-09-20-walking-tour-framework-design.md` — design
- `docs/superpowers/plans/2026-09-20-walking-tour-prototype.md` — implementation plan
- `docs/ENVIRONMENT.md` — verified environment constraints
- `docs/HANDOFF.md` — state and open questions as of the last session
- `docs/decisions/` — decision records; start at `docs/decisions/README.md`
