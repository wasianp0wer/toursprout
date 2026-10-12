# Schema v2: content, place and presentation as independent axes

Sub-project 1 of 4 in the prototype-to-application effort. See
`docs/superpowers/specs/2026-10-12-authoring-application-overview.md` for how
the four fit together.

## Why

In v1, what an overlay *is* determines how it is *drawn*. `kind: "rephoto"`
forces a `geoQuad` anchor and renders as a plane standing in the world; every
other kind forces a `geo` anchor and renders as a clickable marker. The
validator enforces exactly that coupling:

```python
if self.kind == "rephoto" and self.anchor.type != "geoQuad":
    raise ValueError("rephoto overlays require a geoQuad anchor")
if self.kind != "rephoto" and self.anchor.type != "geo":
    raise ValueError(f"{self.kind} overlays require a geo anchor")
```

The editor must let an author hang a photograph in the scene **or** pin it to
the street, as a per-item choice, without changing what the item is. That is
impossible while presentation is welded to content type.

Expanding the `kind` list instead (`rephoto`, `worldText`, `audioPin`, …)
multiplies combinatorially, and multiplies again when AR arrives. Splitting the
axes is the change that makes AR a new *display mode* rather than a parallel
content hierarchy.

Two further v1 problems block the editor and are fixed here, because all three
require the same migration:

- **`Credit` is unsatisfiable for original work.** `source`, `url` and
  `license` are all required and non-blank. Recording your own narration has no
  URL. The editor could not save a valid document.
- **Narration is a per-stop monologue.** The courthouse clip is ~660 kB and
  about a minute. Splitting it needs overlay-level audio, which v1 has in
  principle (`kind: "audio"`) but which carries no notion of playing on
  arrival.

## What changes

### The three axes

| Axis | Field | Answers | Members in v2 |
| --- | --- | --- | --- |
| Content | `kind` | what is it | `text`, `image`, `audio` |
| Place | `anchor` | where is it | `geo` |
| Presentation | `display` | how is it drawn | `marker`, `inWorld`, `ambient` |

`rephoto` ceases to be a kind. A rephotograph is `kind: "image"` with
`display.mode: "inWorld"` — which is what it always was.

`anchor` keeps its discriminated union with a single member. The second variant
is already anticipated in v1's docstring: an image anchor pinning an overlay to
pixel coordinates within one panorama, for content that has no world position.
Keeping the union costs one line and keeps that addition additive.

### Geometry moves from anchor to display

v1's `geoQuad` carried `headingDeg`, `widthM` and `heightM` alongside position.
Those describe how a plane is *drawn*, not where it *is*: a marker at the same
spot needs none of them. They move to `display`, and `geoQuad` disappears.

Anchors therefore collapse to one shape, and switching an overlay between
`marker` and `inWorld` no longer changes its location.

### Models

