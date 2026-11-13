# Author-uploaded base imagery — design

**Date:** 2026-11-11
**Status:** awaiting implementation
**Base:** `main` at `e24845a`.
**Evidence:** `2026-11-11-uploaded-base-imagery-findings.md`, in this
directory. Every premise here was verified there, against the libraries
actually installed; this document decides, it does not re-derive. Section
references of the form *(findings §4)* point at it.
**Sibling:** `2026-11-11-flat-mapillary-imagery-design.md` makes Mapillary's
*own* flat imagery usable. That is a different feature with a different
answer, and §4 says how the two relate.

A stop's base imagery must today be a Mapillary image: `Panorama.provider` is
`Literal["mapillary"]` (`backend/app/models.py:228`). Where Mapillary has no
coverage, there is no stop. The sibling design helps where Mapillary has *flat*
coverage; this one helps where it has **none**, by letting an author upload
their own 360 photograph and build a stop on it.

## 1. Intent

An author standing in a place Mapillary has never driven should be able to
photograph it and make a stop there. The tour document stays portable, the
provenance stays honest, and nothing about an existing Mapillary stop changes.

## 2. Goals

- A stop can be built on a 360 photograph the author uploaded.
- Such a stop carries everything a Mapillary stop carries: text markers,
  audio, and archival photographs draped in the world.
- The uploaded image is part of the portable document, so a bundle still
  round-trips and a published site still works.
- Who took the photograph is recorded in the document, not assumed.
- The view direction is derived from what the author can see, never guessed.
- mapillary-js is contained no less than it is today. This work should leave
  the project *more* able to replace it, not less.

## 3. Non-goals

- **Replacing mapillary-js for Mapillary stops.** Those keep rendering exactly
  as they do now. See §9, decision 7.
- **Offline-capable published tours.** The prize is real and `cachedMediaId`
  is sitting there unread, but it is a separate decision with a licensing
  dimension (§9).
- **Flat uploaded photographs as base imagery.** §4.
- **Tiled or multi-resolution imagery.** One texture per stop.
- **An AR or phone-pose mode.** `GeoAnchor`'s datum already anticipates it
  (`models.py:28-37`); nothing here advances or blocks it.

## 4. Anti-goals

A failure even if it ships and works:

- **A guessed geometry number anywhere in the pipeline.** This project has
  twice placed things wrong by trusting a number nobody had checked — the
  photographs 128 m underground, and the bearing wrong by 138°. An uploaded
  photograph has no SfM reconstruction behind it, so every number comes from
  EXIF or from the author. EXIF is a hint; the author is the authority.
- **A second rendering path that silently diverges.** Two viewers that drift
  apart in how they place a draped photograph would be worse than one viewer
  that cannot do uploads.
- **Imagery in the document that nobody is credited for.**

**Why flat uploads are out of scope, stated as an anti-goal rather than a
shrug.** Mapillary's flat imagery has a real camera pose from SfM, so a marker
anchored outside the frame exists in the world and merely is not visible —
the limit the author accepted in the sibling design. An uploaded flat
photograph has no pose at all. Placing anything in it would mean synthesising a
camera from an assumed field of view, which is precisely the guessed geometry
number above. A flat photograph can already be an `inWorld` overlay; what it
cannot be, for now, is the base view. The honest route for it later is the 2D
`ImageAnchor` variant ADR 0005 already anticipates (`models.py:44-52`), and
that is a larger feature than this one.

## 5. Constraints

| Constraint | Consequence |
| --- | --- |
| mapillary-js 4 was last published in 2023 | the `PanoramaViewer` interface exists to contain it; a second implementation belongs behind the same seam |
| Frontend tests run under vitest + jsdom with **no WebGL** (findings §7) | the scene geometry must be pure functions with their own specs; only the thin GL wrapper goes untested |
| **No browser can launch in the development sandbox** | nothing here will be *seen* working until someone sits at a browser; `docs/UNVERIFIED.md` is where that is recorded, honestly |
| three.js 0.134.0 resolves transitively, and mapillary-js **inlines its own copy** (findings §3) | the real rule is version identity, not instance identity; `docs/ENVIRONMENT.md:129-146` says otherwise and is wrong |
| three 0.134 already clamps an over-cap texture itself (findings §3) | downscaling is a performance and size measure, not a correctness one |
| The host is CGI and deliberately dependency-minimal (ADR 0007) | no Pillow; image inspection and resizing happen in the browser |
| `entry-page.spec.ts:240-250` asserts **no** `ResizeObserver` or `invalidateSize` appears in any non-spec file | a self-hosted viewer that sizes its own canvas trips a guard test by design; see §8, T7 |
| Every additive schema field costs a version bump (ADR 0005) | this feature bumps once, to v4, and carries all of its fields in that one bump |

