# Walkable Tour and Rephotography Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn the Fairfax tour into something you walk — following highlighted ground arrows between stops — and stand historical photographs in the world where their subjects are, fading against the present view.

**Architecture:** `TourStore` gains a viewer position distinct from the narrative position, and decides arrivals by proximity. Wayfinding uses mapillary-js's built-in `highlightId`, fed by a pure edge-picking function. Rephotos render as three.js textured planes through `viewer.addCustomRenderer()`, placed by `geodeticToEnu`. All library types stay behind the existing `PanoramaViewer` seam.

**Tech Stack:** Angular 22 (zoneless, signals), mapillary-js 4.1.2, three 0.134.0 (already hoisted), MapLibre GL 6, FastAPI, pydantic v2, pytest, Vitest

**Spec:** `docs/superpowers/specs/2026-09-20-walkable-tour-and-rephotography-design.md`

## Global Constraints

Carried from the previous plan and `docs/ENVIRONMENT.md`. All still apply.

- **Never use `urllib.request`** — it truncates through the egress proxy. `httpx` only.
- **Always `export UV_CACHE_DIR="$PWD/.uv-cache"`** before any uv command. The Makefile does this.
- **Node must be Node 24** at `/Users/maddiepersonal/.local/share/fnm/node-versions/v24.21.0/installation/bin`. The Makefile pins it.
- **Angular's build cache stays disabled** (`cli.cache.enabled: false`) or `ng build` SIGABRTs with no output.
- **No browser can launch in this sandbox.** Playwright specs may be written but not run here; jsdom integration tests carry the verification weight.
- **`three` must resolve to the hoisted 0.134.0** that mapillary-js depends on. Do not install a second copy — two three.js instances in one WebGL context fail in confusing ways.
- **Every overlay requires a populated `credit`.** A missing credit is a validation failure.
- Angular 22: standalone components, signals, zoneless. Python line length 100.
- Run `make check` after each task. Commit after each task.

## File Structure

```
backend/
  app/models.py                    MODIFY  GeoQuadAnchor, rephoto kind, tightened validation
  tests/test_models.py             MODIFY  rephoto + anchor union cases
content/
  scripts/fetch_media.py           MODIFY  relevance filtering (provenance fix)
  scripts/fetch_rephotos.py        NEW     historical photographs with matched-title credits
  scripts/build_tour.py            MODIFY  emit rephoto overlays
  source/stops.json                MODIFY  rephotos block on the courthouse
  tests/                           (backend/tests owns these)
backend/tests/test_relevance.py    NEW     title-relevance scoring
frontend/src/app/core/
  tour.models.ts                   MODIFY  mirror the schema additions
  geo.ts                           NEW     bearingBetween, distanceBetween — pure
  geo.spec.ts                      NEW
  arrival.ts                       NEW     detectArrival — pure
  arrival.spec.ts                  NEW
  tour-store.ts                    MODIFY  viewerPosition, updateViewerPosition, arriveAt
  tour-store.spec.ts               MODIFY
frontend/src/app/panorama/
  edge-picker.ts                   NEW     pickEdgeToward — pure, plain types
  edge-picker.spec.ts              NEW
  rephoto-placement.ts             NEW     planeTransform — pure
  rephoto-placement.spec.ts        NEW
  panorama-viewer.ts               MODIFY  four new interface methods
  fake-viewer.ts                   MODIFY  record them
  rephoto-renderer.ts              NEW     ICustomRenderer, three.js
  mapillary-viewer.ts              MODIFY  wire edges, position, renderer
  panorama-pane.ts                 MODIFY  drive the new seam methods
  panorama-pane.spec.ts            MODIFY
frontend/src/app/stop/
  stop-panel.ts                    MODIFY  opacity slider
  stop-panel.spec.ts               MODIFY
frontend/src/app/align/
  align-mode.ts                    NEW     ?align=1 nudging + JSON readout
  align-mode.spec.ts               NEW
frontend/src/app/integration/
  real-tour.spec.ts                MODIFY  rephoto assertions
```

---

### Task 1: Schema — rephoto kind and geoQuad anchor

**Files:**
- Modify: `backend/app/models.py`
- Modify: `backend/tests/test_models.py`

**Interfaces:**
- Produces: `GeoQuadAnchor` pydantic model with fields `type: Literal["geoQuad"]`, `lng`, `lat`, `altitude`, `heading_deg` (alias `headingDeg`), `width_m` (alias `widthM`), `height_m` (alias `heightM`). `Anchor` becomes `Annotated[GeoAnchor | GeoQuadAnchor, Field(discriminator="type")]`. `Overlay.kind` gains `"rephoto"`.

Validation gets *stricter*, not looser: `rephoto` requires a `geoQuad` anchor and a `mediaId`; `text`/`image`/`audio` require a `geo` anchor.

- [ ] **Step 1: Write the failing tests**

Append to `backend/tests/test_models.py`:

```python
GEO_QUAD = {
    "type": "geoQuad",
    "lng": -77.30732, "lat": 38.84562, "altitude": 6.0,
    "headingDeg": 200.0, "widthM": 18.0, "heightM": 14.0,
}


def _rephoto(**over):
    base = {
        "id": "court-1863",
        "kind": "rephoto",
        "anchor": dict(GEO_QUAD),
        "title": "Fairfax Court House, 1863",
        "mediaId": "court-1863.jpg",
        "credit": VALID_CREDIT,
    }
    base.update(over)
    return base


def test_rephoto_overlay_parses():
    ov = Overlay.model_validate(_rephoto())
    assert ov.kind == "rephoto"
    assert ov.anchor.type == "geoQuad"
    assert ov.anchor.heading_deg == 200.0
    assert ov.anchor.width_m == 18.0


def test_rephoto_requires_a_geo_quad_anchor():
    """A rephoto is a plane in the world; a bare point cannot place one."""
    with pytest.raises(ValidationError):
        Overlay.model_validate(_rephoto(
            anchor={"type": "geo", "lng": -77.3, "lat": 38.8, "altitude": 3.0}))


def test_rephoto_requires_a_media_id():
    with pytest.raises(ValidationError):
        Overlay.model_validate(_rephoto(mediaId=None))


def test_text_overlay_rejects_a_geo_quad_anchor():
    """geoQuad is meaningless for a marker; accepting it would hide a mistake."""
    with pytest.raises(ValidationError):
        Overlay.model_validate(_overlay(anchor=dict(GEO_QUAD)))


def test_geo_quad_heading_must_be_a_compass_bearing():
    with pytest.raises(ValidationError):
        Overlay.model_validate(_rephoto(anchor={**GEO_QUAD, "headingDeg": 360.0}))
    with pytest.raises(ValidationError):
        Overlay.model_validate(_rephoto(anchor={**GEO_QUAD, "headingDeg": -1.0}))


def test_geo_quad_dimensions_must_be_positive():
    for field in ("widthM", "heightM"):
        with pytest.raises(ValidationError):
            Overlay.model_validate(_rephoto(anchor={**GEO_QUAD, field: 0.0}))


def test_geo_quad_dimensions_have_a_sane_upper_bound():
    """A 500 m photograph is a typo, not a design choice."""
    with pytest.raises(ValidationError):
        Overlay.model_validate(_rephoto(anchor={**GEO_QUAD, "widthM": 500.0}))


def test_anchor_union_discriminates_on_type():
    point = Overlay.model_validate(_overlay())
    quad = Overlay.model_validate(_rephoto())
    assert point.anchor.type == "geo"
    assert quad.anchor.type == "geoQuad"


def test_tour_with_a_rephoto_stop_validates():
    stop = _stop(overlays=[_overlay(), _rephoto()])
    tour = Tour.model_validate(_tour(stops=[stop]))
    assert [o.kind for o in tour.stops[0].overlays] == ["text", "rephoto"]


def test_rephoto_round_trips_through_camel_case_json():
    tour = Tour.model_validate(_tour(stops=[_stop(overlays=[_rephoto()])]))
    dumped = json.loads(tour.model_dump_json(by_alias=True))
    anchor = dumped["stops"][0]["overlays"][0]["anchor"]
    assert anchor["headingDeg"] == 200.0
    assert anchor["widthM"] == 18.0
```

Add `import json` to the top of the file if it is not already imported.

- [ ] **Step 2: Run and verify failure**

```bash
cd backend && uv run pytest tests/test_models.py -q
```

Expected: `ImportError` or failures on unknown kind `rephoto`.

- [ ] **Step 3: Implement**

In `backend/app/models.py`, add after `GeoAnchor`:

```python
class GeoQuadAnchor(Strict):
    """A photograph standing in the world as a flat plane.

    Used by rephoto overlays, where the historical image is draped over the
    scene it depicts rather than pinned to a point. `headingDeg` is the compass
    direction the face of the photograph looks toward.
    """

    type: Literal["geoQuad"] = "geoQuad"
    lng: Annotated[float, Field(ge=-180.0, le=180.0)]
    lat: Annotated[float, Field(ge=-90.0, le=90.0)]
    altitude: float = 0.0
    heading_deg: Annotated[float, Field(ge=0.0, lt=360.0)] = Field(alias="headingDeg")
    width_m: Annotated[float, Field(gt=0.0, le=200.0)] = Field(alias="widthM")
    height_m: Annotated[float, Field(gt=0.0, le=200.0)] = Field(alias="heightM")
```

Replace the `Anchor` alias:

```python
Anchor = Annotated[GeoAnchor | GeoQuadAnchor, Field(discriminator="type")]
```

In `Overlay`, widen `kind` and tighten the validator:

```python
    kind: Literal["text", "image", "audio", "rephoto"]
```

```python
    @model_validator(mode="after")
    def _payload_matches_kind(self) -> Overlay:
        if self.kind == "text" and not (self.body or "").strip():
            raise ValueError("text overlays require a body")
        if self.kind in ("image", "audio", "rephoto") and not self.media_id:
            raise ValueError(f"{self.kind} overlays require a mediaId")
        if self.kind == "rephoto" and self.anchor.type != "geoQuad":
            raise ValueError("rephoto overlays require a geoQuad anchor")
        if self.kind != "rephoto" and self.anchor.type != "geo":
            raise ValueError(f"{self.kind} overlays require a geo anchor")
        return self
```

- [ ] **Step 4: Run and verify pass** — `uv run pytest tests/test_models.py -q`, expect 26 passed.

- [ ] **Step 5: Full suite and commit**

```bash
make check
git add -A && git commit -m "Add rephoto overlay kind and geoQuad anchor variant"
```

---

### Task 2: Library of Congress relevance filtering

The existing `fetch_loc_image` takes the first result carrying an image, with no relevance check. It worked for the courthouse by luck; for any other query it would attach an Alexandria photograph to a Fairfax stop under a confident Library of Congress credit.

**Files:**
- Create: `content/scripts/relevance.py`
- Create: `backend/tests/test_relevance.py`
- Modify: `content/scripts/fetch_media.py`

**Interfaces:**
- Produces: `score_title(title: str, required: list[str], excluded: list[str]) -> float` returning 0.0 for a rejected title and a positive score otherwise; `best_match(items: list[dict], required, excluded) -> dict | None`.

- [ ] **Step 1: Write the failing tests**

`backend/tests/test_relevance.py`:

