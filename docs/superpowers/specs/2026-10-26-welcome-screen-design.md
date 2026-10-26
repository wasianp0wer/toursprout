# The welcome screen: a front door for the authoring app

Design, 2026-10-26, branch `feature/authoring-app`.

## Intent and why

Opening `localhost:4200` today shows a failure. If no tour is open in the
session, the viewer reports that no tour is open and points at
`docs/HANDOFF.md`; the editor at `/edit` reports the same thing for the
same reason. Both messages are now honest (commits `53f57ca`, `c49f2b9`),
which is an improvement over the previous lie about an unreachable
backend, but honest is not the same as usable. The application has no way
to get data into itself. Everything that puts a tour in the session is a
`curl` incantation transcribed out of `HANDOFF.md`, including a two-command
`cp` step that the document has to shout about because forgetting it
produces a tour whose every photograph and narration clip 404s.

This is the first thing a real browser session found, and it is a front
door problem: the application cannot be opened, only bootstrapped. The
welcome screen is the front door. After it exists, a person who has never
read `HANDOFF.md` can open the app and start working.

A second thing falls out of it. The authoring app currently has no way to
*stop* working on a tour. The open tour is the working directory and there
is no save, so there is also no close — once something is open it is open
until someone deletes `content/work/` by hand. Giving the app a front door
means giving it a way back to the front door.

## Goals

- Opening the app at `/` with nothing in the session presents a way in:
  create, import, or open an example.
- Opening the app at `/` with a tour already in the session continues that
  work, without an interstitial.
- Opening a *published* tour at `/` is unaffected. A visitor to a published
  static site sees the tour, never the welcome screen, and the welcome
  screen's existence costs them nothing they would not already download.
- The six-stop Old Town Fairfax tour, media included, can be opened in one
  click. This replaces the "Opening the existing six-stop tour" procedure in
  `HANDOFF.md` as the normal way to do it.
- A tour can be closed, returning to the welcome screen, without losing work
  by accident.
- The viewer stays reachable while authoring, at a URL that means it.
- Guide links are present and placed, pointing nowhere, so the eventual
  handbook has somewhere to land.

## Non-goals

- **No project library and no recent-tours list.** One tour is open at a
  time, which is what the session API models, and keeping a tour means
  exporting a `.zip`. A list of past projects would require the backend to
  own a store of tours, which ADR 0002 deliberately decided against.
- **No new authoring capability.** Nothing here edits a tour. The welcome
  screen's entire job is to get a document and its media into the session
  and hand off to the editor. The *Preview* link is the one addition to the
  editor's chrome, and it only navigates; it is there because this change
  would otherwise make the viewer unreachable.
- **Not writing the guides.** The links are placed and inert, by the
  author's decision.
- **No change to the viewer**, to the publish output, or to the schema.

## Anti-goals

These would make this a failure even if it worked.

- **A welcome screen that a published site's visitors can reach.** A member
  of the public who opens a published walking tour and is asked to import a
  `.zip` has been shown the author's workbench. If the design cannot
  guarantee this, it is wrong.
- **Any path where closing a tour loses work silently.** The working
  directory is the only copy. See the close flow below.
- **A second bootstrap procedure.** If `HANDOFF.md` still needs its `curl`
  and `cp` sequence after this ships, the feature missed.
- **Another misleading error message.** The defect this feature grew out of
  was a message that named the one fix that could not work. "No tour is
  open" and "no backend here" are different situations with different
  remedies and must stay distinguishable.

## Constraints

From the existing code and recorded decisions. A builder should treat these
as fixed.

- **`/` is also the published viewer.** `frontend/src/app/app.routes.ts`
  loads `ViewerPage` eagerly at `''` and again at `'**'`, with a comment
  explaining both: the published-site visitor is the dominant real consumer
  and must not wait on a second chunk, and the wildcard catches
  `index.html` under `<base href="./">` on static hosts that do not rewrite
  directory requests. Both reasons still hold.
- **A published site has no backend.** It serves the built app plus
  `tour-data/`. Any `/api` call from it fails. The viewer makes none today
  and must continue to make none on its own path.
- **The session API is the only way in.** `GET /api/session` returns
  `{"open": false}` or a summary (`open`, `tourId`, `title`, `stopCount`,
  `mediaCount`, `orphanCount`). `POST /api/session/new` takes `{"title":
  ...}` and 409s if something is open unless given `{"force": true}`.
  `POST /api/session/import` takes one `UploadFile`. There is no close
  route and no examples route; both are new work.
