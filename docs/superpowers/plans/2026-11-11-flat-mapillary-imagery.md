# Flat (non-360) Mapillary imagery — implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A flat or fisheye Mapillary image can be chosen as a stop's base
imagery from the editor, and the stop then behaves like any other stop.

**Architecture:** Four pure functions carry the whole feature, each with its own
spec, because the frontend suite runs under vitest with jsdom and no WebGL and
nothing inside the mapillary-js adapter can be tested here: a spacing thinner
(`mapillary-search.ts`), a turn decision (`panorama/view-turn.ts`), a wedge
decision (`editor/footprint.ts`) and a compass-angle sentinel reader
(`mapillary-search.ts`, shared by the other two). `MapillaryViewer` becomes a
thin wrapper that reads the `Image` `moveTo` resolves to and reports it through
a new callback on the `PanoramaViewer` seam; the editor store holds the latest
report keyed by image id, exactly as it already holds the position fix.

**Tech Stack:** Angular 22, mapillary-js 4.1.2, vitest + jsdom, Python 3.12+
(pytest). No new dependency, no schema change, no migration.

**Spec:** `docs/superpowers/specs/2026-11-11-flat-mapillary-imagery-design.md`

## Global Constraints

- **No schema change, no migration, no new dependency** (design §5.6, §7).
  `backend/app/models.py` and `frontend/src/app/core/tour.models.ts` are not
  touched. If a task appears to need a schema field, stop and report.
- **Nothing outside `frontend/src/app/panorama/` imports mapillary-js or
  three** (`docs/ARCHITECTURE.md`). Plain interfaces exported from
  `panorama/panorama-viewer.ts` may be imported anywhere; `mapillary-js` types
  may not.
- **No network call is added anywhere.** `graph.mapillary.com` is unreachable
  from CI and from the production host, which is why panorama search runs in
  the browser. The live API facts used below were probed on 2026-11-11 and are
  recorded in design §1 and §9.1; use those values, make no calls.
- **`camera_type` and `sequence` are confirmed-valid Graph field names;
  `sequence_id` is accepted but returns nothing** (design §1). Only
  `sequence` is added to `FIELDS` (see Task 1).
- **Mapillary reports an unknown compass angle as `-1`, not `null`**
  (design §1). `isNum(-1)` is true, so every reader of a compass angle must
  test for a negative value, not for null.
- **`Image.cameraType` is `undefined` when SfM has not been run**
  (`mapillary.d.ts:1950-1956`). Unknown is treated as spherical: only a
  positive statement of `'perspective'` or `'fisheye'` changes behaviour
  (design §5.3).
- Toolchain: go through the `Makefile`, which pins Node 24 and sets
  `UV_CACHE_DIR`. `make check` is lint + backend tests + frontend tests +
  production build. `make e2e` **cannot run here** — no browser engine
  launches (`docs/ENVIRONMENT.md`).
- Match the surrounding comment density and idiom: this codebase comments
  *why*, especially where a past bug makes a line non-obvious.

## Review Focus

Input classes the design implies that no task's own tests would otherwise
exercise. Each has its test added to the owning task.

1. **A compass angle of `-1` reaching the wedge, not just `selectPanorama`.**
   Both read a Mapillary compass angle and both would store/draw 359°. One
   shared reader, tested from both sides. — Tasks 5 and 7.
2. **A stale report from the previously selected stop.** The author clicks
   stop B while the panorama pane still shows stop A's image; a wedge drawn
   from A's camera angle at B's location is a confident lie. — Tasks 6 and 7.
3. **An unrecognised or absent `cameraType` string.** Mapillary may add a
   projection, and SfM may not have run. Both must behave as today rather
   than as "flat". — Tasks 3 and 7.
4. **A candidate with no sequence id.** Graph can omit `sequence`; thinning
   on `null === null` would collapse every such image to one. — Task 2.
5. **A compass angle outside 0–360, and `-0.0001`.** `((v % 360) + 360) % 360`
   is applied to whatever survives the sentinel test, and `-0.0001` is a
   negative that rounds to a plausible bearing. — Task 5.

---

## File structure

| File | Responsibility |
| --- | --- |
| `frontend/src/app/core/mapillary-search.ts` | Graph query and candidate ranking. Gains `sequenceId` on the candidate, the `thinBySpacing` thinner, and `knownCompassAngle` — the one place that knows Mapillary's `-1` sentinel. |
| `frontend/src/app/panorama/view-turn.ts` (new) | The turn decision and `isFlatCamera`, the one definition of "positively non-spherical". Pure; no mapillary-js import. |
| `frontend/src/app/panorama/panorama-viewer.ts` | The seam. Gains `ImageryReport` and `onImageryReport`. |
| `frontend/src/app/panorama/mapillary-viewer.ts` | Reads the `Image` from `moveTo`, delegates the turn, reports on every `image` event. |
| `frontend/src/app/panorama/fake-viewer.ts` | Records and emits the report, so the store and wedge tests run without WebGL. |
| `frontend/src/app/editor/footprint.ts` | Geometry. Gains `wedgeFor`, the wedge decision over design §6's table, beside the `viewWedge` it feeds. |
| `frontend/src/app/editor/editor-store.ts` | Holds the latest report. |
| `frontend/src/app/editor/document-ops.ts` | `selectPanorama` reads the sentinel through `knownCompassAngle`. |
| `frontend/src/app/editor/edit-map-pane.ts` | Draws the wedge `wedgeFor` describes, or none. |
| `frontend/src/app/editor/edit-panorama-pane.ts` | Wires the viewer's report into the store, beside the existing position wiring. |
| `frontend/src/app/editor/inspector-pane.html`, `.css` | The `360°` / `flat` badge. |
| `content/scripts/probe_coverage.py` | Flat imagery counts as coverage; the verdict and exit decision become testable helpers. |

---

## Task 1: Flat imagery is listed, and sequences come back with it

**Files:**
- Modify: `frontend/src/app/core/mapillary-search.ts:9,11-21,61-83,96-98`
- Test: `frontend/src/app/core/mapillary-search.spec.ts`