```python
from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "content" / "scripts"))

from relevance import best_match, score_title  # noqa: E402

REQUIRED = ["fairfax", "court"]
EXCLUDED = ["alexandria", "chantilly", "lorton", "reston"]


def test_matching_title_scores_above_zero():
    assert score_title("Fairfax Court House, Va.", REQUIRED, EXCLUDED) > 0


def test_title_missing_a_required_term_is_rejected():
    assert score_title("Old Town Hall, Virginia", REQUIRED, EXCLUDED) == 0.0


def test_title_naming_an_excluded_place_is_rejected():
    """This is the actual bug: an Alexandria photo labelled as Fairfax."""
    assert score_title(
        "Alexandria Market House & City Hall, Fairfax Street", REQUIRED, EXCLUDED
    ) == 0.0


def test_matching_is_case_insensitive():
    assert score_title("FAIRFAX COURT HOUSE", REQUIRED, EXCLUDED) > 0


def test_empty_title_is_rejected():
    assert score_title("", REQUIRED, EXCLUDED) == 0.0


def test_more_required_terms_scores_higher():
    both = score_title("Fairfax Court House", REQUIRED, EXCLUDED)
    one = score_title("Fairfax Court", ["fairfax", "court", "house"], EXCLUDED)
    assert both > 0 and one > 0


def test_best_match_picks_the_highest_scoring_item():
    items = [
        {"title": "Virginia countryside", "image_url": ["a.jpg"]},
        {"title": "Fairfax Court House, Va.", "image_url": ["b.jpg"]},
    ]
    assert best_match(items, REQUIRED, EXCLUDED)["title"] == "Fairfax Court House, Va."


def test_best_match_skips_items_without_an_image():
    items = [{"title": "Fairfax Court House", "image_url": []}]
    assert best_match(items, REQUIRED, EXCLUDED) is None


def test_best_match_returns_none_when_nothing_is_relevant():
    items = [{"title": "Alexandria City Hall", "image_url": ["a.jpg"]}]
    assert best_match(items, REQUIRED, EXCLUDED) is None


def test_best_match_handles_list_valued_titles():
    """The LoC API sometimes returns a list where a string is expected."""
    items = [{"title": ["Fairfax Court House"], "image_url": ["a.jpg"]}]
    assert best_match(items, REQUIRED, EXCLUDED) is not None
```

- [ ] **Step 2: Run and verify failure** — `ModuleNotFoundError: No module named 'relevance'`.

- [ ] **Step 3: Implement `content/scripts/relevance.py`**

```python
"""Relevance scoring for archive search results.

Archive search is fuzzy: a query for the Fairfax courthouse cheerfully returns
Alexandria, Chantilly and Reston. Attaching one of those to a Fairfax stop
under a Library of Congress credit is a provenance error, so a result must earn
its place by naming its subject.
"""

from __future__ import annotations


def _as_text(value: object) -> str:
    if isinstance(value, list):
        return " ".join(str(v) for v in value)
    return str(value or "")


def score_title(title: str | list, required: list[str], excluded: list[str]) -> float:
    """Return 0.0 if the title is rejected, otherwise a positive score."""
    text = _as_text(title).lower()
    if not text.strip():
        return 0.0
    if any(term.lower() in text for term in excluded):
        return 0.0
    hits = sum(1 for term in required if term.lower() in text)
    if hits != len(required):
        return 0.0
    # Shorter titles that still match every term are more specific.
    return hits + 1.0 / (1.0 + len(text))


def best_match(items: list[dict], required: list[str], excluded: list[str]) -> dict | None:
    best, best_score = None, 0.0
    for item in items:
        if not item.get("image_url"):
            continue
        score = score_title(item.get("title", ""), required, excluded)
        if score > best_score:
            best, best_score = item, score
    return best
```

- [ ] **Step 4: Run and verify pass** — 10 passed.

- [ ] **Step 5: Wire it into `fetch_media.py`**

Replace the body of `fetch_loc_image` and widen its signature. It now takes the terms a title must contain:

```python
from relevance import best_match  # add near the top, after sys.path setup

EXCLUDED_PLACES = ["alexandria", "chantilly", "lorton", "reston", "great falls",
                   "mclean", "philadelphia", "accawmacke"]


def fetch_loc_image(query: str, required: list[str], dest: Path) -> dict | None:
    """Download the best genuinely-relevant Library of Congress match."""
    r = CLIENT.get(LOC_SEARCH, params={"q": query, "fo": "json", "c": 25})
    r.raise_for_status()
    item = best_match(r.json().get("results", []), required, EXCLUDED_PLACES)
    if item is None:
        return None

    img_url = item["image_url"][-1].split("#")[0]
    if img_url.startswith("//"):
        img_url = "https:" + img_url
    if not img_url.startswith("http"):
        return None
    try:
        img = CLIENT.get(img_url)
    except httpx.HTTPError:
        return None
    if img.status_code != 200 or img.content[:2] != b"\xff\xd8":
        return None

    dest.write_bytes(img.content)
    return {
        "source": "Library of Congress",
        "url": item.get("id") or item.get("url") or LOC_SEARCH,
        "license": "No known restrictions on publication",
        # The matched archive title is recorded so a wrong match is visible in
        # the interface rather than buried in a manifest.
        "creator": _as_credit_creator(item),
    }


def _as_credit_creator(item: dict) -> str:
    creator = _first(item.get("creator")) or "Unknown"
    title = _first(item.get("title")) or ""
    date = _first(item.get("date")) or ""
    parts = [p for p in (creator, title, date) if p]
    return " — ".join(parts)
```

`content/source/stops.json` gains a `imageTerms` array on the courthouse image overlay so the required terms are content, not code:

```json
"imageQuery": "Fairfax Court House Virginia",
"imageTerms": ["fairfax", "court"]
```

Update the call site in `main()`:

```python
            credit = fetch_loc_image(ov["imageQuery"], ov.get("imageTerms", []), MEDIA / media_id)
```

Add a `sys.path` line near the imports so `relevance` resolves:

```python
sys.path.insert(0, str(Path(__file__).resolve().parent))
```

- [ ] **Step 6: Re-run the fetch and confirm the credit changed**

```bash
cd backend && uv run python ../content/scripts/fetch_media.py
python3 -c "import json;print(json.load(open('../content/media/manifest.json'))['courthouse-photo.jpg']['credit'])"
```

Expected: the credit's `creator` now names the matched archive title and date.

- [ ] **Step 7: `make check`, then commit** — `git commit -m "Reject irrelevant archive matches and record matched titles"`

---

### Task 3: Frontend geo helpers — bearing and distance

**Files:**
- Create: `frontend/src/app/core/geo.ts`, `frontend/src/app/core/geo.spec.ts`

**Interfaces:**
- Produces: `bearingBetween(from: LngLatLike, to: LngLatLike): number` — compass degrees, 0 = north, clockwise, range [0, 360). `distanceBetween(from, to): number` — metres. `type LngLatLike = { lng: number; lat: number }`.

- [ ] **Step 1: Write the failing tests**

`frontend/src/app/core/geo.spec.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { bearingBetween, distanceBetween } from './geo';

const FAIRFAX = { lng: -77.30732, lat: 38.84562 };

describe('bearingBetween', () => {
  it('returns 0 due north', () => {
    expect(bearingBetween(FAIRFAX, { lng: FAIRFAX.lng, lat: FAIRFAX.lat + 0.01 }))
      .toBeCloseTo(0, 1);
  });

  it('returns 90 due east', () => {
    expect(bearingBetween(FAIRFAX, { lng: FAIRFAX.lng + 0.01, lat: FAIRFAX.lat }))
      .toBeCloseTo(90, 1);
  });

  it('returns 180 due south', () => {
    expect(bearingBetween(FAIRFAX, { lng: FAIRFAX.lng, lat: FAIRFAX.lat - 0.01 }))
      .toBeCloseTo(180, 1);
  });

  it('returns 270 due west', () => {
    expect(bearingBetween(FAIRFAX, { lng: FAIRFAX.lng - 0.01, lat: FAIRFAX.lat }))
      .toBeCloseTo(270, 1);
  });

  it('always returns a value in [0, 360)', () => {
    const b = bearingBetween(FAIRFAX, { lng: FAIRFAX.lng - 0.01, lat: FAIRFAX.lat - 0.01 });
    expect(b).toBeGreaterThanOrEqual(0);
    expect(b).toBeLessThan(360);
  });

  it('is reversible: the reverse bearing is 180 degrees opposed', () => {
    const to = { lng: -77.30468, lat: 38.84601 };
    const there = bearingBetween(FAIRFAX, to);
    const back = bearingBetween(to, FAIRFAX);
    expect(Math.abs(((there - back + 540) % 360) - 180)).toBeLessThan(0.5);
  });
});

describe('distanceBetween', () => {
  it('is zero for the same point', () => {
    expect(distanceBetween(FAIRFAX, FAIRFAX)).toBeCloseTo(0, 6);
  });

  it('measures a known short hop', () => {
    // Historic courthouse to the Marr monument: about 14 m apart.
    const marr = { lng: -77.30716, lat: 38.84566 };
    const d = distanceBetween(FAIRFAX, marr);
    expect(d).toBeGreaterThan(8);
    expect(d).toBeLessThan(25);
  });

  it('measures a longer walk down Main Street', () => {
    // Courthouse to the museum: roughly 600 m.
    const museum = { lng: -77.3005, lat: 38.84455 };
    const d = distanceBetween(FAIRFAX, museum);
    expect(d).toBeGreaterThan(500);
    expect(d).toBeLessThan(750);
  });

  it('is symmetric', () => {
    const other = { lng: -77.30468, lat: 38.84601 };
    expect(distanceBetween(FAIRFAX, other)).toBeCloseTo(distanceBetween(other, FAIRFAX), 6);
  });
});
```

- [ ] **Step 2: Run and verify failure** — cannot resolve `./geo`.

- [ ] **Step 3: Implement `frontend/src/app/core/geo.ts`**

```ts
export interface LngLatLike {
  lng: number;
  lat: number;
}

const EARTH_RADIUS_M = 6_371_000;

const toRad = (deg: number) => (deg * Math.PI) / 180;
const toDeg = (rad: number) => (rad * 180) / Math.PI;

/** Compass bearing in degrees: 0 is north, increasing clockwise. */
export function bearingBetween(from: LngLatLike, to: LngLatLike): number {
  const phi1 = toRad(from.lat);
  const phi2 = toRad(to.lat);
  const dLambda = toRad(to.lng - from.lng);

  const y = Math.sin(dLambda) * Math.cos(phi2);
  const x =
    Math.cos(phi1) * Math.sin(phi2) - Math.sin(phi1) * Math.cos(phi2) * Math.cos(dLambda);

  return (toDeg(Math.atan2(y, x)) + 360) % 360;
}

/** Great-circle distance in metres. */
export function distanceBetween(from: LngLatLike, to: LngLatLike): number {
  const phi1 = toRad(from.lat);
  const phi2 = toRad(to.lat);
  const dPhi = phi2 - phi1;
  const dLambda = toRad(to.lng - from.lng);

  const a =
    Math.sin(dPhi / 2) ** 2 + Math.cos(phi1) * Math.cos(phi2) * Math.sin(dLambda / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.sqrt(a));
}
```

- [ ] **Step 4: Run and verify pass** — 10 passed.

- [ ] **Step 5: `make check`, commit** — `git commit -m "Add bearing and distance helpers"`

---

### Task 4: Arrival detection

**Files:**
- Create: `frontend/src/app/core/arrival.ts`, `frontend/src/app/core/arrival.spec.ts`

**Interfaces:**
- Consumes: `distanceBetween` from `./geo`, `Stop` from `./tour.models`.
- Produces: `ARRIVAL_RADIUS_M = 30`, `LATCH_RELEASE_M = 45`, and

```ts
export interface ArrivalInput {
  position: LngLatLike;
  stops: Stop[];
  currentIndex: number;
  latched: ReadonlySet<string>;
}
export interface ArrivalResult {
  arrivedIndex: number | null;   // index to advance to, or null
  latched: ReadonlySet<string>;  // updated latch set
}
export function detectArrival(input: ArrivalInput): ArrivalResult;
```

Latching uses hysteresis: a stop latches on arrival and only releases once you are beyond `LATCH_RELEASE_M`. Without the gap, standing on the boundary would re-fire repeatedly.

- [ ] **Step 1: Write the failing tests**

