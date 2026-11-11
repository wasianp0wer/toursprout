# Flat (non-360) Mapillary imagery — design

**Date:** 2026-11-11
**Status:** awaiting implementation
**Base:** `main` at `e24845a`.
**Scope:** the editor's panorama search and the viewer's initial view
direction. No schema change, no migration, no new dependency.

Mapillary's coverage of Old Town Fairfax is dense 360 imagery from a single
2026-08 campaign, and every decision in the prototype was taken against it:
all six stops were chosen by probing for true panoramas before any content was
written. **The author's testers are authoring stops in European towns where
the available imagery is phone and dashcam capture, not 360.** Today the
editor discards all of it, so "Find panoramas near here" returns nothing and
the stop cannot be made at all. This design lets those images be used.

## 1. What is true today

Verified by reading the code at `e24845a`; nothing here was measured in a
browser, which §9 is honest about.

| Fact | Where |
| --- | --- |
| The pano-only filter is already a parameter, defaulting to on | `frontend/src/app/core/mapillary-search.ts:97` |
| Flat images are dropped during ranking | `mapillary-search.ts:72` |
| The only caller takes the default | `frontend/src/app/editor/inspector-pane.ts:289` |
| Ranking already sorts panoramas first, then by distance | `mapillary-search.ts:81` |
| `is_pano` is already requested from the Graph API | `mapillary-search.ts:9` |
| mapillary-js 4 renders `"spherical" \| "fisheye" \| "perspective"` | `frontend/node_modules/mapillary-js/dist/mapillary.d.ts:1249` |
| `moveTo` resolves to the `Image`, which exposes `cameraType` | `mapillary.d.ts:4993`, `:1956` |
| The coverage probe already computes a `flat only` verdict | `content/scripts/probe_coverage.py:209` |
| The editor's map draws a hardcoded 90° view wedge | `frontend/src/app/editor/edit-map-pane.ts:117` |
| A null compass angle is stored as bearing `0` | `frontend/src/app/editor/document-ops.ts:556` |

**Measured against the live Graph API on 2026-11-11**, from this workstation
with the token in `backend/.env`, because neither CI nor the host can reach
`graph.mapillary.com` and an invalid entry in `FIELDS` fails the whole request:

| Question | Answer |
| --- | --- |
| Is `camera_type` a valid field? | **yes** — returns `"perspective"` |
| Is `sequence` a valid field? | **yes** — returns e.g. `Q9GMfRjnXOskmoyDrIFabv` |
| Is `sequence_id` a valid field? | accepted, but **returns nothing**; do not use it |
| What does Mapillary give for an unknown compass angle? | **`-1`**, not `null` |

Three consequences carry the whole design. First, **the viewer needs almost
nothing**: mapillary-js draws all three camera types itself, and
`camera-sync.ts` hands the three.js camera mapillary's own view and projection
matrices, so the in-world renderer that drapes archival photographs is
projection-agnostic by construction. Second, **the filter is a parameter
nobody passes**. Third, and found only by probing, **flat imagery arrives with
two properties 360 imagery does not have**: it comes in dense sequences, and
its compass angle is frequently the sentinel `-1`. Each of those breaks
something, and §5.3 and §5.7 are the consequences.

### 1.1 Coverage actually measured, 50 m radius

| Site | images | pano | flat | sequences | verdict |
| --- | --- | --- | --- | --- | --- |
| Rye, England | 28 | 0 | 28 | **1** | flat only |
| Český Krumlov, Czechia | 46 | 0 | 46 | **17** | flat only |
| Visby, Sweden | 288 | 8 | 280 | 13 | mixed |
| Monsaraz, Portugal | 18 | 0 | 18 | 3 | flat only |
| Dinan, France | 0 | 0 | 0 | 0 | none |
| Alberobello, Italy | 0 | 0 | 0 | 0 | none |

These are not the testers' own sites — the author has not named them — but
they are the same kind of imagery, and they are what §9's checks run against.
Three of six candidate European sites have flat-only coverage and would today
return an empty search; two have none at all, which this design cannot help.

## 2. The one real defect this exposes