**Interfaces:**
- Produces: `PanoramaCandidate.sequenceId: string | null`;
  `rankCandidates(images, lng, lat, panoOnly, limit)` — signature unchanged;
  `MapillarySearch.panoramas(lng, lat, radiusM = 50, panoOnly = false, limit = 20)`.

**Note on `cameraType`:** design §8 leaves it to the builder whether
`PanoramaCandidate` carries `cameraType` at all. It does **not**: the badge
reads `isPano` (Task 8), the turn decision and the wedge read the viewer's
report rather than the search (Tasks 3, 7), and nothing else would consume it.
`camera_type` is therefore **not** added to `FIELDS` either. Design §5.6's own
argument against caching a value that arrives for free applies: an unused
field is a second source of truth that can disagree with Mapillary.

- [x] **Step 1: Write the failing tests**

In `describe('rankCandidates')`, extend the `at` helper to take a sequence
(`at(id, lng, lat, isPano = true, sequence: string | null = null)`, emitting
`sequence` only when non-null) and add:

```ts
it('admits flat images by default, panoramas still first', () => {
  const got = rankCandidates([
    at('flat-near', -77.3069, 38.845, false),
    at('pano-far', -77.305, 38.845),
  ], -77.307, 38.845, false, 20);
  expect(got.map((c) => c.imageId)).toEqual(['pano-far', 'flat-near']);
});

it('carries the sequence id, and null when Mapillary omits it', () => {
  const [withSeq, without] = rankCandidates([
    at('a', -77.3069, 38.845, false, 'Q9GMfRjnXOskmoyDrIFabv'),
    at('b', -77.305, 38.845, false),
  ], -77.307, 38.845, false, 20);
  expect(withSeq.sequenceId).toBe('Q9GMfRjnXOskmoyDrIFabv');
  expect(without.sequenceId).toBeNull();
});
```

In `describe('MapillarySearch')`:

```ts
it('asks for the sequence, and lists flat imagery without being asked to', async () => {
  config.set({ mapillaryToken: 'MLY|t' } as never);
  const p = search.panoramas(14.3153, 48.8109);
  const req = http.expectOne((r) => r.url === 'https://graph.mapillary.com/images');
  expect(req.request.params.get('fields')).toContain('sequence');
  // Český Krumlov: 46 flat images, no panoramas. Today this list is empty.
  req.flush({ data: [at('304177654440052', 14.3153, 48.8110, false, 'KkmbK5LiUsI_cQBJ6LuHpw')] });
  expect((await p).map((c) => c.imageId)).toEqual(['304177654440052']);
});
```

- [x] **Step 2: Run them and confirm they fail for the expected reason**