```python
class GeoAnchor(Strict):
    type: Literal["geo"] = "geo"
    lng: float          # -180..180
    lat: float          # -90..90
    altitude_m: float = 0.0   # alias altitudeM; metres ABOVE LOCAL GROUND

# One member today, so this is a plain alias: pydantic's `discriminator`
# requires an actual union and errors on a single type. It becomes
# `Annotated[GeoAnchor | ImageAnchor, Field(discriminator="type")]` when the
# second variant lands. `type` is already present and literal, so that change
# is additive and no document has to be rewritten.
Anchor = GeoAnchor


class MarkerDisplay(Strict):
    mode: Literal["marker"] = "marker"
    icon: Literal["note", "photo", "audio", "place"] = "note"

class InWorldDisplay(Strict):
    mode: Literal["inWorld"] = "inWorld"
    opacity: float = 0.7        # 0..1, the value the stop OPENS at
    heading_deg: float          # alias headingDeg; 0..360, face direction
    width_m: float              # alias widthM; >0, <=200
    height_m: float             # alias heightM; >0, <=200

class AmbientDisplay(Strict):
    mode: Literal["ambient"] = "ambient"
    autoplay: bool = True

Display = Annotated[
    MarkerDisplay | InWorldDisplay | AmbientDisplay,
    Field(discriminator="mode"),
]


class OriginalCredit(Strict):
    type: Literal["original"] = "original"
    creator: str                # min_length 1, non-whitespace
    license: str                # min_length 1, non-whitespace

class SourcedCredit(Strict):
    type: Literal["sourced"] = "sourced"
    source: str                 # min_length 1, non-whitespace
    url: str                    # min_length 1, non-whitespace
    license: str                # min_length 1, non-whitespace
    creator: str | None = None

Credit = Annotated[OriginalCredit | SourcedCredit, Field(discriminator="type")]


class Overlay(Strict):
    id: str
    kind: Literal["text", "image", "audio"]
    anchor: Anchor
    display: Display
    title: str
    body: str | None = None
    media_id: str | None = None   # alias mediaId
    credit: Credit


class TourDefaults(Strict):
    """Pre-fills OriginalCredit when the author adds their own work."""
    creator: str
    license: str


class Tour(Strict):
    id: str
    schema_version: Literal[2]    # alias schemaVersion
    title: str
    description: str
    defaults: TourDefaults | None = None
    attribution: list[Attribution] = []
    stops: list[Stop]             # min_length 1
```

`Stop`, `Panorama`, `LngLat` and `Attribution` are unchanged.

### Which combinations are legal

Validation moves out of hand-written `if` chains and into one table the
validator reads, so adding AR later means adding a row, not editing logic.

| `kind` | `marker` | `inWorld` | `ambient` |
| --- | --- | --- | --- |
| `text` | yes | no | no |
| `image` | yes | yes | no |
| `audio` | yes | no | yes |

Rejected combinations are renderer limitations, not model limitations, and the
error message must say so. Payload rules carry over from v1: `text` requires a
non-blank `body`; `image` and `audio` require a `mediaId`.

### `altitude` becomes `altitudeM`, and its datum is pinned

v1's `altitude` is ambiguous and has already caused one bug: passed raw to
`geodeticToEnu`, which wants an absolute ellipsoidal height, it put the Fairfax
photographs 128 m underground. `geodeticAltitude()` exists only to add the local
ground reference back.

The document means **metres above local ground**. The rename makes the unit
explicit and matches the existing `widthM` / `heightM` convention. The datum is
also what AR needs — a phone knows its height above the pavement, not above the
ellipsoid — so pinning it now avoids relitigating it later.

`geodeticAltitude()` keeps its job and its name.

## Migration

`migrate_v1_to_v2(doc: dict) -> dict`, pure, dict in and dict out, with the v1
document never mutated. Run once over `content/tours/fairfax-old-town.json`; it
stays in the tree afterwards because exported bundles in the wild will be v1.

| v1 | v2 |
| --- | --- |
| `schemaVersion: 1` | `schemaVersion: 2` |
| `kind: "rephoto"`, `anchor.type: "geoQuad"` | `kind: "image"`, `anchor.type: "geo"`, `display: {mode: "inWorld", headingDeg, widthM, heightM, opacity}` |
| `kind: text\|image\|audio`, `anchor.type: "geo"` | unchanged kind, `display: {mode: "marker", icon}` |
| `anchor.altitude` | `anchor.altitudeM`, same value |
| `credit` (all four fields) | `{type: "sourced", …}` |
| no `defaults` | absent; nothing is invented |

Two details that keep the migration behaviour-preserving rather than merely
valid:

- **Opacity.** v1 opened a stop with the first rephoto at 0.7 and the rest at 0,
  hardcoded in `TourStore.resetRephotoOpacities()`. The migration writes those
  same numbers into `display.opacity` per overlay in document order, so the tour
  opens exactly as it does today — and the value is now authored rather than
  hardcoded.
