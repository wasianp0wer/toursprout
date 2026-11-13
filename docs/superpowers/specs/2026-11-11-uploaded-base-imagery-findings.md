# Uploaded base imagery for a stop — findings

**Date:** 2026-11-11
**Status:** findings only. This is **not** a design. It is input to a design
conversation the author has not had yet, and §9 lists the decisions that
conversation has to make. Nothing here has been implemented and no product
code was changed to produce it.
**Base:** `main` at `e24845a`.
**Feature:** let an author upload their own base imagery for a stop —
equirectangular 360 photographs and ordinary flat photographs — so that stops
can exist where Mapillary has no coverage. Today `Panorama.provider` is
`Literal["mapillary"]` (`backend/app/models.py:231`).
**Direction already chosen (not re-argued here):** a second implementation of
the `PanoramaViewer` interface (`frontend/src/app/panorama/panorama-viewer.ts`),
not a custom mapillary-js `DataProviderBase`.

## How to read this

Every claim is marked. **Verified** means read off a file in this repository
or off a library in `frontend/node_modules`, with the citation. **Measured**
means a command was run in this session and the output is quoted.
**Assumed** means it is my reasoning and nobody has checked it.
**Unverifiable here** means it needs a browser or a GPU, which this
environment does not have (`docs/ENVIRONMENT.md:98-127`), and §7 says where
each such item belongs in `docs/UNVERIFIED.md`.

The four findings that most change the size of this job, up front:

1. **three.js is consumable from this build, and that is now checked rather
   than hoped.** `OrbitControls`, `SphereGeometry` and `Raycaster` type-check
   and bundle under the project's exact settings. §3.
2. **`mapillary-js` inlines its own copy of three.js, so the project already
   runs two three.js module instances in one WebGL context.** The rule in
   `docs/ENVIRONMENT.md:129-146` is really about *version* identity, not
   instance identity, and the document overstates what it is protecting. §2.
3. **three 0.134 already downscales an over-cap texture for you** — through a
   2D canvas, on the main thread, on every visitor's device, with a console
   warning. That turns §6's texture work from "required for correctness" into
   "required for performance and for export size", which is a different and
   smaller argument. §6.2.
4. **A self-hosted viewer that sizes its own canvas with a `ResizeObserver`
   fails an existing test on purpose.** `entry-page.spec.ts:240-250` scans
   every non-spec `.ts` under `frontend/src` for `invalidateSize|ResizeObserver`
   and asserts there are none. §4.

---

## 1. The `PanoramaViewer` contract, method by method

The interface is nine members over 23 lines
(`frontend/src/app/panorama/panorama-viewer.ts:17-39`). Its docstring
(`:12-16`) already names itself the seam that contains mapillary-js and says
mapillary-js is expected to be replaced, and `docs/ARCHITECTURE.md:404-408`
restates it as a layer rule. Route 2 is the thing this interface was built
for; that much is verified, not inferred.

Two consumers: `PanoramaPane` (`panorama-pane.ts:37`) for the viewer and
`EditPanoramaPane` (`edit-panorama-pane.ts:68`) for the editor. Each has its
own `if (o.display.mode === …)` partition loop (`panorama-pane.ts:67-112`,
`edit-panorama-pane.ts:108-132`), which `docs/CHANGING-THINGS.md:84-90`
already flags as real duplication to be touched in both places.

### `attach(container: HTMLElement, accessToken: string): void` (`:18`)

**Mapillary** (`mapillary-viewer.ts:47-88`) constructs
`new Viewer({ accessToken, container, component: { cover: false, marker: true,
bearing: true, zoom: true, direction: true } })`, grabs the `marker` and
`direction` components, constructs an `InWorldRenderer` and registers it with
`viewer.addCustomRenderer` (`:56-59`), and wires three listeners: `click` for
marker hit-testing (`:61-70`), `image` for the position report (`:73-77`), and
`spatialedges` for arrow re-picking (`:80-87`).

**A self-hosted implementation must** create its own canvas and
`WebGLRenderer`, append the canvas to `container`, build a `Scene` and a
`PerspectiveCamera`, install pointer handling for look-around, and start a
draw loop. Four concrete notes:

- `accessToken` is **ignored**. This is already legal: `FakeViewer.attach`
  declares one parameter (`fake-viewer.ts:27-29`) and compiles today, so a
  self-hosted viewer may do the same. The token comes from
  `ConfigStore.mapillaryToken()` (`config-store.ts:14-16`), which returns `''`
  when there is no config — so an uploaded-only published site needs no token
  at all. That is the `cachedMediaId` payoff in §9 decision 7.
- **Draw scheduling is a contract change in spirit.** mapillary-js renders on
  demand, which is why `MapillaryViewer.requestRedraw` calls
  `triggerRerender()` after every placement and opacity change
  (`mapillary-viewer.ts:141-161`), why `docs/ENVIRONMENT.md:172-181` calls it
  required, and why `FakeViewer` models it as a `rerenders` counter
  (`fake-viewer.ts:12-18, 53, 58`). A self-hosted viewer running
  `requestAnimationFrame` continuously has no equivalent and those calls
  become harmless no-ops. *Assumed:* harmless is the right answer — the
  counter is not asserted by `fake-viewer.spec.ts` (five tests, none of them
  about `rerenders`) nor by `panorama-pane.spec.ts`, only by
  `mapillary-viewer.spec.ts:24-32`, which is scoped to the adapter. So the
  counter stays a Mapillary-only claim and nothing has to change.
- **No WebGL in the constructor.** §7 depends on this entirely. Measured:
  under the installed jsdom with no `canvas` package present,
  `canvas.getContext('webgl')` returns `null`. A class that builds its
  renderer in the constructor cannot be instantiated in a unit test.
- **Sizing.** `container` has a size only once laid out. `panorama-pane.css`
  and the hidden-wrapper hazard in `docs/ARCHITECTURE.md:138-152` describe
  exactly this failure for Leaflet, and the project deliberately has no
  recovery. See §4 item 2 for why this is the most likely invisible bug here.

### `load(imageId: string, bearing: number): Promise<void>` (`:19`)

**Mapillary**: `await viewer.moveTo(imageId)` then `faceBearing(bearing)`
(`mapillary-viewer.ts:90-94`). `faceBearing` (`:105-118`) reads the current
bearing and the current centre and shifts by the difference, because
`setCenter` works in basic image coordinates where x = 0 is the left edge of
the panorama and **not** due north — mapping bearing to x directly pointed
every stop in an arbitrary direction (`docs/ENVIRONMENT.md:183-189`). It
swallows its own failure as cosmetic (`:115-117`). The outer promise's
rejection is load-bearing: both panes turn it into the "Street-level imagery
is unavailable for this stop" message (`panorama-pane.ts:61-64`,
`edit-panorama-pane.ts:102-105`), pinned by `panorama-pane.spec.ts:129-137`.

**A self-hosted implementation must** resolve the media reference to a URL
(`TourApi.mediaUrl`, `tour-api.ts:55-57`, is the only URL builder), load the
texture, build the geometry — an inside-out sphere for equirectangular, a
single plane for flat — point the camera, and **resolve only once the texture
has arrived, rejecting when it has not**. `TextureLoader.load` already takes
success and error callbacks and the in-world renderer uses both
(`in-world-renderer.ts:228-243`), so wrapping it in a promise is a few lines
and the existing error message keeps working for free.

Two real problems hide in this one method.

- **What is `imageId` for an uploaded stop?** `Panorama.image_id` is
  `str, min_length=1` (`models.py:232`). Whether the uploaded variant keeps an
  `imageId`-shaped identity decides whether `panoramaFixForStop`
  (`document-ops.ts:252-255`) and `detectArrival` (`arrival.ts:37-44`) change
  at all. §5 traces it; §9 decision 2 is the decision.
- **What does `bearing` mean?** For an uploaded equirectangular JPEG *we*
  choose the texture-to-world mapping, so bearing→yaw can be direct — but only
  once something says which longitude of the image faces north. Nothing in the
  bytes has to. §9 decision 3.

### `setMarkers(markers: OverlayMarker[]): void` (`:20`)

**Mapillary**: `removeAll()` then `add(...)` with `SimpleMarker`s coloured by
three constants (`mapillary-viewer.ts:14-16, 120-135`). The class docstring
(`:28-33`) records that markers accept lng/lat only — **no altitude**.

**A self-hosted implementation must** place its own meshes in ENU, the same
way the draped planes are placed, and must therefore *invent* an altitude that
mapillary chose for us. A small sphere at the anchor's `altitudeM`, or at a
fixed eye height, is the choice; reuse the three colour constants.

**For a flat (non-360) base image this method has no defensible answer.** A
flat photograph is a 2D picture with no world in it, so a geo-anchored marker
has nowhere to go. §9 decision 5.

### `onMarkerClick(handler: (id: string) => void): void` (`:21`)

Trivial in both: store the handler (`mapillary-viewer.ts:137-139`). The work
is the hit test, and mapillary has no `markerclick` event, so the adapter
hit-tests through `markerComponent.getMarkerIdAt(event.pixelPoint)`
(`:61-70`).