`frontend/src/app/core/arrival.spec.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { ARRIVAL_RADIUS_M, detectArrival } from './arrival';
import type { Stop } from './tour.models';

function stop(id: string, order: number, lng: number, lat: number): Stop {
  return {
    id, order, title: id, summary: '',
    location: { lng, lat }, osmRef: null,
    panorama: { provider: 'mapillary', imageId: `img-${order}`, bearing: 0, cachedPath: null },
    overlays: [],
  };
}

// Three stops spaced roughly 200 m apart along a line of latitude.
const STOPS = [
  stop('a', 1, -77.3100, 38.8456),
  stop('b', 2, -77.3077, 38.8456),
  stop('c', 3, -77.3054, 38.8456),
];

const away = { lng: -77.3089, lat: 38.8456 };   // between a and b, far from both

describe('detectArrival', () => {
  it('reports no arrival when far from every stop', () => {
    const r = detectArrival({ position: away, stops: STOPS, currentIndex: 0, latched: new Set() });
    expect(r.arrivedIndex).toBeNull();
  });

  it('arrives when inside the radius of the next stop', () => {
    const r = detectArrival({
      position: STOPS[1].location, stops: STOPS, currentIndex: 0, latched: new Set(),
    });
    expect(r.arrivedIndex).toBe(1);
    expect(r.latched.has('b')).toBe(true);
  });

  it('does not re-arrive at a stop that is already latched', () => {
    const r = detectArrival({
      position: STOPS[1].location, stops: STOPS, currentIndex: 1, latched: new Set(['b']),
    });
    expect(r.arrivedIndex).toBeNull();
  });

  it('arrives walking backwards', () => {
    const r = detectArrival({
      position: STOPS[0].location, stops: STOPS, currentIndex: 2, latched: new Set(),
    });
    expect(r.arrivedIndex).toBe(0);
  });

  it('releases the latch once you walk well clear', () => {
    const r = detectArrival({
      position: away, stops: STOPS, currentIndex: 1, latched: new Set(['b']),
    });
    expect(r.arrivedIndex).toBeNull();
    expect(r.latched.has('b')).toBe(false);
  });

  it('keeps the latch while still close but outside the radius', () => {
    // ~35 m east of stop b: past the arrival radius, inside the release radius.
    const near = { lng: STOPS[1].location.lng + 0.0004, lat: STOPS[1].location.lat };
    const r = detectArrival({
      position: near, stops: STOPS, currentIndex: 1, latched: new Set(['b']),
    });
    expect(r.latched.has('b')).toBe(true);
  });

  it('picks the nearest stop when two are in range', () => {
    const nearB = { lng: STOPS[1].location.lng + 0.00005, lat: STOPS[1].location.lat };
    const r = detectArrival({
      position: nearB, stops: STOPS, currentIndex: 0, latched: new Set(),
    });
    expect(r.arrivedIndex).toBe(1);
  });

  it('does not report arrival at the stop you are already on', () => {
    const r = detectArrival({
      position: STOPS[0].location, stops: STOPS, currentIndex: 0, latched: new Set(['a']),
    });
    expect(r.arrivedIndex).toBeNull();
  });

  it('handles an empty stop list', () => {
    const r = detectArrival({ position: away, stops: [], currentIndex: 0, latched: new Set() });
    expect(r.arrivedIndex).toBeNull();
  });

  it('uses a 30 metre radius', () => {
    expect(ARRIVAL_RADIUS_M).toBe(30);
  });
});
```

- [ ] **Step 2: Run and verify failure** — cannot resolve `./arrival`.

- [ ] **Step 3: Implement `frontend/src/app/core/arrival.ts`**

```ts
import { distanceBetween, type LngLatLike } from './geo';
import type { Stop } from './tour.models';

/** Close enough to count as standing at a stop. */
export const ARRIVAL_RADIUS_M = 30;

/**
 * How far you must get before a stop can trigger again. The gap above
 * ARRIVAL_RADIUS_M is deliberate: without it, lingering on the boundary would
 * re-fire arrival every time the viewer nudged position.
 */
export const LATCH_RELEASE_M = 45;

export interface ArrivalInput {
  position: LngLatLike;
  stops: Stop[];
  currentIndex: number;
  latched: ReadonlySet<string>;
}

export interface ArrivalResult {
  arrivedIndex: number | null;
  latched: ReadonlySet<string>;
}

export function detectArrival(input: ArrivalInput): ArrivalResult {
  const { position, stops, currentIndex, latched } = input;
  const next = new Set(latched);

  // Release latches for stops we have walked well clear of.
  for (const stop of stops) {
    if (next.has(stop.id) && distanceBetween(position, stop.location) > LATCH_RELEASE_M) {
      next.delete(stop.id);
    }
  }

  let bestIndex: number | null = null;
  let bestDistance = Infinity;

  stops.forEach((stop, index) => {
    if (index === currentIndex || next.has(stop.id)) return;
    const d = distanceBetween(position, stop.location);
    if (d <= ARRIVAL_RADIUS_M && d < bestDistance) {
      bestIndex = index;
      bestDistance = d;
    }
  });

  if (bestIndex !== null) next.add(stops[bestIndex].id);
  return { arrivedIndex: bestIndex, latched: next };
}
```

- [ ] **Step 4: Run and verify pass** — 10 passed.

- [ ] **Step 5: `make check`, commit** — `git commit -m "Add proximity arrival detection with latch hysteresis"`

---

### Task 5: TourStore — viewer position and arrivals

**Files:**
- Modify: `frontend/src/app/core/tour-store.ts`, `frontend/src/app/core/tour-store.spec.ts`

**Interfaces:**
- Consumes: `detectArrival`, `ARRIVAL_RADIUS_M` from `./arrival`; `LngLatLike` from `./geo`.
- Produces on `TourStore`: signals `viewerPosition: Signal<LngLatLike | null>`, `nextStop: Signal<Stop | null>`, `bearingToNextStop: Signal<number | null>`; methods `updateViewerPosition(position: LngLatLike): void`, `arriveAt(index: number): void`.

`goTo` remains the deliberate skip. `arriveAt` is what proximity triggers. Both move `currentIndex`; they are separate so that a skip can also seed the latch, preventing an immediate re-arrival at the stop you just skipped to.

- [ ] **Step 1: Write the failing tests**

Append to `frontend/src/app/core/tour-store.spec.ts` (inside the existing `describe`):

```ts
  it('starts with no viewer position', () => {
    store.load(tour());
    expect(store.viewerPosition()).toBeNull();
  });

  it('records viewer position as you move', () => {
    store.load(tour());
    store.updateViewerPosition({ lng: -77.31, lat: 38.8456 });
    expect(store.viewerPosition()).toEqual({ lng: -77.31, lat: 38.8456 });
  });

  it('exposes the next stop while walking', () => {
    store.load(tour());
    expect(store.nextStop()?.id).toBe('s2');
    store.goTo(2);
    expect(store.nextStop()).toBeNull();
  });

  it('exposes a bearing toward the next stop once position is known', () => {
    const t = tour();
    t.stops[0].location = { lng: -77.31, lat: 38.8456 };
    t.stops[1].location = { lng: -77.31, lat: 38.8466 };  // due north
    store.load(t);
    expect(store.bearingToNextStop()).toBeNull();
    store.updateViewerPosition({ lng: -77.31, lat: 38.8456 });
    expect(store.bearingToNextStop()!).toBeCloseTo(0, 0);
  });

  it('advances when the viewer walks into the next stop', () => {
    const t = tour();
    t.stops[1].location = { lng: -77.305, lat: 38.8456 };
    store.load(t);
    store.updateViewerPosition({ lng: -77.305, lat: 38.8456 });
    expect(store.currentIndex()).toBe(1);
  });

  it('does not advance for a position far from any stop', () => {
    store.load(tour());
    store.updateViewerPosition({ lng: -70, lat: 30 });
    expect(store.currentIndex()).toBe(0);
  });

  it('does not re-advance while lingering at the same stop', () => {
    const t = tour();
    t.stops[1].location = { lng: -77.305, lat: 38.8456 };
    store.load(t);
    store.updateViewerPosition({ lng: -77.305, lat: 38.8456 });
    store.updateViewerPosition({ lng: -77.305, lat: 38.8456 });
    expect(store.currentIndex()).toBe(1);
  });

  it('clears the selected overlay on arrival', () => {
    const t = tour();
    t.stops[1].location = { lng: -77.305, lat: 38.8456 };
    store.load(t);
    store.selectOverlay('ov-1');
    store.updateViewerPosition({ lng: -77.305, lat: 38.8456 });
    expect(store.selectedOverlay()).toBeNull();
  });

  it('walking backwards moves the tour back', () => {
    const t = tour();
    t.stops[0].location = { lng: -77.310, lat: 38.8456 };
    t.stops[1].location = { lng: -77.305, lat: 38.8456 };
    store.load(t);
    store.goTo(1);
    store.updateViewerPosition({ lng: -77.310, lat: 38.8456 });
    expect(store.currentIndex()).toBe(0);
  });

  it('a deliberate skip does not immediately re-arrive at itself', () => {
    const t = tour();
    t.stops[1].location = { lng: -77.305, lat: 38.8456 };
    store.load(t);
    store.goTo(1);
    store.updateViewerPosition({ lng: -77.305, lat: 38.8456 });
    expect(store.currentIndex()).toBe(1);
  });

  it('forgets viewer position and latches when a new tour loads', () => {
    const t = tour();
    t.stops[1].location = { lng: -77.305, lat: 38.8456 };
    store.load(t);
    store.updateViewerPosition({ lng: -77.305, lat: 38.8456 });
    store.load(tour());
    expect(store.viewerPosition()).toBeNull();
    expect(store.currentIndex()).toBe(0);
  });
```

- [ ] **Step 2: Run and verify failure** — `store.updateViewerPosition is not a function`.

- [ ] **Step 3: Implement**

In `frontend/src/app/core/tour-store.ts`, add imports:

```ts
import { detectArrival } from './arrival';
import { bearingBetween, type LngLatLike } from './geo';
```

Add private state beside the existing signals:

```ts
  private readonly _viewerPosition = signal<LngLatLike | null>(null);
  private _latched: ReadonlySet<string> = new Set();
```

Add public members:

```ts
  readonly viewerPosition = this._viewerPosition.asReadonly();

  /** The stop the tour is heading toward, or null at the end. */
  readonly nextStop = computed<Stop | null>(() => this.stops()[this._index() + 1] ?? null);

  /** Compass bearing from the viewer to the next stop; null until both are known. */
  readonly bearingToNextStop = computed<number | null>(() => {
    const from = this._viewerPosition();
    const to = this.nextStop();
    return from && to ? bearingBetween(from, to.location) : null;
  });

  /**
   * Feed viewer movement in. The store decides whether it counts as arriving,
   * which keeps the rule in one testable place rather than in a component.
   */
  updateViewerPosition(position: LngLatLike): void {
    this._viewerPosition.set(position);
    const { arrivedIndex, latched } = detectArrival({
      position,
      stops: this.stops(),
      currentIndex: this._index(),
      latched: this._latched,
    });
    this._latched = latched;
    if (arrivedIndex !== null) this.arriveAt(arrivedIndex);
  }

  /** Move because the viewer walked here, as opposed to skipping with goTo. */
  arriveAt(index: number): void {
    this.goTo(index);
  }
```

Update `load` to reset the new state:

```ts
  load(tour: Tour): void {
    this._tour.set(tour);
    this._index.set(0);
    this._selectedOverlayId.set(null);
    this._viewerPosition.set(null);
    this._latched = new Set();
  }
```

Update `goTo` so a deliberate skip latches its destination — otherwise arriving by skip would immediately re-trigger arrival at the same stop:

```ts
  goTo(index: number): void {
    if (index < 0 || index >= this.stops().length) return;
    this._index.set(index);
    this._selectedOverlayId.set(null);
    const stop = this.stops()[index];
    if (stop) this._latched = new Set([...this._latched, stop.id]);
  }
```

- [ ] **Step 4: Run and verify pass** — all store tests green.

- [ ] **Step 5: `make check`, commit** — `git commit -m "Separate viewer position from narrative position in TourStore"`

---

### Task 6: Edge picker for wayfinding

**Files:**
- Create: `frontend/src/app/panorama/edge-picker.ts`, `frontend/src/app/panorama/edge-picker.spec.ts`

**Interfaces:**
- Produces:

```ts
export interface DirectionEdge {
  targetId: string;
  /** Counter-clockwise radians from east, as mapillary-js reports it. */
  azimuthRad: number;
  /** True for edges mapillary-js renders as ground arrows. */
  isGroundArrow: boolean;
}
export const MAX_ARROW_DEVIATION_DEG = 60;
export function pickEdgeToward(edges: DirectionEdge[], targetBearingDeg: number | null): string | null;
```