`MapillaryViewer.faceBearing` (`frontend/src/app/panorama/mapillary-viewer.ts:105`)
turns the view to a compass bearing by reading the current bearing and shifting
the basic-image x coordinate by `delta / 360`. That arithmetic is correct only
for a spherical image, where x spans the full circle. On a perspective image x
spans the camera's field of view — roughly 70–90° — so the same shift
over-rotates by a factor of four or five, and most bearings are not reachable
at all.

This is the same class of error as the hand-guessed bearings in this project's
history, one of which was wrong by 138°, and it is the reason the editor
refuses to derive a heading until the panorama has loaded. It must be fixed as
part of this work rather than discovered later.

## 3. Goals

- A flat or fisheye Mapillary image can be chosen as a stop's base imagery
  from the editor, and the stop then behaves like any other stop.
- An author with dense 360 coverage sees no change in what the search offers
  them first.
- The candidate list offers distinct vantage points, not a sequence of
  near-identical frames. A list that is technically populated and practically
  unusable is a failure of this design, not a limitation of the imagery.
- No stop ever stores or displays a view direction that Mapillary did not
  actually report.
- The initial view direction is either correct or deliberately not set. It is
  never wrong by a factor.
- A tester handed `docs/FOR-HISTORIANS.md` can tell what a flat stop can and
  cannot do before they build one.

## 4. Non-goals

- **Uploading the author's own imagery.** That is a separate, much larger
  piece of work, researched in
  `2026-11-11-uploaded-base-imagery-findings.md`. Nothing here should
  pre-empt its decisions.
- **Recording the camera type in the document.** See §5.6.
- **Any change to how archival photographs are placed, drawn or faded.**
- **Re-probing Fairfax.** The committed tour keeps its 360 panoramas.

## 5. Design

### 5.1 The search stops filtering

`MapillarySearch.panoramas` keeps its `panoOnly` parameter — it is a pure
function's argument and the specs exercise it — but the **default flips to
`false`**, so `inspector-pane.ts:289` admits every image Mapillary can render
without passing an argument. The existing sort at `mapillary-search.ts:81`
already places panoramas above flat images, so an author with 360 coverage
sees the same first results they see today, with flat candidates below them
rather than absent.

`FIELDS` gains `camera_type` and `sequence`; `PanoramaCandidate` gains
`cameraType: string | null` and `sequenceId: string | null`. Both field names
were confirmed against the live API (§1) rather than assumed, which matters
because one bad name fails the entire request and nothing in CI or on the host
can make that call. `is_pano` and the `isPano` field stay: the sort reads
`isPano`, and it is the one signal present on every image whether or not SfM
has run.

**Fisheye is included.** `is_pano` is false for fisheye as well as perspective,
and mapillary-js draws all three. The rule is "whatever the viewer can draw",
not an enumeration of two cases.

### 5.2 Candidates are badged, not gated

No checkbox, no second search button. Each row in the candidate list
(`frontend/src/app/editor/inspector-pane.html:82-90`) carries a badge reading
`360°` or `flat`, derived from `isPano`. The author chooses from one list.

An opt-in control was considered and rejected: the testers this is for have no
360 imagery to prefer, the sort already protects the Fairfax-style author, and
a filter the author has to find and tick is one more way for the search to come
back empty for no visible reason — which is the failure this design exists to
remove.

### 5.3 The view stops turning on imagery it cannot turn

`MapillaryViewer.load` already awaits `moveTo`; it starts using the `Image`
that call resolves to, and turns the view only when the image is not
positively known to be non-spherical:

- `cameraType === 'spherical'` → turn to the stored bearing, as today.
- `cameraType` is `'perspective'` or `'fisheye'` → do not turn. Leave the view
  where mapillary-js opened it.
- `cameraType` is `undefined` → turn, as today.

The last rule is deliberate and is the safe direction. `Image.cameraType` is
documented as "undefined if SfM has not been run" (`mapillary.d.ts:1956`), and
treating unknown as spherical preserves exactly today's behaviour for every
image that works today; only a positive statement from Mapillary changes
anything. The cost is that a flat image whose SfM has not run would still
over-rotate. Whether `cameraType` is in fact always populated for an image the
viewer can render is the one thing in this design that needs a browser (§9).

