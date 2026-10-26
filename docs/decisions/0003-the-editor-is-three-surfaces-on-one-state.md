# 0003 — The editor is three surfaces on one state

Status: accepted, 2026-10-25.

## Problem

Sub-projects 1 and 2 made the tour a clean, versioned, portable document with
somewhere to be written. Nothing yet changed it except a hand-edited JSON file
and `?align=1`, a keyboard-only stopgap that nudged one photograph and printed
JSON to paste into `content/source/stops.json`. The editing core needed to
answer four things at once: where edits live while they are being made, how a
photograph is placed in the world, how mistakes are undone, and what must
never be allowed to go wrong in the document.

## Considered

**Make every property editable on every surface.** Rejected, and not for
economy: each surface can only *see* some of the truth. A 2D map cannot show
height, so altitude cannot honestly be set there. A panorama cannot show what
is behind the viewer, so it is a poor place to decide where a stop goes in
relation to the street. And dragging a photograph around inside a panorama
means inverse-projecting a screen position back to a world position, which
needs a depth, and the author cannot see the depth they would be assuming.
A drag there would silently invent a number and present it as a measurement.

**Fold the draft into `TourStore`.** Rejected: see below.

**Undo by recording inverse operations** (a command pattern). Rejected: see
below.

**Keep `?align=1` beside the new panes.** Rejected: see below.

## Decision

### Three surfaces, each owning the properties it can represent