`azimuthRad` is counter-clockwise from east; a compass bearing is clockwise from north. The conversion is `bearing = 90 - degrees(azimuth)`, normalised. Getting this backwards would highlight an arrow pointing the wrong way, so it is tested at all four cardinals.

- [ ] **Step 1: Write the failing tests**

`frontend/src/app/panorama/edge-picker.spec.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { MAX_ARROW_DEVIATION_DEG, pickEdgeToward, type DirectionEdge } from './edge-picker';

const HALF_PI = Math.PI / 2;

function edge(targetId: string, azimuthRad: number, isGroundArrow = true): DirectionEdge {
  return { targetId, azimuthRad, isGroundArrow };
}

// mapillary azimuth is counter-clockwise from east:
//   0 = east (bearing 90), PI/2 = north (bearing 0), PI = west (bearing 270)
const EAST = edge('east', 0);
const NORTH = edge('north', HALF_PI);
const WEST = edge('west', Math.PI);
const SOUTH = edge('south', -HALF_PI);
const ALL = [EAST, NORTH, WEST, SOUTH];

describe('pickEdgeToward', () => {
  it('picks the north edge for a northward bearing', () => {
    expect(pickEdgeToward(ALL, 0)).toBe('north');
  });

  it('picks the east edge for an eastward bearing', () => {
    expect(pickEdgeToward(ALL, 90)).toBe('east');
  });

  it('picks the south edge for a southward bearing', () => {
    expect(pickEdgeToward(ALL, 180)).toBe('south');
  });

  it('picks the west edge for a westward bearing', () => {
    expect(pickEdgeToward(ALL, 270)).toBe('west');
  });

  it('wraps around north correctly', () => {
    expect(pickEdgeToward(ALL, 350)).toBe('north');
    expect(pickEdgeToward(ALL, 10)).toBe('north');
  });

  it('returns null when no bearing is known', () => {
    expect(pickEdgeToward(ALL, null)).toBeNull();
  });

  it('returns null when there are no edges', () => {
    expect(pickEdgeToward([], 90)).toBeNull();
  });

  it('ignores edges that are not ground arrows', () => {
    const edges = [edge('pano', HALF_PI, false), edge('walk', Math.PI)];
    expect(pickEdgeToward(edges, 0)).toBeNull();
  });

  it('returns null when every arrow points too far from the target', () => {
    // Target due north, only arrow points due south.
    expect(pickEdgeToward([SOUTH], 0)).toBeNull();
  });

  it('accepts an arrow just inside the deviation limit', () => {
    const offBy = MAX_ARROW_DEVIATION_DEG - 5;
    expect(pickEdgeToward(ALL, 90 - offBy)).toBe('east');
  });

  it('picks the closest of two candidates on the same side', () => {
    const near = edge('near', HALF_PI - 0.1);
    const far = edge('far', HALF_PI - 0.6);
    expect(pickEdgeToward([far, near], 0)).toBe('near');
  });
});
```

- [ ] **Step 2: Run and verify failure** — cannot resolve `./edge-picker`.

- [ ] **Step 3: Implement `frontend/src/app/panorama/edge-picker.ts`**

```ts
/**
 * Chooses which ground arrow leads toward the next stop.
 *
 * Kept as a pure function over plain records so mapillary-js types stay inside
 * the adapter, matching how the rest of the panorama folder is arranged.
 */

export interface DirectionEdge {
  targetId: string;
  /** Counter-clockwise radians from east, as mapillary-js reports it. */
  azimuthRad: number;
  /** True for edges mapillary-js renders as ground arrows. */
  isGroundArrow: boolean;
}

/** Beyond this, an arrow is not meaningfully "toward" the destination. */
export const MAX_ARROW_DEVIATION_DEG = 60;

/** mapillary azimuth (CCW from east) to compass bearing (CW from north). */
function azimuthToBearing(azimuthRad: number): number {
  return (((90 - (azimuthRad * 180) / Math.PI) % 360) + 360) % 360;
}

/** Smallest absolute angle between two bearings, in degrees. */
function angularDifference(a: number, b: number): number {
  return Math.abs(((a - b + 540) % 360) - 180);
}

export function pickEdgeToward(
  edges: DirectionEdge[],
  targetBearingDeg: number | null,
): string | null {
  if (targetBearingDeg === null) return null;

  let best: string | null = null;
  let bestDeviation = MAX_ARROW_DEVIATION_DEG;

  for (const edge of edges) {
    if (!edge.isGroundArrow) continue;
    const deviation = angularDifference(azimuthToBearing(edge.azimuthRad), targetBearingDeg);
    if (deviation <= bestDeviation) {
      best = edge.targetId;
      bestDeviation = deviation;
    }
  }

  return best;
}
```

- [ ] **Step 4: Run and verify pass** — 11 passed.

- [ ] **Step 5: `make check`, commit** — `git commit -m "Add pure edge picker for arrow wayfinding"`

---

### Task 7: Rephoto placement maths

**Files:**
- Create: `frontend/src/app/panorama/rephoto-placement.ts`, `frontend/src/app/panorama/rephoto-placement.spec.ts`

**Interfaces:**
- Produces:

```ts
export interface RephotoPlacement {
  id: string;
  imageUrl: string;
  lng: number; lat: number; altitude: number;
  headingDeg: number; widthM: number; heightM: number;
}
export interface PlaneTransform {
  position: [number, number, number];  // ENU: east, north, up
  rotationY: number;                    // radians, about the up axis
  width: number; height: number;
}
export function planeTransform(
  placement: RephotoPlacement,
  enu: [number, number, number],
): PlaneTransform;
```

`enu` is supplied by the caller from mapillary's `geodeticToEnu`, so this function stays pure and testable without the library. A plane's default normal faces +Z (east-ish in the ENU frame once mapped); `rotationY` turns it to face the given compass heading.

- [ ] **Step 1: Write the failing tests**

`frontend/src/app/panorama/rephoto-placement.spec.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { planeTransform, type RephotoPlacement } from './rephoto-placement';

function placement(over: Partial<RephotoPlacement> = {}): RephotoPlacement {
  return {
    id: 'court-1863',
    imageUrl: '/api/media/court-1863.jpg',
    lng: -77.30732, lat: 38.84562, altitude: 6,
    headingDeg: 200, widthM: 18, heightM: 14,
    ...over,
  };
}

describe('planeTransform', () => {
  it('places the plane at the supplied ENU position', () => {
    const t = planeTransform(placement(), [10, -4, 6]);
    expect(t.position).toEqual([10, -4, 6]);
  });

  it('carries physical size through unchanged', () => {
    const t = planeTransform(placement({ widthM: 18, heightM: 14 }), [0, 0, 0]);
    expect(t.width).toBe(18);
    expect(t.height).toBe(14);
  });

  it('faces north for heading 0', () => {
    const t = planeTransform(placement({ headingDeg: 0 }), [0, 0, 0]);
    expect(t.rotationY).toBeCloseTo(0, 6);
  });

  it('turns a quarter circle for heading 90', () => {
    const t = planeTransform(placement({ headingDeg: 90 }), [0, 0, 0]);
    expect(t.rotationY).toBeCloseTo(-Math.PI / 2, 6);
  });

  it('turns a half circle for heading 180', () => {
    const t = planeTransform(placement({ headingDeg: 180 }), [0, 0, 0]);
    expect(Math.abs(t.rotationY)).toBeCloseTo(Math.PI, 6);
  });

  it('rotates clockwise as heading increases, matching a compass', () => {
    const a = planeTransform(placement({ headingDeg: 10 }), [0, 0, 0]).rotationY;
    const b = planeTransform(placement({ headingDeg: 20 }), [0, 0, 0]).rotationY;
    expect(b).toBeLessThan(a);
  });

  it('treats heading 360 as equivalent to 0', () => {
    const a = planeTransform(placement({ headingDeg: 0 }), [0, 0, 0]).rotationY;
    const b = planeTransform(placement({ headingDeg: 359.999 }), [0, 0, 0]).rotationY;
    expect(Math.abs(a - b)).toBeLessThan(0.001);
  });

  it('does not mutate the placement it is given', () => {
    const p = placement();
    planeTransform(p, [1, 2, 3]);
    expect(p.headingDeg).toBe(200);
  });
});
```

- [ ] **Step 2: Run and verify failure** — cannot resolve `./rephoto-placement`.

- [ ] **Step 3: Implement `frontend/src/app/panorama/rephoto-placement.ts`**

```ts
/**
 * Turns a georeferenced photograph into a plane transform.
 *
 * Pure by design: the ENU position is passed in rather than computed, so this
 * can be tested without mapillary-js or a WebGL context.
 */

export interface RephotoPlacement {
  id: string;
  imageUrl: string;
  lng: number;
  lat: number;
  altitude: number;
  /** Compass direction the face of the photograph looks toward. */
  headingDeg: number;
  widthM: number;
  heightM: number;
}

export interface PlaneTransform {
  /** East, north, up — the frame mapillary's geodeticToEnu returns. */
  position: [number, number, number];
  /** Rotation about the up axis, radians. */
  rotationY: number;
  width: number;
  height: number;
}

export function planeTransform(
  placement: RephotoPlacement,
  enu: [number, number, number],
): PlaneTransform {
  // Compass bearings run clockwise; rotation about the up axis runs
  // counter-clockwise, hence the negation.
  const normalised = ((placement.headingDeg % 360) + 360) % 360;
  const rotationY = -(normalised * Math.PI) / 180;

  return {
    position: [enu[0], enu[1], enu[2]],
    rotationY,
    width: placement.widthM,
    height: placement.heightM,
  };
}
```

- [ ] **Step 4: Run and verify pass** — 8 passed.

Note on `heading 359.999`: the test asserts the two rotations are within 0.001 radians. `-0` and `-2π` are the same orientation; the implementation returns a value near `-2π` for 359.999, so compare orientations modulo `2π` if this fails — the assertion above uses raw difference and passes because 359.999° maps to −6.2832 rad while 0° maps to −0, whose absolute difference exceeds the tolerance. **Therefore normalise the comparison in the test** by wrapping both into `[-π, π]`:

```ts
  it('treats heading 360 as equivalent to 0', () => {
    const wrap = (r: number) => Math.atan2(Math.sin(r), Math.cos(r));
    const a = wrap(planeTransform(placement({ headingDeg: 0 }), [0, 0, 0]).rotationY);
    const b = wrap(planeTransform(placement({ headingDeg: 359.999 }), [0, 0, 0]).rotationY);
    expect(Math.abs(a - b)).toBeLessThan(0.001);
  });
```

Use this version of the test, not the earlier one.

- [ ] **Step 5: `make check`, commit** — `git commit -m "Add pure rephoto plane placement maths"`

---

### Task 8: Extend the PanoramaViewer seam

**Files:**
- Modify: `frontend/src/app/panorama/panorama-viewer.ts`, `frontend/src/app/panorama/fake-viewer.ts`

**Interfaces:**
- Consumes: `RephotoPlacement` from `./rephoto-placement`.
- Produces on `PanoramaViewer`:

```ts
setRephotos(rephotos: RephotoPlacement[]): void;
setRephotoOpacity(opacity: number): void;
setDestinationBearing(bearingDeg: number | null): void;
onPositionChange(handler: (position: { lng: number; lat: number }, imageId: string) => void): void;
```

`OverlayMarker` gains `kind: 'overlay' | 'destination'` so the destination marker can be styled differently.

- [ ] **Step 1: Update the interface**

In `frontend/src/app/panorama/panorama-viewer.ts`:

```ts
import type { RephotoPlacement } from './rephoto-placement';

export interface OverlayMarker {
  id: string;
  lng: number;
  lat: number;
  selected: boolean;
  /** Destination markers point at the next stop while walking. */
  kind: 'overlay' | 'destination';
}

export interface PanoramaViewer {
  attach(container: HTMLElement, accessToken: string): void;
  load(imageId: string, bearing: number): Promise<void>;
  setMarkers(markers: OverlayMarker[]): void;
  onMarkerClick(handler: (id: string) => void): void;

  /** Photographs draped in the world. */
  setRephotos(rephotos: RephotoPlacement[]): void;
  /** 0 shows the present view, 1 shows the historical photograph. */
  setRephotoOpacity(opacity: number): void;
  /** Compass bearing to the next stop, or null to clear the highlight. */
  setDestinationBearing(bearingDeg: number | null): void;
  /** Fires whenever the viewer moves to a different image. */
  onPositionChange(
    handler: (position: { lng: number; lat: number }, imageId: string) => void,
  ): void;

  destroy(): void;
}
```