Run: `cd frontend && npx ng test --watch=false` (through the Makefile's PATH).
Expected: the sequence tests fail on `sequenceId` being `undefined` (not a
property of `PanoramaCandidate`); the flat-by-default test fails because
`panoramas` drops the flat image under the current `panoOnly = true`.

- [x] **Step 3: Make the changes**

In `FIELDS` add `sequence` after `is_pano`. Add
`/** Mapillary's \`sequence\`: one capture run. Dense runs are thinned — see thinBySpacing. */`
and `sequenceId: string | null;` to `PanoramaCandidate`, and read
`img['sequence']` in `rankCandidates`, coercing a non-string to `null`. Flip
the `panoOnly` default on `MapillarySearch.panoramas` to `false`, and update
that method's and `rankCandidates`'s doc comments: the list is "imagery near a
point, true 360 panoramas first, nearest first" already — say that flat and
fisheye are included because mapillary-js draws all three, and that `panoOnly`
survives as an argument the specs exercise.

- [x] **Step 4: Run the tests and confirm they pass**

Run: `cd frontend && npx ng test --watch=false`
Expected: PASS, including the existing `drops flat images when panoOnly` at
`mapillary-search.spec.ts:63`, which now exercises the explicit argument.

---

## Task 2: The candidate list is thinned by spacing within a sequence

**Depends on:** Task 1 (`sequenceId`).

**Files:**
- Modify: `frontend/src/app/core/mapillary-search.ts` (beside `rankCandidates`)
- Test: `frontend/src/app/core/mapillary-search.spec.ts`

**Interfaces:**
- Produces: `MIN_CANDIDATE_SPACING_M = 10`;
  `thinBySpacing(candidates: PanoramaCandidate[], minSpacingM?: number): PanoramaCandidate[]`.
  Called inside `rankCandidates` **after** the sort and **before** `slice(0, limit)`.

The rule (design §5.8), verbatim: walking the ranked list in order, keep a
candidate unless an already-kept candidate **from the same sequence** lies
within `minSpacingM` of it. Candidates with no sequence id are never thinned.

- [x] **Step 1: Write the failing tests**

Add a `describe('thinBySpacing')` block. Fixtures are built from the real
shapes in design §1.1 and §9.1 with a metres-north/east helper, not invented
coordinates:

```ts
// Český Krumlov and Rye, from the 2026-11-11 probe (design §9.1).
const KRUMLOV = { lng: 14.3153, lat: 48.8109 };
const RYE = { lng: 0.7311, lat: 50.9509 };
const north = (p: {lng:number;lat:number}, m: number) => ({ ...p, lat: p.lat + m / 111_320 });
const east = (p: {lng:number;lat:number}, m: number) =>
  ({ ...p, lng: p.lng + m / (111_320 * Math.cos((p.lat * Math.PI) / 180)) });
const cand = (imageId: string, at: {lng:number;lat:number}, sequenceId: string | null, from: {lng:number;lat:number}) =>
  ({ imageId, ...at, isPano: false, sequenceId, capturedAt: null, compassAngle: null,
     thumbUrl: null, distanceM: Math.round(haversineM(from.lng, from.lat, at.lng, at.lat) * 10) / 10 });
```

```ts
it("collapses Krumlov's 11 near-identical frames in one sequence to one", () => {
  // 57.5 m out, then 0.9 m apart along the street: distances 57.5 m to 58.2 m.
  const frames = Array.from({ length: 11 }, (_, i) =>
    cand(`k${i}`, east(north(KRUMLOV, 57.5), i * 0.9), '9NrMXWUXTiSDWGqNL2irrA', KRUMLOV));
  expect(thinBySpacing(frames).map((c) => c.imageId)).toEqual(['k0']);
});

it("leaves Rye's single sequence a usable spread along its street", () => {
  // 28 images, one sequence, nearest 40 m; 5 m apart along the street.
  const frames = Array.from({ length: 28 }, (_, i) =>
    cand(`r${i}`, north(RYE, 40 + i * 5), 'Q9GMfRjnXOskmoyDrIFabv', RYE));
  // Every 10 m: 40, 50, ... 170 m.
  expect(thinBySpacing(frames)).toHaveLength(14);
});

it('keeps two frames 0.9 m apart in DIFFERENT sequences', () => {
  const a = cand('953230175442807', north(KRUMLOV, 23), '9NrMXWUXTiSDWGqNL2irrA', KRUMLOV);
  const b = cand('514486621381530', north(KRUMLOV, 23.9), 'dOwlXaqhImEkvyRAMYgPUW', KRUMLOV);
  expect(thinBySpacing([a, b]).map((c) => c.imageId)).toEqual([a.imageId, b.imageId]);
});

it('never thins candidates with no sequence id', () => {
  const frames = Array.from({ length: 5 }, (_, i) =>
    cand(`n${i}`, east(north(KRUMLOV, 57.5), i * 0.9), null, KRUMLOV));
  expect(thinBySpacing(frames)).toHaveLength(5);
});

it('cannot thin a sparse site at all', () => {
  const frames = [0, 1, 2].map((i) =>
    cand(`s${i}`, north(KRUMLOV, 20 + i * 11), 'one-sequence', KRUMLOV));
  expect(thinBySpacing(frames)).toHaveLength(3);
});
```

And in `describe('rankCandidates')`, that the order of operations holds:

```ts
it('thins after the sort and before the limit, so the list still fills to 20', () => {
  // 25 distinct frames 15 m apart in one sequence: none thinned, 20 kept.
  const images = Array.from({ length: 25 }, (_, i) => {
    const at = north(KRUMLOV, 20 + i * 15);
    return { id: `d${i}`, computed_geometry: { coordinates: [at.lng, at.lat] },
             is_pano: false, sequence: 'one-sequence' };
  });
  expect(rankCandidates(images, KRUMLOV.lng, KRUMLOV.lat, false, 20)).toHaveLength(20);
});

it('thins the near-identical frames out of the list it returns', () => {
  const images = Array.from({ length: 11 }, (_, i) => {
    const at = east(north(KRUMLOV, 57.5), i * 0.9);
    return { id: `k${i}`, computed_geometry: { coordinates: [at.lng, at.lat] },
             is_pano: false, sequence: 'dense' };
  });
  expect(rankCandidates(images, KRUMLOV.lng, KRUMLOV.lat, false, 20).map((c) => c.imageId))
    .toEqual(['k0']);
});
```

- [x] **Step 2: Run them and confirm they fail for the expected reason**

Expected: `thinBySpacing is not a function` for the new block, and the two
`rankCandidates` cases return 25-capped-to-20 and all 11 respectively.

- [x] **Step 3: Implement `thinBySpacing` and call it from `rankCandidates`**

Spacing between two candidates is `haversineM` over their own lng/lat, not a
difference of `distanceM` — two frames equidistant from the query point can be
metres apart (design §9.1's 23.0 m pair). Keep the comment explaining why the
pano-only filter was doing this job silently, and why one-frame-per-sequence
was rejected (Rye would offer one candidate for the whole street).

- [x] **Step 4: Run the tests and confirm they pass**

- [x] **Step 5: Record the known, unaddressed limit**

In `panoramas`, beside `limit: 500`, note that Graph's limit is not
nearest-first, so coverage denser than 500 images in 50 m can drop nearer
images before ranking sees them; Visby, the densest site probed, returned 288
(design §5.8).

---

## Task 3: The pure turn decision

**Files:**
- Create: `frontend/src/app/panorama/view-turn.ts`
- Create: `frontend/src/app/panorama/view-turn.spec.ts`

**Interfaces:**
- Produces:
  ```ts
  export function isFlatCamera(cameraType: string | undefined | null): boolean;
  export function centerForBearing(
    cameraType: string | undefined | null,
    currentBearingDeg: number,
    center: [number, number],
    targetBearingDeg: number,
  ): [number, number] | null;
  ```
  `null` means "do not turn". `isFlatCamera` is the one definition of
  "positively non-spherical" and is also imported by Task 7.

Design §8 leaves the helper's home open. It gets its own file: the panorama
folder keeps one concern per module (`edge-picker.ts`, `camera-sync.ts`,
`in-world-placement.ts`, `diagnostics.ts`), each pure with its own spec, and
turning the view belongs to none of them.

- [x] **Step 1: Write the failing tests**

```ts
describe('isFlatCamera', () => {
  it('is true only for the projections that are positively not spherical', () => {
    expect(isFlatCamera('perspective')).toBe(true);
    expect(isFlatCamera('fisheye')).toBe(true);
    expect(isFlatCamera('spherical')).toBe(false);
    // undefined when SfM has not been run, and anything Mapillary adds later:
    // unknown is treated as spherical, which is today's behaviour exactly.
    expect(isFlatCamera(undefined)).toBe(false);
    expect(isFlatCamera(null)).toBe(false);
    expect(isFlatCamera('equirectangular')).toBe(false);
  });
});

describe('centerForBearing', () => {
  it('shifts a spherical image by the signed difference over 360', () => {
    expect(centerForBearing('spherical', 100, [0.5, 0.4], 190)).toEqual([0.75, 0.4]);
  });

  it('takes the short way round at the wrap, and keeps x in [0,1)', () => {
    // 350 to 10 degrees is +20, not -340.
    expect(centerForBearing('spherical', 350, [0.5, 0.4], 10)![0]).toBeCloseTo(0.5 + 20 / 360, 12);
    expect(centerForBearing('spherical', 10, [0.98, 0.4], 100)![0]).toBeCloseTo(0.98 + 0.25 - 1, 12);
    expect(centerForBearing('spherical', 100, [0.02, 0.4], 10)![0]).toBeCloseTo(0.02 - 0.25 + 1, 12);
  });

  it('leaves the y coordinate alone', () => {
    expect(centerForBearing('spherical', 0, [0.5, 0.37], 90)![1]).toBe(0.37);
  });

  it('refuses to turn a perspective or fisheye image', () => {
    // x spans the camera's 70-90 degree field of view, not the full circle:
    // the same shift over-rotates by a factor of four or five.
    expect(centerForBearing('perspective', 100, [0.5, 0.4], 190)).toBeNull();
    expect(centerForBearing('fisheye', 100, [0.5, 0.4], 190)).toBeNull();
  });

  it('turns when the camera type is unknown, which is today\'s behaviour', () => {
    expect(centerForBearing(undefined, 100, [0.5, 0.4], 190)).toEqual([0.75, 0.4]);
  });
});
```

- [x] **Step 2: Run them and confirm they fail**

Expected: the module does not resolve.

- [x] **Step 3: Implement the two functions**

`centerForBearing` carries over the existing arithmetic from
`mapillary-viewer.ts:112-113` **unchanged** for the spherical case —
`delta = (((target - current + 540) % 360) - 180) / 360`, then
`x = (((center[0] + delta) % 1) + 1) % 1` — and the module comment explains
why it is correct only for a spherical image (design §2), citing
`docs/ENVIRONMENT.md`'s "`setCenter` is in basic image coordinates".

- [x] **Step 4: Run the tests and confirm they pass**

---

## Task 4: The viewer uses the decision, and reports what it loaded

**Depends on:** Task 3.

**Files:**
- Modify: `frontend/src/app/panorama/panorama-viewer.ts:17-39`
- Modify: `frontend/src/app/panorama/mapillary-viewer.ts:40-46,73-77,90-118`
- Modify: `frontend/src/app/panorama/fake-viewer.ts`
- Test: `frontend/src/app/panorama/fake-viewer.spec.ts`,
  `frontend/src/app/panorama/mapillary-viewer.spec.ts`

**Interfaces:**
- Consumes: `centerForBearing`, `isFlatCamera` (Task 3).
- Produces, in `panorama-viewer.ts`:
  ```ts
  /** What mapillary-js says about the image it actually loaded — not what the document claims. */
  export interface ImageryReport {
    imageId: string;
    /** undefined when SfM has not been run (mapillary.d.ts:1950). */
    cameraType: string | undefined;
    /** As Mapillary reports it, -1 sentinel and all: knownCompassAngle reads it. */
    compassAngle: number | null;
  }
  ```
  and on the interface, beside `onPositionChange`:
  `onImageryReport(handler: (report: ImageryReport) => void): void;`
- Produces, on `FakeViewer`: `imageryReports: ImageryReport[]` and
  `emitImageryReport(report: ImageryReport): void`.

**The report fires from the existing `image` event, not from `load`.** Design
§5.5 says "on each load"; `moveTo` raises `image`, so the `image` handler is a
superset that also covers the author walking the street with the ground
arrows, and it is the same seam `onPositionChange` already uses, with the same
image-id keying. The turn decision still happens in `load`, from the `Image`
that `moveTo` resolves to, because that is where the bearing is applied.

- [x] **Step 1: Write the failing tests**

In `fake-viewer.spec.ts`:

```ts
it('records and emits imagery reports to the registered handler', () => {
  const v = new FakeViewer();
  const seen: ImageryReport[] = [];
  v.onImageryReport((r) => seen.push(r));
  const report = { imageId: 'img-9', cameraType: 'perspective', compassAngle: -1 };
  v.emitImageryReport(report);
  expect(seen).toEqual([report]);
  expect(v.imageryReports).toEqual([report]);
});

it('does not throw when a report arrives with no handler registered', () => {
  const v = new FakeViewer();
  expect(() => v.emitImageryReport({ imageId: 'x', cameraType: undefined, compassAngle: null }))
    .not.toThrow();
});
```

In `mapillary-viewer.spec.ts`, a second `describe` driving `load` against a
stubbed `viewer` handle, as the existing block already stubs one:

```ts
describe('MapillaryViewer turning the view', () => {
  const stub = (cameraType: string | undefined) => {
    const viewer = new MapillaryViewer();
    const centers: [number, number][] = [];
    Object.assign(viewer, { viewer: {
      moveTo: async () => ({ id: 'img-1', cameraType, compassAngle: 12 }),
      getBearing: async () => 100,
      getCenter: async () => [0.5, 0.4],
      setCenter: (c: [number, number]) => { centers.push(c); },
    } });
    return { viewer, centers };
  };

  it('turns a spherical image to the stored bearing', async () => {
    const { viewer, centers } = stub('spherical');
    await viewer.load('img-1', 190);
    expect(centers).toEqual([[0.75, 0.4]]);
  });

  it('does NOT turn a perspective image — the over-rotation defect', async () => {
    const { viewer, centers } = stub('perspective');
    await viewer.load('img-1', 190);
    expect(centers).toEqual([]);
  });

  it('turns when the camera type is undefined', async () => {
    const { viewer, centers } = stub(undefined);
    await viewer.load('img-1', 190);
    expect(centers).toEqual([[0.75, 0.4]]);
  });
});
```

- [x] **Step 2: Run them and confirm they fail for the expected reason**

Expected: `emitImageryReport is not a function`; and the perspective case
fails by calling `setCenter` — which is design §2's defect, demonstrated.

- [x] **Step 3: Make the changes**

Add `ImageryReport` and `onImageryReport` to the interface. In
`MapillaryViewer`: hold a `reportHandler`; in the `image` handler (beside the
position report) fire
`{ imageId: image.id, cameraType: image.cameraType, compassAngle: image.compassAngle }`;
make `load` keep the `Image` that `moveTo` resolves to and pass
`image.cameraType` to `faceBearing`, which delegates to `centerForBearing` and
calls `setCenter` only for a non-null result, keeping the existing try/catch
and its "a view that will not turn is a cosmetic failure" comment. Replace
`faceBearing`'s doc comment's arithmetic explanation with a pointer to
`view-turn.ts`, and say that a flat image is left where mapillary-js opened it.
`FakeViewer` gains the array, the handler and the emitter.

`Image.cameraType` is typed `string` but documented as possibly `undefined`,
so read it as `string | undefined` at this boundary.

- [x] **Step 4: Run the tests and confirm they pass**

---

## Task 5: An unknown compass angle is not a bearing of 359°

**Files:**
- Modify: `frontend/src/app/core/mapillary-search.ts` (add `knownCompassAngle`)
- Modify: `frontend/src/app/editor/document-ops.ts:556`
- Test: `frontend/src/app/core/mapillary-search.spec.ts`,
  `frontend/src/app/editor/document-ops.spec.ts`

**Interfaces:**
- Produces: `knownCompassAngle(v: number | null | undefined): number | null` in
  `mapillary-search.ts` — the compass angle normalised to 0–360, or `null` when
  Mapillary does not know it. One home for the `-1` sentinel, because both
  readers of a compass angle (`selectPanorama` here, `wedgeFor` in Task 7) get
  theirs from Mapillary.

- [x] **Step 1: Write the failing tests**

In `mapillary-search.spec.ts`:

```ts
describe('knownCompassAngle', () => {
  it('reads Mapillary\'s -1 as unknown, not as a bearing', () => {
    // 25 of Krumlov's 46 flat images report -1. isNum(-1) is true, so a null
    // check yields 359: due north on no evidence whatever.
    expect(knownCompassAngle(-1)).toBeNull();
    expect(knownCompassAngle(-0.0001)).toBeNull();
    expect(knownCompassAngle(-360)).toBeNull();
  });

  it('is null for an absent angle', () => {
    expect(knownCompassAngle(null)).toBeNull();
    expect(knownCompassAngle(undefined)).toBeNull();
    expect(knownCompassAngle(NaN)).toBeNull();
    expect(knownCompassAngle(Infinity)).toBeNull();
  });

  it('normalises a known angle into 0-360', () => {
    expect(knownCompassAngle(0)).toBe(0);
    expect(knownCompassAngle(293.97)).toBe(293.97);
    expect(knownCompassAngle(360)).toBe(0);
    expect(knownCompassAngle(400)).toBe(40);
  });
});
```

In `document-ops.spec.ts`, beside the existing `selectPanorama` cases:

```ts
it('stores bearing 0 for Mapillary\'s -1, not 359', () => {
  const r = selectPanorama(tour([stop('s1', 1)]), 's1', {
    imageId: '304177654440052', lng: 14.3153, lat: 48.8110, compassAngle: -1,
  })!;
  expect(r.tour.stops[0].panorama.bearing).toBe(0);
});

it('stores bearing 0 for any negative angle, including -0.0001 and -360', () => {
  for (const compassAngle of [-0.0001, -360]) {
    const r = selectPanorama(tour([stop('s1', 1)]), 's1',
      { imageId: 'i', lng: 14.3153, lat: 48.8110, compassAngle })!;
    expect(r.tour.stops[0].panorama.bearing).toBe(0);
  }
});

it('stores a real 0 as 0 — the document cannot tell it from "unknown", by design', () => {
  // Panorama.bearing is required and non-nullable and the schema does not
  // change (design §5.5, §5.6), so "facing north" and "direction unknown" are
  // the same number here. The map's wedge is what distinguishes them, from the
  // viewer's report rather than from this value.
  const r = selectPanorama(tour([stop('s1', 1)]), 's1',
    { imageId: 'i', lng: 14.3153, lat: 48.8110, compassAngle: 0 })!;
  expect(r.tour.stops[0].panorama.bearing).toBe(0);
});

it('keeps a known flat-image angle', () => {
  const r = selectPanorama(tour([stop('s1', 1)]), 's1', {
    imageId: '953230175442807', lng: 14.3153, lat: 48.8110, compassAngle: 293.97,
  })!;
  expect(r.tour.stops[0].panorama.bearing).toBe(293.97);
});
```

- [x] **Step 2: Run them and confirm they fail for the expected reason**

Expected: `knownCompassAngle` is not exported; and the `-1` case fails with
**received 359**, which is the defect design §5.4 names.

- [x] **Step 3: Implement**

Add `knownCompassAngle` with a comment naming the sentinel, the 25-of-46
measurement and why a null check does not catch it. In `selectPanorama`
replace the `isNum(...) ? ... : 0` expression with
`knownCompassAngle(candidate.compassAngle) ?? 0`, and extend the existing
"or north when that is unknown" comment to say that `0` is what a
non-nullable `Panorama.bearing` can store and that the map's wedge, not this
number, is what tells the author the direction is unknown.

- [x] **Step 4: Run the tests and confirm they pass**

---

## Task 6: The editor store holds the latest report

**Depends on:** Task 4 (`ImageryReport`).

**Files:**
- Modify: `frontend/src/app/editor/editor-store.ts:27-39,136-150`
- Modify: `frontend/src/app/editor/edit-panorama-pane.ts:87-92`
- Test: `frontend/src/app/editor/editor-store.spec.ts`,
  `frontend/src/app/editor/edit-panorama-pane.spec.ts`

**Interfaces:**
- Produces: `EditorStore.imageryReport: Signal<ImageryReport | null>` and
  `setImageryReport(r: ImageryReport | null): void`, cleared by `clear()`.

`edit-panorama-pane.ts` is not in design §10's file list, but §5.5 says the
report is "wired in the editor" and §10 explains that the visitor-facing
`panorama-pane.ts` is deliberately absent — the editor's panorama pane is the
component that owns the viewer, so the wiring goes there, beside the position
wiring it already does.

- [x] **Step 1: Write the failing tests**

In `editor-store.spec.ts`:

```ts
const REPORT = { imageId: 'img-1', cameraType: 'perspective', compassAngle: -1 };

it('holds the latest imagery report, and the newest wins', () => {
  store.load(tour());
  store.setImageryReport(REPORT);
  expect(store.imageryReport()).toEqual(REPORT);
  const next = { imageId: 'img-2', cameraType: 'spherical', compassAngle: 90 };
  store.setImageryReport(next);
  expect(store.imageryReport()).toEqual(next);
});

it('keeps the report keyed by image id, as panoramaPosition is', () => {
  // Nothing here filters a stale report: the key travels with it and the
  // reader (wedgeFor) compares it to the stop's own panorama, exactly as
  // panoramaFixForStop does for the position.
  store.load(tour());
  store.setImageryReport(REPORT);
  expect(store.imageryReport()!.imageId).toBe('img-1');
});

it('drops the report when the tour closes', () => {
  store.load(tour());
  store.setImageryReport(REPORT);
  store.clear();
  expect(store.imageryReport()).toBeNull();
});

it('drops the report when another tour is loaded', () => {
  store.load(tour());
  store.setImageryReport(REPORT);
  store.load(tour());
  expect(store.imageryReport()).toBeNull();
});
```

In `edit-panorama-pane.spec.ts`:

```ts
it('publishes the viewer\'s imagery report to the store', async () => {
  // ... existing harness: store.load + select + create the component with `fake`
  fake.emitImageryReport({ imageId: 'img-1', cameraType: 'perspective', compassAngle: -1 });
  expect(store.imageryReport()).toEqual({ imageId: 'img-1', cameraType: 'perspective', compassAngle: -1 });
});
```

- [x] **Step 2: Run them and confirm they fail**

- [x] **Step 3: Implement**

Add the signal, the readonly accessor and the setter with a doc comment in the
voice of `panoramaPosition`'s — what the viewer actually loaded, keyed by
image id so a lagging pane cannot pass the previous image's camera off as this
one's, and never part of the document. Reset it in `clear()` (which `load`
calls), with the same note the position fix carries. In
`edit-panorama-pane.ts`'s constructor add
`this.viewer.onImageryReport((r) => this.store.setImageryReport(r));`

- [x] **Step 4: Run the tests and confirm they pass**

---

## Task 7: The map's wedge becomes camera-type-aware

**Depends on:** Tasks 3 (`isFlatCamera`), 4 (`ImageryReport`), 5
(`knownCompassAngle`), 6 (the store).

**Files:**
- Modify: `frontend/src/app/editor/footprint.ts` (beside `viewWedge`)
- Modify: `frontend/src/app/editor/edit-map-pane.ts:15-18,111-120`
- Test: `frontend/src/app/editor/footprint.spec.ts`,
  `frontend/src/app/editor/edit-map-pane.spec.ts`

**Interfaces:**
- Produces:
  ```ts
  /** 360 imagery: the stored bearing is a direction the visitor can turn to. Unchanged. */
  export const SPHERICAL_WEDGE_FOV_DEG = 90;
  /** Flat imagery: an under-claim of what the camera caught. See the comment. */
  export const FLAT_WEDGE_FOV_DEG = 60;
  export function wedgeFor(
    panorama: { imageId: string; bearing: number },
    report: ImageryReport | null,
  ): { bearingDeg: number; fovDeg: number } | null;
  ```
  `null` means "draw no wedge".

Design §6 fixes the narrower flat angle as "a fixed constant, not computed"
but gives no number. **60° is this plan's choice:** narrower than the
spherical 90°, and deliberately under-claiming against the 70–90° §6 estimates
for real flat capture, so the indicator never suggests more was captured than
was. `camera_parameters` would give the real figure and is explicitly out of
scope.

- [x] **Step 1: Write the failing tests**

In `footprint.spec.ts`, design §6's table row by row, plus the two Review
Focus cases it does not list:

```ts
describe('wedgeFor', () => {
  const PANORAMA = { imageId: 'img-1', bearing: 113 };
  const report = (over: Partial<ImageryReport> = {}): ImageryReport =>
    ({ imageId: 'img-1', cameraType: 'spherical', compassAngle: 90, ...over });

  it('spherical: 90 degrees from the STORED bearing, as today', () => {
    expect(wedgeFor(PANORAMA, report())).toEqual({ bearingDeg: 113, fovDeg: 90 });
  });

  it('flat with a known angle: the REPORTED angle, narrower', () => {
    expect(wedgeFor(PANORAMA, report({ cameraType: 'perspective', compassAngle: 190 })))
      .toEqual({ bearingDeg: 190, fovDeg: 60 });
    expect(wedgeFor(PANORAMA, report({ cameraType: 'fisheye', compassAngle: 293.97 })))
      .toEqual({ bearingDeg: 293.97, fovDeg: 60 });
  });

  it('flat with an unknown angle: no wedge', () => {
    // Krumlov image 304177654440052 reports -1. Drawing 359 degrees here is
    // the stored-bearing lie design §5.4 removes.
    expect(wedgeFor(PANORAMA, report({ cameraType: 'perspective', compassAngle: -1 }))).toBeNull();
    expect(wedgeFor(PANORAMA, report({ cameraType: 'perspective', compassAngle: null }))).toBeNull();
  });

  it('nothing reported yet: no wedge', () => {
    expect(wedgeFor(PANORAMA, null)).toBeNull();
  });

  it('a report for ANOTHER image is not this stop\'s camera', () => {
    expect(wedgeFor(PANORAMA, report({ imageId: 'img-other' }))).toBeNull();
    expect(wedgeFor(PANORAMA, report({ imageId: 'img-other', cameraType: 'perspective', compassAngle: 190 })))
      .toBeNull();
  });

  it('an unknown or absent camera type behaves as spherical', () => {
    expect(wedgeFor(PANORAMA, report({ cameraType: undefined }))).toEqual({ bearingDeg: 113, fovDeg: 90 });
    expect(wedgeFor(PANORAMA, report({ cameraType: 'equirectangular' })))
      .toEqual({ bearingDeg: 113, fovDeg: 90 });
  });
});
```

In `edit-map-pane.spec.ts`, that the pane obeys it. The existing
`shows the panorama position and view wedge from the gated fix` test at
`:151` must keep passing, so `start` gains an imagery report defaulting to a
spherical one for `img-1`:

```ts
it('draws no wedge until the viewer has reported, but still draws the dot', async () => {
  await start([inWorld()], 'o1', PANO, null);   // fix present, no report
  expect(q('[data-panorama-position]')).toBeTruthy();
  expect(q('[data-view-wedge]')).toBeNull();
});

it('draws no wedge for a flat image whose compass angle is unknown', async () => {
  await start([inWorld()], 'o1', PANO, { imageId: 'img-1', cameraType: 'perspective', compassAngle: -1 });
  expect(q('[data-panorama-position]')).toBeTruthy();
  expect(q('[data-view-wedge]')).toBeNull();
});

it('draws a wedge for a flat image whose compass angle is known', async () => {
  await start([inWorld()], 'o1', PANO, { imageId: 'img-1', cameraType: 'perspective', compassAngle: 190 });
  expect(q('[data-view-wedge]')).toBeTruthy();
});
```

- [x] **Step 2: Run them and confirm they fail for the expected reason**

Expected: `wedgeFor is not a function`; and the two pane cases fail by finding
a wedge the pane draws unconditionally from `stop.panorama.bearing`.

- [x] **Step 3: Implement**

`wedgeFor` returns `null` when `report` is null or its `imageId` differs from
`panorama.imageId`; for `isFlatCamera(report.cameraType)` it returns the
`knownCompassAngle(report.compassAngle)` with `FLAT_WEDGE_FOV_DEG`, or `null`
when that is null; otherwise the stored bearing with
`SPHERICAL_WEDGE_FOV_DEG`. Its doc comment carries design §6's table and says
this is an indicator of where the camera looked, not a claim about what is
visible, and that it is on the authoring map only.

In `edit-map-pane.ts` delete the local `WEDGE_FOV_DEG`, keep `WEDGE_RADIUS_M`,
and draw the wedge only when `wedgeFor(stop.panorama, this.store.imageryReport())`
returns a spec, passing its `bearingDeg` and `fovDeg` to `viewWedge`. The
panorama dot keeps its own condition (the position fix): a dot with no wedge
is the correct picture for a flat image with no known angle. Extend the
component's doc comment, which already explains the `panoramaFixForStop` gate,
to say the wedge is drawn from the viewer's report rather than the document
because a flat image's stored bearing may mean nothing.

- [x] **Step 4: Run the tests and confirm they pass**

---

## Task 8: Candidates are badged, not gated

**Depends on:** Task 1.

**Files:**
- Modify: `frontend/src/app/editor/inspector-pane.html:82-90`
- Modify: `frontend/src/app/editor/inspector-pane.css:42-49`
- Test: `frontend/src/app/editor/inspector-pane.spec.ts`

Design §8 leaves the badge's source open: it reads **`isPano`**, the one signal
present on every image whether or not SfM has run (design §5.1). There is no
checkbox and no second search button (design §5.2).

- [x] **Step 1: Write the failing test**

```ts
it('badges every candidate 360 or flat, and lists both in one list', async () => {
  // ... existing harness, with the search returning one of each
  const badges = qa('[data-candidate-kind]');
  expect(badges.map((b) => b.getAttribute('data-candidate-kind'))).toEqual(['pano', 'flat']);
  expect(badges.map((b) => b.textContent!.trim())).toEqual(['360°', 'flat']);
  // No opt-in control: one list, and nothing to tick to see flat imagery.
  expect(q('input[type=checkbox]')).toBeNull();
});
```

- [x] **Step 2: Run it and confirm it fails**

Expected: no element matches `[data-candidate-kind]`.

- [x] **Step 3: Add the badge**

In the `@for` row, beside the distance `<span>`:
`<span class="badge" [attr.data-candidate-kind]="c.isPano ? 'pano' : 'flat'">{{ c.isPano ? '360°' : 'flat' }}</span>`.
Give `.badge` a rule in `inspector-pane.css` that keeps it in the row's second
grid column with the text (the `li` is a two-column grid whose `span` and
`button` both sit in column 2).

- [x] **Step 4: Run the tests and confirm they pass, the whole frontend suite included**

The empty-list message `data-panorama-none` still reads "No panoramas found
near this location." — leave the copy; it is now a genuinely empty result.

---

## Task 9: The coverage probe stops treating flat-only as failure

**Files:**
- Modify: `content/scripts/probe_coverage.py:209,225,233`
- Test: `backend/tests/test_content.py`

**Interfaces:**
- Produces, in `probe_coverage.py`:
  ```python
  STRONG_MIN_IMAGES = 3
  STRONG_MAX_NEAREST_M = 40.0
  STRONG_MIN_SITES = 4

  def site_verdict(image_count: int, pano_count: int) -> str      # "PANO" | "flat only" | "NO IMAGERY"
  def is_strong_candidate(image_count: int, nearest_m: float | None) -> bool
  def probe_exit_code(stops: list[dict]) -> int                   # 0 or 1, over "image_count"/"nearest_m" keys
  ```

- [x] **Step 1: Write the failing tests**

Add to `backend/tests/test_content.py` (which already puts
`content/scripts` on `sys.path`), importing from `probe_coverage`:

```python
def test_a_flat_only_site_is_still_a_verdict_of_flat_only():
    assert site_verdict(46, 0) == "flat only"
    assert site_verdict(288, 8) == "PANO"
    assert site_verdict(0, 0) == "NO IMAGERY"


def test_flat_imagery_counts_as_coverage():
    # Cesky Krumlov: 46 flat images, no panoramas, nearest 21.8 m.
    assert is_strong_candidate(46, 21.8) is True
    # Rye: 28 flat images, but the nearest is 40 m away - just inside the bar.
    assert is_strong_candidate(28, 40.0) is True
    assert is_strong_candidate(28, 40.1) is False
    assert is_strong_candidate(2, 10.0) is False
    assert is_strong_candidate(0, None) is False


def test_four_flat_only_sites_exit_zero():
    # The three flat-only European sites probed on 2026-11-11 plus one mixed:
    # under the old bar (>=3 PANORAMAS within 40 m) this run failed.
    stops = [
        {"image_count": 46, "pano_count": 0, "nearest_m": 21.8},
        {"image_count": 28, "pano_count": 0, "nearest_m": 40.0},
        {"image_count": 18, "pano_count": 0, "nearest_m": 30.0},
        {"image_count": 288, "pano_count": 8, "nearest_m": 5.0},
    ]
    assert probe_exit_code(stops) == 0


def test_sites_with_no_imagery_at_all_still_fail():
    # Dinan and Alberobello returned nothing; this design cannot help them.
    assert probe_exit_code([{"image_count": 0, "pano_count": 0, "nearest_m": None}] * 6) == 1
```

- [x] **Step 2: Run them and confirm they fail**

Run: `cd backend && uv run pytest -q tests/test_content.py`
Expected: `ImportError` — the three helpers do not exist.

- [x] **Step 3: Extract the helpers and change the bar**

Define the three constants and three functions above `main`, and have `main`
call them in place of its inline `verdict = ...` expression (`:209`) and its
`strong = [...]` comprehension (`:225`), returning `probe_exit_code(report["stops"])`
(`:233`). Panorama counts keep their own column and their own line in the
summary — they are still the better imagery; only the strong-candidate bar
changes. Update the summary's wording from `>=3 panos within 40m` to
`>=3 images within 40m`, and the module docstring's "preferring true 360
panoramas over flat perspective shots" to say that panoramas are preferred but
flat imagery counts, because the editor can now use it.

- [x] **Step 4: Run the backend tests and lint**

Run: `make lint && cd backend && uv run pytest -q`
Expected: PASS. `ruff` covers `../content/scripts`.

---

## Task 10: The documents

**Files:**
- Modify: `docs/FOR-HISTORIANS.md` (a new passage after "Starting")
- Modify: `README.md:26` (the imagery row) and the paragraph at `:32-35`
- Modify: `docs/UNVERIFIED.md` (one new entry, number 42)
- Modify: `docs/HANDOFF.md` (current state and test counts)

No test. House style: dense, specific, citing `file.ts:line`, candid about
measured versus assumed.

- [x] **Step 1: `docs/FOR-HISTORIANS.md`**

A short passage in that page's plain second-person voice, covering design
§5.9's three points and nothing more: flat imagery appears in the search
labelled `flat`; at a flat stop the view cannot be turned, because the camera
only ever pointed one way; and anything placed outside what the camera was
pointed at will be in the tour but never visible, so put photographs roughly
where the camera was looking. No warning and no guard rail exists for this
(design §6) — say so plainly, as that page says plainly that the recorder has
never been tried.

- [x] **Step 2: `README.md`**

The imagery row becomes Mapillary with both kinds named — 360° panoramas where
they exist, flat and fisheye capture where they do not. The paragraph below it
says all six Fairfax stops were chosen by probing for panoramas; add that the
editor no longer requires one, so a tour can be authored where coverage is
phone and dashcam capture, and that the committed tour keeps its panoramas.

- [x] **Step 3: `docs/UNVERIFIED.md`, entry 42**

Matching the existing entries' three-part shape (**Unproven** / **Why not
here** / **Close it**), with design §9's six checks as a numbered procedure
and §9.1's concrete subjects — the coordinates, the four Krumlov image ids and
their sequences and compass angles, Visby and Rye — so it can be run rather
than aspired to. It must say that **check 3 can change the design and should
be done first**: if `Image.cameraType` is undefined for a flat image the
viewer renders, the "unknown is spherical" fallback is wrong for exactly the
images this feature is for and the rule inverts to "turn only when positively
spherical" (`view-turn.ts`). Note that an id that no longer resolves means
re-probing, not a defect. Add entry 42 to the file's opening orientation
paragraphs, which say what the latest branch added.

