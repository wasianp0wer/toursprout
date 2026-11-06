# 0005 — Schema v3 locks the document

Status: accepted, 2026-11-01.

Supersedes nothing. Extends [0001](0001-three-axes-for-overlays.md), whose
three axes are what made this a short list rather than a redesign.

## Problem

The models are being locked: from here on, a change to them has to migrate
cleanly. Three features are planned and none is being built yet — AR (a phone
camera with the tour laid out in the real view), UI customization, and
importing assets from an Omeka instance. The question asked of the schema was
whether anything in it stops those landing cleanly later.

Mostly it does not. ADR 0001's three axes hold up: AR is a fourth
`display.mode` over the same anchors, `altitudeM` is already metres above
local ground because a phone knows its height above the pavement, `Credit`
and `Display` are real discriminated unions so new variants are additive, and
`Anchor = GeoAnchor` is a deliberate one-line alias waiting for a second
member.

What the audit found instead was a small set of changes that **could not be
made later at all** — tightenings. Loosening a rule is free: every document
already written satisfies the looser one. Tightening rejects documents that
are already in the wild, in exported `.zip`s outside this repository and in
`content/work/` directories that persist between runs. A tightening deferred
past the lock is a tightening abandoned.

So v3 is not "the AR schema" or "the Omeka schema". It is the last chance to
tighten, taken before the lock, plus the machinery that makes v4 cheap.

## Decision

Four changes. The first three are the tightenings; the fourth is what the
rest of this is for.

### 1. Stop ids and overlay ids are one namespace, unique tour-wide

v2 validated stop ids and never looked at overlay ids. The editor was the
only thing keeping them apart — `allIds()` in `document-ops.ts` allocates
from the combined pool — and the invariant was load-bearing, because
`mapOverlay`, `findOverlay` and `deleteOverlay` each match an id across
*every* stop rather than within one. Two stops sharing an overlay id meant
editing or deleting one silently hit both. An imported bundle could carry
that, and nothing would say so.

The invariant was asserted only in `test_overlay_ids_are_globally_unique`,
which reads `content/source/stops.json` — the content pipeline's input, not
the schema. So it protected the seed tour and nothing else.

Enforced in the schema now because an importer is the likely source of a
collision: ids minted from someone else's identifiers (an Omeka item, an
archive accession) collide in ways hand-authoring does not.

### 2. A cached panorama is a media id, not a path

v2's `Panorama.cachedPath` held `media/pano/x.jpg` — a path with the
directory baked in. An overlay's `mediaId` is relative to `media/`. Two
spellings for the same kind of thing, and the consequence was not cosmetic:
`media_store.orphan_ids` and `bundle._media_sets` both collected overlay
`mediaId`s and neither read `cachedPath`, so

- the shipped Fairfax example reported **six permanent orphans** which were
  in fact its six cached panoramas, referenced by six stops. The number was
  recorded as correct in three documents and pinned by a test; and
- `missing_media` could not see a missing panorama, so a bundle with the
  document and the nine top-level media files but no `media/pano/` imported
  clean — `200`, `"mediaCount": 9`, no warnings — and 404ed in the viewer
  later. That landmine is written up in `UNVERIFIED.md` entry 17, verified
  live at the time. It is closed by this change: such an import is now
  refused by name.

v3 renames the field to `cachedMediaId` and holds a media id. The rename is
the point — silently redefining a field of the same name would leave every
document in the wild claiming a shape it does not have.

Both references now share one validated type, `MediaRef` (a relative POSIX
path inside `media/`: no absolute path, no `..`, no backslash, no repeated
`media/` prefix), and one collector, `models.referenced_media`, which is the
only place that knows what counts as a reference. The bug was two collectors
that each knew about one of the two fields; a third field added to either
without the other would have done it again.

Neither `mediaId` nor `cachedPath` was validated at all through v2, so
`../../etc/passwd` was a valid document. Nothing server-side joined them to a
path, so no live hole was open — `MediaRef` is here because an unconstrained
reference is exactly what an importer supplies, and because this is the last
chance to constrain it.

### 3. An `Attribution` may have no URL, but never a blank one

`Attribution.url` and `.license` were plain `str`, so `""` validated, while
every `Credit` field was `NonBlank`.

The fix is not simply to tighten both. Requiring a URL would repeat precisely
the v1 mistake ADR 0001 records: v1's single `Credit` shape demanded a URL,
the author's own recordings have none, and the editor could not save at all.
A line of credit with nothing to link to is ordinary. So `url` is
`NonBlank | None` — absent is `null`, and `""` is a field somebody failed to
fill in, which is refused. `license` stays required, because an unlicensed
line of credit is the thing the field exists to prevent.

The viewer's template emitted `<a href>` unconditionally, which for a null
URL is a link to the page itself, and tracked the loop by `url`, which two
unlinked credits would now share. Both fixed.

### 4. One entry point, one step per version