**Self-hosted**: `Raycaster.setFromCamera(coords, camera)` then
`intersectObjects`. Verified present in the installed three:
`frontend/node_modules/three/src/core/Raycaster.js:34` and `:66`, typed at
`frontend/node_modules/@types/three/src/core/Raycaster.d.ts:36`.
`docs/UNVERIFIED.md` entry 3 already names the mapillary pin hit test as "the
one thing on this list a browser is strictly required for" (`:139-140`),
because jsdom computes no layout. A raycast version inherits that exactly.

### `setInWorldPlacements` (`:24`) and `setInWorldOpacity` (`:30`)

**Mapillary**: delegate to `InWorldRenderer` and request a redraw
(`mapillary-viewer.ts:141-149`). The interface comment on
`setInWorldOpacity` (`:25-29`) says the whole map is passed at once "so the
renderer cannot drift out of step with the store" — that property is
host-independent and must be preserved.

**Self-hosted**: the scene-graph half of `InWorldRenderer` is reusable almost
verbatim; the host-coupled half is not. §2 draws the line.

### `setDestinationBearing(bearingDeg: number | null): void` (`:32`)

**Mapillary**: stores it and re-picks the highlighted ground arrow through
`pickEdgeToward` over the latest spatial edges (`mapillary-viewer.ts:163-166,
185-189`, fed by `:80-87`).

**Self-hosted: a genuine no-op.** An uploaded panorama has no neighbours and
no edge graph, so there is no arrow to highlight. The *feature* does not
vanish, though — `README.md:72-76` describes the arrow and the green
destination marker as two halves of the same affordance, and the destination
marker is built in the pane, not the viewer (`panorama-pane.ts:98-107`), so it
survives. An uploaded stop is a **dead end in the walking graph**: following a
street out of it is impossible and `Next`/`Previous` are the only way on.
*Verified that nothing models this today:* `TourStore.bearingToNextStop`
(`tour-store.ts:49-54`) still computes a number and
`PanoramaPane`'s effect still pushes it down (`panorama-pane.ts:116`).
Whether a visitor should be told is a product question, not a finding.

### `onPositionChange(handler)` (`:34-36`)

**Mapillary**: the `image` event, reporting `image.computedLngLat ?? image.lngLat`
and `image.id` (`mapillary-viewer.ts:73-77`). One handler field
(`:43-45, 168-172`), last registration wins.

**Self-hosted**: this is the single most consequential method in the whole
feature, because it is the only input to the heading gate. §5.

### `destroy(): void` (`:38`)

**Mapillary**: removes the custom renderer by id, nulls the component handles,
`viewer.remove()`, nulls the viewer (`mapillary-viewer.ts:174-183`). Note that
it leaves the object **re-attachable** — a later `attach` rebuilds everything
— and §4 shows the application depends on that today by accident.

**Self-hosted must** dispose geometries, materials and textures (the pattern
is `in-world-renderer.ts:262-271`), cancel the draw loop, `renderer.dispose()`
and `forceContextLoss()`, remove the canvas from the container, and dispose
the pointer controls. `OrbitControls` declares `dispose()`
(`@types/three/examples/jsm/controls/OrbitControls.d.ts`) and its constructor
writes `domElement.style.touchAction = 'none'`
(`three/examples/jsm/controls/OrbitControls.js:33`), which is a side effect on
an element the pane owns and which `dispose()` does not undo.

### Summary: what is trivial or absent for uploaded imagery

| Member | For an uploaded stop |
| --- | --- |
| `attach`'s `accessToken` | ignored; no token needed at all |
| `setDestinationBearing` | **no-op** — no edges, no arrows |
| `setMarkers` | real for 360; **undefined for flat** (§9.5) |
| `load`'s `bearing` | meaningful only once north is known (§9.3) |
| `onMarkerClick` | real, but needs a raycast and is browser-only to prove |
| `onPositionChange` | real, and the gate depends on it exactly (§5) |
| `setInWorldPlacements` / `setInWorldOpacity` | real; mostly reused code (§2) |
| `load` / `destroy` | real, and the bulk of the new work |

---

## 2. What is reusable as-is

| File | Verdict |
| --- | --- |
| `in-world-placement.ts` | **Verbatim** |
| `diagnostics.ts` | **Verbatim** |
| `in-world-renderer.ts` | **Reusable with change** — split it |
| `fake-viewer.ts` | **Reusable with change** — needs a label |
| `camera-sync.ts` | Mapillary-specific *by purpose*; correct, and dead on this route |
| `edge-picker.ts` | Mapillary-specific, and correctly so |

### `in-world-placement.ts` — verbatim

It is already pure and already takes ENU in rather than computing it
(`:36-39`, and the module docstring at `:1-6` says this is deliberate so it can
be tested without mapillary-js or a WebGL context). It imports nothing — not
even three: `inWorldMaterialOptions` writes `side: 2 as const // THREE.DoubleSide`
by hand (`:86`). It documents the two traps that cost real time: ENU is Z-up
so a `PlaneGeometry` left alone lies flat on the ground (`:40-48`), and the
rotation order must be explicit `ZYX` or every photograph faces south
(`:25-33`). `geodeticAltitude` (`:67-69`) converts height-above-ground to the
absolute altitude `geodeticToEnu` wants, which once put the Fairfax
photographs 128 m underground (`:59-66`, `models.py:31-36`).

**One condition makes this free, and it is a constraint on the new code, not a
cost:** the self-hosted scene must also be **ENU, Z-up**. If it uses three's
conventional Y-up, every number in this file and its 129-line spec is wrong.
Write that into the plan.

### `diagnostics.ts` — verbatim

Nothing mapillary in it (`:9-34`). The `?diag=1` flag is read in the adapter
(`mapillary-viewer.ts:56-58`), not in the module, so a self-hosted viewer can
take the same flag. Keep the `[in-world]` prefix so the console procedure in
`docs/UNVERIFIED.md` entry 3 still applies, and *consider* a second label so a
reader can tell the two renderers apart — the renderer also exposes itself on
`window.__inWorld` for console interrogation (`in-world-renderer.ts:51-55`),
and two of them would collide.

### `camera-sync.ts` — correct, and dead on this route

Its only job is to take a view matrix and a projection matrix *handed in by a
host renderer* and decompose them, because assigning `camera.matrixWorld`
directly does not survive `WebGLRenderer.render`'s call to
`updateMatrixWorld` (`:4-12`, `docs/ENVIRONMENT.md:161-171`). A self-hosted
viewer **owns** the camera and sets position and quaternion itself, so three
composes the matrix in the ordinary way and there is nothing to decompose. The
file needs no change and should acquire no new caller; a self-hosted viewer
calling `syncCamera` would be a smell. ADR 0005's note that loosening
`Panorama` would "force null handling through … `camera-sync`"
(`docs/decisions/0005-schema-v3-locks-the-document.md:163-165`) is about a
different change and does not apply here.

### `in-world-renderer.ts` — split it along a line that is already visible

272 lines, and the seam is clean. **Host-independent** (reusable with no
behaviour change): `setPlacements` and its in-place-vs-rebuild decision
(`:119-141`), `updateInPlace` (`:143-148`), `transformMesh` (`:150-166`),
`setOpacity` (`:168-181`), `rebuild` with its texture loading (`:218-260`),
`disposeMeshes` (`:262-271`), the `Scene`, the mesh map, and `inspect()`
(`:59-88`). **Mapillary-shaped** (five things, all of which owning our own
context removes):

1. the `implements ICustomRenderer` / `RenderPass.Opaque` surface (`:34-36`)
   and `onAdd`/`onReference`/`onRemove`/`render` (`:90-216`);
2. `new WebGLRenderer({ canvas, context })` over a **borrowed** canvas and
   context (`:90-93`);
3. `setPixelRatio(1)` to match the borrowed context, without which the
   panorama goes soft at the edges (`:96-98`);
4. `renderer.resetState()` plus saving and restoring `context.VIEWPORT` around
   our draw, because three writes its own and mapillary renders after us in
   the same context (`:210-215`);
5. `syncCamera` from the supplied matrices (`:195`).

**The two-copies hazard, corrected.** The class docstring says three is "the
version mapillary-js depends on (0.134), deliberately not installed
separately: two three.js copies sharing one WebGL context fail in ways that are
hard to diagnose" (`:26-33`), and `docs/ENVIRONMENT.md:129-146` says the same
at length. **Measured, and the premise is not quite what the documents say:**
`frontend/node_modules/mapillary-js/dist/mapillary.module.js` has **no import
statements at all** and contains three 0.134 inlined — `const REVISION = '134'`
at `:2748`, plus `class WebGLRenderer`, `class SphereGeometry`,
`class Raycaster`, `class PerspectiveCamera` and `class TextureLoader`. So
`import { WebGLRenderer } from 'three'` at `in-world-renderer.ts:16` resolves
to `frontend/node_modules/three/build/three.module.js`, a **different module
instance of the same version**, and the project already has two three.js
instances writing to one WebGL context. It survives because the versions are
byte-identical; items 3 and 4 above are the visible cost. The rule the
documents are really enforcing is **version identity**, and that is worth
saying in those words, because the next reader will otherwise conclude the
instance-level hazard is being avoided when it is not.

