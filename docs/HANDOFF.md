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

**Tests:** 719 backend (pytest), 867 frontend (Vitest, 38 files); lint and
production build clean via `make check`, which exits 0 and prints `All checks
passed!` (run on 2026-11-17, on `docs/publish-mark`). Eager bundle 2.17 MB raw
/ 375.52 kB transferred (2.15 MB / 372.22 kB before per-tour theming); the
editor, welcome and unnamed lazy chunks print 122.46 / 12.57 / 10.14 kB raw,
and the chunk paragraph below carries the same figures.

**The deployed authoring host is slow, and published pages now know they are
published (2026-11-17, ADR [0010](decisions/0010-a-published-page-knows-it-is-published.md)).**
`area51.reclaimhosting.com` (cPanel/CloudLinux; Cloudflare, then Reclaim's
Caddy, then Apache, then CGI) answers `/api/session` in 12.6-14.0 s and once
took 73.2 s to first byte, measured. A cold CGI request of this app is
0.20-0.32 s locally, TLS is 0.06 s, and a 15 kB favicon takes 12.2 s on a
Cloudflare miss against 0.33 s on a hit, so the latency is the host's path to
its origin, not CGI and not the app. `EntryPage`'s 2 s probe therefore always
timed out and showed the viewer to the author. The fix went through two changes
after the 2 s probe, all the same day. The author proposed the mark:
`publish.py` marks the zip's `index.html` with `data-published` (the on-disk
`dist/index.html` stays unmarked) and a marked page never calls `/api`. The
same commit gave the unmarked page a 30 s fallback; it was found to be shorter
than the 73.2 s answer and was withdrawn. The second change, by the author's
ruling that an unmarked page *is* the authoring host by contract, is what the
code does now: an unmarked page awaits `/api/session` with **no deadline**,
shows "Waiting for the tour service…" after 5 s as information only, and reads
the answer three ways: status 0, a 404 or a 200 that is not a session summary
reveals the viewer at once (static-host signatures); a session summary goes to
`/edit` or the welcome screen; every other 4xx and every 5xx is a visible
"broken" message with the status, with no navigation. The accepted trade: a
hand-copied, *unpublished* `dist/` on a static host that *black-holes* `/api`
shows the waiting line for good (reasoned, not observed). Every zip entry is
also written at 0644 now (the session's 0600 used to leak onto `tour-data/*`).
None of it has been seen in a browser or on the host: `UNVERIFIED.md` entry 45,
which supersedes 20 to 22.

**Where the work is, as of 2026-11-17.** From the author's merge (2026-11-16,
when HEAD moved to `main`) the work landed directly on `main` rather than on a
feature branch, until `87e22fa`. `origin/main` is at `dc43ad5`; `cebdc9f` and
`dc43ad5` are on it. Five commits on `main` are **not pushed**: `51ee7be`
(the media-cache window, "Cache media for an hour, not immutably for a year",
which is **not** publish-mark work) and the four publish-mark commits after
it, `b618229` (the plan), `f504730`, `17cff28` and `234b5d0`.
`feature/ui-customization` points at the same commit as `main` and is now
meaningless. `docs/publish-mark` carries `87e22fa`, `240fe87`, `08270dd` and
the documentation commit that rewrote this note. `stash@{0}` holds exactly the
City Hall panorama swap (`1047663651213936`, 200.9 changed to
`1412217390816350`, 193.9, across `content/coverage-report.json`,
`content/media/manifest.json` and `content/tours/fairfax-old-town.json`); the
author reported that it came from re-running `make content`. **Whether to apply it is an open decision**
for the author, not something to pop to make the tree clean. (`stash@{1}` is
a WIP on `main` at `dc42bae`, contents not inspected.)