The stop's stored `bearing` is unchanged and still meaningful: `selectPanorama`
(`frontend/src/app/editor/document-ops.ts:556`) already writes the candidate's
`compass_angle`, which for a flat image is the direction the camera itself
faced. Nothing needs to be nulled or special-cased in the document.

**The decision must be extracted into a pure function.** The frontend tests run
under vitest with jsdom and no WebGL, and `fake-viewer.ts` records
`{imageId, bearing}` without modelling camera types, so a branch buried inside
`MapillaryViewer` is untestable. Following `in-world-placement.ts` and
`edge-picker.ts`, which are pure precisely "so this can be tested without
mapillary-js or a WebGL context", the builder adds a pure helper — given a
camera type, the current bearing, the current centre and the target bearing,
return the new centre or `null` for "do not turn" — unit-tests it directly, and
leaves `MapillaryViewer` a thin wrapper around it.

### 5.4 An unknown compass angle is not a bearing of 359°

`selectPanorama` (`frontend/src/app/editor/document-ops.ts:556`) writes
`isNum(candidate.compassAngle) ? ((v % 360) + 360) % 360 : 0`. The probe found
that Mapillary reports an unknown compass angle as **`-1`**, not `null` — 25
of Český Krumlov's 46 flat images do. `isNum(-1)` is true, so the expression
yields `359`, and the stop is stored facing almost due north on no evidence
whatever, passing every schema validation because 359 is a legal bearing.

This is the hand-guessed-bearing failure this project has already been bitten
by, arriving through a new door: nothing is guessed, but a sentinel is read as
data. A null check does not catch it.

`selectPanorama` must treat a negative compass angle as absent. What "absent"
then means is the subject of §5.5, because `Panorama.bearing` is not nullable
and this design does not change the schema.

### 5.5 What a stop with no known bearing faces

`Panorama.bearing` is required and non-nullable, so a stop whose imagery has
no compass angle must still store a number, and `0` is what it stores. "No
schema change" (§5.6) means the document cannot distinguish *facing north*
from *direction unknown*, and nothing in this design should pretend otherwise.

What follows from that is that **the stored bearing must stop being the only
source for the wedge.** A flat image's bearing is not a view direction the
author chose; it is a fact about the camera. Since §5.3 already declines to
turn the view on flat imagery, the stored number is unused by the viewer for
exactly these stops — the map's wedge is the one thing still reading it.

So the viewer reports what it actually loaded, and the map trusts that over
the document. `PanoramaViewer` gains a reporting callback alongside the
existing `onPositionChange`, firing on each load with the loaded image's
camera type and its own compass angle, both of which mapillary-js already
exposes on `Image`. The editor store holds the latest report, keyed by image
id exactly as `panoramaFixForStop` keys the position fix, so a stale report
from a previous stop is never read. This is the same seam, and the same
discipline, as the existing refusal to derive a heading before the panorama
has loaded.

A document opened fresh therefore has no camera-type report until its panorama
loads, and draws no wedge until then. That is the correct behaviour and not a
degradation: the alternative is a wedge drawn from a number that may mean
nothing.

### 5.6 No schema change

`Panorama` says nothing about projection and nothing needs it. The viewer
learns the camera type from Mapillary at load, which is the only moment it
matters, and the editor learns it from the search when the author is choosing.
Adding a field would mean schema v4, a migration step, a frontend literal bump
and a second source of truth that can disagree with Mapillary — all to cache a
value that arrives for free. ADR 0005 is explicit that every additive field
costs a version bump, and this one buys nothing.

### 5.7 The coverage probe stops treating flat-only as failure

`content/scripts/probe_coverage.py` exits non-zero unless at least four sites
have three or more panoramas within 40 m (`:225`, `:233`). It keeps reporting panorama
counts separately — they are still the better imagery — but its
strong-candidate test counts flat imagery as coverage. This script is content
tooling for a Fairfax-style regeneration, not a path the testers touch; it is
in scope only so that it stops contradicting the rest of the application.

### 5.8 The candidate list is thinned by spacing, not by sequence