`migration.py` exposed exactly one function, `migrate_v1_to_v2`, named at
three call sites and about fifteen places in the tests. A v3 meant either
renaming it everywhere or having a function called `migrate_v1_to_v2`
secretly do two hops.

It is now `migrate(doc)` over a `_MIGRATIONS` registry: callers ask for
current and never for a hop, and v4 is a function plus one dictionary entry
with no call site touched. Each step stamps its own target version rather
than `SCHEMA_VERSION`, so adding a step cannot silently relabel an older one,
and the loop refuses a step that fails to advance the version rather than
spinning.

## Costs, and what was deliberately not done

**The v2→v3 step renames rather than refuses.** v2 never checked overlay
ids, so documents with duplicates exist and must still open; the step
suffixes them `-2`, `-3` with the same idiom as the editor's `uniqueId`, so
a migrated id and an authored one are indistinguishable. Nothing inside a
document references an overlay id — only the editor's selection state does,
and that is never saved (ADR 0003) — so the rename loses nothing. A blank
attribution licence and a `cachedPath` outside `media/` *are* refused, by
name, because neither has an honest value to invent.

**Two fixtures are frozen, not refreshed.**
`backend/tests/fixtures/fairfax-old-town-v1.json` stays v1 forever and
`fairfax-old-town-v2.json` stays v2, so the chain is exercised end to end
against real content — v1 now migrates through two steps — rather than
comparing an already-current document to itself.

**`extra="forbid"` stays, so there is no forward-compatibility lane.** Every
additive field is a hard rejection for an older reader, which means each of
the three planned features needs a version bump and a migration step even
when the change is purely additive. That is a decision to bump often, not a
free lunch; it is kept because a typo in hand-authored content vanishing
silently is the worse failure. The version check fires before field
validation, so an older build meeting a newer document says so about the
version rather than about an unknown key.

**The frontend still has no migration, and `schemaVersion` is a TypeScript
literal.** Deliberate, and documented in `tour.models.ts`: a file-backed
viewer with no Python in the path must fail rather than silently accept an
older document. The consequence to know is that a v2 bundle unzipped by hand
beside a v3 viewer build gets no migration and no clear error. Every
supported route in goes through the backend, where `migrate` runs.

## What was found and left alone

These are not v3's business, and each is a decision the author still has to
make rather than a defect:

- **`Stop.panorama` is required, and mapillary-shaped.** An AR visitor is
  standing in the street and has no panorama to show; `Session.skeleton`
  already fakes one (`imageId: "0"`). Loosening to `Panorama | None` migrates
  for free on the data side but flips the TypeScript type and forces null
  handling through both panorama panes, `camera-sync`, the
  `panoramaFixForStop` heading gate and arrival. Whether AR stops carry a
  panorama decides whether that is needed at all, so it waits for the
  decision rather than guessing now. `provider` is a literal, so a second
  provider is additive, but `Panorama` is not structured as a discriminated
  union the way `Credit` and `Display` are.
- **UI customization has nowhere to live, and the natural home is on the
  wrong side of the document/config line.** `TILE_URL` and `ATTRIBUTION` are
  module constants in `main.py` written into `config.json`, which is derived
  state rebuilt on every open and publish and deliberately excluded from
  exported bundles — so a per-tour basemap would not survive a round trip.
  `ARRIVAL_RADIUS_M` and `LATCH_RELEASE_M` are compile-time constants. And
  `Tour.attribution` is already unread: the viewer renders
  `ConfigStore.attribution()`, the committed example's array is identical to
  the `ATTRIBUTION` constant, and no editor op writes it. Which copy is
  authoritative has to be settled before theming lands on top of it.
  Separately, and this is a security point rather than a modelling one:
  anything free-form (a CSS blob, a font URL, an arbitrary tile URL) arriving
  in `tour.json` from an imported bundle is served from the author's own
  origin on a published site, which is the threat the import allowlist exists
  to close. Customization belongs in enumerated tokens and bounded scalars,
  not strings the viewer interpolates into style or `src`.
- **Omeka has nowhere to record item identity or date, and media carries no
  metadata of its own.** `SourcedCredit.url` is a citation for display, not a
  sync key, so a re-import cannot say "this is item 412, updated"; there is no
  date field, and the shipped content proves the gap by carrying dates inside
  the `creator` string (`"Unknown — Fairfax court-house — 1863-01-01"`) and
  the title. Credit lives on the overlay, not the media, so two overlays on
  one `mediaId` carry credits that can disagree and unplaced media carries no
  provenance at all. An Omeka item is item-metadata plus one-or-more files and
  can today only be flattened into one overlay. An `identifier` on
  `SourcedCredit` is additive and cheap; a media-level record is structural.
  Both are left for the Omeka work to decide, with the warning that an
  identifier added *after* the first import leaves that batch unreconcilable.
- **Synthetic content has no honest credit shape.** The narration overlays
  are `sourced` with a `url` pointing at an Apple support page, because
  `sourced` requires a URL and `original` means the author's own work. The
  union is discriminated, so a third variant stays additive.