**A cache bug found while the branch was being handed over, and fixed on
it.** The author's editor kept loading a tour from an earlier session while
the session on disk held another, so every autosave was refused for the wrong
schema version. `GET /tour-data/*` advertised `ETag` and `Last-Modified` but
set no `Cache-Control`, so a browser applied heuristic freshness and answered
`TourApi.getTour()` from its own cache **without contacting the server** —
and a hard reload does not dislodge that, because it bypasses the cache for
the page and its subresources but not for requests the application makes
afterwards. Schema v4 only made it loud: before the bump the same staleness
loaded quietly and then autosaved the old document over whatever was really
open, which is the mechanism behind Outstanding item **A** below. Fixed in
two places — the route sends `Cache-Control: no-cache` (`2f5681b`) and
`TourApi` asks to revalidate from the client (`4301203`), the latter being
the only guard that reaches a published site, where the host's headers are
not ours. Media is untouched and still caches: a media id is a content hash.
The browser-side checks nobody here can run, including how a reload behaves
offline, are `UNVERIFIED.md` entry 44.

There are **three** lazy chunks: the editor,
122.46 kB raw / 28.05 kB transferred (was 105.34 / 24.68); the welcome screen,
12.57 kB / 4.04 kB; and a third, unnamed one, 10.14 kB / 3.59 kB. The third was
not recorded here before and is not a regression: it is the Mapillary search
client (`graph.mapillary.com/images`, its field list and bounding-box helper)
with a little shared document code, shared by the editor and welcome chunks
(anyone reaching the welcome screen downloads it), which a published visitor
never fetches because a published site always has a tour open. It arrived
with the flat-imagery work or earlier and simply went unlisted. The fonts
are 14 `woff2` files totalling 433,184 bytes, fingerprinted into `media/`,
plus four `OFL-*.txt` licences in `fonts/`; all of them ship in every
published zip.

*(This line read 413 backend / 606 frontend until 2026-11-11 and had gone
stale by a long way: `main` at `e24845a` already ran 692 backend, the
workstation-deploy branch having added `test_deploy_script.py`. The frontend
figure was never re-measured after that branch either. Take the numbers above
as the ones a run actually printed.)*

**Per-tour theming was built on 2026-11-14 and 15, on
`feature/ui-customization`, and none of it has been seen in a browser.** A
tour may now carry a `theme`: one of four presets (`nocturne`, `archival`,
`civic`, `fieldNotes`), up to thirteen colour overrides, one of five type
pairings, a type scale and one of three layouts
(`widePanel`, `panelLeft`, `immersive`). It is **schema v4**, with a migration
step that only stamps the version, because `extra="forbid"` makes even an
additive field a hard rejection for an older reader; `fairfax-old-town-v3.json`
is frozen beside the v1 and v2 fixtures. `core/theme.ts` is the one place the
token set is defined; the viewer writes the resolved tokens onto its own host
element; the editor has a theme dialog with a live miniature. Four families
ship with the app (EB Garamond, Libre Franklin, IBM Plex Sans and Mono; 14
files, as above, because three also ship italics and Mono only a medium),
each with a latin and a latin-ext file so a stop called *Łódź* does not fall
back mid-word. Why it was built this way is ADR
[0009](decisions/0009-the-look-is-in-the-document.md); how it fits is the token
flow in [`ARCHITECTURE.md`](ARCHITECTURE.md); where a change goes is entry 11 of
[`CHANGING-THINGS.md`](CHANGING-THINGS.md); and the twelve checks that need a
browser, **preset legibility first**, are `UNVERIFIED.md` entry 43.

**A whole-branch review on 2026-11-15 found three things worth knowing about,
and all three are fixed.** The `muted` and `mutedWeak` derivations came from a
mockup and were only ever exercised on the three light presets, because
Nocturne pins both — nobody had measured them there, and they were 3.48:1 and
1.30:1 where AA asks 4.5; they are now `mix(ink, panel, 0.28)` and
`mix(muted, panel, 0.25)`, and `core/theme.spec.ts` holds a contrast floor for
every pair the viewer paints, on every preset. A preset's pin used to outlive
the palette: on Nocturne, setting `paper`, `panel` and `ink` left `soft` and
`chip` pinned to their dark values, which is a stop summary at 1.69:1 and an
overlay list at 1.09:1, and the readout showed neither — so the pins that
exist only for legacy exactness now yield to their derivations once any of the
core six is overridden, and the readout shows five pairs rather than three.
And `map-pane.css`'s `color-mix` had no fallback, so a browser without it got
Leaflet's own white box. **No existing tour's appearance changes**, because
every one of them carries no overrides at all and Nocturne pins the three
tokens whose ratios moved. The detail is in ADR 0009 §4.