- **Media is allowlisted, and there are two allowlists — use the import
  one.** `media/` may hold only the image and audio types uploads accept,
  because a published site serves `tour-data/` from the author's origin and
  anything else there would run as executable content. Two different pieces
  of code enforce that, and they are **not** interchangeable:
  - `bundle._check_media_file` is the *import* path. It sniffs and
    extension-checks, and **preserves file names and nested directories**.
  - `media_store.store_media` is the *upload* path. It deliberately
    **renames** every file to `<slug>-<contenthash><ext>` and writes it flat
    into `media/`.

  **Every new ingestion path in this design — examples and loose-file import
  — uses the import path.** Not `store_media`. The repository's own tour
  requires it: `content/tours/fairfax-old-town.json` references media by
  exact name (`court-1863.jpg`, `narration-historic-courthouse.m4a`) and six
  panoramas by nested path (`"cachedPath": "media/pano/pano-historic-courthouse.jpg"`).
  Routing an example through `store_media` would rename all nine media ids,
  flatten `pano/`, and leave a document pointing at files that no longer
  exist under those names — so `mediaCount`/`orphanCount` would not match
  the acceptance figures below and `export` would 409 on missing media
  instead. The two allowlists also differ in content: import allows `.jpeg`,
  `store_media`'s table does not.

  This is also why `cp content/media/*` is wrong: it sweeps in
  `manifest.json`, which import correctly refuses.
- **Mutating routes refuse `Sec-Fetch-Site: cross-site`.** New mutating
  routes take the same `_reject_cross_site` dependency.
- **The content pipeline stays.** `make content` and
  `content/source/stops.json` are untouched by this work. Outstanding item 2
  in `HANDOFF.md` — the drift between `stops.json` and the shipped document
  — is the author's open decision and this design does not resolve it or
  depend on it.
- **No browser runs in the development sandbox.** This feature is a screen,
  so its verification is the jsdom suite plus backend tests, and the first
  person to see it in a browser will be the author. Every new surface gets
  an entry in `docs/UNVERIFIED.md`.
- **TDD, per project convention.** Failing test first.

## How it works

### Routing: `/` decides

`''` stops being `ViewerPage` directly and becomes a small eager component
— call it the entry page — that asks `GET /api/session` once and then
resolves to one of three outcomes:

| What the session says | What happens |
| --- | --- |
| Request fails, or does not answer inside the timeout below | Render `ViewerPage` **in place**, no navigation. This is the published-site case and today's behaviour, including today's honest failure messages. |
| `200 {"open": true, …}` | Navigate to `/edit`. |
| `200 {"open": false}` | Render the welcome screen (lazy chunk). |

Rendering the viewer *in place* rather than redirecting is deliberate and is
the anti-goal above made structural: a published site cannot reach the
welcome screen, because reaching it requires a backend that answered. It
also leaves the published URL untouched, which matters on static hosts that
404 unknown paths rather than rewriting them to `index.html`.

The entry page must stay small and eager. The welcome screen itself is a
lazy chunk, like the editor, so the published-site visitor downloads none
of it.

**The probe must not delay the published site's first paint, and this is a
call taken here rather than left open.** Today `/` renders `ViewerPage`
immediately and its constructor starts fetching `tour-data/config.json` and
`tour-data/tour.json`. If the entry page waits on `/api/session` before the
viewer may begin, every published-site visitor — the dominant real consumer
— pays a round trip for a request that exists only to fail. So:

- The session probe and the viewer's own `tour-data/` bootstrap are issued
  **concurrently**, not in sequence. The routing decision waits only on the
  probe; the viewer's data is already in flight when it resolves.
- The probe carries a **short timeout** (2 s is the suggested starting
  figure, and the builder may tune it). A host that black-holes the request
  rather than refusing it must not produce a blank page until the browser
  gives up. Timeout is treated as "no backend".
- Until the probe resolves, the entry page renders a quiet neutral
  placeholder, not an error and not a partial welcome screen. A refused
  connection resolves in single-digit milliseconds, so in the normal
  published case this is not seen.

The anti-goal test (below) therefore asserts on **concurrency**, not merely
on call order: the viewer's bootstrap must be observable as having started
without waiting for the probe to fail.

Add an explicit `path: 'view'` → `ViewerPage` before the wildcard, so there
is a URL that always means "show me the tour as a reader sees it" and does
not bounce back to the editor through the decider. `'**'` already resolves
there, but relying on the wildcard for a first-class control is accidental.
Preview is only ever used with a backend running, so a static host's
treatment of `/view` does not arise.

**A *Preview* link in the editor's top bar is in scope**, by the author's
decision. It is one link to `/view`, not an authoring capability, and
without it the viewer becomes unreachable with the backend up: `/` now goes
to the editor whenever a tour is open. That has a documentation
consequence this work must carry — **`docs/UNVERIFIED.md` entries 2 and 9
currently instruct the reader to open `http://localhost:8000/`**, which
after this change lands in the editor. Both entries move to `/view`. Entry 2
is one of the two recommended starting points for the first browser
session, so leaving it stale would send the first real run to the wrong
place, which is the exact failure this feature grew out of.