- [ ] **Step 2: Write the failing FakeViewer tests**

`frontend/src/app/panorama/fake-viewer.spec.ts` (new file):

```ts
import { describe, expect, it } from 'vitest';
import { FakeViewer } from './fake-viewer';
import type { RephotoPlacement } from './rephoto-placement';

const REPHOTO: RephotoPlacement = {
  id: 'court-1863', imageUrl: '/api/media/court-1863.jpg',
  lng: -77.30732, lat: 38.84562, altitude: 6,
  headingDeg: 200, widthM: 18, heightM: 14,
};

describe('FakeViewer', () => {
  it('records rephotos', () => {
    const v = new FakeViewer();
    v.setRephotos([REPHOTO]);
    expect(v.rephotos.at(-1)).toEqual([REPHOTO]);
  });

  it('records opacity changes', () => {
    const v = new FakeViewer();
    v.setRephotoOpacity(0.4);
    expect(v.opacity).toBe(0.4);
  });

  it('records destination bearing including null', () => {
    const v = new FakeViewer();
    v.setDestinationBearing(123);
    expect(v.destinationBearing).toBe(123);
    v.setDestinationBearing(null);
    expect(v.destinationBearing).toBeNull();
  });

  it('emits position changes to the registered handler', () => {
    const v = new FakeViewer();
    const seen: string[] = [];
    v.onPositionChange((_pos, imageId) => seen.push(imageId));
    v.emitPositionChange({ lng: -77.3, lat: 38.8 }, 'img-9');
    expect(seen).toEqual(['img-9']);
  });

  it('does not throw when position changes with no handler registered', () => {
    const v = new FakeViewer();
    expect(() => v.emitPositionChange({ lng: 0, lat: 0 }, 'x')).not.toThrow();
  });
});
```

- [ ] **Step 3: Run and verify failure** — `v.setRephotos is not a function`.

- [ ] **Step 4: Extend `fake-viewer.ts`**

```ts
import type { RephotoPlacement } from './rephoto-placement';
import type { OverlayMarker, PanoramaViewer } from './panorama-viewer';

/** Records interactions so component behaviour can be asserted without WebGL. */
export class FakeViewer implements PanoramaViewer {
  loaded: { imageId: string; bearing: number }[] = [];
  markers: OverlayMarker[][] = [];
  rephotos: RephotoPlacement[][] = [];
  opacity: number | null = null;
  destinationBearing: number | null = null;
  destroyed = false;
  failNextLoad = false;
  attachedTo: HTMLElement | null = null;

  private markerHandler: ((id: string) => void) | null = null;
  private positionHandler:
    | ((position: { lng: number; lat: number }, imageId: string) => void)
    | null = null;

  attach(container: HTMLElement): void {
    this.attachedTo = container;
  }

  async load(imageId: string, bearing: number): Promise<void> {
    if (this.failNextLoad) {
      this.failNextLoad = false;
      throw new Error('no imagery');
    }
    this.loaded.push({ imageId, bearing });
  }

  setMarkers(markers: OverlayMarker[]): void {
    this.markers.push(markers);
  }

  onMarkerClick(handler: (id: string) => void): void {
    this.markerHandler = handler;
  }

  emitMarkerClick(id: string): void {
    this.markerHandler?.(id);
  }

  setRephotos(rephotos: RephotoPlacement[]): void {
    this.rephotos.push(rephotos);
  }

  setRephotoOpacity(opacity: number): void {
    this.opacity = opacity;
  }

  setDestinationBearing(bearingDeg: number | null): void {
    this.destinationBearing = bearingDeg;
  }

  onPositionChange(
    handler: (position: { lng: number; lat: number }, imageId: string) => void,
  ): void {
    this.positionHandler = handler;
  }

  emitPositionChange(position: { lng: number; lat: number }, imageId: string): void {
    this.positionHandler?.(position, imageId);
  }

  destroy(): void {
    this.destroyed = true;
  }
}
```

Existing `panorama-pane.spec.ts` builds markers without `kind`; update its expectations to include `kind: 'overlay'` where it asserts on marker shape.

- [ ] **Step 5: Run and verify pass** — 5 new tests green, existing panorama tests still green.

- [ ] **Step 6: `make check`, commit** — `git commit -m "Extend PanoramaViewer seam for rephotos and wayfinding"`

---

### Task 9: Rephoto renderer and adapter wiring

This is the only task that touches WebGL. Everything it depends on was made pure in Tasks 6 and 7, so what remains here is plumbing.

**Files:**
- Create: `frontend/src/app/panorama/rephoto-renderer.ts`
- Modify: `frontend/src/app/panorama/mapillary-viewer.ts`

**Interfaces:**
- Consumes: `planeTransform`, `RephotoPlacement`; `pickEdgeToward`, `DirectionEdge`.
- Produces: `class RephotoRenderer implements ICustomRenderer` with `setRephotos(placements)`, `setOpacity(value)`, and the `ICustomRenderer` members `id`, `renderPass`, `onAdd`, `onReference`, `onRemove`, `render`.

- [ ] **Step 1: Implement `frontend/src/app/panorama/rephoto-renderer.ts`**

```ts
import {
  type ICustomRenderer,
  type IViewer,
  type LngLatAlt,
  RenderPass,
  geodeticToEnu,
} from 'mapillary-js';
import {
  Matrix4,
  Mesh,
  MeshBasicMaterial,
  PerspectiveCamera,
  PlaneGeometry,
  Scene,
  TextureLoader,
  WebGLRenderer,
} from 'three';
import { planeTransform, type RephotoPlacement } from './rephoto-placement';

/**
 * Draws historical photographs as planes standing in the world.
 *
 * Tags cannot carry an image texture, so this is the supported route. The
 * three.js version is whatever mapillary-js depends on (0.134) — deliberately
 * not installed separately, since two three.js copies in one WebGL context
 * fail in ways that are hard to diagnose.
 */
export class RephotoRenderer implements ICustomRenderer {
  readonly id = 'rephoto-renderer';
  readonly renderPass = RenderPass.Opaque;

  private renderer: WebGLRenderer | null = null;
  private readonly scene = new Scene();
  private readonly camera = new PerspectiveCamera();
  private readonly loader = new TextureLoader();
  private reference: LngLatAlt | null = null;
  private placements: RephotoPlacement[] = [];
  private meshes = new Map<string, Mesh>();
  private opacity = 0;

  onAdd(_viewer: IViewer, reference: LngLatAlt, context: WebGLRenderingContext): void {
    this.reference = reference;
    const canvas = context.canvas as HTMLCanvasElement;
    this.renderer = new WebGLRenderer({ canvas, context });
    this.renderer.autoClear = false;
    this.rebuild();
  }

  onReference(_viewer: IViewer, reference: LngLatAlt): void {
    this.reference = reference;
    this.rebuild();
  }

  onRemove(): void {
    this.disposeMeshes();
    this.renderer = null;
  }

  setRephotos(placements: RephotoPlacement[]): void {
    this.placements = placements;
    this.rebuild();
  }

  setOpacity(value: number): void {
    this.opacity = Math.min(1, Math.max(0, value));
    for (const mesh of this.meshes.values()) {
      const material = mesh.material as MeshBasicMaterial;
      material.opacity = this.opacity;
      mesh.visible = this.opacity > 0.01;
    }
  }

  render(_context: WebGLRenderingContext, viewMatrix: number[], projectionMatrix: number[]): void {
    if (!this.renderer || this.meshes.size === 0 || this.opacity <= 0.01) return;

    const view = new Matrix4().fromArray(viewMatrix);
    this.camera.matrixWorld = view.invert();
    this.camera.matrixWorldInverse = new Matrix4().fromArray(viewMatrix);
    this.camera.projectionMatrix = new Matrix4().fromArray(projectionMatrix);
    this.camera.projectionMatrixInverse = this.camera.projectionMatrix.clone().invert();

    this.renderer.resetState();
    this.renderer.render(this.scene, this.camera);
  }

  private rebuild(): void {
    this.disposeMeshes();
    const reference = this.reference;
    if (!reference) return;

    for (const placement of this.placements) {
      const enu = geodeticToEnu(
        placement.lng, placement.lat, placement.altitude,
        reference.lng, reference.lat, reference.alt,
      ) as [number, number, number];

      const transform = planeTransform(placement, enu);
      const material = new MeshBasicMaterial({
        transparent: true,
        opacity: this.opacity,
        depthTest: false,
      });
      // A texture that fails to load leaves the plane untextured rather than
      // breaking the tour.
      this.loader.load(
        placement.imageUrl,
        (texture) => {
          material.map = texture;
          material.needsUpdate = true;
        },
        undefined,
        () => console.warn(`rephoto texture failed: ${placement.imageUrl}`),
      );

      const mesh = new Mesh(new PlaneGeometry(transform.width, transform.height), material);
      mesh.position.set(transform.position[0], transform.position[1], transform.position[2]);
      mesh.rotation.y = transform.rotationY;
      mesh.visible = this.opacity > 0.01;

      this.scene.add(mesh);
      this.meshes.set(placement.id, mesh);
    }
  }

  private disposeMeshes(): void {
    for (const mesh of this.meshes.values()) {
      this.scene.remove(mesh);
      mesh.geometry.dispose();
      (mesh.material as MeshBasicMaterial).map?.dispose();
      (mesh.material as MeshBasicMaterial).dispose();
    }
    this.meshes.clear();
  }
}
```

- [ ] **Step 2: Wire the adapter**

In `frontend/src/app/panorama/mapillary-viewer.ts`, add imports:

```ts
import { DirectionComponent, MarkerComponent, SimpleMarker, Viewer } from 'mapillary-js';
import { pickEdgeToward, type DirectionEdge } from './edge-picker';
import { RephotoRenderer } from './rephoto-renderer';
import type { RephotoPlacement } from './rephoto-placement';
```

Add fields:

```ts
  private directionComponent: DirectionComponent | null = null;
  private rephotoRenderer: RephotoRenderer | null = null;
  private destinationBearing: number | null = null;
  private latestEdges: DirectionEdge[] = [];
  private positionHandler:
    | ((position: { lng: number; lat: number }, imageId: string) => void)
    | null = null;
```

Extend `attach`, after the existing marker wiring. `direction` must be enabled for arrows to appear:

```ts
    this.directionComponent = this.viewer.getComponent('direction') as DirectionComponent;

    this.rephotoRenderer = new RephotoRenderer();
    this.viewer.addCustomRenderer(this.rephotoRenderer);

    this.viewer.on('image', (event) => {
      const image = event.image;
      const lngLat = image.computedLngLat ?? image.lngLat;
      this.positionHandler?.({ lng: lngLat.lng, lat: lngLat.lat }, image.id);
    });

    // Ground arrows come from spatial edges; re-pick whenever they change.
    this.viewer.on('spatialedges', (event) => {
      this.latestEdges = event.status.edges.map((edge) => ({
        targetId: edge.target,
        azimuthRad: edge.data.worldMotionAzimuth,
        isGroundArrow: GROUND_ARROW_DIRECTIONS.has(edge.data.direction),
      }));
      this.applyHighlight();
    });
```

Update the viewer construction to enable `direction`:

```ts
      component: { cover: false, marker: true, bearing: true, zoom: true, direction: true },
```

Add the direction allow-list and the new methods:

```ts
import { NavigationDirection } from 'mapillary-js';

/** The edge kinds mapillary-js draws as arrows on the ground. */
const GROUND_ARROW_DIRECTIONS = new Set<NavigationDirection>([
  NavigationDirection.StepForward,
  NavigationDirection.StepBackward,
  NavigationDirection.StepLeft,
  NavigationDirection.StepRight,
  NavigationDirection.Next,
  NavigationDirection.Prev,
]);
```