**A self-hosted viewer on its own canvas pays none of items 1–5.** It also
makes a sixth thing available that is *not* a free win:
`inWorldMaterialOptions` sets `depthTest: false, depthWrite: false`
(`in-world-placement.ts:84-85`), which is a consequence of drawing into
someone else's depth buffer after their pass. Owning the context makes real
depth testing possible — but turning it on is a visible behaviour change and
belongs in its own decision, not in this feature.

### `edge-picker.ts` — mapillary-specific, correctly

Pure and well factored (`:1-6` says it is kept pure so mapillary types stay in
the adapter), but its entire input is a spatial-edge graph with mapillary's
counter-clockwise-from-east azimuth convention (`:8-14, 19-22`). An uploaded
stop has no edges. Not reused, not changed, not deleted.

### `fake-viewer.ts` — reusable with change, and the change gates §7

It implements the interface and records every call (`:5-78`), already drops
`accessToken` (`:27-29`), and can simulate marker clicks and position changes
(`:47-49, 71-73`). For a dispatcher it needs a **label** so a pane test can
assert *which* implementation received a call, and its `rerenders` counter
should be documented as a Mapillary-only claim (§1). Five spec files provide
the token with a single `FakeViewer` instance — `app.spec.ts:23`,
`entry-page.spec.ts:38`, `viewer-page.spec.ts:25`,
`panorama-pane.spec.ts:72`, `edit-panorama-pane.spec.ts:47` — which is the
decisive fact in §4.

### `geodeticToEnu`: keep importing it

**Verified it is a public, pure function.** Declared at
`frontend/node_modules/mapillary-js/dist/mapillary.d.ts:17` and present in the
package's export list (`mapillary.module.js:10832`). The implementation is
`geodeticToEnu` → `geodeticToEcef` → `ecefToEnu`
(`mapillary.module.js:45268-45271, 45302-45319, 45362-45379`): WGS84
ellipsoid, roughly 40 lines of arithmetic, no viewer state, no network, no
WebGL. It is already used from `in-world-renderer.ts:153-158`.

**Neither of the project's own geo modules is a substitute.**
`frontend/src/app/core/geo.ts` has `bearingBetween` and `distanceBetween` on a
sphere of radius 6 371 000 m (`:6, 12-32`) and `metresToLat`/`metresToLng` as
an equirectangular approximation at 111 320 m per degree (`:34-40`).
`content/scripts/geo.py` is the same approximation and says so in its
docstring (`:1-6, 12-18`). Neither does geodetic→ENU, neither is ellipsoidal,
and neither handles altitude at all.

**Recommendation (not a decision):** keep importing it. The import stays
inside `panorama/`, so the layer rule in `docs/ARCHITECTURE.md:404-408` is
satisfied, and writing our own 40-line `enu.ts` would create a *second* answer
to a question already answered — any disagreement between the two would show
up as draped photographs landing in slightly different places on uploaded
stops than on Mapillary stops, which is precisely the bug class this project
has already paid for twice. Revisit when mapillary-js is removed outright; at
that point a small `enu.ts` with a spec pinned against mapillary's output is
the right move.

**One honest cost.** Keeping the import means a published site containing
*only* uploaded stops still ships mapillary-js. `panorama/` is reached from
`ViewerPage`, which is eager (`docs/ARCHITECTURE.md:73-76`), so mapillary-js is
in the initial chunk; adding a self-hosted viewer **increases** the initial
bundle rather than offering a path to dropping it. The production budget is
3 MB warn / 4 MB error (`frontend/angular.json:36-48`) against a current
2.23 MB raw / 487 kB transferred (`docs/ENVIRONMENT.md:95-96`). That is
headroom, not comfort. Worth measuring with `make build` as part of the work
rather than at the end.

---

## 3. three.js, as installed

### What is on disk

| Fact | Where |
| --- | --- |
| `three@0.134.0` | `frontend/node_modules/three/package.json` (`version`) |
| Not a direct dependency | `frontend/package.json:13-25` — no `three` entry |
| Pinned and reproducible | `frontend/package-lock.json:7506-7511` — exact version plus integrity |
| Dependency path | `npm ls three` → `frontend@0.0.0 └─┬ mapillary-js@4.1.2 └── three@0.134.0` (measured) |
| Physically hoisted | `require.resolve('three')` from `frontend/src` → `frontend/node_modules/three/build/three.js` (measured) |
| No `exports` map, no `types` field | `three/package.json` — so deep subpaths resolve by plain path lookup |
| Types ship, from `@types/three@0.134.0` | mapillary-js declares it in `dependencies` (not dev); hoisted to `frontend/node_modules/@types/three`; `index.d.ts:8` re-exports `./src/Three` |

Note the version range: mapillary-js asks for `three: "^0.134.0"`, and npm's
caret on a `0.x` version means `>=0.134.0 <0.135.0`. **So no lockfile refresh
can drag three forward to a version where `examples/jsm` moved to `addons/` or
where an `exports` map appeared.** That removes the usual reason to distrust a
transitive dependency.

### Equirectangular sphere, from the files

- `SphereGeometry(radius = 1, widthSegments = 32, heightSegments = 16,
  phiStart = 0, phiLength = 2π, thetaStart = 0, thetaLength = π)` —
  `three/src/geometries/SphereGeometry.js:5-7`; typed at
  `@types/three/src/geometries/SphereGeometry.d.ts:3`. It emits `uvs` as part
  of its buffers, so an equirectangular image maps onto it directly with a
  plain `MeshBasicMaterial({ map })`.
- `FrontSide = 0`, `BackSide = 1`, `DoubleSide = 2` —
  `three/src/constants.js:12-14`. **`BackSide` is the one to use**: the camera
  sits at the sphere's centre and must see the inside. The common alternative
  (`geometry.scale(-1, 1, 1)`) is equivalent but reads worse.
- `EquirectangularReflectionMapping = 303` exists
  (`three/src/constants.js:60`, typed at
  `@types/three/src/constants.d.ts:114`) but is **the wrong tool here** — it
  is for environment maps on reflective materials, not for a textured
  skybox sphere. Mentioning it because it is the first thing a reader will
  reach for.
- The **seam longitude and pole orientation are ours to choose**, which is
  exactly why §9 decision 3 exists.

### `OrbitControls`

- `three/examples/jsm/controls/OrbitControls.js:1-9` imports
  `{ EventDispatcher, MOUSE, Quaternion, Spherical, TOUCH, Vector2, Vector3 }
  from 'three'` — a **bare specifier**, so it joins the existing
  `node_modules/three` instance and does not create a third copy.
- Types at `@types/three/examples/jsm/controls/OrbitControls.d.ts:1`, which
  imports from `'../../../src/Three'`; the full API is declared, including
  `dispose()`, `enableZoom`, `enablePan`, `minDistance`/`maxDistance` and
  `target`.
- **Consumable from this Angular/TypeScript/vitest build: measured.** I
  type-checked a probe importing `SphereGeometry`, `Mesh`,
  `MeshBasicMaterial`, `Texture`, `Raycaster`, `Vector2`, `BackSide`,
  `PerspectiveCamera`, `WebGLRenderer`, `Scene` and `TextureLoader` from
  `three`, `OrbitControls` from
  `three/examples/jsm/controls/OrbitControls`, and `geodeticToEnu` from
  `mapillary-js`, under a `tsconfig.json` copying `frontend/tsconfig.json:5-16`
  exactly (`"module": "preserve"`, `"types": []` as in
  `tsconfig.app.json:5-7`, `skipLibCheck`, `isolatedModules`,
  `noPropertyAccessFromIndexSignature`, target ES2022) with the frontend's real
  `node_modules` symlinked in. **`tsc` exits 0 with no diagnostics.** The same
  file then bundles with the project's own esbuild
  (`frontend/node_modules/.bin/esbuild --bundle --format=esm`), exit 0,
  2.8 MB unminified, `OrbitControls` present in the output.
  *Caveat, stated plainly:* the project sets **no** `"strict": true` anywhere
  (`frontend/tsconfig.json:5-16` sets four individual flags only), so this is
  clean under the project's real settings, not under strict. And neither check
  proves the bundle *runs* — jsdom has no WebGL, and `ng build` was not run
  with these imports added. The Angular builder uses this same esbuild, so the
  residual risk is low, not zero.
- **Design caveat:** `OrbitControls` orbits a *target*. A panorama needs the
  camera to sit still and rotate in place, which means putting `target` just
  in front of the camera and locking pan and zoom — workable and widely done,
  but a slight misuse. A hand-rolled pointer-drag yaw/pitch is perhaps 60
  lines with no dependency, no misuse, and no `touchAction` side effect
  (`OrbitControls.js:33`). Small open choice, not a decision.

### `Raycaster`

`three/src/core/Raycaster.js` with `setFromCamera(coords, camera)` at `:34`
and `intersectObjects(objects, recursive = true, intersects = [])` at `:66`;
typed at `@types/three/src/core/Raycaster.d.ts:36`. Sufficient for marker
hit-testing. Unprovable without a browser (§7).

### Texture limits, from the source

Two things that matter in §6 and that I had assumed wrongly before reading
them:

- `renderer.capabilities.maxTextureSize` is
  `gl.getParameter(gl.MAX_TEXTURE_SIZE)` —
  `three/src/renderers/webgl/WebGLCapabilities.js:76, 104`; typed at
  `@types/three/src/renderers/webgl/WebGLCapabilities.d.ts:14`. **So the real
  cap can be read at runtime instead of guessed.**
- **Non-power-of-two is fine on WebGL2.** `textureNeedsPowerOfTwo` returns
  `false` immediately when `isWebGL2` (`WebGLTextures.js:110-111`), and
  `WebGLRenderer` tries contexts in the order
  `['webgl2', 'webgl', 'experimental-webgl']` (`WebGLRenderer.js:225`). So an
  equirectangular texture needing `RepeatWrapping` at the seam does **not**
  have to be a power of two on any current device. I had expected the
  opposite.
- **three clamps an over-cap texture itself.** `uploadTexture` calls
  `resizeImage(texture.image, needsPowerOfTwo, false, maxTextureSize)`
  (`WebGLTextures.js:528-529`), and `resizeImage` scales the **longest side**
  down to `maxSize`, resamples through a 2D canvas `drawImage`, and logs
  `THREE.WebGLRenderer: Texture has been resized from (WxH) to (wxh)`. This
  reshapes §6.2 substantially.

### Should three become a direct dependency?

The resolution story is safe: exact version in the lockfile with an integrity
hash, a `0.x` caret that cannot move, and a verified hoist. The **intent**
story is not. `frontend/package.json` does not mention three, and
`docs/ENVIRONMENT.md:129-146` tells the next reader to expect exactly one
entry nested under mapillary-js and to treat a direct install as a mistake.
A self-hosted viewer makes three a first-class dependency of our own code in a
way `in-world-renderer.ts` arguably already did — and the next person who
removes mapillary-js removes three with it, silently, and the self-hosted
viewer stops resolving.

**My recommendation, which is §9 decision 4 and not mine to settle:** add
`"three": "0.134.0"` — exact, not caret — and amend
`docs/ENVIRONMENT.md:129-146` to say the rule is *version identity with
mapillary-js*, not *absence from `package.json`*. npm dedupes to the single
hoisted copy because the version is identical, so `npm ls three` would then
print one entry with two parents, and the document's own check must be
updated to accept that or it becomes a false alarm. The document needs the
instance-level correction from §2 regardless.

---

## 4. The dispatcher problem

### What is true today

- `PANORAMA_VIEWER` is an `InjectionToken` with
  `providedIn: 'root'` and `factory: () => new MapillaryViewer()`
  (`panorama-pane.ts:19-22`). **One instance for the whole application.**
- Both panes inject that one instance (`panorama-pane.ts:37`,
  `edit-panorama-pane.ts:68`), each keeps its own `attached` boolean
  (`panorama-pane.ts:43`, `edit-panorama-pane.ts:73`), and each calls
  `viewer.destroy()` on its own teardown (`panorama-pane.ts:46`,
  `edit-panorama-pane.ts:85`).
- **Consequence nobody wrote down:** navigating `/edit` → `/view` hands the
  second pane an already-destroyed singleton. It works only because
  `MapillaryViewer.destroy` nulls everything (`:174-183`) and the pane's
  `attached` flag is fresh, so `attach` rebuilds from scratch (`:47-88`). That
  is correct by coincidence of ordering, and it is the thing a dispatcher must
  stop depending on.
- Both panes register their own `onPositionChange` handler
  (`panorama-pane.ts:48-50`, `edit-panorama-pane.ts:90-92`) and
  `MapillaryViewer` keeps **one** handler field (`:43-45, 168-172`), so the
  last registration wins. Harmless today because only one pane is alive.
- Scene state arrives through **four separate effects** in the viewer pane —
  load (`:52-65`), markers and placements (`:67-112`), opacity (`:114`),
  destination bearing (`:116`) — and three in the editor pane (`:94-106`,
  `:108-132`).

### What has to change

**1. The token's value becomes a forwarding host, not a registry.** The
cheapest shape that satisfies both panes unchanged is an object that *itself*
implements `PanoramaViewer` and forwards to whichever child the current stop
needs. The alternative — making the token a `Record<Provider, () =>
PanoramaViewer>` — changes the token's type and therefore **all five** spec
files that override it (`app.spec.ts:23`, `entry-page.spec.ts:38`,
`viewer-page.spec.ts:25`, `panorama-pane.spec.ts:72`,
`edit-panorama-pane.spec.ts:47`), every one of which does
`{ provide: PANORAMA_VIEWER, useValue: <a single FakeViewer> }`. The
forwarding host also keeps the interface as the seam its docstring and
`docs/ARCHITECTURE.md:404-408` say it is. **This is the single most
cost-saving choice in the whole feature.**

**2. Container ownership, and the hazard that lives there.** Both panes pass
`this.container().nativeElement` once (`panorama-pane.ts:55-58`).
`MapillaryViewer` appends mapillary's own DOM into it; a self-hosted viewer
appends a canvas. Two implementations must not both hold children in the same
element. Two options:

- *(a) one child `<div>` per implementation, inactive one hidden.* Keeps a
  Mapillary viewer warm across a trip to an uploaded stop and back, which
  matters because `new Viewer(...)` is the expensive call.
- *(b) tear the active one down and empty the container on every provider
  switch.* Simpler; costs a full reload at each switch.

**(a) collides with a documented hazard.** An implementation attached into a
hidden element measures its canvas at 0×0, which is exactly the Leaflet
failure described in `docs/ARCHITECTURE.md:138-152`, and the project
deliberately has **no recovery** for it. So (a) must hide with `visibility`
and never `display`, or must attach lazily on first activation.

And the trap: **the obvious fix is forbidden by a test, on purpose.**
`entry-page.spec.ts:240-250` reads every non-spec `.ts` under `frontend/src`
and asserts that none matches `/invalidateSize|ResizeObserver/`. Its docstring
(`:220-239`) says the test is inverted deliberately — adding a `ResizeObserver`
would be an *improvement*, and the test exists so that improvement cannot land
while `ARCHITECTURE.md`, `CHANGING-THINGS.md`, `UNVERIFIED.md` entry 20,
`entry-page.css` and the comment above it all still tell the next reader there
is no recovery. **So a self-hosted viewer that sizes its canvas with a
`ResizeObserver` forces that premise to be closed out across five places in
the same branch, and the test to be deleted.** That is real work and it is
invisible until the suite goes red. It is also, arguably, the right thing to
do — but it must be planned, not discovered.

**3. Stop change must replay cached setter state.** Today a stop change is a
single `load()` on one viewer (`panorama-pane.ts:52-65`, pinned by
`panorama-pane.spec.ts:96-103`). With two providers a stop change can also be a
*provider* change, and then the host must: deactivate the old child, activate
the new one, attach it if it has never been attached, **re-register
`onMarkerClick` and `onPositionChange` on it**, and **replay the last
`setMarkers`, `setInWorldPlacements`, `setInWorldOpacity` and
`setDestinationBearing`** — because those come from separate effects that will
not re-run merely because the viewer changed. **The host must therefore cache
the latest argument to each setter.** This is the most easily forgotten piece
of the whole feature, and it is exactly the kind of thing a two-`FakeViewer`
pane test can prove.

**4. `destroy()` means two things now.** The pane's `DestroyRef` teardown
should destroy *every* child the host built, and the `attached` flag moves
into the host, per child — a pane-level boolean cannot express "mapillary is
attached, self-hosted is not". The panes' own `attached` fields should go
away, in both files.

### What breaks in `panorama-pane.spec.ts`

**With a forwarding host: nothing.** All 20 tests in the file go through
`FakeViewer` via the token override at `:70-75` and assert only on recorded
calls. Specifically safe: `:84-88` (load with bearing), `:90-94` (attaches),
`:96-103` (reloads on stop change), `:139-144` (destroys on teardown),
`:204-212` (feeds movement into the store).

Three things still need attention.

- **`:84-88` asserts `fake.loaded` equals `[{ imageId: 'img-1', bearing: 90 }]`.**
  If the uploaded variant's `load` takes something other than an `imageId`
  string (§9 decision 2c), this assertion and `FakeViewer.load`
  (`fake-viewer.ts:31-37`) both change. **Having the host resolve the media
  reference before calling `load` keeps the signature and this test** — prefer
  that unless there is a reason not to.
- **`:139-144` asserts `fake.destroyed`.** Passes unchanged so long as the
  token still yields the fake in tests, which it does. Fine.
- **New tests, not changed ones**, for: a tour mixing a Mapillary stop and an
  uploaded stop reaching different children, and the replay in item 3. Both
  need a two-fake harness, which is why `FakeViewer` needs a label (§2).

---

## 5. The editor's heading gate

### The gate

One function, three lines:

```ts
// frontend/src/app/editor/document-ops.ts:252-255
export function panoramaFixForStop(stop: Stop | null, fix: PanoramaFix | null): PanoramaFix | null {
  if (!stop || !fix) return null;
  return fix.imageId === stop.panorama.imageId ? fix : null;
}
```