The pano-only filter was doing a second job nobody had named: **thinning.**
`panoramas()` asks for a 50 m bbox with Graph `limit: 500` and keeps 20 after
sorting, and on 360 imagery those 20 were 20 distinct vantage points. On the
phone and dashcam capture this feature exists for they are not. Český Krumlov
returns 46 flat images in 17 sequences within 50 m, one sequence contributing
11 frames spanning 57.5 m to 58.4 m — ninety centimetres apart, visually
identical, and all 11 would occupy over half the list.

**One frame per sequence is the wrong fix.** Rye's 28 flat images are a single
sequence; keeping one per sequence would offer the author exactly one
candidate for the entire street, which is worse than the problem. The rule is
therefore spatial:

> Walking the ranked list in order, keep a candidate unless an
> already-kept candidate **from the same sequence** lies within a minimum
> spacing of it. Candidates with no sequence id are never thinned.

This collapses Krumlov's 11 near-identical frames to one while leaving Rye a
usable spread along its street, and it cannot thin a sparse site at all.

A pure function with its own spec, in `mapillary-search.ts` beside
`rankCandidates`, applied **after** sorting and **before** the limit of 20 —
the order matters, or thinning would operate on an already-truncated list. The
minimum spacing is a module constant; 10 m is the author's starting value and
the builder may argue for another from the fixtures.

**A known, unaddressed limit:** Graph's `limit: 500` is not nearest-first, so
on coverage denser than 500 images in 50 m, images nearer than the ones
returned can be dropped before ranking ever sees them. Visby, the densest site
probed, returned 288 and did not reach the cap. This is recorded rather than
fixed; the fix is a smaller radius or paging, and neither is worth doing before
a real site hits it.

### 5.9 The historian's page says what a flat stop can do

`docs/FOR-HISTORIANS.md` gains a short passage, in the voice of the rest of
that page, covering: flat imagery will appear in the search labelled `flat`;
the view cannot be turned; and anything anchored outside what the camera was
pointed at will not be visible. `README.md`'s imagery row is adjusted so it no
longer implies 360 only.

## 6. The accepted limit

**The author has accepted this and does not want the editor to warn about it.**

On a 360 panorama a visitor can turn all the way round, so a draped archival
photograph is always reachable. A flat image shows one direction, perhaps
70–90° wide. Anything anchored outside that wedge — an archival photograph, a
text marker, a destination arrow — is in the document, renders correctly, and
is simply never visible. "The same data we have now" therefore works at a flat
stop only when the archival photograph happens to face roughly the way the
camera did.

No out-of-frame warning and no refusal to anchor: the limit is a property of
the imagery, and the author would rather have the stop than the guard rail.

**The map's wedge is the exception, and the author chose it deliberately.**
An indicator already exists — `edit-map-pane.ts:117` draws
`viewWedge(fix, stop.panorama.bearing, 90, 25)` — so "no field-of-view
indicator" was never available as a position; the only question was whether
the existing one tells the truth on flat imagery. Today it does not: a flat
stop with an unknown compass angle would draw a confident 90° wedge pointing
within a degree of north (§5.4).

It becomes camera-type-aware, reading the viewer's report (§5.5):

| Reported camera type | Wedge |
| --- | --- |
| `spherical` | unchanged — 90° from the stored bearing, as today |
| flat, compass angle known | drawn from the **reported** angle, narrower |
| flat, compass angle unknown (`-1` or absent) | **none** |
| nothing reported yet | none |

This is an indicator of where the camera looked, not a claim about what is
visible, and it is on the authoring map only — the visitor never sees it. The
narrower angle for flat imagery is a fixed constant, not computed: Mapillary
does return `camera_parameters`, from which a real field of view could be
derived, and doing so is explicitly out of scope here.

## 7. Decisions, and whose they are

| Decision | Whose |
| --- | --- |
| The out-of-frame limit is acceptable and gets no warning or refusal | the author's, §6 |
| The map's wedge becomes camera-type-aware | the author's, §6 |
| The candidate list is thinned rather than shipped redundant | the author's, §5.8 |
| A live probe was run to pick test subjects and confirm field names | the author's, §1 |
| Flat imagery is listed by default rather than opt-in | mine |
| Fisheye is included alongside perspective | mine |
| Unknown `cameraType` is treated as spherical | mine |
| No camera type in the schema | mine |
| Thinning is by spatial spacing within a sequence, not one per sequence | mine, §5.8 |
| 10 m minimum spacing, as a module constant | mine, §5.8 |
| A negative compass angle is absent, and stores bearing `0` | mine, §5.4 |
| The viewer reports camera type and compass angle through a new seam | mine, §5.5 |
| No wedge at all until the viewer has reported | mine, §5.5 |
| The turn decision becomes a pure, unit-tested function | mine |
| The coverage probe counts flat imagery, bar of three images within 40 m | mine |
| A small verdict helper is extracted from `probe_coverage.py` so it can be tested | mine |
| The branch lands with §9's browser checks open, as `UNVERIFIED.md` entries | mine |
| The branch stops before deploying; shipping to testers is a separate act | mine |

