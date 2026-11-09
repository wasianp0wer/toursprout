# clio-wired

A prototype for a digital-humanities framework that tells historical walking
tours over real street-level imagery. This proof of concept is a six-stop tour
of Old Town Fairfax, Virginia, with text, archival photography and narration
anchored to points in the world and overlaid on 360° panoramas.

It has grown from a one-tour prototype into an authoring application: the tour
is a portable document (`tour.json` plus `media/`, exportable as a `.zip`),
an editor at `/edit` changes it, and it can be published as a static site that
needs no backend. There is still one hand-authored tour. The editor's
close dialog and microphone recorder have never been seen running in a
browser, because none can launch in the development environment
(`docs/UNVERIFIED.md` says exactly what has and has not been seen). The
**schema** is the part meant to survive.

It can run on your own machine, or be hosted so that several historians each
author in their own browser: `docs/DEPLOY.md` is the runbook for the host, and
`docs/FOR-HISTORIANS.md` is the one page a historian is given.

## What it is made of

| Layer | Choice |
| --- | --- |
| Map geometry and place identity | OpenStreetMap (Overpass, raster tiles) |
| Street-level imagery | Mapillary, CC-BY-SA 4.0 |
| Archival photography | Library of Congress, public domain |
| Narration | The committed tour's clips were synthesised on macOS and are labelled as synthetic; in the editor, narration is recorded from the microphone |
| Backend | FastAPI, pydantic, Python 3.12 or newer (`requires-python`; CI and the deploy use 3.12) |
| Frontend | Angular 22, Leaflet 1.9, mapillary-js 4 |

OpenStreetMap has no street-level imagery of its own; that is what Mapillary
supplies. All six stops were chosen by probing actual Mapillary coverage
before any content was written — see `content/scripts/probe_coverage.py` and
`content/coverage-report.json`.

## Prerequisites

- **Node 24** — Angular 22 rejects Node 25. The Makefile pins the path.
- **uv** with `UV_CACHE_DIR` set (the Makefile does this).
- **A Mapillary token** in `backend/.env` as `MAPILLARY_TOKEN=MLY|...`.
  Needed to regenerate content and for the editor's panorama search, which
  runs in the browser with this token; the committed tour runs without it.

Read `docs/ENVIRONMENT.md` before debugging anything. It records several
non-obvious constraints that each cost real time to find.

## Running it

```sh
make serve      # builds the frontend, serves everything on :8000
```

Then open <http://localhost:8000>. FastAPI serves both the API and the built
Angular bundle, so there is one process and no proxy. Your open tour belongs
to your browser, not to the server: the first request sets a `tour_sid`
cookie and the tour lives in a directory named by it, under `sessions_dir`
(default `~/.clio-wired/sessions`; set `SESSIONS_DIR` in `backend/.env` to
move it). A second browser, or a private window, gets its own empty session.
`/` works out who is asking: with nothing open in this browser's session it
shows a welcome screen, where *Old Town
Fairfax* opens the committed six-stop tour — document, media and all — in one
click, and where a `.zip` or a loose `tour.json` with its media folder can be
dropped instead; with a tour open it goes straight to the editor; and on a
published static site, where there is no backend to answer, it is the viewer.
`/view` is the viewer with a backend up, which is what the editor's *Preview*
link uses. `docs/HANDOFF.md` has the same operations as `curl`, for a terminal
with no browser, plus exporting and publishing.

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

**Bringing media in.** The editor uploads images and audio into the open tour
and records narration from the microphone; the recorder prefers `audio/mp4`
where `MediaRecorder.isTypeSupported` allows it, otherwise whatever the browser
produces by default (the sniffer accepts WebM and Ogg as well as MP4). Two
searches help find where things are. **Panorama search runs in the browser**,
straight to `graph.mapillary.com` with the token from the viewer config (the
hosted server cannot reach Mapillary), and **place search** goes through the
backend to OpenStreetMap's Overpass. Searching the Library of Congress from
inside the editor, and synthesising narration with macOS `say`, were
**removed**: loc.gov refuses the host, and `say` exists on neither the host nor
a Windows laptop. A historian finds a photograph at loc.gov in their own
browser and uploads it (`docs/FOR-HISTORIANS.md`). The reasons, and the
measurements behind them, are in
`docs/decisions/0006-host-it-one-session-per-browser.md`; the upload rules
are in `docs/decisions/0004-media-comes-in-by-content-and-tools-wrap-the-scripts.md`.

## Tests

```sh
make check      # lint + backend tests + frontend tests + production build (counts: docs/HANDOFF.md)
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
schema before writing. This pipeline is independent of the editor, and its
input `content/source/stops.json` has drifted from the hand-tuned committed
JSON, so running it overwrites that alignment work; see `docs/HANDOFF.md`
(Outstanding, item 2) before running it.

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
- `docs/DEPLOY.md` — putting it on the Reclaim host: a numbered runbook with stop-and-report points, and every setting
- `docs/FOR-HISTORIANS.md` — the one page a historian tester is given
- `docs/HANDOFF.md` — current state, how to run it, landmines, open questions
- `docs/UNVERIFIED.md` — everything no one has seen work, each with the check that closes it; start here at a browser
- `docs/ARCHITECTURE.md` — how the parts fit and what each layer may not do
- `docs/CHANGING-THINGS.md` — where a given change goes
- `docs/decisions/` — decision records; start at `docs/decisions/README.md`