## 6. Decisions

All seven open questions from findings §9 are settled. **These are the
author's decisions**, made 2026-11-11; the reasoning recorded against each is
the reason given at the time.

### 6.1 An uploaded base image carries its own credit

A required `credit: Credit` on the uploaded variant, the same discriminated
union an `Overlay` uses (`models.py:160`). `TourDefaults` (`:211-215`)
pre-fills an `OriginalCredit` so the author does not retype their own name.

The viewer must therefore render a credit it renders nowhere today —
`stop-panel.ts:53-58` shows only the *selected overlay's* credit — so a
per-stop credit line is new UI. Accepted: the alternative was an asymmetry
where a photograph draped **in** the world must be credited and the
photograph it is draped **onto** need not be, which this project cannot
defend (`README.md:147-158`).

A `Tour.attribution` entry was rejected because that array is currently unread
— the viewer renders the *config's* copy — and using it would mean first
settling which copy is authoritative, a question ADR 0005 deliberately left
open and which this feature should not be made to answer.

### 6.2 Every panorama variant keeps an `imageId`-shaped identity

The uploaded variant carries both an `imageId` and a `MediaRef` naming the
file, following the `Anchor` precedent (`models.py:44-52`).

This is the conservative choice and was made for one reason: it leaves
`panoramaFixForStop` (`document-ops.ts:252-255`), `detectArrival`'s exact-id
match (`arrival.ts:37-44`), `PanoramaViewer.load(imageId, bearing)` and every
pane spec untouched. Those first two are the functions this project is most
careful about.

The cost is a reader asking why there are two fields, and a **resolver** so the
self-hosted viewer can turn an id into a file. The resolver is the dispatcher's
job (§7.2), not the viewer's: a viewer that reaches into the tour document to
find its own bytes would be a worse seam than the one being replaced.

The id for an uploaded panorama is minted by the editor, is unique in the
tour, and is **not** the media id — two stops may legitimately share one
uploaded photograph, and an id that is really a filename would make that
inexpressible.

### 6.3 North is set by the author, against the map

The author aligns the uploaded panorama by dragging it while watching the map,
exactly as the overlay heading gate already works, and the stored value is
derived from that. EXIF `GPSImgDirection` **pre-fills** the starting point and
is never trusted: a `'M'` reference is magnetic, and a declination error is the
138° class of mistake arriving by post.

So `bearing` keeps one meaning across every variant — a compass direction — and
`bearingToNextStop`, the destination marker and the arrival logic all keep
their referent. The cost is new UI and one more step per stop, which §4's
first anti-goal makes worth paying.

Until the author has set it, the stop has no north. The editor must say so
rather than default to zero, and must not let the stop be published in that
state. This mirrors the existing refusal to derive an overlay heading before
the panorama has loaded.

### 6.4 `three` becomes a direct, exactly pinned dependency

`"three": "0.134.0"` in `frontend/package.json`, no caret, because the version
must match the copy mapillary-js inlines. Our own code imports three, so
`package.json` should say so; left transitive, removing mapillary-js later
would remove three silently and the self-hosted viewer would stop resolving
with no warning.

`docs/ENVIRONMENT.md:129-146` is corrected in the same change. It currently
reads as a prohibition on two three.js *instances*; findings §3 established
that mapillary-js already inlines its own (`REVISION = '134'` and a
`WebGLRenderer` class inside `mapillary.module.js`), so the project has been
running two instances all along and the constraint it is really protecting is
version identity. Its `npm ls three` check is updated to accept one entry with
two parents.

### 6.5 Both resolutions are stored; only the small one is published

Two `MediaRef` fields on the uploaded variant — the display-sized derivative
and the author's original — both counted by `referenced_media`
(`models.py:315-333`, the one place such a field belongs). A **bundle** carries
both, so ADR 0002's portable document can be re-derived at full quality. A
**published static site** carries only the derivative, so a visitor never
downloads an 11000×5500 original.

Bundle and publish are already separate code paths over the same media set, so
this is one filter rather than a second accounting of media. The builder should
expect `referenced_media` to stay the single collector and the publish path to
subtract, not to maintain a parallel list — the bug ADR 0005 records is
exactly two collectors disagreeing.

### 6.6 `cachedMediaId` stays dormant

The self-hosted viewer is **not** wired to Mapillary stops' cached panoramas,
although it could be and although that would make published tours work with no
token and no network.