### The editor's existing empty state goes away

`editor-page.html` already carries a full "no tour is open" state — a
heading, a title input and a *New tour* button calling
`POST /api/session/new`. The welcome screen supersedes it. Rather than keep
two ways to create a tour:

- **`/edit` with nothing open navigates to `/`**, which then shows the
  welcome screen. There is one front door.
- The editor's empty-state markup and its `New tour` handler are removed.

**Closing tears the editor down.** After the close route returns, the
editor must not remain mounted over a session that no longer exists — its
draft store would still hold a tour and `Autosave` would keep issuing
`PUT /api/session/tour`, which now 409s and surfaces as "Save failed". That
is precisely the misleading-message anti-goal. Close therefore: calls the
close route, tears down the draft store and stops autosave, then navigates
to `/`. The builder should expect this to be the larger half of the close
work — it is a lifecycle change, not just a dialog.

### The welcome screen

Layout chosen by the author from two mockups (the alternative put the three
choices side by side with guides in a footer). Left two-thirds, right
third.

**Left, largest element: a drop zone.** It accepts either a packaged `.zip`
bundle or a loose `tour.json` together with its media folder, and carries a
browse link for anyone who would rather pick files than drag them. The
loose-file path exists because the repository's own tour is in that shape —
`content/tours/fairfax-old-town.json` beside `content/media/` — and
requiring the author to zip it first would be re-inventing the procedure
this feature is meant to delete.

**Left, below it: two smaller buttons.**

- *New empty tour* asks for a title and nothing else, matching what
  `POST /api/session/new` already takes, then goes to the editor. Everything
  else is set in the editor where it can be seen. (The author considered
  also asking for a starting location so the map and panorama search open
  somewhere useful, and chose not to.)
- *Open example* opens an example tour, media and all, in one click.

**Right third: a standing column of guide links** — getting started, stops
and narration, placing a photograph, finding panoramas, publishing — styled
as links, with a quiet note that they are not written yet. Clicking does
nothing. The author chose visible-but-inert over stubbing a `/guides` route
or pointing at the repository's own markdown.

### Examples are a generic facility

The author chose a permanent, generic example mechanism over either a
hardcoded "Fairfax demo" button or a development-only convenience. So:

- The backend exposes the examples it has, and the welcome screen renders
  whatever comes back. Fairfax is one entry in that list, not a special
  case in the frontend.
- An example is a document plus a media directory, somewhere under
  `content_dir`. Opening one performs, server-side and atomically, what
  `HANDOFF.md`'s procedure does by hand: create the session, write the
  document, copy the media **through the import allowlist**
  (`bundle._check_media_file`, preserving names and `pano/`; see the
  constraint above) so `manifest.json` and anything else inadmissible is
  excluded rather than copied and later refused.
- **Opening an example copies. It never mutates the example.** Each click
  writes a fresh copy of the document and its media into `content/work/`,
  leaving the source untouched. The example's media directory is shared with
  the content pipeline and is not the session's to modify.
- With no examples configured, the button is absent. The welcome screen
  must read correctly in that state; it is the state every author other
  than this one will be in.

The first example is the six-stop Old Town Fairfax tour. The observed
figures for a correct open are in `HANDOFF.md` and are the acceptance
target: `stopCount` 6, `mediaCount` 15, `orphanCount` 6, and an export of
roughly 4.5 MB that re-imports cleanly with six informational warnings
about unreferenced panoramas.

**It is a frozen committed snapshot, not a pointer at the live pipeline
output**, by the author's decision. `content/tours/fairfax-old-town.json` is
the file `make content` regenerates, and `HANDOFF.md` outstanding item 2
records that regenerating it silently reverts the hand-tuned courthouse
alignment. An example that changed depending on when the author last ran the
pipeline would also make the acceptance figures above unreproducible. So the
example is its own committed artifact under `content/`, and **`make content`
must leave it alone** — the `content:` target must not write to it, and if
that is not already structurally true the builder makes it so. This design
does not resolve outstanding item 2; it declines to be affected by it.

### Closing a tour

A *Close tour* control lives in the editor's top bar beside Export and
Publish, and is the only way back to the welcome screen. The author chose
the guarded flow over a plain confirmation.

Guarded means the dialog:

- names the tour and what is in it, in the terms the session already
  reports — title, stop count, media count;
- says plainly that the tour only exists here and closing deletes the
  working copy;
- offers *Download tour.zip* as the prominent action;
- keeps the cold-close action unavailable until the author has either
  downloaded the bundle or explicitly acknowledged that they do not want
  it;
