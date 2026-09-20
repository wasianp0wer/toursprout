# Walkable tour and rephotography — design

**Date:** 2026-09-20
**Status:** approved, implementing
**Builds on:** `2026-09-20-walking-tour-framework-design.md`

Two features for the Fairfax prototype: the tour becomes something you walk
rather than click through, and historical photographs stand in the world where
their subjects are, fading against the present.

## 1. Verified premises

Established against the installed library and live archives before design, not
assumed.

- `DirectionConfiguration` exposes **`highlightId`**: mapillary-js will
  highlight a specific ground arrow given a target image id. No custom
  rendering needed for wayfinding.
- `viewer.on('spatialedges')` yields `NavigationEdge[]`, each carrying
  `target` and **`worldMotionAzimuth`** — documented as "the counter clockwise
  horizontal rotation angle from the X-axis", i.e. radians in an ENU frame
  where 0 is east.
- Tags (`OutlineTag`, `SpotTag`, `ExtremePointTag`) carry only fill colours,
  sprite icons and text. **They cannot render an image**, so a draped
  photograph requires `viewer.addCustomRenderer()`.
- `ICustomRenderer` receives the view and projection matrices; `geodeticToEnu`
  converts lng/lat/alt into the viewer's local frame.
- **`three@0.134.0` is already hoisted** at the top level as a mapillary-js
  dependency. Rephotography adds no new package and no duplicate three.js.
- The Library of Congress holds genuine Fairfax Court House photographs from
  **1861, 1863 and 1918**. The 1863 image shows Union cavalry before the same
  brick building and cupola visible in the modern panorama.
- The other five stops have essentially no Old Town Fairfax imagery. Targeted
  searches return Alexandria, Chantilly, Lorton and Reston.

## 2. Scope

Rephotography is **demonstrated at the courthouse**, which can layer 1863,
1918 and today. The remaining stops keep their text and audio overlays. The
mechanism is general; the content is where the archive is.

## 3. Walkable tour

`TourStore` currently conflates the tour's narrative position with the
viewer's location. Walking separates them.

| Concept | Meaning |
| --- | --- |
| `currentIndex` | which stop the tour is *on* — narrative position |
| `viewerPosition` | where the panorama viewer *is* — updated as you walk |

- `updateViewerPosition(lngLat)` feeds viewer movement into the store. The
  store decides whether that constitutes an arrival.
- **Arrival** occurs within **30 m** of a stop, and advances `currentIndex` to
  that stop. It is latched per stop: re-entering the radius without leaving
  does not re-fire.
- `goTo(index)` remains the Next/Previous skip and is unaffected.
- Walking **backwards** works identically — approach the previous stop and the
  tour follows.
- Arrival does **not** autoplay narration. Browsers block unprompted audio, and
  sound starting by itself in a museum context is intrusive.

The arrival decision is a pure function over (position, stops, current index,
latched set), so every transition is testable without a viewer.

## 4. Wayfinding

Two cues, because either alone fails.

**The highlighted arrow.** On each `spatialedges` event the adapter maps
mapillary's edges into plain records and calls a pure
`pickEdgeToward(edges, targetBearingDeg)`. That function converts the target
compass bearing into the ENU convention, filters to edges rendered as ground
arrows, and returns the target id with the smallest angular difference — or
`null` when nothing is within a sensible tolerance. The adapter then calls
`directionComponent.configure({ highlightId })`.

**The destination marker.** The next stop is rendered as a visually distinct
marker while walking. The arrow only helps when you are already facing roughly
the right way; the marker tells you which way to turn when you are not.

Keeping edge selection as a pure function over plain records means mapillary's
types stay contained in the adapter, consistent with the existing
`PanoramaViewer` seam.

## 5. Rephotography

### Schema

A new overlay kind and a second anchor variant. `image` continues to mean
"photograph shown in the side panel"; `rephoto` means "photograph standing in
the world".