Two reasons, in order. It would make `provider` and *renderer* come apart, so
the dispatcher would key on something other than the provider, which reopens
§6.2 while this feature is still being built. And serving cached Mapillary
pixels from the author's own origin is redistribution of CC-BY-SA 4.0 imagery
rather than embedding a viewer; whether the attribution already in the
interface (`main.py:90-91`) satisfies the share-alike terms in that posture is
a question for the author and their institution, and was explicitly not
answered here.

**Build so this stays cheap to add.** The dispatcher chooses a renderer from
the panorama variant; nothing should assume that *uploaded variant* and
*self-hosted renderer* are the same predicate. A later decision to render
cached Mapillary imagery locally should be a change to the choice function and
nothing else.

## 7. Architecture

### 7.1 Schema v4

`Panorama` becomes a discriminated union on `provider`, the shape `Credit` and
`Display` already use, which ADR 0005 named as the change this would need:

- `MapillaryPanorama` — today's fields, unchanged.
- `UploadedPanorama` — `imageId` (§6.2), `mediaId` and `originalMediaId`
  (§6.5), `bearing` nullable-until-set (§6.3), `credit` (§6.1), and the
  projection, which is `"equirectangular"` and nothing else for now (§4).

`referenced_media` gains the two new refs. `_v3_to_v4` is one function plus
one entry in `_MIGRATIONS`; v3 documents migrate by tagging the existing
variant, which loses nothing.

Follow `docs/CHANGING-THINGS.md:103-166` literally. Two traps it records:
`SCHEMA_VERSION` and `Tour.schema_version`'s literal are separate places, and
`tour.models.ts` has **no drift test**, so a stale TypeScript mirror fails
nothing. Freeze a v3 fixture before the bump; that step is not optional.

### 7.2 The dispatcher is a forwarding host, not a factory

One `PanoramaViewer` implementation that owns both real ones and forwards to
whichever the current stop needs. It is what `PANORAMA_VIEWER` provides.

This shape was chosen on the evidence in findings §4: five spec files inject a
single `FakeViewer` with `{ provide: PANORAMA_VIEWER, useValue: ... }`
(`app.spec.ts:23`, `entry-page.spec.ts:38`, `viewer-page.spec.ts:25`,
`panorama-pane.spec.ts:72`, `edit-panorama-pane.spec.ts:47`), and a forwarding
host leaves all twenty pane tests working unchanged. A factory registry would
rewrite every one of them.

Two requirements the builder must not discover the hard way:

1. **The host caches every setter and replays it on a switch.** Scene state
   arrives from four independent effects in `panorama-pane.ts` — markers,
   placements, opacities, destination bearing — and a provider swapped in
   mid-tour would otherwise come up blank until something happened to change.
2. **The host resolves ids to media URLs** before calling the self-hosted
   viewer (§6.2), so neither viewer knows about the tour document.

`panorama-pane.ts` attaches its viewer once, behind an `attached` flag. That
flag and `destroy()`'s meaning both change; `panorama-pane.spec.ts` is the
test to read first.

### 7.3 The self-hosted viewer

An inside-out sphere textured with the equirectangular image, in three.js,
behind the existing `PanoramaViewer` interface. Draped photographs reuse
`in-world-placement.ts` verbatim — it is already pure and already takes ENU in,
which is ADR 0001 paying out. Markers become sprites with a `Raycaster`
hit-test. Owning the WebGL context removes the shared-context hazard that
`in-world-renderer.ts` documents, because there is no borrowed context.

`geodeticToEnu` currently comes from mapillary-js. Whether the self-hosted
viewer keeps importing it or gets its own is left to the builder (§10), with
one constraint: **one implementation, used by both viewers.** Two ENU
conversions that disagree is §4's second anti-goal exactly.

### 7.4 Getting the image in

Uploads already work end to end: `media_store.py` sniffs and stores JPEG, PNG
and WebP under content-derived ids, the bundle import allowlist already admits
those extensions, and publish copies `media/`. An uploaded base image adds **no
new untrusted-input surface** — it rides the path every overlay image rides.

What is new happens in the browser, for the reason ADR 0007 gives:

- **Reading the JPEG's metadata** — XMP `GPano:ProjectionType` to confirm it
  really is equirectangular, EXIF GPS to pre-fill the position and
  `GPSImgDirection` to pre-fill north (§6.3). No new dependency.
- **Downscaling** before upload, by canvas. Performance, export size and upload
  time — *not* correctness: findings §3 established that three 0.134 already
  clamps an over-cap texture itself and that NPOT is fine on WebGL2.