```ts
  setRephotos(rephotos: RephotoPlacement[]): void {
    this.rephotoRenderer?.setRephotos(rephotos);
  }

  setRephotoOpacity(opacity: number): void {
    this.rephotoRenderer?.setOpacity(opacity);
  }

  setDestinationBearing(bearingDeg: number | null): void {
    this.destinationBearing = bearingDeg;
    this.applyHighlight();
  }

  onPositionChange(
    handler: (position: { lng: number; lat: number }, imageId: string) => void,
  ): void {
    this.positionHandler = handler;
  }

  private applyHighlight(): void {
    if (!this.directionComponent) return;
    const highlightId = pickEdgeToward(this.latestEdges, this.destinationBearing);
    this.directionComponent.configure({ highlightId: highlightId ?? undefined });
  }
```

Update `setMarkers` to style destination markers distinctly:

```ts
const DESTINATION = '#5fd08a';

  setMarkers(markers: OverlayMarker[]): void {
    if (!this.markerComponent) return;
    this.markerComponent.removeAll();
    this.markerComponent.add(
      markers.map((m) => {
        const colour =
          m.kind === 'destination' ? DESTINATION : m.selected ? SELECTED : UNSELECTED;
        return new SimpleMarker(m.id, { lng: m.lng, lat: m.lat }, {
          color: colour,
          ballColor: colour,
          interactive: true,
          radius: m.kind === 'destination' ? 1.1 : 0.7,
        });
      }),
    );
  }
```

Extend `destroy` to release the renderer:

```ts
  destroy(): void {
    if (this.viewer && this.rephotoRenderer) {
      this.viewer.removeCustomRenderer(this.rephotoRenderer.id);
    }
    this.rephotoRenderer = null;
    this.directionComponent = null;
    this.viewer?.remove();
    this.viewer = null;
    this.markerComponent = null;
  }
```

- [ ] **Step 3: Verify it compiles and bundles**

```bash
make build
```

Expected: exit 0. Confirm the bundle grew by roughly the size of the three.js code already present — it should not double.

- [ ] **Step 4: Confirm three.js was not duplicated**

```bash
cd frontend && npm ls three
```

Expected: a single `three@0.134.0`, deduped.

- [ ] **Step 5: `make check`, commit** — `git commit -m "Render rephotos as textured planes and highlight the arrow toward the next stop"`

---

### Task 10: PanoramaPane drives the new behaviour

**Files:**
- Modify: `frontend/src/app/panorama/panorama-pane.ts`, `frontend/src/app/panorama/panorama-pane.spec.ts`

**Interfaces:**
- Consumes: `TourStore.bearingToNextStop`, `TourStore.nextStop`, `TourStore.updateViewerPosition`, `RephotoPlacement`, `TourApi.mediaUrl`.
- Produces: no new exports; behaviour only.

- [ ] **Step 1: Write the failing tests**

Append to the existing `describe` in `panorama-pane.spec.ts`. Extend the `tour()` helper first so stop 1 carries a rephoto:

```ts
const REPHOTO_OVERLAY = {
  id: 'court-1863',
  kind: 'rephoto' as const,
  anchor: {
    type: 'geoQuad' as const,
    lng: -77.3073, lat: 38.8456, altitude: 6,
    headingDeg: 200, widthM: 18, heightM: 14,
  },
  title: 'Fairfax Court House, 1863',
  body: null,
  mediaId: 'court-1863.jpg',
  credit: { source: 'LoC', url: 'U', license: 'PD', creator: null },
};
```

```ts
  it('sends rephoto placements to the viewer', async () => {
    const t = tour();
    t.stops[0].overlays = [...t.stops[0].overlays, REPHOTO_OVERLAY];
    store.load(t);
    await render();
    const sent = fake.rephotos.at(-1)!;
    expect(sent).toHaveLength(1);
    expect(sent[0].id).toBe('court-1863');
    expect(sent[0].imageUrl).toBe('/api/media/court-1863.jpg');
    expect(sent[0].headingDeg).toBe(200);
  });

  it('sends no rephotos for a stop that has none', async () => {
    store.load(tour());
    await render();
    expect(fake.rephotos.at(-1)).toEqual([]);
  });

  it('does not send point overlays as rephotos', async () => {
    const t = tour();
    t.stops[0].overlays = [...t.stops[0].overlays, REPHOTO_OVERLAY];
    store.load(t);
    await render();
    expect(fake.rephotos.at(-1)!.map((r) => r.id)).toEqual(['court-1863']);
  });

  it('feeds viewer movement back into the store', async () => {
    const t = tour();
    t.stops[1].location = { lng: -77.305, lat: 38.8456 };
    store.load(t);
    const fixture = await render();
    fake.emitPositionChange({ lng: -77.305, lat: 38.8456 }, 'img-walked');
    fixture.detectChanges();
    expect(store.currentIndex()).toBe(1);
  });

  it('pushes the bearing to the next stop down to the viewer', async () => {
    const t = tour();
    t.stops[0].location = { lng: -77.31, lat: 38.8456 };
    t.stops[1].location = { lng: -77.31, lat: 38.8466 };
    store.load(t);
    const fixture = await render();
    fake.emitPositionChange({ lng: -77.31, lat: 38.8456 }, 'img-1');
    fixture.detectChanges();
    await fixture.whenStable();
    expect(fake.destinationBearing).toBeCloseTo(0, 0);
  });

  it('includes a destination marker for the next stop', async () => {
    store.load(tour());
    await render();
    const kinds = fake.markers.at(-1)!.map((m) => m.kind);
    expect(kinds).toContain('destination');
  });

  it('drops the destination marker on the final stop', async () => {
    store.load(tour());
    const fixture = await render();
    store.goTo(1);
    fixture.detectChanges();
    await fixture.whenStable();
    expect(fake.markers.at(-1)!.every((m) => m.kind === 'overlay')).toBe(true);
  });
```

- [ ] **Step 2: Run and verify failure** — `fake.rephotos` is empty; no destination marker.

- [ ] **Step 3: Implement**

In `panorama-pane.ts`, add imports:

```ts
import { TourApi } from '../core/tour-api';
import type { RephotoPlacement } from './rephoto-placement';
```

Inject the API:

```ts
  private readonly api = inject(TourApi);
```

Register the position callback in the constructor, next to `onMarkerClick`:

```ts
    this.viewer.onPositionChange((position) => this.store.updateViewerPosition(position));
```

Replace the marker effect so it includes the destination, and add two more effects:

```ts
    effect(() => {
      const selectedId = this.store.selectedOverlay()?.id ?? null;
      const markers = this.store
        .overlaysForCurrentStop()
        .filter((o) => o.anchor.type === 'geo')
        .map((o) => ({
          id: o.id,
          lng: o.anchor.lng,
          lat: o.anchor.lat,
          selected: o.id === selectedId,
          kind: 'overlay' as const,
        }));

      // The highlighted arrow only helps when you are already facing the right
      // way; the destination marker tells you which way to turn when you are not.
      const next = this.store.nextStop();
      if (next) {
        markers.push({
          id: `destination-${next.id}`,
          lng: next.location.lng,
          lat: next.location.lat,
          selected: false,
          kind: 'destination' as const,
        });
      }

      this.viewer.setMarkers(markers);
    });

    effect(() => {
      const rephotos: RephotoPlacement[] = this.store
        .overlaysForCurrentStop()
        .filter((o) => o.kind === 'rephoto' && o.anchor.type === 'geoQuad' && o.mediaId)
        .map((o) => {
          const anchor = o.anchor as Extract<typeof o.anchor, { type: 'geoQuad' }>;
          return {
            id: o.id,
            imageUrl: this.api.mediaUrl(o.mediaId!),
            lng: anchor.lng,
            lat: anchor.lat,
            altitude: anchor.altitude,
            headingDeg: anchor.headingDeg,
            widthM: anchor.widthM,
            heightM: anchor.heightM,
          };
        });
      this.viewer.setRephotos(rephotos);
    });

    effect(() => {
      this.viewer.setDestinationBearing(this.store.bearingToNextStop());
    });
```

- [ ] **Step 4: Run and verify pass** — all panorama tests green.

- [ ] **Step 5: `make check`, commit** — `git commit -m "Drive rephotos, wayfinding and walking from PanoramaPane"`

---

### Task 11: Opacity slider in the stop panel

**Files:**
- Modify: `frontend/src/app/stop/stop-panel.ts`, `frontend/src/app/core/tour-store.ts`, `frontend/src/app/stop/stop-panel.spec.ts`

**Interfaces:**
- Produces on `TourStore`: `rephotoOpacity: Signal<number>` (default `0.7`) and `setRephotoOpacity(value: number): void`, clamped to `[0, 1]`. `hasRephotos: Signal<boolean>`.

Opacity lives in the store rather than the component so `PanoramaPane` can read it without the two components knowing about each other.

- [ ] **Step 1: Write the failing tests**

Append to `stop-panel.spec.ts`:

```ts
  const REPHOTO = {
    id: 'court-1863', kind: 'rephoto' as const,
    anchor: { type: 'geoQuad' as const, lng: -77.3, lat: 38.8, altitude: 6,
              headingDeg: 200, widthM: 18, heightM: 14 },
    title: 'Fairfax Court House, 1863', body: null, mediaId: 'court-1863.jpg',
    credit: CREDIT,
  };

  it('shows no comparison slider when the stop has no rephoto', () => {
    store.load(tour([overlay()]));
    expect(render().querySelector('[data-rephoto-opacity]')).toBeNull();
  });

  it('shows the comparison slider when the stop has a rephoto', () => {
    store.load(tour([REPHOTO as never]));
    expect(render().querySelector('[data-rephoto-opacity]')).not.toBeNull();
  });

  it('labels the slider ends then and now', () => {
    store.load(tour([REPHOTO as never]));
    const text = render().textContent ?? '';
    expect(text).toContain('then');
    expect(text).toContain('now');
  });

  it('moving the slider updates the store', () => {
    store.load(tour([REPHOTO as never]));
    const el = render();
    const slider = el.querySelector<HTMLInputElement>('[data-rephoto-opacity]')!;
    slider.value = '0.25';
    slider.dispatchEvent(new Event('input'));
    expect(store.rephotoOpacity()).toBeCloseTo(0.25, 3);
  });
```

And to `tour-store.spec.ts`:

```ts
  it('defaults rephoto opacity to a visible ghost', () => {
    expect(store.rephotoOpacity()).toBeCloseTo(0.7, 3);
  });

  it('clamps rephoto opacity into range', () => {
    store.setRephotoOpacity(5);
    expect(store.rephotoOpacity()).toBe(1);
    store.setRephotoOpacity(-3);
    expect(store.rephotoOpacity()).toBe(0);
  });

  it('knows whether the current stop has a rephoto', () => {
    store.load(tour());
    expect(store.hasRephotos()).toBe(false);
  });
```

- [ ] **Step 2: Run and verify failure.**

- [ ] **Step 3: Implement the store additions**

```ts
  private readonly _rephotoOpacity = signal(0.7);
  readonly rephotoOpacity = this._rephotoOpacity.asReadonly();

  readonly hasRephotos = computed(() =>
    this.overlaysForCurrentStop().some((o) => o.kind === 'rephoto'),
  );

  setRephotoOpacity(value: number): void {
    this._rephotoOpacity.set(Math.min(1, Math.max(0, value)));
  }
```

- [ ] **Step 4: Add the slider to `stop-panel.ts`**

Insert above the `.controls` footer in the template:

```html
      @if (store.hasRephotos()) {
        <div class="rephoto-control">
          <label for="rephoto-opacity">Compare</label>
          <div class="slider-row">
            <span>now</span>
            <input
              id="rephoto-opacity"
              data-rephoto-opacity
              type="range"
              min="0" max="1" step="0.01"
              [value]="store.rephotoOpacity()"
              (input)="onOpacity($event)"
            />
            <span>then</span>
          </div>
        </div>
      }
```

And the handler on the class:

```ts
  protected onOpacity(event: Event): void {
    this.store.setRephotoOpacity(Number((event.target as HTMLInputElement).value));
  }
```

Append to `stop-panel.css`:

```css
.rephoto-control { margin-top: 1rem; border-top: 1px solid #333944; padding-top: 0.9rem; }
.rephoto-control label { display: block; font-size: 0.7rem; text-transform: uppercase; letter-spacing: 0.08em; color: #9aa0ab; margin-bottom: 0.4rem; }
.slider-row { display: flex; align-items: center; gap: 0.5rem; font-size: 0.7rem; color: #9aa0ab; }
.slider-row input { flex: 1; }
```

- [ ] **Step 5: Push opacity into the viewer**

Add one effect to `panorama-pane.ts`:

```ts
    effect(() => this.viewer.setRephotoOpacity(this.store.rephotoOpacity()));
```

- [ ] **Step 6: Run and verify pass; `make check`; commit** — `git commit -m "Add then/now comparison slider"`

---

### Task 12: Alignment mode

Exists because the render cannot be seen from this environment: without it, every alignment is a blind edit-and-reload cycle.

**Files:**
- Create: `frontend/src/app/align/align-mode.ts`, `frontend/src/app/align/align-mode.spec.ts`
- Modify: `frontend/src/app/app.ts`, `frontend/src/app/app.html`

**Interfaces:**
- Produces: `nudgeAnchor(anchor: GeoQuadAnchorLike, key: string): GeoQuadAnchorLike` — a pure reducer — and `AlignMode` component, selector `app-align-mode`, rendered only when `location.search` contains `align=1`.

```ts
export interface GeoQuadAnchorLike {
  lng: number; lat: number; altitude: number;
  headingDeg: number; widthM: number; heightM: number;
}
export const STEP_M = 1;
export const STEP_DEG = 2;
```

- [ ] **Step 1: Write the failing tests**

`frontend/src/app/align/align-mode.spec.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { nudgeAnchor, STEP_DEG, type GeoQuadAnchorLike } from './align-mode';

const BASE: GeoQuadAnchorLike = {
  lng: -77.30732, lat: 38.84562, altitude: 6,
  headingDeg: 200, widthM: 18, heightM: 14,
};

describe('nudgeAnchor', () => {
  it('ArrowUp moves the photograph north', () => {
    expect(nudgeAnchor(BASE, 'ArrowUp').lat).toBeGreaterThan(BASE.lat);
  });

  it('ArrowDown moves it south', () => {
    expect(nudgeAnchor(BASE, 'ArrowDown').lat).toBeLessThan(BASE.lat);
  });

  it('ArrowRight moves it east', () => {
    expect(nudgeAnchor(BASE, 'ArrowRight').lng).toBeGreaterThan(BASE.lng);
  });

  it('ArrowLeft moves it west', () => {
    expect(nudgeAnchor(BASE, 'ArrowLeft').lng).toBeLessThan(BASE.lng);
  });

  it('PageUp raises it and PageDown lowers it', () => {
    expect(nudgeAnchor(BASE, 'PageUp').altitude).toBeGreaterThan(BASE.altitude);
    expect(nudgeAnchor(BASE, 'PageDown').altitude).toBeLessThan(BASE.altitude);
  });

  it('+ grows and - shrinks, preserving aspect ratio', () => {
    const bigger = nudgeAnchor(BASE, '+');
    expect(bigger.widthM).toBeGreaterThan(BASE.widthM);
    expect(bigger.widthM / bigger.heightM).toBeCloseTo(BASE.widthM / BASE.heightM, 6);
    expect(nudgeAnchor(BASE, '-').widthM).toBeLessThan(BASE.widthM);
  });

  it('never shrinks below a visible size', () => {
    let a = { ...BASE, widthM: 1, heightM: 1 };
    for (let i = 0; i < 20; i++) a = nudgeAnchor(a, '-');
    expect(a.widthM).toBeGreaterThan(0);
  });

  it('[ and ] rotate by the heading step', () => {
    expect(nudgeAnchor(BASE, ']').headingDeg).toBeCloseTo(BASE.headingDeg + STEP_DEG, 6);
    expect(nudgeAnchor(BASE, '[').headingDeg).toBeCloseTo(BASE.headingDeg - STEP_DEG, 6);
  });

  it('wraps heading into [0, 360)', () => {
    expect(nudgeAnchor({ ...BASE, headingDeg: 359 }, ']').headingDeg).toBeLessThan(360);
    expect(nudgeAnchor({ ...BASE, headingDeg: 1 }, '[').headingDeg).toBeGreaterThanOrEqual(0);
  });

  it('ignores keys it does not handle', () => {
    expect(nudgeAnchor(BASE, 'q')).toEqual(BASE);
  });

  it('does not mutate the anchor it is given', () => {
    nudgeAnchor(BASE, 'ArrowUp');
    expect(BASE.lat).toBe(38.84562);
  });
});
```

- [ ] **Step 2: Run and verify failure.**

- [ ] **Step 3: Implement `frontend/src/app/align/align-mode.ts`**