```jsonc
Overlay {
  kind: "text" | "image" | "audio" | "rephoto",
  anchor: GeoAnchor | GeoQuadAnchor,     // discriminated on `type`
  ...
}

GeoQuadAnchor {
  type: "geoQuad",
  lng, lat, altitude,      // centre of the plane
  headingDeg,              // compass direction the photo faces
  widthM, heightM          // physical size
}
```

Validation is tightened rather than loosened: `rephoto` requires a
`geoQuad` anchor and a `mediaId`; `text`, `image` and `audio` require a `geo`
anchor. A `geoQuad` on a text overlay is a validation failure. This is the
second member of the tagged union the original schema was built to accept, so
adding it is additive, not a break.

### Rendering

`RephotoRenderer implements ICustomRenderer`. On `onAdd` it builds a three.js
scene; each rephoto becomes a `PlaneGeometry` with the photograph as a texture,
positioned by `geodeticToEnu` against the viewer's reference and rotated by
`headingDeg`. `onReference` recomputes positions when the viewer rebases.
`render` draws with the supplied view and projection matrices.

Placement maths — heading and size to plane transform — is a pure function
tested independently of WebGL.

### Controls

Opacity is a single slider in the stop panel, from the historical photograph
to the present view. The intermediate positions are where rephotography
actually works: you watch a roofline align.

### The viewer seam

mapillary-js and three.js stay behind `PanoramaViewer`, which gains:

```ts
setRephotos(rephotos: RephotoPlacement[]): void;
setRephotoOpacity(opacity: number): void;
setDestinationBearing(bearingDeg: number | null): void;
onPositionChange(handler: (lngLat: LngLat, imageId: string) => void): void;
```

`FakeViewer` records all four, so component behaviour is tested without WebGL —
which matters more than usual here, since no browser can run in this sandbox.

## 6. Alignment mode

`?align=1` enables nudging the selected rephoto: arrow keys adjust aim and
distance, `+`/`-` adjust size, `[`/`]` adjust heading. A readout shows the live
anchor values and a button copies the JSON.

This is a content-authoring affordance, not the editor interface excluded from
the prototype. It exists because the render cannot be seen from here: without
it, every alignment is a blind edit-and-reload cycle.

## 7. A provenance bug to fix first

`fetch_loc_image` takes the **first** search result carrying an image, with no
relevance check. It worked for the courthouse by luck. For any other query it
would have attached an Alexandria or Chantilly photograph to a Fairfax stop
with a confident Library of Congress credit — precisely the silent provenance
error this project must not make.

The fix: require the item's title to match the stop's subject terms, reject
items whose titles name a different place, and record the matched LoC title in
the credit block so a wrong match is visible in the interface rather than
hidden in a manifest.

## 8. Testing

- **Pure functions** — bearing between coordinates, `pickEdgeToward`, arrival
  detection and latching, geoQuad placement maths.
- **Store** — arrive versus skip, latch behaviour, walking backwards, viewer
  position updates that are not arrivals.
- **Viewer seam** — `FakeViewer` assertions for rephotos, opacity, destination
  bearing and position callbacks.
- **Schema** — `rephoto` requires `geoQuad` and `mediaId`; `geoQuad` on a text
  overlay is rejected; existing overlays still validate.
- **Integration** — the real committed tour's rephoto anchors sit within a
  short walk of their stop, and every rephoto carries a credit.

## 9. Risks

| Risk | Mitigation |
| --- | --- |
| Alignment cannot be verified from here | alignment mode; values committed to content, not code |
| Auto-advance fires while merely passing by | 30 m radius, latched per stop, tested at the boundary |
| No arrow points toward the next stop | `pickEdgeToward` returns null; destination marker still guides |
| three.js version coupled to mapillary-js | pinned to the hoisted 0.134.0; contained behind the seam |
| Rephoto texture fails to load | renders nothing and logs; the tour continues |

## 10. Out of scope

Wipe and hard-toggle comparison modes, rephotos at stops without genuine
archival imagery, image-anchored overlays, narration autoplay, and any
persistent authoring UI beyond the alignment readout.