`outline-pane` owns structure: which stops exist, in what order, which
overlays they hold. `inspector-pane` owns every property as a number or a
choice — it is the only place that can set all of them precisely, and the
only one that needs no pointing device. `edit-map-pane` owns ground position
and heading (a drag handle, and a footprint line from `footprint.ts` showing
the photograph's extent). `edit-panorama-pane` owns what only the panorama
shows: how big and how high the photograph looks standing in the real view,
with opacity and keyboard nudging. Nothing is edited in two places by
different logic; the reducer that nudges a placement (`nudge.ts`) is shared,
and every pane edits by calling a function from `document-ops.ts`.

### One state, and the document changes only through pure functions

`document-ops.ts` is the only code that produces a changed document. Each
operation takes a tour and returns a new one, never mutating its input. A
refused operation returns the **same tour reference**, which is how callers
tell "nothing happened" from "something changed" without a second channel.
Values are clamped or checked where they enter the document, not later:
opacity into [0, 1], width and height above zero, latitude and longitude
range-checked, heading normalised to [0, 360). The backend validates too, but
the editor does not rely on a 422 to find out it wrote nonsense.

### `EditorStore` is separate from `TourStore`

`TourStore` is the viewer's: which stop the visitor is at, where the
panorama is, which opacities are showing. It has to work in a published site
with no editor at all. `EditorStore` holds the draft, the selection, the saved document (from which
`dirty` is derived), `lastError`, the undo stack, `panoramaPosition` and `manualHeadings`. Their
lifetimes are unrelated: navigation state resets when the visitor moves on;
draft state must survive any number of navigations and is thrown away only
by `load`. Merging them would make every viewer carry editor state it can
never use, and would make "current stop" mean two different things —
`TourStore` has a walking order; `EditorStore.currentStop` is simply whatever
is selected, or owns the selected overlay. Two stores keeps those honest.
Retiring align mode also removed the one place `TourStore` knew about
editing (`_alignmentOverride`).

`EditorStore.apply(fn)` runs a transform against the draft. A transform that
*throws* (for example refusing to delete the last stop) is caught into
`lastError` and leaves the draft and the undo stack untouched; a failed edit
is not an edit. So is a transform that returns the **same reference**, which is
the pure layer's signal for "refused": `apply` ignores it entirely, pushing no
undo entry, dirtying nothing and triggering no save. A selection that no longer names anything in the draft is
cleared automatically, so undo and delete cannot leave the panes pointing at
nothing.

### Undo is whole-document snapshots

`apply` pushes the previous tour onto a stack capped at `UNDO_DEPTH` (50);
`undo` pops it. Because every operation is non-mutating and returns a fresh
document, a snapshot is just a reference to the old one — nearly free, since
unchanged stops and overlays are shared between versions rather than copied.
An inverse-operation scheme would need a correct inverse for every operation
and would have to stay correct as operations are added; a snapshot cannot
drift out of agreement with the operation that made it. The price is that
undo is coarse: it restores a whole document, and has no notion of undoing
one overlay's change while keeping a later change elsewhere. The cap bounds
memory in a long session, at the price of forgetting the oldest edits.

### Autosave writes the whole document, once at a time

`autosave.ts` debounces the draft and `PUT`s the whole document. At most one
save is in flight; edits that arrive meanwhile are folded into a single
queued follow-up that re-reads the draft when it starts, so it saves what the
draft has become, not what it was. A rejected save (the backend returns 422)
keeps the draft and retries on the next change, so a bad value never costs
the author their work.

`dirty` is **derived, not stored**: it is `draft !== savedDoc`, where
`savedDoc` is set by `load` and by `markSaved(doc)`. It was first a stored
flag set by hand at four sites, and was wrong three times at the same spot —
undo forgot to set it, so an undo made after a save was never persisted. A
derived value cannot be forgotten, and undoing back to exactly the saved
document correctly reports clean. `markSaved(doc)` takes effect only if `doc`
is still the draft; otherwise a slow save would mark newer, unsaved edits as
clean. A `putTour` that throws synchronously is turned into a rejection, so a
failed call can never leave a save marked in flight. Whole-document writes match the session API's contract
(`PUT /api/session/tour`, decision 0002) and avoid inventing a patch format
that would have to be kept in step with `document-ops`.

### The manual-heading flag is editor state and never reaches the document

`manualHeadings` is a set of overlay ids whose heading the author typed or
dragged, so the inspector and the map can show "this is not derived" and
offer a way back. It is deliberately not a field on the overlay. The
document describes what a visitor sees; whether a number was derived or
chosen is a fact about the editing session. Putting it in the schema would
add a field the viewer ignores, would have to be migrated, validated and
bundled, and would claim a permanence it does not have: once the author
re-derives, the flag is meaningless. It is cleared by `load`. The cost: close
the editor and reopen the tour, and nothing remembers which headings were
set by hand.

### `?align=1` was retired, not kept

Align mode existed because nothing else could place a photograph. The
editable panes do the same job properly, and its nudge arithmetic was correct
and tested, so that reducer moved to `editor/nudge.ts` with its tests and the
rest — `frontend/src/app/align/`, the URL flag, and the preview-override
state in `TourStore` — was deleted. Keeping it would have meant two ways of
placing a photograph, with two outputs (an edit in the draft; JSON pasted into
`stops.json`) that can disagree about where the photograph is. Alignment
work done in the editor lands in the document the viewer reads, not in a
source file the next `make content` could overwrite.

## Costs, and a caution that must not be removed

**Heading derivation, and the gate that exists because it went wrong.**

`headingDeg` must be derived from where the panorama actually stands, never
guessed. Every hand-authored bearing in this project's history was wrong, one
by 138 degrees, putting the subject behind the viewer. That is why
`build_tour.py` derives headings, and the editor must do the same.

During this sub-project the editor got it wrong the same way. The first
"derive heading" action derived from `stop.location`; there was no fallback
involved, it simply never used the panorama's position at all. On the real tour that is a **178-degree error** for the 1863
courthouse photograph: it would have faced exactly backwards. `stop.location`
is the building; the panorama is where the camera car stood, **38.7 m
away**, and a bearing from the wrong end of that gap points the wrong way.
It was caught by arithmetic, not by eye, because no browser can run in this
environment — which means nobody has ever looked at it, and a plausible-looking
wrong angle would have been committed without anyone noticing.

The first fix was **UI-only and insufficient**: the Derive button was
disabled until a panorama position was known, but the pure functions were not
yet gated, so everything that did not go through that button (switching an
overlay to `inWorld`, a typed heading, the map's rotation handle) could still
write a heading from the wrong place. That is the strongest argument for where
the gate lives. A disabled control protects one caller; the review that found
the gap was reading the functions, not the screen.

The fix that held is structural, not a fallback with a better default.
`EditorStore.panoramaPosition` holds a `PanoramaFix` — `{imageId, lng, lat}`,
keyed to *which* panorama it describes. `panoramaFixForStop(stop, fix)` is the
single gate: it returns null unless the fix's `imageId` matches the stop's
panorama. Deriving a heading, setting one by hand (the inspector's field and the
map's handle both go through `setOverlayHeadingManual`), and switching an
overlay to `inWorld` (which needs a heading, and has no honest "unset" value)
are all **refused inside the pure functions** — they hand back the same tour — not
merely disabled in the UI. A disabled button protects one caller; the
function protects all of them, including ones not yet written. The panorama
pane fills the seam from mapillary-js's `image` event and uses the id of the
image **actually loaded**, not the one it asked for, because a load that lags
the selection would otherwise publish the previous panorama's position under
the new panorama's name.

A derived heading is also kept an **invariant** rather than a one-time stamp:
it is a function of the anchor, so moving the anchor (map drag, panorama
nudge, inspector field) re-derives it, via `setOverlayAnchorKeepingHeading`,
for every `inWorld` overlay not in `manualHeadings` while a fix is available.
At the courthouse a 5 m sideways move swings the correct bearing by about 7
degrees, and nothing would otherwise have told the author. `nudge.ts` has no
heading keys for the same reason: it has no fix to offer.

The cost: until the panorama has loaded, a stop's overlays cannot be switched
to `inWorld` or have a heading derived, and a hand-set heading is only
possible while the author can see where the camera really stands. That is
intentional friction. **Do not remove or loosen the gate to make that
friction go away**; the failure it prevents is silent, looks correct, and
points a photograph backwards.

Other costs:

- **Nothing here has been seen in a browser.** The panes are covered by jsdom
  and by arithmetic in pure modules (`footprint.ts`, `nudge.ts`,
  `document-ops.ts`), not by anyone looking at them. The author still has to
  open `/edit`, align the courthouse photographs against the panorama, and
  judge them.
- **`footprint.ts` has stated limits.** A local equirectangular offset is
  accurate over the tens of metres a footprint spans at this tour's latitude;
  it is not meaningful near the poles, and a footprint straddling the
  antimeridian comes back as two coordinates on opposite sides of it, which a
  renderer would draw as a line across the whole map. The limits are in the
  file header. A walking tour of streets does not reach either.
- **The panorama pane cannot set position.** It nudges by keyboard, and the
  map is where position is set by pointing. That is the first decision above,
  paying its price.
- **Image and audio kinds cannot yet be chosen freely.** `legalKindsFor`
  offers them only when the overlay already has media, because media upload
  is not built.

## How the deferred features land on this

- **Media upload** is the next thing that changes what the inspector may
  offer; `legalKindsFor` is where that constraint is encoded, and should be
  relaxed there, not worked around in the panes.
- **New operations** go in `document-ops.ts` as pure functions that return
  the same reference when refused, and are applied through
  `EditorStore.apply`. Because `dirty` is derived and `apply` ignores a same-reference result,
  undo, dirty tracking and autosave then work without further change. One cost of deriving `dirty`:
  it is false whenever the draft is the last-saved document, even while a PUT of a different document
  is in flight (undo back to it mid-save). `Autosave` covers that in its save-completion path rather
  than with a stored flag: when a save lands and the draft is no longer what was written, it queues a
  follow-up, and the status stays off "saved" until that lands. In that window `dirty` alone is not
  the truth about disk. Any operation that needs a heading must pass through
  `panoramaFixForStop`.
- **Retiring `content/source/stops.json`** (HANDOFF, outstanding item 2)
  becomes possible now that the document can be edited in place; this record
  does not decide it.
