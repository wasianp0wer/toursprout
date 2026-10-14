# The editing core: placing content against map and street at once

Sub-project 3a of 4. See
`docs/superpowers/specs/2026-10-12-authoring-application-overview.md` for the
whole arc. Sub-project 3 was specified there as one piece; it is split here,
because the editor, media upload, audio recording and the re-homed acquisition
scripts together are larger than sub-projects 1 and 2 combined.

- **3a (this spec): the editing core.** Arrange and place what a tour already
  contains, precisely, against a map and a panorama at the same time.
- **3b: media and acquisition.** Upload files, record audio, and re-home the
  Python content scripts as tools the editor calls.

## Why this slice first, and why it is worth having alone

`docs/HANDOFF.md`'s first outstanding item has been open since the prototype:

> **Rephoto alignment is unfinished.** The anchors are estimates, improved by
> hand in commit `de48b0d` but not finished. Use `?align=1`; it needs eyes on
> a browser.

And its second, found during sub-project 2, is that the hand alignment in
`de48b0d` has silently drifted from `content/source/stops.json`, so the next
`make content` would discard it.

Both are the same problem: **there is no real tool for placing a photograph in
the world, so placement lives in a half-finished keyboard mode and in a JSON
file nobody can see.** This sub-project builds that tool. When it lands, the
author can finish the alignment by eye, the document becomes the only place
placement lives, and the drift question answers itself.

That is worth shipping before any media work, and it needs nothing from 3b.

## What this can and cannot do without 3b

An `image` or `audio` overlay requires a `mediaId`, and nothing can produce one
until upload exists. So:

- **Can:** place, align, resize, re-anchor, reorder, retitle, re-credit and
  delete **every overlay that already exists**, including the two courthouse
  photographs. Add and edit **text** overlays. Add, reorder and delete stops.
  Edit tour-level fields.
- **Cannot:** add an image or audio overlay. The editor shows the action and
  explains that it arrives with media upload, rather than hiding it.

## Shape

A second route, not a second application. The viewer stays exactly as it is.

| Route | Is |
| --- | --- |
| `/` | the viewer, unchanged |
| `/edit` | the editor |

`@angular/router` and `@angular/forms` are already dependencies and are not yet
wired into `app.config.ts`; this adds `provideRouter`. No new dependency.

The old `?align=1` mode retires: it was a stopgap for exactly this, and keeping
two placement mechanisms would mean two things to maintain and two to disagree.
Its pure reducer `nudgeAnchor` is **kept and promoted**, because it is the
correct arithmetic and is already tested.

### The three surfaces

```
+----------------+---------------------------+----------------+
|  OUTLINE       |   MAP (top-down)          |  INSPECTOR     |
|                |                           |                |
|  Stop 1        |      \  cam  /            |  lng  -77.3072 |
|   - text       |       \ FOV /             |  lat   38.8456 |
|   - photo  *   |   =====*=====  footprint  |  altM    3.0   |
|   - audio      |        o  drag = position |  headDeg 284.4 |
|  Stop 2        |        ^  rotate = heading|  widthM  18.0  |
|   ...          +---------------------------+  heightM 12.0  |
|                |   STREET (panorama)       |  opacity  0.70 |
|  [+ stop]      |                           |                |
|  [+ text]      |     [ghosted photograph]  |  [derive       |
|                |      drag = altitude      |   heading]     |
|                |      nudge = fine align   |                |
+----------------+---------------------------+----------------+
```

Each property lives in exactly one surface, and all three read and write the
same state:

| Surface | Owns |
| --- | --- |
| Map | position (`lng`, `lat`), `headingDeg`, and seeing every overlay at once |
| Panorama | `altitudeM`, `widthM`, `heightM`, and fine alignment against the real scene |
| Inspector | the exact number for any of them, plus titles, bodies and credits |

This division is not cosmetic. A 2D map cannot show how tall something is; a
panorama cannot show what is behind the viewer; and inverse-projecting a drag
in a panorama back to a world position needs a depth the author cannot see.
Each surface is given the properties it can actually represent.

## Derived, never guessed

The project's hardest-won rule. All six hand-authored stop bearings were wrong,
one by 138 degrees, which put the subject behind the viewer. `build_tour.py`
derives `headingDeg` from where the panorama actually stands and ignores any
authored value.

The editor must not quietly reintroduce the thing that rule exists to prevent:

- A newly placed in-world overlay gets its heading **derived** from the current
  stop's panorama position, never typed.
- Dragging the rotation handle, or typing in the heading field, is a deliberate
  manual override. The overlay is then marked as manually oriented, and the
  inspector offers **Derive from panorama** to put it back.
- The marker is per-overlay state in the editor only. It is **not** written to
  the document: the schema records where a photograph faces, not the provenance
  of that number, and adding a field for it would be the editor leaking into a
  format two other sub-projects depend on.

## State, and what "saved" means

`EditorStore` is separate from `TourStore`. The viewer's store is navigation
state — current stop, arrival latching, opacity — and bolting a draft document
onto it would tangle two lifetimes that have nothing to do with each other.