- **Refusing a flat upload** with a message that says why and points at
  `inWorld` overlays as the thing it can be instead (§4).

`selectPanorama` returns `null` for a candidate with no usable position
(`document-ops.ts:553-554`), but "uploaded, EXIF has no GPS yet" is a
legitimate state rather than a refusal. The upload needs a document-change op
that can carry a null fix, which the existing one cannot express.

## 8. Tasks

Sizes from findings §8 — **S** hours, **M** about a day, **L** more than a day
— and they are estimates. "Parallel-safe" means no overlapping file list *and*
no dependency; a shared registry file counts as a conflict.

| # | Task | Size | Depends on |
| --- | --- | --- | --- |
| T1 | Schema v4 union, migration, frozen v3 fixture | M | — |
| T2 | Pure self-hosted scene geometry | S | — |
| T3 | Browser XMP/EXIF reader | M | — |
| T4 | Browser downscale | S–M | — |
| T5 | Split `InWorldRenderer` into pure placement and GL wrapper | M | — |
| T6 | The self-hosted `PanoramaViewer` | L | T1, T2, T5 |
| T7 | The forwarding host | M–L | T6 |
| T8 | Upload a base image in the editor | M | T1, T3, T4, T7 |
| T9 | North alignment UI (§6.3) | M | T7, T8 |
| T10 | Credit for an uploaded base image, viewer and editor (§6.1) | S–M | T1, T8 |
| T11 | `three` direct, `ENVIRONMENT.md` corrected (§6.4) | S | — |
| T12 | Publish filter for the original (§6.5) | S | T1 |
| T13 | Documents: ADR, `UNVERIFIED.md`, `FOR-HISTORIANS.md`, `HANDOFF.md` | M | all |

**Parallel-safe set: {T2, T3, T4, T5, T11}.** Everything else is sequential.
T1 is parallel-safe with nothing: it touches `models.py` and `tour.models.ts`,
which nearly everything reads.

The irreducible work is T6 and T7. T1 and T5 look large and are not — the
migration registry, the frozen fixtures, the `ICustomRenderer` seam and the
already-pure ENU split are each exactly where they need to be.

**T7 trips a guard test on purpose.** `entry-page.spec.ts:240-250` greps every
non-spec `.ts` for `ResizeObserver` and `invalidateSize` and asserts none
appears. A viewer that sizes its own canvas with a ResizeObserver fails it by
design, and that test's own docstring says retiring it means updating
`ARCHITECTURE.md`, `CHANGING-THINGS.md`, `UNVERIFIED.md` entry 20 and
`entry-page.css`. Either budget for that or size the canvas without an
observer; do not discover it when the suite goes red.

## 9. Testing, and what stays unverified

Unit-testable, and where the value is: the pure scene geometry (T2), the
metadata reader against real byte fixtures (T3), the downscale's arithmetic
(T4), the split placement math (T5), the host's cache-and-replay and its
renderer choice (T7), the migration both ways (T1), and the publish filter
(T12). Findings §7 has the two patterns this repo already uses for testing
WebGL-adjacent code without WebGL; follow them rather than inventing a third.

What no unit test can reach: whether the sphere is oriented correctly, whether
a draped photograph lands where the author put it, and whether north means
what §6.3 says it means. Those are Playwright cases that **cannot run in the
development sandbox**, and until someone runs them this feature is unverified
in the way `docs/UNVERIFIED.md` means.

A new entry there, written as a runnable procedure, covering at least: an
uploaded 360 renders and can be looked around; north set by dragging agrees
with the map; a draped archival photograph appears where the editor shows it;
the credit line appears; a bundle round-trips with both resolutions and a
published site carries only one; and a Mapillary stop in the same tour still
behaves exactly as before — that last one is the regression that matters most,
because the forwarding host is new code in every stop's path.

## 10. Left to the builder

- Whether the self-hosted viewer imports `geodeticToEnu` from mapillary-js or
  gets its own, subject to §7.3's one-implementation constraint.
- Camera controls: `OrbitControls` from `three/examples/jsm` is confirmed
  consumable under this project's tsconfig (findings §3), but a hand-written
  drag-to-look may be smaller than configuring it. Either is fine.
- The minimum display size the downscale targets, and whether it is a constant
  or derived from the device.
- How the editor presents "north is not set yet" — a disabled publish, a
  warning in the inspector, or both.
- The id-minting scheme for an uploaded panorama (§6.2), subject to uniqueness
  within the tour.
- Whether T13's ADR is one record or two. The schema union and the second
  renderer are arguably separate decisions with separate half-lives.