- offers *Keep working* as the quiet way out.

**How the dialog knows a download happened — a call taken here.** The
editor's existing export control is `<a href="/api/session/export" download>`,
and an anchor click gives the page no completion signal; nothing in the
backend reports the bundle's size without building it. So the dialog's
download fetches `GET /api/session/export` as a blob and hands it to the
author through an object URL. That one request yields both facts: the
transfer resolving is the completion signal that releases the gate, and the
blob's length is the exact size. The size is therefore shown *after* the
bundle exists, not predicted before it — no size-estimate route, and no
building the archive twice. The cost is holding a few megabytes in memory
briefly, which is acceptable for a deliberate, once-per-session action.
The editor's top-bar *Export* control is unaffected and stays a plain link.

**When the bundle cannot be built — also a call taken here.**
`GET /api/session/export` 409s when the open document references media the
archive does not have (`bundle.py`'s `missing_media`). That is the worst
case: the working copy is the only copy *and* it cannot be bundled. Close is
**not** refused in that state — refusing would trap the author in a tour
they cannot leave. Instead the dialog reports plainly that the tour cannot
be exported as it stands, says why, and falls back to the acknowledge path,
so discarding it is possible but only ever on purpose.

Closing then discards the working directory through a new backend route.
That route is destructive, so: it is mutating (cross-site refused), and it
fails loudly rather than partially. It is not the only code that removes
`content/work/` — `Session.new(force=True)` does too — but it is the only
one whose purpose is removal, and the two should share whatever does the
removing rather than growing a second implementation.

## What is left to the builder

- **The loose-file import mechanism.** Two reasonable shapes: assemble the
  dropped files into a bundle in the browser and post it to the existing
  single-file `POST /api/session/import`, or extend that route to accept
  several parts (a document plus media files). The second keeps one
  endpoint, one allowlist and one set of warnings, and avoids putting a zip
  writer in the eager bundle; the first leaves the backend untouched. Either
  must produce the same session state and the same warnings as importing the
  equivalent `.zip`, and must reject the same things.

  **Whichever shape is chosen, each media file must carry its path relative
  to the media root, not just a flat file name.** The repository's own tour
  is the motivating case and it has a `media/pano/` subdirectory, so a flat
  `File[]` is not enough: the drop handler needs `webkitRelativePath`, or
  `webkitGetAsEntry` to walk a dropped directory. Nested paths surviving
  intact is the whole reason the loose-file path exists, and it is the first
  thing to test.
- **How examples are configured** — a settings field, a manifest file in
  `content/examples/`, or convention over `content/tours/` — and what each
  entry carries beyond id, title and media directory. A short description
  for the button is likely wanted.
- **Route names and shapes** for closing and for examples, consistent with
  the existing `/api/session/*` family.
- **Whether the entry page's session probe is shared with the editor**,
  which already makes the same call on load, or repeated. Repeating it is
  one extra request and is simpler; sharing it is tidier and risks a stale
  read.
- **All visual detail** beyond the arrangement above: type, spacing, the
  drop zone's hover and error states, what a failed import looks like.
- **Test placement**, following the existing suites: backend tests for the
  new routes including the allowlist behaviour and the 409 cases, and jsdom
  integration tests for the three-way routing decision, which is the part
  most worth pinning because the published-site branch cannot be checked by
  eye here.

## Verification

`make check` must stay clean: lint, both suites, production build. Beyond
that, three things specific to this work:

- **The published-site branch has a test, not an argument.** A test must
  assert that when `GET /api/session` fails, `/` renders the viewer, makes no
  navigation and no further `/api` call, and that the viewer's `tour-data/`
  bootstrap started without waiting for the probe to fail. A second test
  must cover the probe timing out rather than being refused. This is the
  anti-goal with teeth.
- **The example opens to its recorded figures.** A backend test asserts
  `stopCount` 6, `mediaCount` 15, `orphanCount` 6 after opening the Fairfax
  example, and that the nine named media files and the six `media/pano/`
  panoramas are present under their original names and paths. This is what
  catches a future refactor routing examples through `store_media`.
- **The eager bundle does not grow meaningfully.** The welcome screen is
  lazy. Record the before and after figures; the current eager bundle is
  2.13 MB raw / 371.39 kB transferred.
- **`HANDOFF.md`'s bootstrap procedure is replaced, not supplemented.**
  When the examples path works, the "Opening the existing six-stop tour"
  section becomes a note that the welcome screen does this, with the `curl`
  sequence kept only as the headless fallback it actually is.

New entries go in `docs/UNVERIFIED.md` for everything a browser has to
confirm: the drop zone with a real drag, the loose-file path with the
repository's own `tour.json` and `content/media/`, the example button's
resulting session figures, and the close dialog's gating.