`EditorStore` holds the draft document, the selection, dirty state, an undo
stack, and the last validation error. It is a plain signal store with no DOM,
no HTTP and no map, so the whole of the editor's logic is testable without a
browser — which matters more here than anywhere else in the project, because
**no browser can run in the development sandbox at all.**

- **Autosave.** Every mutation marks the draft dirty; a debounced
  `PUT /api/session/tour` follows. Sub-project 2 made that endpoint
  validate-then-`os.replace`, so a save either lands whole or does not happen.
- **A rejected save is not a lost edit.** A 422 keeps the draft exactly as it
  is, shows the message against the offending field where the path can be
  recovered from pydantic's error, and retries on the next change. The author
  can always keep typing.
- **Undo** is a stack of whole-document snapshots. The document is tens of
  kilobytes and the alternative is a command pattern over a tree; snapshots are
  the right trade at this size and are hard to get subtly wrong. Depth is
  capped so a long session cannot grow without bound.

## Invariants the editor must maintain

The schema already enforces these; the editor has to avoid producing documents
that trip them, because a draft that cannot be saved is worse than one that can.

- **Stop `order` is contiguous from 1.** Adding, deleting and reordering all
  renumber. This is pure list arithmetic and is tested as such.
- **Ids are unique and stable.** A new stop or overlay gets a slug derived from
  its title, de-duplicated with a numeric suffix. Ids never change when a title
  is edited — the document references them, and a renaming author does not
  expect their links to move.
- **`kind` and `display.mode` must be a legal pair** (text→marker; image→marker
  or inWorld; audio→marker or ambient). The editor offers only legal modes for
  the selected kind, reading the same table the backend validates against
  rather than a second copy of it.
- **A text overlay needs a non-blank body**; an image or audio overlay needs a
  `mediaId`. A new text overlay is created with placeholder body text rather
  than empty, so it is valid the instant it exists.
- **Credit is required.** A new overlay gets an `original` credit pre-filled
  from the tour's `defaults`. If the tour has no defaults yet, the editor asks
  for a creator and licence once and writes them there — which is what the
  `defaults` field was added for in sub-project 1.

## Out of scope

Media upload, audio recording, and the re-homed acquisition scripts (3b). AR,
themes, Omeka. Multi-tour. Collaborative editing. A map basemap other than the
existing OSM raster tiles. Drag-and-drop between stops.

`content/source/stops.json` and `make content` still stand. They retire at the
end of 3b, when the editor can do everything they can — and the drift recorded
in HANDOFF is the author's call to make then, with a tool in hand.

## Testing

TDD throughout. The 195 backend and 214 frontend tests stay green.

**The important part: the logic is pure, so it is testable.** No browser runs
here, so anything that only works inside a real map or a real WebGL context is
effectively unverifiable. The design pushes the real work into functions that
take values and return values:

- `nudgeAnchor` — already pure and tested; extended, not rewritten.
- `deriveHeading(from, to)` — reuses `bearingBetween` in `core/geo.ts`.
- `renumberStops`, `moveStop`, `addStop`, `deleteStop` — list arithmetic over
  the document, each asserted to leave `order` contiguous from 1.
- `addOverlay`, `deleteOverlay`, `setDisplayMode` — document transforms, each
  asserted to produce something the **backend** accepts, by round-tripping
  through a real `PUT` in the backend suite rather than trusting the frontend's
  idea of valid.
- `slugify` and id de-duplication.
- The undo stack.
- `legalModesFor(kind)` — asserted against `DISPLAY_MODES_BY_KIND` so the two
  cannot drift.

**Components** are tested in jsdom for the wiring: that dragging emits the
right store call, that the inspector reflects the selection, that a 422 renders
a message, that choosing a kind offers only legal modes.

**What cannot be tested here, and must be said plainly:** whether a drag feels
right, whether the footprint drawn on the map corresponds to what the plane
looks like in the panorama, and whether the alignment the author achieves is
actually aligned. Those need the author, a browser, and the real tour. The
acceptance below is written so that the first thing they do outside the sandbox
is the thing this was built for.

**Acceptance.** `make check` green. Then, outside the sandbox: open `/edit` on
the real tour, select the 1863 courthouse photograph, and align it by eye using
map, panorama and inspector together. Save. Reload. It is still aligned.

## Risks

- **The largest piece of UI this project has had**, in an environment where no
  part of it can be seen. Mitigated by keeping logic pure and components thin,
  and by being explicit about what remains unverified.
- **mapillary-js renders on demand.** Changing custom content does nothing
  until `triggerRerender()`. This has already produced two wrong root-cause
  conclusions in this project's history; an editor mutates the scene constantly
  and will hit it far more often than the viewer did.
- **Autosave plus an open document is a data-loss surface.** The mitigations
  are that saves are atomic, that a rejected save never discards the draft, and
  that undo is local. There is no server-side history; `export` is the backup,
  and the editor should say so where the author can see it.
- **Retiring `?align=1` removes the only placement tool that currently exists**
  before the new one has been used by anyone. It is replaced in the same
  sub-project, not left as a gap.