- **Audio migrates to `marker`, not `ambient`.** Nothing autoplays in v1:
  `StopPanel` renders `<audio controls preload="none">` only once the visitor
  selects the overlay. Migrating to `ambient` would start six narrations playing
  by themselves. `ambient` is a capability the editor can set on new work.

`icon` is chosen from `kind`: `text` to `note`, `image` to `photo`, `audio` to
`audio`.

Reading a v1 document anywhere in the app routes through the migration first, so
only v2 exists above the parsing boundary.

## Frontend changes

Mechanical, and all behaviour-preserving. `rephoto` appears in 20 frontend
files (and in 5 more across the backend and content scripts).

- `tour.models.ts` mirrors the new pydantic models, including the two
  discriminated unions.
- `TourStore.rephotos()` becomes `inWorldOverlays()`, filtering
  `display.mode === 'inWorld'` instead of `kind === 'rephoto'`.
  `resetRephotoOpacities()` reads `display.opacity` instead of the 0.7/0 rule.
- `PanoramaPane` partitions by `display.mode`: `marker` to `setMarkers()`,
  `inWorld` to the three.js renderer, `ambient` drawn nowhere.
- `RephotoPlacement` takes geometry from `display` rather than `anchor`.
- `StopPanel` reads the credit union — `sourced` shows source and link,
  `original` shows creator. Both show the licence.
- Modules renamed to match the vocabulary: `rephoto-placement` to
  `in-world-placement`, `rephoto-renderer` to `in-world-renderer`. Leaving
  `rephoto` in the names would make the code lie once `inWorld` is a general
  presentation mode. The *domain* word rephotography is still right in prose and
  in `fetch_rephotos.py`, which genuinely fetches historical photographs.

`?align=1` alignment mode keeps working against `display` geometry, and keeps
emitting pasteable JSON — in v2 shape.

## Out of scope

Deliberately not in this sub-project: any write path, bundles, the editor,
`ambient` playback behaviour in the viewer (the mode validates and round-trips;
nothing autoplays yet), AR, themes, Omeka. No visible behaviour changes.

`content/source/stops.json` and `build_tour.py` are updated only enough to emit
v2. They retire in sub-project 3.

## Testing

TDD: failing test first, watch it fail, then implement.

**Backend.** The 119 existing tests stay green except where they assert v1
shapes, which are rewritten to v2 rather than deleted. New coverage:

- every legal `kind` x `display.mode` pair validates; every illegal one is
  rejected with a message naming both
- both credit variants validate; a blank or whitespace field in either is
  rejected; an unknown `type` is rejected
- `geoQuad` and `kind: "rephoto"` are now rejected outright
- migration: the real `fairfax-old-town.json` v1 document migrates, validates as
  v2, and preserves every id, title, body, mediaId, licence and coordinate
- migration is pure — the input dict is untouched
- migration is idempotent on a v2 document
- the two courthouse photographs land at `opacity` 0.7 and 0 in document order
- all six audio overlays land on `marker`, none on `ambient`

**Frontend.** The 196 existing tests stay green on the same terms. The
integration suite in `real-tour.spec.ts` loads the real migrated tour and is the
main guard that nothing regressed. New coverage: store partitioning by display
mode, opacity seeded from the document, both credit variants rendering.

**Acceptance.** `make check` green, and the production build still produces a
single bundle around 2.04 MB raw / 348 kB transferred. A size jump means
something pulled in a dependency it should not have.

## Risks

- **A wide, mechanical rename across 21 frontend files.** Mitigated by the
  existing suites: a mechanical error fails a test rather than shipping.
- **No browser can launch in this sandbox**, so the rendered result is
  unverifiable here. The jsdom integration suite carries the weight, exactly as
  it does today. Visual confirmation needs the user outside the sandbox.
- **The migration runs once on real content.** The v1 file is in git, and the
  migration is tested against it rather than against a fixture, so a lossy
  migration fails the suite instead of quietly dropping an overlay.