**One visible change to the existing tour, and it is deliberate: the stop
panel's Prev/Next button was blue (`#2f7fd4` on `#fff`) and is now the accent,
gold under the default Nocturne preset.** `wayfinding` now means "another stop"
and nothing else; before, the same value meant that on the map and "primary
button" in the panel. Everything else resolves to the values the application
shipped before the branch (`core/theme.spec.ts` pins them), so this is the only
appearance change to a tour that already exists. It took three attempts: the
conversion first mapped the button to `wayfinding`, which preserved the colour;
a review praised that as correct; and it was caught only four tasks later, when
the theme dialog's subset test noticed `--on-accent` was read by nothing. Anyone
comparing the Fairfax tour before and after should expect to see it.

**`Tour.attribution` is still the open question ADR 0005 left, and this work did
not close it.** The viewer still renders `ConfigStore.attribution()`, not the
document's copy. It did not block theming, which styles the attribution bar
whichever copy feeds it; but the document now carries presentation, which
strengthens the case that it should carry its own credits one day.

**Flat (non-360) Mapillary imagery landed on 2026-11-11, and none of it has
been seen in a browser.** Until this branch a stop's base imagery had to be a
true 360 panorama: the editor's search discarded everything else, so an author
in a town covered only by phone and dashcam capture got an empty list and
could not make a stop at all. Three of six candidate European sites probed on
2026-11-11 were flat-only. The search now lists flat and fisheye imagery,
badged `360°` or `flat`, thinned to distinct vantage points
(`MIN_CANDIDATE_SPACING_M`, 10 m); the view declines to turn on imagery whose
x axis is not the full circle (`panorama/view-turn.ts` — the old arithmetic
over-rotated a perspective image by a factor of four or five); an unknown
compass angle is Mapillary's `-1` sentinel rather than null and now stores
bearing `0` instead of 359 (`knownCompassAngle`); and the edit map's view
wedge is drawn from the viewer's report of the image it loaded rather than
from the document, so a flat stop with no known angle draws none at all
(`wedgeFor`). **No schema change, no migration, no new dependency.** The
design is
`docs/superpowers/specs/2026-11-11-flat-mapillary-imagery-design.md` and the
plan is `docs/superpowers/plans/2026-11-11-flat-mapillary-imagery.md`.
Its six browser checks are open as **`UNVERIFIED.md` entry 42**, whose first
check — whether `Image.cameraType` is populated at all for a flat image — can
send the design back, and should be done first.

It landed as one commit, `f8988cd`, written on `feature/flat-panoramas` and
now an ancestor of `main`. `make check` was run on it twice — once in the
worktree it was built in, once in the main checkout after the branch was
switched there — and printed `All checks passed!` both times. The second run
is the one worth having: the two checkouts carry their own `node_modules`
and virtualenv, so a pass in one is not a pass in the other.

**Thinning has no exception for 360 imagery**, because the design specified
none, and that is the piece of this nobody has looked at. Fairfax stops have
32-84 panoramas within 40 m, so an author re-searching at one now gets a
thinned list where they used to get every frame. It cannot alter a stop that
already exists — thinning touches only the candidate list — but the design
promised a 360 author would see no change at the top of the list, and this is
a change. Outstanding item 10.