`PanoramaFix extends LngLatLike` and adds `imageId` (`:239-241`), keyed that
way because "the panorama pane can lag a selection change; an unkeyed position
would then silently be the previous panorama's, and a heading derived from it
points the photograph the wrong way" (`:233-238`). Everything that can set a
heading goes through it: `setOverlayMode` into `inWorld` (`:341-342`),
`deriveOverlayHeading` (`:359-360`), `setOverlayHeadingManual` (`:380`), and
`setOverlayAnchorKeepingHeading` via the second (`:283-292`).
`docs/ARCHITECTURE.md:391-402` states the rule and its caveat — the gate is
enforced by those ops, not by the type system. `README.md:96-101` records why:
every hand-guessed bearing in this project's history was wrong, one by 138°.

### What an uploaded panorama must report through `onPositionChange`

**1. An `imageId` byte-equal to `stop.panorama.imageId` as the document stores
it.** Not the mediaId, unless the document's identity field *is* the mediaId.
This is the hard requirement, and it is why §9 decision 2 is not cosmetic: if
the v4 union gives the uploaded variant a different field name and no
`imageId`, then `panoramaFixForStop` has no `stop.panorama.imageId` to compare
and must learn a second shape — a change to the one function the whole heading
discipline rests on. ADR 0005's own precedent points the other way: `Anchor`
keeps `type` present and literal precisely so that adding a variant is a
one-line change at the alias (`models.py:44-52`).

**2. A real lng/lat for where the camera stood.** For an uploaded 360 there
are exactly two honest sources — EXIF GPS (§6.1) or the author placing the
camera by hand on the map. **`stop.location` is explicitly not a third**: it
is the building, not the camera, wrong by up to 178°
(`document-ops.ts:320-326`, `mapillary-search.ts:51-59`,
`docs/ARCHITECTURE.md:392-394`). When neither source is available, the correct
behaviour is for the uploaded viewer to report **no position at all**, leaving
`panoramaPosition` null and the gate shut — which refuses the `inWorld` switch
exactly as it does today for a Mapillary stop whose panorama has not loaded.
That is the feature working, not a gap.

**3. Fired after the texture resolves, once per load.** Mapillary fires on the
`image` event, i.e. after `moveTo` resolves (`mapillary-viewer.ts:73-77`).
Firing earlier would let the editor derive a heading for a stop whose panorama
has not drawn — the thing `README.md:96-101` says the editor deliberately
refuses.

### Every call site

**Producers — `setPanoramaPosition`** (`editor-store.ts:37-39`; the signal at
`:27`, cleared on `load` at `:146-149`):

| Site | What it does |
| --- | --- |
| `editor/edit-panorama-pane.ts:90-92` | The viewer-driven producer. Wires `onPositionChange` straight into the store, deliberately using the **reported** id and not the requested one (`:87-89`). |
| `editor/inspector-pane.ts:318-324` | The search-driven producer, and **not** from the viewer at all. `selectPanorama` (`document-ops.ts:549-562`) returns `{ tour, fix }` built from one candidate so "the position can never belong to a different image than the id written" (`:538-547`); the pane applies the tour then publishes the fix. |
| tests only | `editor-store.spec.ts:190`; `inspector-pane.spec.ts:46, 138, 171, 183, 244, 434`; `edit-map-pane.spec.ts:41` |

**`inspector-pane.ts:318` is the path an upload must mirror**, and it is the
one place the shape does not quite fit. `selectPanorama` returns `null` — no
document change at all — when the candidate's position is unusable
(`document-ops.ts:553-554`, pinned at `document-ops.spec.ts:555-560`). For an
upload, "stored, and selected, but with no position yet" is a **legitimate
state**, so the analogous op must be able to return a document change with a
`null` fix rather than refusing the whole thing. Easy to get wrong.

**Readers — `panoramaPosition`** (`editor-store.ts:36`):