```ts
import { Component, computed, inject, signal } from '@angular/core';
import { TourStore } from '../core/tour-store';

export interface GeoQuadAnchorLike {
  lng: number;
  lat: number;
  altitude: number;
  headingDeg: number;
  widthM: number;
  heightM: number;
}

/** One metre per keypress, converted to degrees at Fairfax's latitude. */
export const STEP_M = 1;
export const STEP_DEG = 2;
const METRES_PER_DEGREE_LAT = 111_320;
const SCALE_FACTOR = 1.05;
const MIN_SIZE_M = 0.5;

function metresToLat(m: number): number {
  return m / METRES_PER_DEGREE_LAT;
}

function metresToLng(m: number, lat: number): number {
  return m / (METRES_PER_DEGREE_LAT * Math.cos((lat * Math.PI) / 180));
}

/** Pure reducer: an anchor and a key in, a new anchor out. */
export function nudgeAnchor(anchor: GeoQuadAnchorLike, key: string): GeoQuadAnchorLike {
  const next = { ...anchor };
  switch (key) {
    case 'ArrowUp':
      next.lat += metresToLat(STEP_M);
      break;
    case 'ArrowDown':
      next.lat -= metresToLat(STEP_M);
      break;
    case 'ArrowRight':
      next.lng += metresToLng(STEP_M, anchor.lat);
      break;
    case 'ArrowLeft':
      next.lng -= metresToLng(STEP_M, anchor.lat);
      break;
    case 'PageUp':
      next.altitude += STEP_M;
      break;
    case 'PageDown':
      next.altitude -= STEP_M;
      break;
    case '+':
    case '=':
      next.widthM = anchor.widthM * SCALE_FACTOR;
      next.heightM = anchor.heightM * SCALE_FACTOR;
      break;
    case '-':
      next.widthM = Math.max(MIN_SIZE_M, anchor.widthM / SCALE_FACTOR);
      next.heightM = Math.max(MIN_SIZE_M, anchor.heightM / SCALE_FACTOR);
      break;
    case ']':
      next.headingDeg = (anchor.headingDeg + STEP_DEG + 360) % 360;
      break;
    case '[':
      next.headingDeg = (anchor.headingDeg - STEP_DEG + 360) % 360;
      break;
    default:
      return anchor;
  }
  return next;
}

export function alignModeEnabled(search: string): boolean {
  return new URLSearchParams(search).get('align') === '1';
}

@Component({
  selector: 'app-align-mode',
  template: `
    @let anchor = draft();
    @if (anchor) {
      <aside class="align" data-align-panel>
        <p class="keys">← → ↑ ↓ move · PgUp/PgDn height · +/− size · [ ] heading</p>
        <pre data-align-json>{{ json() }}</pre>
        <button type="button" data-align-copy (click)="copy()">copy anchor JSON</button>
      </aside>
    } @else {
      <aside class="align"><p>No rephoto on this stop to align.</p></aside>
    }
  `,
  styles: [`
    .align { position: absolute; top: 0.75rem; left: 0.75rem; z-index: 5;
             background: rgba(15,17,20,0.92); border: 1px solid #e8b04b;
             border-radius: 4px; padding: 0.6rem 0.75rem; font-size: 0.7rem;
             color: #ecebe6; max-width: 22rem; }
    .keys { margin: 0 0 0.5rem; color: #9aa0ab; }
    pre { margin: 0 0 0.5rem; white-space: pre-wrap; font-size: 0.68rem; }
    button { font: inherit; background: #e8b04b; border: 0; border-radius: 3px;
             padding: 0.3rem 0.55rem; cursor: pointer; }
  `],
  host: { '(document:keydown)': 'onKey($event)' },
})
export class AlignMode {
  private readonly store = inject(TourStore);
  private readonly override = signal<GeoQuadAnchorLike | null>(null);

  protected readonly draft = computed<GeoQuadAnchorLike | null>(() => {
    const manual = this.override();
    if (manual) return manual;
    const rephoto = this.store.overlaysForCurrentStop().find((o) => o.kind === 'rephoto');
    if (!rephoto || rephoto.anchor.type !== 'geoQuad') return null;
    const a = rephoto.anchor;
    return {
      lng: a.lng, lat: a.lat, altitude: a.altitude,
      headingDeg: a.headingDeg, widthM: a.widthM, heightM: a.heightM,
    };
  });

  protected readonly json = computed(() => {
    const a = this.draft();
    return a ? JSON.stringify({ type: 'geoQuad', ...a }, null, 2) : '';
  });

  protected onKey(event: KeyboardEvent): void {
    const current = this.draft();
    if (!current) return;
    const next = nudgeAnchor(current, event.key);
    if (next === current) return;
    event.preventDefault();
    this.override.set(next);
    this.store.setAlignmentOverride(next);
  }

  protected copy(): void {
    void navigator.clipboard?.writeText(this.json());
  }
}
```

- [ ] **Step 4: Add the store hook the panel writes to**

In `tour-store.ts`:

```ts
  private readonly _alignmentOverride = signal<GeoQuadAnchorLike | null>(null);
  readonly alignmentOverride = this._alignmentOverride.asReadonly();

  /** Alignment mode only: live-replace the current stop's rephoto anchor. */
  setAlignmentOverride(anchor: GeoQuadAnchorLike | null): void {
    this._alignmentOverride.set(anchor);
  }
```

Import the type from `../align/align-mode`. In `panorama-pane.ts`, apply the override inside the rephoto effect so nudges are visible immediately:

```ts
      const override = this.store.alignmentOverride();
      const withOverride = override
        ? rephotos.map((r, i) => (i === 0 ? { ...r, ...override } : r))
        : rephotos;
      this.viewer.setRephotos(withOverride);
```

- [ ] **Step 5: Mount it in the shell**

`app.ts`:

```ts
import { AlignMode, alignModeEnabled } from './align/align-mode';
```

Add `AlignMode` to `imports`, and:

```ts
  protected readonly aligning = alignModeEnabled(
    typeof location === 'undefined' ? '' : location.search,
  );
```

In `app.html`, inside `.panorama-slot`:

```html
    <section class="panorama-slot">
      <app-panorama-pane />
      @if (aligning) { <app-align-mode /> }
    </section>
```

`.panorama-slot` needs `position: relative;` in `app.css` for the panel to anchor.

- [ ] **Step 6: Run and verify pass; `make check`; commit** — `git commit -m "Add alignment mode for georeferencing rephotos"`

---

### Task 13: Rephoto content — the courthouse through three eras

**Files:**
- Create: `content/scripts/fetch_rephotos.py`
- Modify: `content/source/stops.json`, `content/scripts/build_tour.py`
- Modify: `frontend/src/app/core/tour.models.ts`

**Interfaces:**
- Produces: `content/media/court-1863.jpg`, `content/media/court-1918.jpg`, manifest entries for each, and `rephoto` overlays on the courthouse stop in the built tour.

The Library of Congress holds Fairfax Court House photographs from 1861, 1863 and 1918. The 1863 image shows Union cavalry before the same brick building and cupola visible in today's panorama.

- [ ] **Step 1: Add the rephotos block to `content/source/stops.json`**

On the `historic-courthouse` stop, alongside `overlays`:

```json
    "rephotos": [
      {
        "id": "court-1863",
        "title": "Fairfax Court House, 1863",
        "query": "Fairfax Court House",
        "terms": ["fairfax", "court"],
        "preferDate": "1863",
        "anchor": {
          "type": "geoQuad",
          "lng": -77.30736, "lat": 38.84569, "altitude": 7.0,
          "headingDeg": 200, "widthM": 26, "heightM": 20
        }
      },
      {
        "id": "court-1918",
        "title": "Fairfax Court House, about 1918",
        "query": "Fairfax Court House",
        "terms": ["fairfax", "court"],
        "preferDate": "1918",
        "anchor": {
          "type": "geoQuad",
          "lng": -77.30736, "lat": 38.84569, "altitude": 7.0,
          "headingDeg": 200, "widthM": 26, "heightM": 20
        }
      }
    ]
```

These anchor values are a starting estimate derived from the stop location and the panorama's 200° bearing. They are expected to be corrected using alignment mode — that is what it is for.

- [ ] **Step 2: Implement `content/scripts/fetch_rephotos.py`**

```python
"""Fetch historical photographs to be draped over the scenes they depict.

Separate from fetch_media.py because the selection rule is different: a
rephoto is chosen for its date as well as its subject, so that one site can be
shown across several eras.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

import httpx

sys.path.insert(0, str(Path(__file__).resolve().parent))

from relevance import best_match, score_title  # noqa: E402

REPO = Path(__file__).resolve().parents[2]
MEDIA = REPO / "content" / "media"
SOURCE = REPO / "content" / "source" / "stops.json"

UA = "clio-wired-prototype/0.1 (graduates@rrchnm.org)"
LOC_SEARCH = "https://www.loc.gov/photos/"
EXCLUDED_PLACES = ["alexandria", "chantilly", "lorton", "reston", "great falls",
                   "mclean", "philadelphia", "accawmacke"]

CLIENT = httpx.Client(timeout=90.0, headers={"User-Agent": UA}, follow_redirects=True)


def _first(value):
    if isinstance(value, list):
        return value[0] if value else None
    return value


def pick_by_date(items: list[dict], terms: list[str], prefer_date: str) -> dict | None:
    """Prefer an item from the wanted year, falling back to any relevant one."""
    relevant = [i for i in items
                if i.get("image_url") and score_title(i.get("title", ""), terms, EXCLUDED_PLACES)]
    dated = [i for i in relevant if prefer_date in str(_first(i.get("date")) or "")]
    if dated:
        return dated[0]
    return best_match(items, terms, EXCLUDED_PLACES)


def main() -> int:
    MEDIA.mkdir(parents=True, exist_ok=True)
    manifest_path = MEDIA / "manifest.json"
    manifest = json.loads(manifest_path.read_text()) if manifest_path.exists() else {}
    failures = 0

    for stop in json.loads(SOURCE.read_text()):
        for spec in stop.get("rephotos", []):
            r = CLIENT.get(LOC_SEARCH, params={"q": spec["query"], "fo": "json", "c": 25})
            r.raise_for_status()
            item = pick_by_date(r.json().get("results", []), spec["terms"], spec["preferDate"])
            if item is None:
                print(f"  {spec['id']:<18} NO RELEVANT MATCH", file=sys.stderr)
                failures += 1
                continue

            url = item["image_url"][-1].split("#")[0]
            if url.startswith("//"):
                url = "https:" + url
            img = CLIENT.get(url)
            if img.status_code != 200 or img.content[:2] != b"\xff\xd8":
                print(f"  {spec['id']:<18} DOWNLOAD FAILED", file=sys.stderr)
                failures += 1
                continue

            media_id = f"{spec['id']}.jpg"
            (MEDIA / media_id).write_bytes(img.content)
            title = _first(item.get("title")) or ""
            date = _first(item.get("date")) or "?"
            manifest[media_id] = {
                "file": media_id,
                "credit": {
                    "source": "Library of Congress",
                    "url": item.get("id") or LOC_SEARCH,
                    "license": "No known restrictions on publication",
                    "creator": f"{title} — {date}",
                },
            }
            print(f"  {spec['id']:<18} [{date}] {title[:48]}")

    manifest_path.write_text(json.dumps(manifest, indent=2))
    return 1 if failures else 0


if __name__ == "__main__":
    raise SystemExit(main())
```

- [ ] **Step 3: Emit rephoto overlays in `build_tour.py`**

Inside the per-stop loop, after the narration block:

```python
        for spec in src.get("rephotos", []):
            media_id = f"{spec['id']}.jpg"
            if media_id not in manifest:
                sys.exit(f"missing rephoto {media_id}; run fetch_rephotos.py first")
            overlays.append({
                "id": spec["id"],
                "kind": "rephoto",
                "anchor": spec["anchor"],
                "title": spec["title"],
                "mediaId": media_id,
                "credit": manifest[media_id]["credit"],
            })
```

- [ ] **Step 4: Mirror the schema in `tour.models.ts`**

```ts
export interface GeoQuadAnchor {
  type: 'geoQuad';
  lng: number;
  lat: number;
  altitude: number;
  headingDeg: number;
  widthM: number;
  heightM: number;
}

export type Anchor = GeoAnchor | GeoQuadAnchor;

export type OverlayKind = 'text' | 'image' | 'audio' | 'rephoto';

export interface Overlay {
  id: string;
  kind: OverlayKind;
  anchor: Anchor;
  title: string;
  body: string | null;
  mediaId: string | null;
  credit: Credit;
}
```

- [ ] **Step 5: Add the pipeline step to the Makefile**

In the `content` target, between `fetch_media.py` and `make_narration.py`:

```makefile
	cd backend && uv run python ../content/scripts/fetch_rephotos.py
```

- [ ] **Step 6: Run the pipeline and inspect what arrived**

```bash
make content
python3 -c "
import json
m = json.load(open('content/media/manifest.json'))
for k in ('court-1863.jpg', 'court-1918.jpg'):
    print(k, '->', m[k]['credit']['creator'])
"
```

Expected: two files whose credits name the matched archive title and date. **Open both images and confirm they show the courthouse**, not another building — this pipeline chooses by title, and a title can still mislead.

- [ ] **Step 7: `make check`; commit** — `git commit -m "Add 1863 and 1918 courthouse rephotos"`

---

### Task 14: Integration tests over the real tour

**Files:**
- Modify: `frontend/src/app/integration/real-tour.spec.ts`
- Modify: `frontend/tests/e2e/tour.spec.ts`

Browser tests still cannot run here, so the jsdom integration suite carries the verification weight.

- [ ] **Step 1: Write the failing tests**

Append to `real-tour.spec.ts`:

```ts
  it('the courthouse carries rephotos from more than one era', () => {
    store.goTo(0);
    const rephotos = store.overlaysForCurrentStop().filter((o) => o.kind === 'rephoto');
    expect(rephotos.length).toBeGreaterThanOrEqual(2);
  });

  it('every rephoto has a geoQuad anchor with a real size', () => {
    for (let i = 0; i < 6; i++) {
      store.goTo(i);
      for (const ov of store.overlaysForCurrentStop()) {
        if (ov.kind !== 'rephoto') continue;
        expect(ov.anchor.type).toBe('geoQuad');
        const a = ov.anchor as Extract<typeof ov.anchor, { type: 'geoQuad' }>;
        expect(a.widthM).toBeGreaterThan(0);
        expect(a.heightM).toBeGreaterThan(0);
        expect(a.headingDeg).toBeGreaterThanOrEqual(0);
        expect(a.headingDeg).toBeLessThan(360);
      }
    }
  });

  it('every rephoto stands within a short walk of its stop', () => {
    for (const stop of store.stops()) {
      for (const ov of stop.overlays) {
        if (ov.kind !== 'rephoto') continue;
        const a = ov.anchor as Extract<typeof ov.anchor, { type: 'geoQuad' }>;
        expect(Math.abs(a.lng - stop.location.lng)).toBeLessThan(0.002);
        expect(Math.abs(a.lat - stop.location.lat)).toBeLessThan(0.002);
      }
    }
  });

  it('every rephoto credits a named archive and matched item', () => {
    for (const stop of store.stops()) {
      for (const ov of stop.overlays) {
        if (ov.kind !== 'rephoto') continue;
        expect(ov.credit.source).toContain('Library of Congress');
        expect(ov.credit.creator?.length).toBeGreaterThan(0);
      }
    }
  });

  it('walking to a stop advances the tour, as the panorama would', () => {
    store.goTo(0);
    const third = store.stops()[2];
    store.updateViewerPosition(third.location);
    expect(store.currentIndex()).toBe(2);
  });

  it('every stop except the last exposes a bearing to walk toward', () => {
    for (let i = 0; i < 5; i++) {
      store.goTo(i);
      store.updateViewerPosition(store.stops()[i].location);
      expect(store.bearingToNextStop()).not.toBeNull();
    }
    store.goTo(5);
    store.updateViewerPosition(store.stops()[5].location);
    expect(store.bearingToNextStop()).toBeNull();
  });
```

- [ ] **Step 2: Add e2e coverage for when a browser is available**

Append to `frontend/tests/e2e/tour.spec.ts`:

```ts
test('the courthouse offers a then/now comparison', async ({ page }) => {
  await expect(page.locator('[data-rephoto-opacity]')).toBeVisible();
});

test('the comparison slider is absent on a stop with no rephoto', async ({ page }) => {
  await page.locator('[data-next]').click();
  await expect(page.locator('[data-rephoto-opacity]')).toHaveCount(0);
});

test('alignment mode is off unless asked for', async ({ page }) => {
  await expect(page.locator('[data-align-panel]')).toHaveCount(0);
});
```

- [ ] **Step 3: Run and verify** — `make check` green. E2E remains unrunnable here; note it and move on.

- [ ] **Step 4: Commit** — `git commit -m "Cover walking and rephotos in the integration suite"`

---

### Task 15: Documentation

**Files:**
- Modify: `README.md`, `docs/ENVIRONMENT.md`

- [ ] **Step 1: Document the two features in `README.md`**

Add a "Walking and comparing" section covering: following highlighted ground arrows between stops, the 30 m auto-advance and that Next still skips, the then/now slider at the courthouse, and `?align=1` for georeferencing with the key bindings listed.

- [ ] **Step 2: Note the three.js constraint in `docs/ENVIRONMENT.md`**

Record that `three` must stay the hoisted 0.134.0 that mapillary-js depends on, that installing a second copy breaks the shared WebGL context in hard-to-diagnose ways, and that `npm ls three` should report exactly one deduped entry.

- [ ] **Step 3: Final `make check`; commit** — `git commit -m "Document walking, rephotography and alignment mode"`

---

## Self-review

**Spec coverage.** §3 walkable tour → Tasks 4, 5, 10. §4 wayfinding → Tasks 6, 9, 10. §5 rephotography schema → Tasks 1, 13; rendering → Tasks 7, 9; controls → Task 11; seam → Task 8. §6 alignment mode → Task 12. §7 provenance bug → Task 2. §8 testing → distributed, plus Task 14. §9 risks → alignment mode (Task 12), latch hysteresis (Task 4), null highlight and destination marker (Tasks 6, 10), pinned three.js (Tasks 9, 15), texture failure handling (Task 9).

**Placeholder scan.** No TBDs. Every code step carries real code. Task 7 contains an explicit correction to its own earlier test — the corrected version is the one to use, and that is stated plainly rather than left ambiguous.

**Type consistency.** `RephotoPlacement` fields (`id`, `imageUrl`, `lng`, `lat`, `altitude`, `headingDeg`, `widthM`, `heightM`) are identical across Tasks 7, 8, 9 and 10. `PanoramaViewer`'s four new methods have the same signatures in the interface (Task 8), `FakeViewer` (Task 8), `MapillaryViewer` (Task 9) and the calls from `PanoramaPane` (Task 10). `GeoQuadAnchorLike` in Task 12 matches the anchor fields from Task 1. `detectArrival`'s `ArrivalInput`/`ArrivalResult` in Task 4 match the call in Task 5. Python aliases (`headingDeg`, `widthM`, `heightM`) match the TypeScript mirror in Task 13.

**One risk the plan carries knowingly.** The anchor values in Task 13 are estimates. They will look wrong until corrected through alignment mode, and that correction cannot happen in this environment. Task 13 Step 6 requires opening the fetched images to confirm subject; the geometry itself needs a human at a browser.