- [x] **Step 4: `docs/HANDOFF.md`**

Record the branch: what it changed, the real `make check` counts, that it
stops before deploying, and that its browser checks are open as entry 42.
**Correct the stale test counts** in the "Tests:" line — they read 413
backend / 606 frontend but `main` at `e24845a` already runs 692 backend.

---

## Task 11: The optional Playwright case

**Files:**
- Modify: `frontend/tests/e2e/tour.spec.ts` (or a sibling)

**This cannot be run here** and its absence from a test run is not a failure
(`docs/ENVIRONMENT.md`). Write it; do not try to execute it.

- [x] **Step 1: Add the Český Krumlov list case**

Drive the editor's panorama search at `48.8109, 14.3153` and assert the
candidate list is non-empty and carries `flat` badges. It needs a Mapillary
token in the environment: the case must **skip with a stated reason** when
there is none (`test.skip(!process.env.MAPILLARY_TOKEN, '...')`), never fail.

- [x] **Step 2: Confirm it is syntactically sound without running it**

**`make check` does not cover this file.** `tsconfig.app.json` and
`tsconfig.spec.json` between them include only `src/**`, so nothing in
`frontend/tests/e2e/` is typechecked until `playwright test` builds it — which
cannot happen here. Typecheck it by hand instead, and do **not** run
`make e2e`:

```sh
cd frontend && npx tsc --noEmit --ignoreConfig --strict \
  --target ES2022 --module nodenext --moduleResolution nodenext --types node \
  tests/e2e/flat-imagery.spec.ts tests/e2e/tour.spec.ts tests/e2e/fixtures.ts
```

---

## Task 12: The full suite

- [x] **Step 1: Run `make check`**

Run: `make check`
Expected: lint clean, backend green, frontend green, production build emitted.
Baseline before this branch, measured at `e24845a`: **692 backend**, and the
frontend suite requires `npm install` in a fresh worktree before it can run
at all.

- [x] **Step 2: Record the real counts in `docs/HANDOFF.md`**

Only after the run, and only the numbers it printed.

---

## Not done, deliberately

- No schema field for the camera type (design §5.6, §7).
- No out-of-frame warning and no refusal to anchor outside the camera's wedge:
  the author accepted the limit and asked for no guard rail (design §6).
- No field of view derived from `camera_parameters` (design §6).
- No re-probe of Fairfax; the committed tour keeps its 360 panoramas
  (design §4).
- Nothing about uploading the author's own imagery, which is a separate
  piece of work under design (design §4).
- No deploy (design §7's last row).
