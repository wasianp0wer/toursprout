# 0001 — Overlays have three independent axes

Status: accepted, 2026-10-12.

## Problem

In schema v1 an overlay's rendering was dictated by its content type.
`kind: "rephoto"` forced a `geoQuad` anchor and rendered as a plane standing
in the world; every other kind forced a `geo` anchor and rendered as a
clickable marker, enforced by a validator that named both.

The editor has to let an author hang a photograph in the scene **or** pin it
to the street, as a per-item choice. While presentation was welded to content
type, that choice was inexpressible: it would have meant changing what the
item *was* in order to change how it *looked*.

## Considered

**Expand the `kind` list** — `rephoto`, `worldText`, `audioPin`, and so on.
No restructuring, and the validator stays simple. Rejected: the list
multiplies combinatorially, and multiplies again for every new presentation
target. AR alone would roughly double it.

**Carry both presentations at once**, with a viewer-level switch between
"ghosted into the scene" and "pins only". Rejected for now as more authoring
work per item than the author wants, though the split below does not prevent
it: a future `display` variant can carry both.

## Decision

Three independent fields. `kind` (text, image, audio) is what an overlay is,
`anchor` is where it is, `display` (marker, inWorld, ambient) is how it is
drawn. A rephotograph is `kind: "image"` with `display.mode: "inWorld"` —
which is what it always was.

Geometry moved with it. v1's `headingDeg`, `widthM` and `heightM` sat on the
anchor, but they describe how a plane is drawn, not where it is; a marker at
the same spot needs none of them. They now live on `InWorldDisplay`, which is
why switching an overlay between marker and inWorld no longer moves it.

Which combinations are legal lives in one table, `DISPLAY_MODES_BY_KIND`,
rather than a chain of conditionals. A rejection is a *renderer* limitation,
not a limit of the model, and the error message says so.

## Costs

A schema version and a migration, `app.migration.migrate_v1_to_v2`, which
stays in the tree indefinitely: exported bundles in the wild will be v1. Every
read path runs through it, so only v2 exists above the parsing boundary.

The migration is deliberately behaviour-preserving rather than merely valid.
Opacity is written as v1's hardcoded "first at 0.7, rest hidden" so a migrated
tour opens identically, and audio becomes `marker` rather than `ambient`
because nothing autoplayed in v1 — migrating to `ambient` would have started
six narrations playing by themselves.

Two on-screen changes at the courthouse stop were not behaviour-preserving,
and nobody has decided whether to fix them (frontend/src/app/stop/stop-panel.ts):

- The overlay list badges each row with `{{ ov.kind }}`. The two courthouse
  photographs read `REPHOTO` in v1 and now read `IMAGE`, so the list shows
  three identical `IMAGE` rows where it used to distinguish the draped
  photographs from the panel one.
- v1's `@switch` on `kind` had no case for `'rephoto'`, so selecting one
  rendered only a title and credit. The same overlay is `kind: 'image'` in
  v2 and hits the `'image'` case, so an `<img>` now also appears — a
  courthouse photograph is shown twice at once, ghosted into the panorama
  and as a thumbnail in the panel. Both are arguably improvements; both are
  pinned by tests in `stop-panel.spec.ts` rather than decided here.

## How the deferred features land on this

- **AR** is a fourth `display.mode` reading the same anchors, not a parallel
  content hierarchy. This is the decision's main payoff. It is also why
  `altitude` was renamed `altitudeM` and pinned to metres above local ground:
  a phone knows its height above the pavement, not above the ellipsoid, and
  the ambiguity had already put the Fairfax photographs 128 m underground once.
- **Themes** are a tour-level style block; `display` says what an overlay is,
  a theme says how that kind of thing looks across the tour.
- **Omeka** populates the `sourced` credit variant from Dublin Core
  (`dcterms:publisher`, `dcterms:rights`, `dcterms:creator`). The credit union
  was split in the same change because original work — the author's own
  recordings — has no URL, which made v1's single credit shape unsatisfiable
  and would have stopped the editor saving at all.