## 8. Left to the builder

- Where the pure turn helper lives and what it is called. It belongs in
  `frontend/src/app/panorama/`; whether it joins an existing module or gets its
  own file is a judgement about that folder, not about this feature.
- The exact wording and markup of the `360°` / `flat` badge, and whether it
  reads from `isPano` or `cameraType`. `isPano` is the more reliable field;
  `cameraType` is the more precise label when present.
- Whether `PanoramaCandidate.cameraType` is worth carrying at all if the badge
  ends up reading `isPano`. Adding it costs a field and a `FIELDS` entry; it is
  the builder's call whether anything uses it.
- The passage in `docs/FOR-HISTORIANS.md`, within §5.9's three points.

## 9. Testing, and what stays unverified

Unit-testable, and required:

- `rankCandidates` admits flat images with the default argument, still sorts
  panoramas first, and still drops malformed geometry
  (`mapillary-search.spec.ts` already covers the pano-only case at `:63` and
  that test stays, exercising the explicit argument).
- The pure turn helper: spherical turns, perspective and fisheye do not,
  undefined turns, and the existing wrap-around arithmetic is unchanged for
  the spherical case.
- The candidate list renders a badge per row (`inspector-pane.spec.ts`).
- The thinning function (§5.8): 11 frames 0.9 m apart in one sequence collapse
  to one; 28 frames spread along one sequence survive as several; two frames
  0.9 m apart in *different* sequences both survive; candidates with no
  sequence id are never thinned; thinning runs after the sort and before the
  limit, so a thinned list still fills to 20 where 20 distinct frames exist.
  Fixtures should be built from the real shapes in §1.1 rather than invented.
- `selectPanorama` with `compassAngle: -1` stores bearing `0`, not `359`
  (`document-ops.spec.ts`). Also `-0.0001` and `-360`. A real `0` from
  Mapillary still stores `0` — the two are indistinguishable in the document
  by design (§5.5), and the test should say so rather than imply otherwise.
- The wedge decision as a pure function over §6's four-row table, including
  "nothing reported yet" (`edit-map-pane.spec.ts` or beside it).
- The viewer's report is keyed by image id and a stale report from the previous
  stop is not read (`editor-store.spec.ts`), mirroring `panoramaFixForStop`.
- `probe_coverage.py`'s verdict and exit code over a flat-only fixture, against
  the extracted verdict helper (`backend/tests/test_content.py` or alongside
  the existing relevance tests).

`fake-viewer.ts` grows the new reporting callback, which is what lets the
wedge and store tests run with no WebGL.

**Not verifiable here, and it goes in `docs/UNVERIFIED.md` as its own entry:**
no browser engine launches in the development sandbox, so nobody will have seen
a flat Mapillary image render in this application until someone sits at a
browser. The specific checks that close the entry:

1. A stop built on a flat candidate loads and shows the street.
2. The view does **not** whip round on load — the §5.3 defect, confirmed absent.
3. `Image.cameraType` is in fact populated for a flat image the viewer renders,
   which is the assumption §5.3's fallback rests on. If it is undefined, the
   fallback is wrong for exactly the images this feature is for, and the rule
   inverts to "turn only when positively spherical".
4. A draped archival photograph inside the camera's wedge appears and fades.
5. The ground arrows still walk between flat images in a sequence.

6. The wedge is absent on a flat stop whose compass angle is `-1`, and present
   on one whose angle is known (§6).

Check 3 is the one that can change the design. It should be done first.

### 9.1 Concrete subjects for those checks