Landing is not shipping. The branch stops before deploying, and sending it to
testers is a separate, manual act (`docs/DEPLOY.md`).

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
  `EntryPage` that reads the publish-time mark and, if absent, asks
  `GET /api/session` with **no deadline** (it was 2 s until 2026-11-17, then
  30 s, briefly; see the note above). A marked page
  (`<html data-published>`) renders the viewer at once with no request.
  Unmarked, it reads the answer three ways. Status 0, a 404, or a 200 that is
  not a session summary (what a static host with SPA rewriting answers) →
  render the **viewer in place**, no navigation, which is the static-host
  case. `{open: true}` → go to `/edit`. `{open: false}` → the welcome screen,
  a lazy chunk. Any other 4xx, or any 5xx → a "broken" message carrying the
  status, the viewer not shown, nothing navigating. After 5 s without an
  answer a "Waiting for the tour service…" line appears; it decides nothing.
  The viewer is mounted from the first paint and merely hidden while the
  request is outstanding, so its `tour-data/` fetches are already in flight
  when the answer is "no backend". See `ARCHITECTURE.md`, "Routing: who is
  asking".
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
  images and audio, records narration from the microphone, and searches for
  panoramas (from the browser, straight to Mapillary) and for places (through
  `backend/app/tools.py`). Archive search and synthesised narration were
  removed for the hosted deployment (ADR 0006). Its top bar carries *Preview* (a plain link to
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
- **Session API.** The open tour is an unpacked working directory, one per
  browser (`<sessions_dir>/<sid>/`, where the sid is in the `tour_sid` cookie;
  see ADR 0006) that every edit writes through to; there is no
  explicit save. A session API opens, edits, closes, exports and publishes it
  as a `.zip`. The whole surface:

  ```
  GET    /api/session                      {"open": false} or a summary
  DELETE /api/session                      discard the working copy; 409 if nothing is open
  POST   /api/session/new                  {"title": …}; 409 if a tour is already
                                           open, unless {"force": true}
  GET    /api/session/examples             {"examples": [{id, title, description}]}
  POST   /api/session/examples/{id}        409 if open, 404 unknown, 400 malformed
  POST   /api/session/import               form field `file`, one .zip; 409 if a tour
                                           is already open, unless -F force=true
  POST   /api/session/import-files         form field `files`; each part's FILENAME is
                                           its bundle-relative path (media/pano/x.jpg);
                                           409 if a tour is already open
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
- **Themes.** The viewer reads the tour's `theme` and dresses itself in it; the
  editor opens a *Theme* dialog from a button in its header (preset, colours,
  type pairing, type scale, layout, a contrast readout that warns and never
  blocks) over a live miniature. It is a modal rather than a sidebar pane
  because a theme is set once and stops are edited for an hour after. The editor, the welcome screen and the entry page are never
  themed. See the paragraph under "Current state".
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
curl -c jar.txt -b jar.txt -X POST localhost:8000/api/session/new \
  -H 'Content-Type: application/json' -d '{"title": "A tour"}'      # start empty
curl -c jar.txt -b jar.txt -X POST localhost:8000/api/session/import \
  -F file=@tour.zip -F force=true                                   # open a bundle
curl -c jar.txt -b jar.txt localhost:8000/api/session/examples      # what examples exist
curl -c jar.txt -b jar.txt -X POST \
  localhost:8000/api/session/examples/fairfax-old-town              # open one, media and all
curl -c jar.txt -b jar.txt -X PUT localhost:8000/api/session/tour \
  -H 'Content-Type: application/json' -d @tour.json                 # write the document
curl -c jar.txt -b jar.txt localhost:8000/api/session/export -o tour.zip  # save it out as a zip
curl -c jar.txt -b jar.txt localhost:8000/api/session/publish -o site.zip # a backend-free static site
curl -c jar.txt -b jar.txt -X DELETE localhost:8000/api/session     # discard the working copy
```

**Every line carries `-c jar.txt -b jar.txt`, and that is not decoration.** A
session now belongs to a cookie (`tour_sid`), and each `curl` is a fresh client
that remembers nothing. Without a cookie jar, `new` mints a session and throws
the cookie away, then `export` arrives cookieless, finds nothing open and 409s
with "no tour is open" — and the `new` before it left a directory nobody can
reach. This was run, not reasoned: against a live backend, `new` followed by
`export` with no jar answered `409`, and the same pair with the jar answered
`200`, the zip containing `bundle.json` and `tour.json`. `-c` writes the
cookie the server sets and `-b` sends it back; give both on every line so
the order of the lines stops mattering. Delete `jar.txt` to become a
different historian.

The cookie is `Secure`, which does not stop this on `http://localhost`: with
curl 8.7.1 it was stored (`#HttpOnly_localhost ... TRUE ... tour_sid ...` in
the jar) and sent back on the next request. Whether other curl versions treat
`localhost` the same was not tried. The one setting to know about is where the
sessions land: with no `SESSIONS_DIR` in `backend/.env` they go to
`~/.clio-wired/sessions`, outside the repository, so a terminal session leaves
directories in your home folder. Point it somewhere disposable
(`SESSIONS_DIR=/tmp/sessions` in the environment, which is how this was run, or
a line in `backend/.env`) for throwaway work. A second shell with its own jar is a second session, and a
`curl` with no jar at all mints a new one each time it is allowed to
(`new`, `import`, `import-files` and the examples route mint; `export`,
`publish`, `PUT tour`, media upload, `DELETE` and `tour-data/` never do).

Every route that replaces the session directory refuses while a tour is already
open, because the working directory is the author's only copy of an
unexported tour: `new` and `import` take `force` to say the discard is
deliberate (`-F force=true` on `import`, since its body is already
multipart), and `import-files` and the examples route take nothing — close
the tour first. The `force=true` above is there because the line before it
opens an empty tour; drop it when nothing is open.

`DELETE /api/session` is what the editor's *Close tour* calls. It deletes
the session directory and there is no undo: export first. It refuses with 409 when
nothing is open, which is deliberate — a caller asking to close nothing has a
stale idea of the session, and saying so beats agreeing with it.

Loose files go to a second import route, which is what the welcome screen's
drop zone uses. Each part's *filename* is its path inside the bundle, so
nested media keeps its directory. **Close the open tour first** — this
replaces the session directory, so it 409s while a tour is open, exactly as `new`
and the examples route do:

```sh
curl -c jar.txt -b jar.txt -X POST localhost:8000/api/session/import-files \
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

Every edit above writes straight through to the session directory. See
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
panorama (`media/pano/pano-<stop>.jpg is not referenced by the tour`) — as
recorded under schema v2; under v3 the same call returns `"orphanCount": 0`
and no warnings (ADR 0005; re-run on 2026-11-06), and
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
curl -c jar.txt -b jar.txt -X POST localhost:8000/api/session/examples/fairfax-old-town
```

That one line replaces everything below it, and the rest of this section is
kept only to explain what it does and what used to go wrong. The long way,
which is still what to reach for with a tour that is *not* a shipped example:

```sh
curl -c jar.txt -b jar.txt -X POST localhost:8000/api/session/new \
  -H 'Content-Type: application/json' -d '{"title": "Old Town Fairfax"}'

curl -c jar.txt -b jar.txt -X PUT localhost:8000/api/session/tour \
  -H 'Content-Type: application/json' -d @content/tours/fairfax-old-town.json

# The session directory is named by the sid; GET /api/session reports it as
# recoveryKey while a tour is open. SESSIONS_DIR is whatever backend/.env sets
# (default ~/.clio-wired/sessions).
SID=$(curl -s -c jar.txt -b jar.txt localhost:8000/api/session \
  | python3 -c 'import sys,json; print(json.load(sys.stdin)["recoveryKey"])')

# Copy the media, but not manifest.json. *.jpg and *.m4a are the three
# archival photographs and the six narration clips; pano/ is the cached
# panoramas the stops' cachedMediaId fields point at.
cp content/media/*.jpg content/media/*.m4a "$SESSIONS_DIR/$SID/media/"
cp -R content/media/pano "$SESSIONS_DIR/$SID/media/"

curl -c jar.txt -b jar.txt localhost:8000/api/session/export -o fairfax-old-town.zip
```

Run against a live backend with `SESSIONS_DIR` set to a temporary directory,
this returned `"stopCount": 6`, `"mediaCount": 15`, `"orphanCount": 0` and
an `export` of `200`. (Export `$SESSIONS_DIR` in the shell first, or
substitute the path.)

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
  **That orphan count is now 0, and the six warnings below are now none.**
  The run above is kept as recorded, but schema v3 corrected the accounting:
  those six were never orphans, they were the stops' cached panoramas, and
  the reference check simply could not see them (ADR 0005). Everything else
  in this transcript still holds; a rerun today differs only in those two
  figures.
- `GET /api/session/export` returns a 4.5&nbsp;MB zip (4,536,271 bytes).
- Re-importing that zip (`curl -X POST localhost:8000/api/session/import -F
  file=@fairfax-old-town.zip -F force=true`) returns 200, `"stopCount": 6`,
  `"mediaCount": 15`, and six warnings, one per panorama: `media/pano/
  pano-<stop>.jpg is not referenced by the tour`. These were
  informational, and as of v3 they are not emitted at all — see the note
  above.
  (`force=true` was added to that line afterwards, when `import` gained the
  conflict guard: the recorded run did it with the exported tour still open,
  which now needs saying out loud. The figures are the live ones.)
  The panoramas are cached copies named by `cachedMediaId` (`cachedPath`
  when this was recorded), not overlay images, and the importer keeps them.
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

Items 1 to 9 are still true as of 2026-10-26, and none has been closed.
Items 10 and 11 arrived with the flat-imagery work on 2026-11-11.

The welcome-screen sub-project's reviews also left a list of findings they
judged and deliberately did not fix, in
[`superpowers/reviews/2026-10-26-welcome-screen-followups.md`](superpowers/reviews/2026-10-26-welcome-screen-followups.md).
Its first item — that `PUT /api/session/tour` guards on `is_open` alone, so a
stale editor tab's autosave can overwrite whichever tour is open now — is the
one remaining way to lose the author's work without saying so, and is a better
candidate for the next session than anything numbered below.

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
   - ~~A real loc.gov redirect through `archive-fetch`.~~ The tool is gone
     (ADR 0006).
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

10. **Candidate thinning applies to 360 imagery too, and nobody has judged
    whether it should.** `thinBySpacing` keeps roughly one frame per 10 m
    within a sequence (`MIN_CANDIDATE_SPACING_M`) regardless of projection,
    because the flat-imagery design specified no exception. It exists because
    the pano-only filter it replaced was silently doing two jobs — excluding
    flat imagery *and* keeping a dense drive from burying everything else —
    and dropping the filter exposed the second one. The cheaper fix of one
    frame per sequence was rejected on evidence: Rye's 28 images are a single
    sequence, so that would have thinned a whole town to one vantage point.

    The open question is Fairfax, where stops have 32-84 panoramas within
    40 m. Those authors now see a thinned list. **No existing stop can
    change** — thinning touches the editor's candidate list and nothing
    else, and no stored field is involved — so this is a question about the
    authoring experience, not about the shipped tour. Judging it needs a
    browser and the Fairfax tour open, which makes it part of the same first
    browser session as `UNVERIFIED.md` entry 42. The three outcomes are:
    leave it, exempt panoramas from thinning, or widen the spacing for them.

11. **Author-uploaded base imagery is designed and not built.** The sibling
    question to the flat-imagery work — letting an author supply their own
    images, 360 or flat, where Mapillary has none — is specified in
    `docs/superpowers/specs/2026-11-11-uploaded-base-imagery-design.md`, on
    the evidence in `-findings.md` beside it (1305 lines, gathered by
    reading the code, not estimated). Unlike item A it is **large**: it needs
    a schema bump and a migration (v4 went to theming and v5 to the tour
    icon, which took them first, so this is v6 or later), a self-hosted
    viewer so `PanoramaViewer` is no longer only mapillary-js, a direct
    three.js dependency pinned to the 0.134.0 that arrives transitively
    today, and `publish.py` taught to read more of the document — it reads
    one field of it already, `Tour.icon`, through `migrate` and `Tour`
    (ADR 0009's amendment), but it still zips the working directory
    wholesale and knows nothing of imagery, which an earlier draft of that
    design got wrong (it said `publish.py` imported only `zipfile` and
    `Path`) and had to correct.

    It is **not ready to implement.** Eight decisions taken after its
    builder check are not yet written into it, four of them the author's.
    The design's §6.5 still states the corrected-away premise that bundle
    and publish are one filter. Read the findings before the design.

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
  before, 2.15 MB / 372.09 kB after — because the welcome screen is its own
  11.62 kB chunk and a published visitor never fetches it. That was the
  constraint the whole routing design was built around.
- **A published visitor used to pay a probe, and no longer does.** *(Superseded
  2026-11-17.)* It was issued concurrently with the viewer's own `tour-data/`
  fetches, and a host that black-holed `/api/session` cost the full 2 s
  deadline as a blank page, written down in `UNVERIFIED.md` entries 20 to 22.
  A marked page now makes no probe (ADR 0010). The only visitor who can still
  wait is one using an unpublished bundle hand-copied onto a static host that
  black-holes `/api`, and they wait indefinitely: the unmarked path has no
  deadline (the 30 s one that replaced the 2 s was withdrawn because the host
  once took 73.2 s), so they see the waiting line and never the tour.

One thing this branch broke and the documentation pass caught: **the viewer's
own 404 message had gone stale in exactly the way the entry above describes.**
It said *"Open or import one in the editor, or follow 'Opening the existing
six-stop tour' in docs/HANDOFF.md"* — naming a capability this branch deleted,
since `/edit` with nothing open now bounces to `/`. It now says *"No tour is
open. Go to the start screen at / to create one, import a bundle, or open the
example."*, and `viewer-page.spec.ts` asserts it does not say "in the editor".
Shipping a stale pointer in the message a reader sees when nothing is open
would have been this branch's own defect, committed at the end of it.

Figures after: 407 backend, 599 frontend. Three of those tests arrived with
this documentation pass rather than the feature: writing a guarantee down is
what exposed that nothing enforced it, twice — "`make content` leaves
`content/examples/` alone" (now two tests in `test_content.py`) and "nothing
recovers a map measured at the wrong size" (now a guard in
`entry-page.spec.ts`).

The front door has never been seen in a browser either, so it arrives with
thirteen new `UNVERIFIED.md` entries, and the welcome screen is now that
document's entry 1 — it is how you get a tour open before checking anything
else.

### What the whole-branch review changed afterwards

Three things it found were worth fixing before handing the branch over, all
of them the same shape: a guarantee the branch states in one place and does
not keep in another.

- **The drop zone was the hole in the one-tour guarantee.** `new` and the
  examples route both 409 while a tour is open, because replacing
  the session directory throws away the author's only copy of an unexported tour.
  `POST /api/session/import-files` did not, so a drop onto a *stale* welcome
  screen — a second tab left showing the front door — replaced the first
  tab's tour silently. It now refuses in the same words.
- **So does `POST /api/session/import`, and that one nearly got away.** It was
  scoped out of the review as inherited and predating this branch, which was
  the wrong test of whether it mattered: `ingest` sends every single-`.zip`
  drop to it, and a packaged bundle is the first thing the drop zone's own
  text offers, so the stale-second-tab scenario still worked in full, through
  the most prominent control on the screen this branch added. It now takes
  `force` — `Session.new`'s flag and its bargain, that the remaining ways to
  lose an open document all require saying so on purpose — as a multipart
  field beside the file. The welcome screen never sends it, and
  `session-api.spec.ts` asserts that it does not.
- **That route also wrote a big drop to disk twice before refusing it**, on
  the event loop: staging copied every part into a temp tree, `write_bundle`
  deflated the lot, and only `read_bundle` then applied the 5000-entry /
  512 MB caps. (The loose route's own count check is `>= MAX_ENTRIES`, one
  lower than it looks: staging adds a `bundle.json`, so N parts are N + 1
  archive entries.) Both are now checked off the parts list first, and the route
  is a plain `def` so the copy runs in the threadpool rather than stalling
  every other request this process serves. A folder of two thousand JPEGs is
  not an exotic drop for someone who moves photographs on USB sticks.
- **Two messages were nearly true, which is this branch's own defect to
  commit.** A `.zip` dropped with anything beside it fell through to the
  loose-file path and was reported as not being part of a tour; it now says a
  bundle has to be dropped on its own. And the skipped notice gave the media
  allow-list as its reason for a list that also holds AppleDouble sidecars,
  whose names end `.jpg`; it now gives the general reason.

Smaller: `entry-page.spec.ts` now asserts the "no further `/api` call" the
design named and the tests had not; the window-level stray-drag guard no
longer takes `preventDefault` from a text field or claims the whole page for
a drag carrying no files — while still answering a *file* dropped on a text
field, since an unanswered file drag is the navigation the guard exists to
stop; and `editor-page.ts` records why the close dialog shuts before the
DELETE rather than after it.

Figures after: 413 backend, 606 frontend.

### 2026-11-11: flat (non-360) Mapillary imagery

Commit `f8988cd`, written on `feature/flat-panoramas`. What the branch does
is under Current state and what it left open is Outstanding item 10; what
belongs here is how it was decided and the two things that were got wrong
first.

The opening question was how hard it would be to support **(A)** Mapillary's
non-360 imagery and **(B)** authors uploading their own images where
Mapillary has none. Reading the code instead of estimating settled that A was
small and B was not, so A was specified, built and landed in a day while B
stayed a document (Outstanding item 11). The motivation was not hypothetical:
much of Europe has no usable 360 coverage, and testers in those places could
not make a stop at all.

Two findings came from probing the live Graph API from the workstation with
the author's token, and neither could have been reasoned out:

- **`camera_type` is a valid field on an image.** It had been called
  unverifiable and cut from the request on that basis — a wrong call,
  reversed when the probe answered `"perspective"`. It was then cut again
  deliberately, because nothing reads it: the badge reads `is_pano`, and the
  view and the wedge read what the viewer reports about the image it actually
  loaded, which is a better source than what the search said beforehand.
- **Mapillary answers `-1` for "no compass angle", not null.** `document-ops`
  normalised that into the valid bearing `359`, so a stop built on an image
  of unknown direction aimed the view almost due north and looked
  deliberate. An existing test asserted the wrong value (`-10` → `350`); it
  was rewritten with a comment recording that it had encoded the defect.
  This is the second time a guessed bearing has cost this project real work —
  see the landmine above — and the fix is the same principle: absent now
  reads as absent.

Three of six candidate European sites probed that day were flat-only, which
is the whole argument for the branch.

The unplanned discovery was that **the pano-only filter was doing a second,
undocumented job** — thinning a dense capture drive down to something
browsable — so removing it degraded the list in a way the design had not
anticipated. That is where `thinBySpacing` came from, and why it is spatial
rather than per-sequence: Rye's 28 images are one sequence, so one frame per
sequence would have reduced a whole town to a single vantage point.

Figures after: 696 backend, 740 frontend; lint and production build clean.
The branch changed no schema, ran no migration and added no dependency, and
none of it has been seen in a browser (`UNVERIFIED.md` entry 42). The new
Playwright case `frontend/tests/e2e/flat-imagery.spec.ts` has **never been
executed** — it needs `MAPILLARY_TOKEN` and skips without one — and `make
check` does not typecheck `tests/e2e/` at all, since neither tsconfig
includes it, so it was typechecked by hand.