| Site | Use |
| --- | --- |
| `editor/edit-map-pane.ts:62` | `protected fixed = () => panoramaFixForStop(...)` — enables the map's heading handle. Its docstring at `:30` names the gate as "the project's single gate". |
| `editor/inspector-pane.ts:61` | Same, for the inspector's derive and manual-override controls. |
| `editor/edit-panorama-pane.ts:165` | Inside `nudge`, passed to `setOverlayAnchorKeepingHeading`. |
| tests | `edit-panorama-pane.spec.ts:106-128` (including the negative case: a neighbour's id gives `null`); `inspector-pane.spec.ts:413, 434` |

**`selectPanorama`** is called from `inspector-pane.ts:318` and nowhere else
in production (`document-ops.spec.ts:533-566` otherwise).

### The viewer side, which matters for a different reason

`TourStore.updateViewerPosition(position, imageId?)` (`tour-store.ts:80-90`)
takes the id as **optional** and forwards it to `detectArrival`. When it is
present, `detectArrival` trusts an exact `stop.panorama.imageId` match over
every distance test (`arrival.ts:32-44`), because vantage points sit on the
road and can be nearer a neighbouring stop than their own — the courthouse
panorama is 39 m from the courthouse and 26 m from the Marr Monument
(`:33-36`). Without an id it falls back to the nearest-stop radius test
(`:53-78`), which is the behaviour that was *wrong* for Fairfax.

**So an uploaded stop that reports its own id arrives correctly and
immediately; one that reports nothing inherits a known bug.** Reporting the id
matters as much in the viewer as in the editor. The only viewer-side producer
is `panorama-pane.ts:48-50`.

---

## 6. Getting the image in

### Confirming the premise: this belongs in the browser

**Confirmed, on three independent grounds.**

1. **No Pillow, and the dependency list is deliberately short.**
   `backend/pyproject.toml:5-12` lists six runtime dependencies — fastapi,
   pydantic, pydantic-settings, httpx, python-multipart, a2wsgi. The dev-group
   comment (`:14-22`) shows the author already treats `[project.dependencies]`
   as "what lands on the host" and keeps it minimal on purpose, down to the
   reasoning about cp312 wheels building from source and failing a deploy.
2. **CGI starts a fresh interpreter per request.** ADR 0007 is the record;
   the measurement table at
   `docs/superpowers/specs/2026-11-09-cgi-deployment-design.md:22-33` puts
   cold start at 0.36–0.40 s over 8 runs and concludes "CGI is affordable". A
   Pillow import is paid on **every request**, including the ones with nothing
   to do with images. That is a measurable regression across the whole app for
   the benefit of one operation.
3. **An architectural reason independent of cost.** `store_media` stores bytes
   **unchanged** under an id derived from their content
   (`media_store.py:118-120, 127-173`), and dedupes by comparing bytes
   (`:148-156`). A server that re-encoded an upload would break what a
   `mediaId` *means*, and would have to store two files or lie about one.

### 6.1 Detecting equirectangular, and reading EXIF GPS

The file is already in hand as a `File` in the browser — `outline-pane.ts:207-214`
is the existing precedent. Everything below is pure `ArrayBuffer` arithmetic,
no new dependency, and **fully unit-testable in jsdom** because no canvas and
no image decode is involved.

- **JPEG segment walk.** `FFD8`, then repeating
  `FF <marker> <len-hi> <len-lo> <payload>` until `FFDA`. ~30 lines over a
  `DataView`.
- **XMP → `GPano:ProjectionType`.** The `APP1` (`FFE1`) segment whose payload
  begins `http://ns.adobe.com/xap/1.0/\0`; decode the rest as UTF-8 and look
  for `GPano:ProjectionType` with value `equirectangular`. Both the attribute
  and the element form occur in the wild. Do **not** parse the XML — a regex
  over the decoded string is the right level, and it is what every small
  library does. ~15–20 lines.
  Worth reading while there: `GPano:CroppedAreaImageWidthPixels`,
  `FullPanoWidthPixels` and `CroppedAreaLeftPixels`, because a **partial**
  (cropped) equirectangular is not a full sphere and mapping it onto one
  stretches it. Phone "photospheres" are usually full; stitched panoramas
  often are not. ~25 lines more.
  **Known gap to write down rather than discover:** extended XMP
  (`http://ns.adobe.com/xmp/extension/\0`) is used when the packet exceeds
  64 KB. GPano fields are normally in the standard packet, but not always.
- **EXIF GPS.** The `APP1` segment beginning `Exif\0\0`, then a TIFF header
  (`II`/`MM`, `0x002A`, offset to IFD0), then IFD0; tag `0x8825` is the offset
  to the GPS IFD, and in it `0x0001`/`0x0002` are the latitude ref and three
  RATIONALs, `0x0003`/`0x0004` the longitude pair. A cut-down walker that
  follows only IFD0 → GPS IFD and understands only RATIONAL and ASCII is ~50
  lines; a general one ~70.
  **Also present, and interesting:** `0x0011` GPSImgDirection with `0x0010`
  GPSImgDirectionRef (`'T'` true, `'M'` magnetic) — a candidate answer to
  "where is north in this image". It is also exactly the kind of value this
  project's history says not to trust: `docs/ENVIRONMENT.md:196-202` is titled
  *"Derive view bearings; do not author them by eye"*, and a magnetic
  reference with no declination correction is off by up to ~20° in the
  continental US. **Treat it as a prefill the author confirms, never as a
  derivation.**
- **Total: roughly 150–200 lines of dependency-free TypeScript.** *Rough
  figure, not measured.* A fixture JPEG can be built inside the test from a
  hand-written byte array, so the suite needs no binary fixture.
- **Scope honestly.** `ALLOWED_TYPES` admits JPEG, PNG and WebP
  (`media_store.py:27-36`), but neither PNG nor WebP carries GPano in
  practice and WebP's XMP lives in a different container. Restricting
  equirectangular detection to JPEG and treating PNG/WebP as flat is the
  honest scope.
- **Do not fall back to the aspect ratio.** A 2:1 ratio is a *hint*. Deriving
  "equirectangular" from it would silently wrap an ordinary wide photograph
  around a sphere. XMP, or the author says so — never the ratio alone.
  Whether the author may override the sniff is §9 decision 5's neighbour.

### 6.2 Texture size

**The premise, re-examined against the installed three — and it changes.**

- *Unverifiable here:* that a consumer 360 JPEG is ~11000×5500, and that
  mobile GPUs commonly cap `MAX_TEXTURE_SIZE` at 4096. No browser, no GPU.
  The second is at least **checkable at runtime**:
  `renderer.capabilities.maxTextureSize`
  (`WebGLCapabilities.js:76, 104`). A self-hosted viewer should read it rather
  than assume it.
- *Verified:* mapillary-js tiles its own imagery — `ImageTileEnt` and
  `ImageTilesContract` are in its export list
  (`mapillary.module.js:10832`) — and ours will not. **So the uploaded path
  has a ceiling the Mapillary path does not, and the visitor's device sets it,
  not us.**
- *Verified, and it reframes the whole section:* **three 0.134 already handles
  an over-cap texture.** `uploadTexture` calls
  `resizeImage(texture.image, needsPowerOfTwo, false, maxTextureSize)`
  (`WebGLTextures.js:528-529`), and `resizeImage` scales the **longest side**
  to `maxSize`, resamples through a 2D canvas `drawImage`, and warns
  `THREE.WebGLRenderer: Texture has been resized from (WxH) to (wxh)`. For an
  11000×5500 source on a 4096 device that produces 4096×2048 — which happens
  to be exactly the right aspect-preserving result for an equirectangular
  image.
- *Verified, against my own earlier assumption:* **no power-of-two requirement.**
  `textureNeedsPowerOfTwo` returns `false` on WebGL2
  (`WebGLTextures.js:110-111`) and `WebGLRenderer` prefers WebGL2
  (`WebGLRenderer.js:225`), so the `RepeatWrapping` an equirectangular seam
  needs does not force a power-of-two size on any current device.

**So the downscale is not required for correctness. It is required for three
other reasons, and they are the honest argument:**

1. three's fallback costs a **full decode of the original plus a 2D-canvas
   resample, on the main thread, on every visitor's device, on every load**.
   Downscaling at upload moves that cost to the author, once.
2. Export and publish carry the bytes. `write_bundle` includes `media/` and
   `build_site` copies the whole working directory
   (`docs/ARCHITECTURE.md:243-266`). Six 60-Mpx panoramas make a bundle a
   historian cannot reasonably move, on a shared host.
3. Upload time on a CGI host, and `max_media_file_bytes` (default 64 MB,
   `config.py:49`, `media_store.py:52`) with a declared-length pre-check in
   middleware (`main.py:390-403`).

**What the existing upload path needs.** `SessionApi.uploadMedia(file: File)`
posts a `FormData` to `/api/session/media` and returns `res.mediaId`
(`session-api.ts:83-93`); the route stores the bytes unchanged
(`main.py:671-720`). A browser-side downscale therefore means **uploading a
different `File` than the author chose** — one built from the resized blob.
Four consequences, each concrete:

- **The name matters.** The stored id's slug comes from the name we pass
  (`media_store._slug`, `:109-120`), so the resized `File` must keep a
  sensible name or the author sees `blob-<hash>.jpg` in their media list.
- **Dedupe silently weakens.** The content hash is of the *resized* bytes, and
  `createImageBitmap`'s `resizeQuality` is not specified to be bit-identical
  across browsers. So two authors uploading the same photograph get two
  different `mediaId`s, and the "same content, same stored file" promise
  (`media_store.py:150-156`) no longer holds for this path. Worth stating in
  the design; not a defect.
- **Re-encoding is admissible.** All three of `.jpg`/`.png`/`.webp` are
  sniffable (`media_store.py:41-47, 71-95`), so emitting JPEG is fine; a PNG
  re-encoded to JPEG loses alpha, which a base image does not have.
- **`createImageBitmap(file, { resizeWidth, resizeHeight, resizeQuality })`
  is the right first choice** (it decodes off the main thread and resamples
  itself), with `drawImage` into a canvas plus `canvas.toBlob` as the
  fallback. **But both share a hazard that cannot be tested here: the
  browser's own image-decode size limit.** Safari/iOS has historically
  refused to decode very large JPEGs, and a 60-Mpx source is squarely in that
  territory — so the downscale that exists to make the texture loadable may
  itself fail to decode the source. *Unverifiable here.* It belongs in
  `docs/UNVERIFIED.md` as a **blocking** unknown for large uploads, with the
  honest mitigation being a clear refusal telling the author to downscale in
  their own tool.

**Where this code goes.** Not in `outline-pane.ts` — that pane adds *overlays*
and its `createFromMedia` path (`:238-...`) is overlay-shaped. A base image
sets `stop.panorama`, so the op belongs beside `selectPanorama` in
`document-ops.ts` and the surface belongs in `inspector-pane.ts`, next to
`findPanoramas` and `usePanorama` (`:285-325`), because that is where choosing
a stop's panorama already lives. The discipline is unchanged: **network first,
document second** (`outline-pane.ts:204-235`,
`docs/CHANGING-THINGS.md:219-220`), so a refused upload never touches the
draft. The `accept` attribute precedent is `outline-pane.html:15`.

**And one thing not to forget:** a new `MediaRef` field belongs in
`referenced_media` (`models.py:315-333`) and **nowhere else** — that function's
docstring says so, and the bug it exists to prevent is two collectors each
knowing about only one reference. Getting this wrong reproduces the v2 orphan
miscount exactly.

---

## 7. Testing strategy

### The environment, measured

- Frontend tests run through `@angular/build:unit-test`
  (`frontend/angular.json:74-76`) under vitest with jsdom (`jsdom` is a
  devDependency, `package.json:33`). There is **no** vitest config file and
  **no** test-setup file in `frontend/` — only `playwright.config.ts`.
- **No canvas and no WebGL.** Measured against the installed jsdom with no
  `canvas` npm package present (verified absent from
  `frontend/node_modules`): `canvas.getContext('2d')` returns `null` and logs
  *"Not implemented: HTMLCanvasElement's getContext() method: without
  installing the canvas npm package"*; `getContext('webgl')` likewise returns
  `null`; `window.createImageBitmap` is `undefined`; `canvas.toBlob` exists as
  a function but has nothing to draw from.
- Playwright cannot launch any engine in the sandbox
  (`docs/ENVIRONMENT.md:98-127`: Chromium dies at a Mach-port check, Firefox
  cannot spawn a content process). `make e2e` must be run from an ordinary
  terminal (`Makefile:39-42`).
- The e2e suite **stubs all of mapillary.com** and says so: "The panorama
  cannot render real imagery under these conditions, so these tests assert on
  tour navigation, overlays and credits rather than on pixels"
  (`frontend/tests/e2e/fixtures.ts:3-21`).

### What can be unit-tested — and the two patterns already in the repo

**Pattern A: pure math, using three's math classes, no renderer.**
`in-world-placement.spec.ts:21-30` builds a `faceDirection` helper that applies
the returned rotation to `new Vector3(0, 0, 1)` via `Euler` and asks where the
face points. **This is the largest reusable win available**, and it covers
everything a self-hosted viewer computes: the camera quaternion for a given
bearing, a marker's ENU position, the yaw/pitch clamp, the sphere's
UV→compass mapping. It argues for pulling every such computation **out of the
viewer class** into a pure module beside `in-world-placement.ts`, rather than
leaving it inside the class where it cannot be reached.

**Pattern B: scene-graph bookkeeping without a context.**
`in-world-renderer.spec.ts` (five tests) constructs the real renderer, never
calls `onAdd`, sets `reference` directly and replaces `loader.load` with a
`vi.fn()` (`:6-32`), then asserts on the mesh map, geometry parameters and
material identity (`:34-85`). A self-hosted viewer can be driven the same way
**only if the `WebGLRenderer` is built lazily and separately from the scene**.
If the constructor reaches for a WebGL context it returns `null` here and the
class cannot even be instantiated. **So: scene, camera, meshes and materials
in the constructor and in the `setX` methods; `WebGLRenderer`, pointer
controls and the draw loop in `attach`, never in the constructor.** That is a
design constraint, and it is cheap only if stated before the code is written.

Also unit-testable:

- **Component wiring through `FakeViewer`**, unchanged — and this is where the
  dispatcher's replay-on-switch (§4 item 3) is proven.
- **The byte readers** (§6.1), completely, including against hand-built
  fixture bytes.
- **`load()`'s promise contract** with `TextureLoader.load` stubbed: that it
  resolves on success and rejects on texture failure, which is what keeps the
  existing "imagery is unavailable" message working
  (`panorama-pane.spec.ts:129-137`).
- **The downscale *decision*** — target dimensions from source dimensions and
  a cap — if the drawing step sits behind an injected function. The pixels
  cannot be tested: no 2D context, no `createImageBitmap`.

### What only Playwright can cover (and so, today, only outside the sandbox)

- That anything draws at all; that the sphere is inside-out rather than
  invisible from within; that the texture is not mirrored or rotated 180°;
  that the seam is where we think it is.
- That `bearing` points the view where the author meant. **This is the
  138°-class failure and no jsdom test can see it.**
- Marker hit-testing by raycast — jsdom computes no layout, so pointer
  coordinates are meaningless. `docs/UNVERIFIED.md` entry 3 already calls the
  mapillary equivalent the one thing a browser is strictly required for
  (`:139-140`).
- Pointer-drag look-around, and whatever `OrbitControls` does with
  `touchAction` on a touch device.
- Everything in §6.2: whether a 60-Mpx JPEG decodes, what `maxTextureSize`
  really is on a phone, what the downscale produces.

**An underrated upside of Route 2, worth writing down.** The e2e suite stubs
*all* of mapillary.com (`fixtures.ts:9-21`), so it can never assert pixels on
a Mapillary stop. An uploaded stop's imagery comes from `tour-data/media/`,
which the suite serves for real. **A self-hosted stop would be the first
panorama the Playwright suite could actually assert something visual about.**

### What has to land in `docs/UNVERIFIED.md`

In that file's own shape (*Unproven* / *Why not here* / *Close it*), ordered
the way the file orders things — by how much work a failure invalidates:

1. That an uploaded equirectangular JPEG renders as a navigable panorama at
   all, right way out and right way up.
2. That `bearing` faces the view the author chose, measured against a
   landmark. **The 138° check.**
3. That a draped `inWorld` photograph lands in the **same place** on an
   uploaded stop as on a Mapillary stop at the same coordinates. This is the
   only honest test of §2's "verbatim" claim about `in-world-placement.ts` and
   the ENU frame: put the same overlay on both kinds of stop and compare.
4. Marker raycast hit-testing.
5. That a 360 JPEG straight off a consumer camera **decodes** in the browser,
   and what the downscale produces.
6. `maxTextureSize` on a real phone, and what three's own rescale actually
   does to a 60-Mpx image there.
7. That a published static site with an uploaded-only tour works **with no
   Mapillary token**. Nothing today can show this, and it is the
   `cachedMediaId` payoff (§9 decision 7).
8. That the dispatcher's container handling does not leave a 0×0 canvas on a
   provider switch (§4 item 2).

---

## 8. Effort

Sizes are **S** (hours), **M** (about a day), **L** (more than a day), and are
*estimates, not measurements*. Files are listed because this project's
convention requires it, and because "parallel-safe" here means **no
overlapping file list and no dependency** — shared registry files count as
conflicts even when the tasks look independent.

### T1 — Schema v4: `Panorama` becomes a discriminated union — **M**

`backend/app/models.py`, `backend/app/migration.py`, `backend/app/session.py`
(`skeleton`, `:65-88`, whose placeholder is `provider: "mapillary",
imageId: "0"` at `:84-85`), **`backend/tests/fixtures/fairfax-old-town-v3.json`
(new, frozen *before* the bump)**, `backend/tests/test_migration.py`,
`backend/tests/test_models.py`, `backend/tests/test_bundle.py` (`_minimal_doc`),
`content/scripts/build_tour.py`, `frontend/src/app/core/tour.models.ts`,
`frontend/src/app/editor/test-builders.ts`.

The recipe is `docs/CHANGING-THINGS.md:103-166` and should be followed
literally. The mechanical part really is small — `_MIGRATIONS` is a dict with
two entries (`migration.py:244-247`) and `migrate` chains them (`:250-280`), so
v4 is one function plus one entry — but it is **wide**: `SCHEMA_VERSION`
(`models.py:25`) and `Tour.schema_version: Literal[3]` (`:265`) are two
separate places, and the TypeScript literal (`tour.models.ts:120`) is a third
whose change is what surfaces the frontend compile errors. **Freezing the v3
fixture first is not optional** (`CHANGING-THINGS.md:145-149`). The failing
tests to expect are listed at `:151-166`. Note also
`CHANGING-THINGS.md:161-163`: `tour.models.ts` has **no drift test**, so
nothing fails if the mirror is left behind — that is the one step with no
safety net.

**Blocked on §9 decisions 1 and 2.** Parallel-safe with nothing: it touches
`models.py` and `tour.models.ts`, which nearly everything reads.

### T2 — Pure self-hosted scene geometry — **S**

Two **new** files under `frontend/src/app/panorama/` (a module and its spec).
Bearing→camera quaternion, the sphere's seam and UV convention, marker ENU
placement, yaw/pitch clamp. All pure; tested with Pattern A (§7).
**No dependencies — can start immediately.** Parallel-safe with T3, T4, T5.

### T3 — JPEG metadata reader — **M**

Two **new** files. ~150–200 lines plus a thorough spec, pure bytes (§6.1).
No dependencies. Parallel-safe with T2, T4, T5. **The best first task**: it is
independent, fully provable here, and it tells the author whether the
equirectangular sniff is reliable enough to build on *before* anything
expensive is written.

### T4 — Browser downscale — **S–M**

Two **new** files. Small code; the spec is awkward because jsdom has neither
`createImageBitmap` nor a 2D context (§7), so the drawing step must sit behind
an injected function and the spec can only prove the sizing decision.
No dependencies. Parallel-safe with T2, T3, T5.

### T5 — Split `InWorldRenderer` — **M**

`frontend/src/app/panorama/in-world-renderer.ts`, `in-world-renderer.spec.ts`,
and one **new** file for the extracted host-independent scene. The split line
is §2's list of five. **The existing five tests must keep passing unchanged** —
they already drive the class without `onAdd` (`:6-32`), which is exactly the
seam this formalises, so they are the safety net.
No dependencies. Parallel-safe with T2, T3, T4. **Not** with T6 or T7.

### T6 — The self-hosted `PanoramaViewer` — **L**

One **new** implementation file plus its spec under
`frontend/src/app/panorama/`. Equirectangular sphere, flat plane, camera,
pointer look-around, draw loop, marker meshes, raycast hit-test, `load`
promise, `onPositionChange`, `destroy`. Constrained by §7: **no WebGL in the
constructor.** Depends on T1, T2, T5. Parallel-safe with T3, T4.

### T7 — The dispatcher — **M–L**

`frontend/src/app/panorama/panorama-pane.ts` (the token), a **new** host file,
`frontend/src/app/panorama/fake-viewer.ts` (a label),
`frontend/src/app/panorama/panorama-pane.spec.ts`, `fake-viewer.spec.ts`, and
`frontend/src/app/editor/edit-panorama-pane.ts` (its `attached` flag goes
away). The substance is the replay-on-switch cache (§4 item 3) and the
container handling (§4 item 2). **If a `ResizeObserver` is used, this task also
owns closing out the no-recovery premise across `docs/ARCHITECTURE.md`,
`docs/CHANGING-THINGS.md`, `docs/UNVERIFIED.md` entry 20,
`frontend/src/app/entry/entry-page.css` and deleting
`entry-page.spec.ts:240-250`** — budget for that or avoid the observer.
Depends on T1, T6. **Parallel-safe with nothing in the frontend**: it touches
the file every pane spec provides through.

### T8 — Upload a base image, in the editor — **M**

`frontend/src/app/editor/document-ops.ts` (a new op beside `selectPanorama`),
`document-ops.spec.ts`, `frontend/src/app/editor/inspector-pane.ts` and
`.html`, `inspector-pane.spec.ts`. Reuses `SessionApi.uploadMedia` unchanged.
Network-first-document-second, and the fix-or-`null` question from §5.
Depends on T1, T3, T4. File lists do not overlap T7's, but `document-ops.ts`
and `inspector-pane.ts` are the editor's two busiest files — **run it after
T7 unless the final plan proves them disjoint.**

### T9 — Credit for an uploaded base image — **S–M**

Blocked on §9 decision 1; size depends entirely on the answer. Files range
from `models.py` + `tour.models.ts` + `inspector-pane` (option a) to nothing
at all (option c).

### T10 — Documents — **M**

`docs/UNVERIFIED.md` (eight entries, §7), `docs/ENVIRONMENT.md` (the
two-instances correction from §2, and the `npm ls three` check if T-decision 4
goes direct), `docs/ARCHITECTURE.md` (the `panorama/` table row at `:70` and
the layer rule at `:404-408`), `docs/CHANGING-THINGS.md` (a new entry, or an
amendment to entry 2's "draw it in **both** places" at `:84-90`),
`README.md:21-35`, and a decision record if the author wants Route 2 on the
books. Depends on everything, and **must land in the same branch**: this
repository's answer to documentation going stale is a test that fails
(`docs/CHANGING-THINGS.md:1-29`), and three of the claims above are currently
pinned by tests that will go red.

### Shape of the whole thing

```
parallel-safe, start together:   T2   T3   T4   T5
                                  │    │    │    │
decision 1,2 ──► T1 ──────────────┴────┴────┴────┤
                  │                              │
                  └──► T6 ──► T7 ──► T8 ──► T9 ──┴──► T10
```

**Parallel-safe set: {T2, T3, T4, T5}.** Everything else is sequential, and
T1 is blocked on a conversation rather than on code.

**Honest read on size.** The irreducible work is T6 (a panorama renderer is a
panorama renderer) and T7 (two implementations in one pane). What looks large
and is not is T1 and T5 — the migration registry, the frozen fixtures, the
`ICustomRenderer` seam and the already-pure ENU split are all exactly where
they need to be, which is ADR 0005 and ADR 0001 paying out. The surprises are
the `ResizeObserver` test (§4), the `selectPanorama`-returns-`null` shape
(§5), and the fact that half of §6.2's motivation evaporated on reading
three's source (§3).

---

## 9. Open decisions — the author's, not mine

Ranked by how much else they block. **None of these is settled here.** Each
lists the options and the consequence of each.

### 1. Where does an uploaded base image record who took it? *(blocks T1, T9)*

Every `Overlay` requires a `credit` (`models.py:191`; `Credit` is a
discriminated union at `:160`). **`Panorama` has no credit field at all**
(`:219-234`), because Mapillary attribution is a module constant written into
derived `config.json` (`main.py:90-91`, `_viewer_config` at `:174-179`) and
rendered by `ViewerPage` from `ConfigStore.attribution()`
(`viewer-page.ts:45-46`, `viewer-page.html:10-16`). An author's own 360
photograph has nowhere to go.

- **(a) `credit: Credit` on the uploaded variant, required.** Provenance as
  strong as an overlay's; `creditLine` (`core/credit.ts:9-15`) renders it
  unchanged; `TourDefaults` (`models.py:211-215`) already pre-fills an
  `OriginalCredit` so the author does not retype their name. *Cost:* the
  viewer must show it somewhere it shows nothing today — `stop-panel.ts:53-58`
  renders only the **selected overlay's** credit, so a per-stop credit line is
  new UI.
- **(b) A `Tour.attribution` entry.** No new UI; the footer already renders
  attribution. *Cost:* `Tour.attribution` is **currently unread** — the viewer
  renders the *config's* copy, the committed example's array is identical to
  the `ATTRIBUTION` constant, and no editor op writes it
  (ADR 0005, `:170-186`, "UI customization has nowhere to live"). Choosing
  (b) means first settling which copy is authoritative, which ADR 0005
  explicitly left open.
- **(c) Nothing.** Cheapest, and defensible for a tour whose base imagery the
  author took and whose `TourDefaults` already name them. *Cost:* the one
  asymmetry a reader will notice — a photograph draped **in** the world must
  be credited, the photograph it is draped **onto** need not be — and it is
  the asymmetry a provenance-minded project is least able to defend
  (`README.md:147-158`).

### 2. What identifies an uploaded panorama, and what does `load()` receive? *(blocks T1, T6, T7)*

- **(a) Keep an `imageId`-shaped identity on every variant**, plus a separate
  `MediaRef` field naming the file — the `Anchor` precedent
  (`models.py:44-52`). *Consequence:* `panoramaFixForStop`
  (`document-ops.ts:252-255`), `detectArrival`'s exact-id match
  (`arrival.ts:37-44`), `PanoramaViewer.load(imageId, bearing)` and
  `panorama-pane.spec.ts:84-88` all keep working untouched. *Cost:* two fields
  where one would do, and a reader asking why.
- **(b) The uploaded variant carries only a `MediaRef`**; the dispatcher
  resolves it before calling `load`. *Consequence:* one field, honest shape,
  and `load`'s signature survives. *Cost:* the gate and the arrival check each
  need a second shape — a change to the two functions this project is most
  careful about.
- **(c) Widen `load` to take the whole `Panorama`.** *Consequence:* cleanest
  for the viewer. *Cost:* every implementation, `FakeViewer.load`
  (`fake-viewer.ts:31-37`), and every pane spec asserting on `fake.loaded`.

### 3. Where is north in an uploaded equirectangular image? *(blocks T2, T6)*

`bearing` is a required `[0, 360)` on `Panorama` (`models.py:233`) and today
means a compass direction — which `faceBearing` reaches only by reading
mapillary's own bearing and shifting, because the image's left edge is not
north (`mapillary-viewer.ts:96-118`, `docs/ENVIRONMENT.md:183-189`).

- **(a) Store a per-stop north offset for the image's seam**, prefilled from
  EXIF `GPSImgDirection` where present. *Consequence:* `bearing` keeps one
  meaning everywhere; the destination marker and `bearingToNextStop` stay
  meaningful. *Cost:* a new field, and a value wrong by the magnetic
  declination when the EXIF reference is `'M'` — the 138° class of error, in a
  project that has already been bitten by it twice.
- **(b) `bearing` means "yaw from the image's own left edge" for uploaded
  stops.** *Consequence:* no new field, nothing to get wrong. *Cost:* the
  field's meaning now depends on the variant; the destination marker's
  position in the uploaded stop's world is unknowable; `bearingToNextStop`
  becomes a number with no referent.
- **(c) Require the author to set it by dragging in the panorama while
  watching the map** — the same discipline the heading gate already enforces
  for overlays. *Consequence:* the only option consistent with
  `docs/ENVIRONMENT.md:196-202`. *Cost:* new UI, and one more thing per stop.

### 4. Does `three` become a direct dependency? *(blocks nothing; decide early anyway)*

Evidence in §3. **(a) Direct, exact `0.134.0`**, and amend
`docs/ENVIRONMENT.md:129-146` to say the rule is version identity, updating
its `npm ls three` check to accept one entry with two parents.
**(b) Stay transitive**, relying on the lockfile
(`package-lock.json:7506-7511`) and npm's caret-on-`0.x` rule. *Consequence of
(b):* the existing check keeps passing and nothing in `package.json` records
that our own code needs three — so removing mapillary-js removes it silently,
and the self-hosted viewer stops resolving with no warning. The ENVIRONMENT.md
correction from §2 is needed either way.

### 5. Is a flat (non-360) base image in scope at all? *(blocks T6, and the feature's value)*

A flat photograph has no world to put a marker or a draped plane in (§1).

- **(a) Allow it, and drop markers and `inWorld` overlays for such stops.**
  *Cost:* needs a **new mechanism** — `DISPLAY_MODES_BY_KIND`
  (`models.py:169-173`) is keyed by overlay `kind`, not by the stop's provider,
  so "no markers on flat stops" cannot be expressed as a table cell. ADR 0001
  says a renderer limitation belongs in that table; this one does not fit it.
- **(b) Allow it with markers in 2D image coordinates.** This is the
  `ImageAnchor` variant ADR 0005 already anticipates (`models.py:44-52`), and
  it is a **much larger feature** than this one.
- **(c) 360 only for now, with a clear refusal for a flat upload.**
  *Consequence:* the feature ships sooner, and the thing an author most wants
  for a stop with no coverage — "here is a photograph I took of this
  building" — is still unserved. Note that an ordinary photograph *can*
  already be an `inWorld` overlay; what it cannot be is the base view.

### 6. Does an uploaded base image keep the author's original? *(blocks T4, T8)*

- **(a) Store both** a display-sized derivative and the original, as two
  `MediaRef` fields, both counted by `referenced_media`
  (`models.py:315-333` — the one place such a field belongs). *Cost:* `media/`
  roughly doubles for base imagery, and an export of a six-stop 360 tour
  becomes large on a shared host.
- **(b) Store only the downscaled file.** *Cost:* the tour can never be
  re-derived at higher quality, and the author's only full-resolution copy
  lives outside the portable document that ADR 0002 is built around.

### 7. Does `cachedMediaId` become the self-hosted viewer's input for *Mapillary* stops too? *(blocks nothing; changes everything)*

`cachedMediaId` is written only by `content/scripts/build_tour.py:190` and
read by **nothing** in `frontend/src`. A self-hosted renderer gives it a
purpose: a published site could render a cached Mapillary panorama with no
token and no network.

- **(a) Yes.** *Consequence:* the single largest win available here — a
  published tour that works offline and needs no `mapillaryToken` in
  `config.json`. *Costs, two:* `provider` and *renderer* come apart, so the
  dispatcher must key on something other than `provider`, which reopens
  decision 2; and the bytes are now **served from the author's own origin**,
  which is redistribution of CC-BY-SA 4.0 imagery rather than embedding a
  viewer. Attribution is already present (`main.py:90-91`), but whether the
  share-alike and attribution terms are satisfied by that line when the
  project is hosting the pixels is a question for the author, not for me, and
  I am not qualified to answer it.
- **(b) No.** `cachedMediaId` stays a content-pipeline artefact and the
  feature stays small. *Cost:* the field remains dead weight that
  `docs/decisions/0005` already had to explain once.