Probed on 2026-11-11 and recorded here so the `UNVERIFIED.md` entry is a
procedure rather than an aspiration. Mapillary imagery can be withdrawn
upstream, so an id that no longer resolves means re-probing, not a defect.

**Flat-only, many sequences — the main subject.** Český Krumlov,
`48.8109, 14.3153`. 46 flat images, 0 panoramas, 17 sequences within 50 m.

| image id | distance | sequence | compass |
| --- | --- | --- | --- |
| `304177654440052` | 21.8 m | `KkmbK5LiUsI_cQBJ6LuHpw` | **-1** |
| `953230175442807` | 23.0 m | `9NrMXWUXTiSDWGqNL2irrA` | 293.97 |
| `313605866995776` | 23.0 m | `9NrMXWUXTiSDWGqNL2irrA` | 298.12 |
| `514486621381530` | 27.0 m | `dOwlXaqhImEkvyRAMYgPUW` | 190 |

The first row is the §5.4 and §6 subject: unknown compass angle, so it must
store bearing `0` and draw no wedge. The second and third are 0.9 m apart in
one sequence and are the thinning subject. The fourth has a known angle and
must draw a wedge.

**Mixed — proves the sort still protects a 360 author.** Visby, Sweden,
`57.6409, 18.2960`. 8 panoramas against 280 flat images; the panoramas must
still occupy the top of the list.

**Single sequence — the thinning edge case.** Rye, England,
`50.9509, 0.7311`. 28 flat images, all in sequence
`Q9GMfRjnXOskmoyDrIFabv`, nearest 40 m. Thinning must leave several
candidates here, not one.

The e2e target (`make e2e`, `Makefile:40`) runs outside the sandbox, so the
list rendering for Český Krumlov is a reasonable Playwright case; it needs a
token in the environment and will be skipped without one, which the case
should state rather than fail on.

## 10. Files

| File | Change |
| --- | --- |
| `frontend/src/app/core/mapillary-search.ts` | default `panoOnly` to false; `camera_type` and `sequence` in `FIELDS`; `cameraType` and `sequenceId` on the candidate; the thinning function (§5.8) |
| `frontend/src/app/core/mapillary-search.spec.ts` | the §9 cases, including thinning |
| `frontend/src/app/panorama/panorama-viewer.ts` | the reporting callback on the interface (§5.5) |
| `frontend/src/app/panorama/mapillary-viewer.ts` | `load` reads the resolved `Image`; `faceBearing` delegates to the helper; fires the report |
| `frontend/src/app/panorama/fake-viewer.ts` | the new callback, so the store and wedge tests can drive it |
| `frontend/src/app/panorama/` (new or existing module) | the pure turn helper, and its spec |
| `frontend/src/app/editor/editor-store.ts` | holds the latest viewer report, keyed by image id |
| `frontend/src/app/editor/editor-store.spec.ts` | the staleness case |
| `frontend/src/app/editor/edit-map-pane.ts` | the camera-type-aware wedge (§6) |
| `frontend/src/app/editor/edit-map-pane.spec.ts` | §6's four rows |
| `frontend/src/app/editor/document-ops.ts` | `selectPanorama` treats a negative compass angle as absent (§5.4) |
| `frontend/src/app/editor/document-ops.spec.ts` | the `-1` case |
| `frontend/src/app/editor/inspector-pane.html` | the badge |
| `frontend/src/app/editor/inspector-pane.spec.ts` | the badge renders |
| `content/scripts/probe_coverage.py` | flat imagery counts as coverage; verdict helper extracted |
| `backend/tests/test_content.py` | the verdict helper over a flat-only fixture |
| `frontend/tests/e2e/` | optionally the Český Krumlov list case (§9.1) |
| `docs/FOR-HISTORIANS.md` | §5.9 |
| `README.md` | the imagery row no longer implies 360 only |
| `docs/UNVERIFIED.md` | one new entry, §9's six checks and §9.1's subjects |
| `docs/HANDOFF.md` | current state, per §7's last row |

`panorama-pane.ts` is deliberately absent: the viewer's report is wired in the
editor, and the visitor-facing pane neither draws a wedge nor needs the camera
type. If the builder finds it must change, that is worth reporting back — it
would mean §5.5's seam is in the wrong place.
