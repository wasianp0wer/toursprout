# Editing Core Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A tool for placing a tour's content precisely, against a top-down map and a street-level panorama at the same time.

**Architecture:** A second route, `/edit`, beside the unchanged viewer. `EditorStore` holds the draft document, selection, undo stack and validation state as plain signals — no DOM, no HTTP, no map — and every document change is a pure function over the document. Three surfaces (outline, map, panorama) plus a numeric inspector all read and write that one store, each owning the properties it can actually represent. Autosave does a debounced whole-document `PUT`.

**Tech Stack:** Angular 22 (signals, standalone components, `@angular/router`, `@angular/forms` — both already dependencies, neither yet wired up), TypeScript, Vitest, Leaflet 1.9, mapillary-js 4.1.2, three.js 0.134. Backend: FastAPI, pydantic, pytest.

**Spec:** `docs/superpowers/specs/2026-10-13-editing-core-design.md`
**Umbrella:** `docs/superpowers/specs/2026-10-12-authoring-application-overview.md`
**Prior sub-projects:** `2026-10-12-schema-v2-design.md`, `2026-10-12-bundle-and-publish-design.md`

## Global Constraints

- All commands run through `make`, which pins Node 24 at `/Users/maddiepersonal/.local/share/fnm/node-versions/v24.21.0/installation/bin`. **Never call `npx`/`ng` directly** — ambient `node` is v25 and Angular 22 rejects it.
- `UV_CACHE_DIR` must stay inside the repo. Angular's build cache must stay disabled or `ng build` SIGABRTs silently.
- **No browser can launch in this sandbox.** Never attempt Playwright or `make e2e`. jsdom (Vitest) carries all frontend verification.
- **Never use `urllib`** — it truncates through the egress proxy. `httpx` everywhere. This sub-project needs no network.
- Use `$TMPDIR`, never `/tmp`.
- Baseline: **195 pytest, 214 Vitest**, lint clean, bundle 2.04 MB raw / 348.40 kB transferred. Report the bundle size every task; a material jump means an unintended dependency.
- **Derived, never guessed.** `headingDeg` is derived from panorama geometry. A manual override must be a deliberate act with a way back, and the override flag is editor state that is **never written to the document**.
- Legal `kind` × `display.mode`: text→marker; image→marker, inWorld; audio→marker, ambient. The frontend must read this from one place, asserted against the backend's `DISPLAY_MODES_BY_KIND`.
- JSON is camelCase on the wire. `Strict` pydantic models are `extra="forbid"`.
- Let git use its own config. Do **not** pass `-c user.email=...`.
- Commit messages end with `Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>`.

## Review Focus

Input classes and failure modes the spec implies that no happy-path test exercises. Each is assigned to the task that owns the code.

1. **Deleting the last stop.** `Tour.stops` has `min_length=1`, so a document with zero stops cannot be saved. The editor must refuse the deletion rather than produce an unsaveable draft. → Task 1.
2. **Two stops or overlays given the same title.** Slug collision must produce distinct stable ids, and renaming later must not move an id that the document references. → Task 1.
3. **Switching an overlay's kind to one its current display mode cannot have** — image/inWorld switched to text. The editor must coerce to a legal mode rather than offer an invalid pair. → Task 1.
4. **A 422 arriving while the author is still typing.** The draft must survive, the message must be visible, and the next keystroke must retry — not deadlock on a rejected save. → Task 2.
5. **An overlay selected, then its stop deleted.** Selection must not dangle at an id that no longer exists, in any of the three surfaces. → Task 1 (store) and Task 3 (outline).

---

### Task 1: The document transforms and `EditorStore`

Pure TypeScript. No components, no HTTP, no map. This is the whole of the editor's logic and is where the verification weight sits, because nothing visual can be checked in this environment.

**Files:**
- Create: `frontend/src/app/editor/document-ops.ts`
- Create: `frontend/src/app/editor/document-ops.spec.ts`
- Create: `frontend/src/app/editor/editor-store.ts`
- Create: `frontend/src/app/editor/editor-store.spec.ts`

**Interfaces:**
- Consumes: `core/tour.models` (`Tour`, `Stop`, `Overlay`, `Display`, `Credit`, `OverlayKind`), `core/geo` (`bearingBetween`, `LngLatLike`).
- Produces, from `document-ops.ts`:
  - `DISPLAY_MODES_BY_KIND: Readonly<Record<OverlayKind, readonly DisplayMode[]>>`
  - `legalModesFor(kind: OverlayKind): readonly DisplayMode[]`
  - `slugify(text: string): string`
  - `uniqueId(base: string, taken: Iterable<string>): string`
  - `renumberStops(stops: Stop[]): Stop[]`
  - `addStop(tour: Tour, title: string): Tour`
  - `deleteStop(tour: Tour, stopId: string): Tour` — throws `LastStopError` if it would empty the tour
  - `moveStop(tour: Tour, stopId: string, delta: number): Tour`
  - `addTextOverlay(tour: Tour, stopId: string, title: string): Tour`
  - `deleteOverlay(tour: Tour, overlayId: string): Tour`
  - `updateOverlay(tour: Tour, overlayId: string, patch: Partial<Overlay>): Tour`
  - `setOverlayKind(tour: Tour, overlayId: string, kind: OverlayKind): Tour`
  - `deriveHeading(anchor: LngLatLike, panorama: LngLatLike): number`
  - `defaultCreditFor(tour: Tour): Credit`
- Produces, from `editor-store.ts`: the `EditorStore` injectable described in step 5.

- [ ] **Step 1: Write the failing document-ops tests**

Create `frontend/src/app/editor/document-ops.spec.ts`:

```typescript
import { describe, expect, it } from 'vitest';
import {
  LastStopError, addStop, addTextOverlay, defaultCreditFor, deleteOverlay,
  deleteStop, deriveHeading, legalModesFor, moveStop, renumberStops,
  setOverlayKind, slugify, uniqueId, updateOverlay,
} from './document-ops';
import type { Overlay, Stop, Tour } from '../core/tour.models';

function overlay(id: string, over: Partial<Overlay> = {}): Overlay {
  return {
    id, kind: 'text',
    anchor: { type: 'geo', lng: -77.3, lat: 38.84, altitudeM: 2 },
    display: { mode: 'marker', icon: 'note' },
    title: 'An overlay', body: 'Body', mediaId: null,
    credit: { type: 'original', creator: 'M', license: 'CC-BY-4.0' },
    ...over,
  };
}

function stop(id: string, order: number, overlays: Overlay[] = []): Stop {
  return {
    id, order, title: `Stop ${order}`, summary: 'summary',
    location: { lng: -77.3, lat: 38.84 }, osmRef: null,
    panorama: { provider: 'mapillary', imageId: `img-${order}`, bearing: 90, cachedPath: null },
    overlays,
  };
}

function tour(stops: Stop[] = [stop('s1', 1)]): Tour {
  return {
    id: 't', schemaVersion: 2, title: 'T', description: '',
    defaults: { creator: 'M. Harrington', license: 'CC-BY-4.0' },
    attribution: [], stops,
  };
}

describe('slugify and uniqueId', () => {
  it('makes a readable slug', () => {
    expect(slugify('Fairfax County Historic Courthouse'))
      .toBe('fairfax-county-historic-courthouse');
  });

  it('survives punctuation and collapses runs', () => {
    expect(slugify("Earp's  Ordinary --- 1800!")).toBe('earps-ordinary-1800');
  });

  it('never returns an empty id', () => {
    expect(slugify('!!!')).toBe('untitled');
  });

  it('de-duplicates against ids already taken', () => {
    expect(uniqueId('courthouse', ['courthouse'])).toBe('courthouse-2');
    expect(uniqueId('courthouse', ['courthouse', 'courthouse-2'])).toBe('courthouse-3');
  });
});

describe('stop ordering', () => {
  it('renumbers contiguously from 1', () => {
    const out = renumberStops([stop('a', 7), stop('b', 3), stop('c', 90)]);
    expect(out.map((s) => s.order)).toEqual([1, 2, 3]);
  });

  it('adds a stop at the end, contiguous', () => {
    const out = addStop(tour([stop('s1', 1), stop('s2', 2)]), 'A New Place');
    expect(out.stops.map((s) => s.order)).toEqual([1, 2, 3]);
    expect(out.stops[2].id).toBe('a-new-place');
  });

  it('moves a stop and renumbers', () => {
    const out = moveStop(tour([stop('a', 1), stop('b', 2), stop('c', 3)]), 'c', -1);
    expect(out.stops.map((s) => s.id)).toEqual(['a', 'c', 'b']);
    expect(out.stops.map((s) => s.order)).toEqual([1, 2, 3]);
  });

  it('clamps a move at the ends rather than throwing', () => {
    const t = tour([stop('a', 1), stop('b', 2)]);
    expect(moveStop(t, 'a', -1).stops.map((s) => s.id)).toEqual(['a', 'b']);
    expect(moveStop(t, 'b', 1).stops.map((s) => s.id)).toEqual(['a', 'b']);
  });

  it('deletes a stop and renumbers', () => {
    const out = deleteStop(tour([stop('a', 1), stop('b', 2), stop('c', 3)]), 'b');
    expect(out.stops.map((s) => s.id)).toEqual(['a', 'c']);
    expect(out.stops.map((s) => s.order)).toEqual([1, 2]);
  });

  it('refuses to delete the last stop', () => {
    // Tour.stops has min_length=1, so this would make the draft unsaveable.
    expect(() => deleteStop(tour([stop('a', 1)]), 'a')).toThrow(LastStopError);
  });
});

describe('overlays', () => {
  it('adds a text overlay that is valid the instant it exists', () => {
    const out = addTextOverlay(tour(), 's1', 'A note');
    const added = out.stops[0].overlays[0];
    expect(added.kind).toBe('text');
    expect(added.display.mode).toBe('marker');
    expect(added.body!.trim().length).toBeGreaterThan(0);
    expect(added.credit.type).toBe('original');
  });

  it('anchors a new overlay at its stop, not at null island', () => {
    const t = tour([stop('s1', 1)]);
    const added = addTextOverlay(t, 's1', 'A note').stops[0].overlays[0];
    expect(added.anchor.lng).toBeCloseTo(t.stops[0].location.lng, 6);
    expect(added.anchor.lat).toBeCloseTo(t.stops[0].location.lat, 6);
  });

  it('de-duplicates overlay ids across the whole tour, not just one stop', () => {
    let t = tour([stop('s1', 1), stop('s2', 2)]);
    t = addTextOverlay(t, 's1', 'A note');
    t = addTextOverlay(t, 's2', 'A note');
    const ids = t.stops.flatMap((s) => s.overlays.map((o) => o.id));
    expect(new Set(ids).size).toBe(2);
  });

  it('keeps an id stable when the title changes', () => {
    let t = addTextOverlay(tour(), 's1', 'Original');
    const id = t.stops[0].overlays[0].id;
    t = updateOverlay(t, id, { title: 'Renamed entirely' });
    expect(t.stops[0].overlays[0].id).toBe(id);
    expect(t.stops[0].overlays[0].title).toBe('Renamed entirely');
  });

  it('deletes an overlay', () => {
    const t = tour([stop('s1', 1, [overlay('o1'), overlay('o2')])]);
    expect(deleteOverlay(t, 'o1').stops[0].overlays.map((o) => o.id)).toEqual(['o2']);
  });

  it('does not mutate its input', () => {
    const t = tour([stop('s1', 1, [overlay('o1')])]);
    const before = JSON.stringify(t);
    updateOverlay(t, 'o1', { title: 'Changed' });
    deleteOverlay(t, 'o1');
    expect(JSON.stringify(t)).toBe(before);
  });
});

describe('kind and display mode', () => {
  it('offers only legal modes', () => {
    expect(legalModesFor('text')).toEqual(['marker']);
    expect([...legalModesFor('image')].sort()).toEqual(['inWorld', 'marker']);
    expect([...legalModesFor('audio')].sort()).toEqual(['ambient', 'marker']);
  });

  it('coerces an illegal mode when the kind changes', () => {
    // An inWorld image switched to text cannot stay inWorld: the backend
    // rejects the pair, so the draft would be unsaveable.
    const t = tour([stop('s1', 1, [overlay('o1', {
      kind: 'image', body: null, mediaId: 'p.jpg',
      display: { mode: 'inWorld', opacity: 0.7, headingDeg: 284.4, widthM: 18, heightM: 12 },
    })])]);
    const out = setOverlayKind(t, 'o1', 'text');
    expect(out.stops[0].overlays[0].display.mode).toBe('marker');
  });

  it('leaves a mode alone when it is already legal for the new kind', () => {
    const t = tour([stop('s1', 1, [overlay('o1', {
      kind: 'audio', body: null, mediaId: 'a.m4a',
      display: { mode: 'marker', icon: 'audio' },
    })])]);
    expect(setOverlayKind(t, 'o1', 'image').stops[0].overlays[0].display.mode).toBe('marker');
  });
});

describe('deriveHeading', () => {
  it('points an overlay back at the panorama that views it', () => {
    // Panorama due south of the anchor: the face must look south, 180 degrees.
    expect(deriveHeading({ lng: -77.3, lat: 38.846 }, { lng: -77.3, lat: 38.845 }))
      .toBeCloseTo(180, 1);
  });

  it('returns a value in [0, 360)', () => {
    const h = deriveHeading({ lng: -77.3, lat: 38.845 }, { lng: -77.3, lat: 38.846 });
    expect(h).toBeGreaterThanOrEqual(0);
    expect(h).toBeLessThan(360);
  });
});

describe('defaultCreditFor', () => {
  it('uses the tour defaults', () => {
    expect(defaultCreditFor(tour())).toEqual({
      type: 'original', creator: 'M. Harrington', license: 'CC-BY-4.0',
    });
  });

  it('falls back to something valid when the tour has no defaults', () => {
    const credit = defaultCreditFor({ ...tour(), defaults: null });
    expect(credit.type).toBe('original');
    expect((credit as { creator: string }).creator.trim().length).toBeGreaterThan(0);
  });
});
```

- [ ] **Step 2: Run them and watch them fail**

Run: `make frontend-test`
Expected: FAIL — `Cannot find module './document-ops'`.

- [ ] **Step 3: Implement `document-ops.ts`**

Every function takes a document and returns a new one. Nothing mutates its
input: the undo stack keeps references to previous documents, and a mutation
would corrupt history retroactively.

```typescript
/**
 * Pure transforms over a tour document.
 *
 * Every function here returns a new document and never mutates its input. The
 * undo stack holds references to previous documents, so an in-place change
 * would rewrite history as well as the present.
 *
 * These exist as free functions rather than methods on the store so the
 * editor's whole logic can be tested without Angular, a map, or a browser —
 * which matters here more than usual, because no browser runs in this
 * project's development environment at all.
 */
import { bearingBetween, type LngLatLike } from '../core/geo';
import type {
  Credit, Display, Overlay, OverlayKind, Stop, Tour,
} from '../core/tour.models';

export type DisplayMode = Display['mode'];

/**
 * Mirrors DISPLAY_MODES_BY_KIND in backend/app/models.py. A rejection is a
 * renderer limitation, not a limit of the model. The backend validates the
 * same table; a test asserts the two agree, so this copy cannot drift silently.
 */
export const DISPLAY_MODES_BY_KIND: Readonly<Record<OverlayKind, readonly DisplayMode[]>> = {
  text: ['marker'],
  image: ['marker', 'inWorld'],
  audio: ['marker', 'ambient'],
};

export function legalModesFor(kind: OverlayKind): readonly DisplayMode[] {
  return DISPLAY_MODES_BY_KIND[kind];
}

export class LastStopError extends Error {
  constructor() {
    // Tour.stops has min_length=1. Producing an empty tour would make the
    // draft unsaveable, which is a worse failure than refusing the delete.
    super('a tour must have at least one stop');
    this.name = 'LastStopError';
  }
}

export function slugify(text: string): string {
  const slug = text
    .toLowerCase()
    .replace(/['’]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return slug || 'untitled';
}

/** Append a numeric suffix until the id is free. Ids are stable once set. */
export function uniqueId(base: string, taken: Iterable<string>): string {
  const used = new Set(taken);
  if (!used.has(base)) return base;
  for (let n = 2; ; n += 1) {
    const candidate = `${base}-${n}`;
    if (!used.has(candidate)) return candidate;
  }
}

function allIds(tour: Tour): string[] {
  return [
    ...tour.stops.map((s) => s.id),
    ...tour.stops.flatMap((s) => s.overlays.map((o) => o.id)),
  ];
}

export function renumberStops(stops: Stop[]): Stop[] {
  return stops.map((s, i) => ({ ...s, order: i + 1 }));
}

export function addStop(tour: Tour, title: string): Tour {
  const id = uniqueId(slugify(title), allIds(tour));
  const last = tour.stops[tour.stops.length - 1];
  const stop: Stop = {
    id, order: tour.stops.length + 1, title,
    summary: 'Describe this place.',
    // Start where the previous stop is: an author adds the next stop near the
    // last one far more often than at the origin, and (0, 0) is in the ocean.
    location: last ? { ...last.location } : { lng: 0, lat: 0 },
    osmRef: null,
    panorama: last
      ? { ...last.panorama }
      : { provider: 'mapillary', imageId: '0', bearing: 0, cachedPath: null },
    overlays: [],
  };
  return { ...tour, stops: renumberStops([...tour.stops, stop]) };
}

export function deleteStop(tour: Tour, stopId: string): Tour {
  const remaining = tour.stops.filter((s) => s.id !== stopId);
  if (remaining.length === 0) throw new LastStopError();
  return { ...tour, stops: renumberStops(remaining) };
}

export function moveStop(tour: Tour, stopId: string, delta: number): Tour {
  const from = tour.stops.findIndex((s) => s.id === stopId);
  if (from < 0) return tour;
  const to = from + delta;
  if (to < 0 || to >= tour.stops.length) return tour; // clamp, do not throw
  const stops = [...tour.stops];
  const [moved] = stops.splice(from, 1);
  stops.splice(to, 0, moved);
  return { ...tour, stops: renumberStops(stops) };
}

export function defaultCreditFor(tour: Tour): Credit {
  return {
    type: 'original',
    creator: tour.defaults?.creator?.trim() || 'Unknown',
    license: tour.defaults?.license?.trim() || 'All rights reserved',
  };
}

export function addTextOverlay(tour: Tour, stopId: string, title: string): Tour {
  const id = uniqueId(slugify(title), allIds(tour));
  const stop = tour.stops.find((s) => s.id === stopId);
  if (!stop) return tour;
  const overlay: Overlay = {
    id, kind: 'text',
    anchor: { type: 'geo', lng: stop.location.lng, lat: stop.location.lat, altitudeM: 2 },
    display: { mode: 'marker', icon: 'note' },
    title,
    // Placeholder rather than empty: a text overlay needs a non-blank body to
    // validate, and an invalid draft cannot be saved.
    body: 'Write something about this.',
    mediaId: null,
    credit: defaultCreditFor(tour),
  };
  return mapStop(tour, stopId, (s) => ({ ...s, overlays: [...s.overlays, overlay] }));
}

export function deleteOverlay(tour: Tour, overlayId: string): Tour {
  return {
    ...tour,
    stops: tour.stops.map((s) => ({
      ...s, overlays: s.overlays.filter((o) => o.id !== overlayId),
    })),
  };
}

export function updateOverlay(
  tour: Tour, overlayId: string, patch: Partial<Overlay>,
): Tour {
  // `id` is deliberately not patchable: the document references overlays by
  // id, and a renaming author does not expect their links to move. Copy and
  // delete rather than destructure-and-discard, which trips noUnusedLocals.
  const safe: Partial<Overlay> = { ...patch };
  delete (safe as { id?: string }).id;
  return {
    ...tour,
    stops: tour.stops.map((s) => ({
      ...s,
      overlays: s.overlays.map((o) => (o.id === overlayId ? { ...o, ...safe } : o)),
    })),
  };
}

export function setOverlayKind(tour: Tour, overlayId: string, kind: OverlayKind): Tour {
  return {
    ...tour,
    stops: tour.stops.map((s) => ({
      ...s,
      overlays: s.overlays.map((o) => {
        if (o.id !== overlayId) return o;
        const legal = legalModesFor(kind);
        const display = legal.includes(o.display.mode)
          ? o.display
          : defaultDisplayFor(kind, o);
        return { ...o, kind, display };
      }),
    })),
  };
}

function defaultDisplayFor(kind: OverlayKind, previous: Overlay): Display {
  const icon = kind === 'image' ? 'photo' : kind === 'audio' ? 'audio' : 'note';
  if (legalModesFor(kind).includes('marker')) return { mode: 'marker', icon };
  // Unreachable today — every kind can be a marker — but the table is the
  // authority, not this assumption, so fall back to the kind's first legal mode.
  return previous.display;
}

function mapStop(tour: Tour, stopId: string, fn: (s: Stop) => Stop): Tour {
  return { ...tour, stops: tour.stops.map((s) => (s.id === stopId ? fn(s) : s)) };
}

/**
 * The compass direction an in-world overlay's face must look to meet the
 * panorama that views it.
 *
 * Derived, never typed. Every hand-authored bearing in this project's history
 * was wrong, one by 138 degrees, which put the subject behind the viewer.
 */
export function deriveHeading(anchor: LngLatLike, panorama: LngLatLike): number {
  const bearing = bearingBetween(anchor, panorama);
  return ((bearing % 360) + 360) % 360;
}
```

- [ ] **Step 4: Run the tests**

Run: `make frontend-test`
Expected: PASS. Fix until green.

- [ ] **Step 5: Write the failing `EditorStore` tests, then implement it**

`EditorStore` is an injectable holding signals: `draft` (`Tour | null`),
`selectedId` (`string | null`), `dirty`, `lastError` (`string | null`), and a
capped undo stack. It exposes `load(tour)`, `apply(fn: (t: Tour) => Tour)`,
`select(id)`, `undo()`, `canUndo`, and computed `selectedOverlay`,
`selectedStop`, `currentStop`.

Create `frontend/src/app/editor/editor-store.spec.ts`. Reuse the `tour`,
`stop` and `overlay` builders from `document-ops.spec.ts` by exporting them
from a small shared `test-builders.ts`, rather than copying them.

```typescript
import { beforeEach, describe, expect, it } from 'vitest';
import { EditorStore, UNDO_DEPTH } from './editor-store';
import { addTextOverlay, deleteOverlay, deleteStop, updateOverlay } from './document-ops';
import { overlay, stop, tour } from './test-builders';

describe('EditorStore', () => {
  let store: EditorStore;
  beforeEach(() => { store = new EditorStore(); });

  it('starts with no draft and nothing selected', () => {
    expect(store.draft()).toBeNull();
    expect(store.selectedId()).toBeNull();
    expect(store.dirty()).toBe(false);
    expect(store.canUndo()).toBe(false);
  });

  it('loads a document without marking it dirty', () => {
    store.load(tour());
    expect(store.draft()?.id).toBe('t');
    expect(store.dirty()).toBe(false);
  });

  it('applies a transform and marks the draft dirty', () => {
    store.load(tour());
    store.apply((t) => addTextOverlay(t, 's1', 'A note'));
    expect(store.draft()!.stops[0].overlays).toHaveLength(1);
    expect(store.dirty()).toBe(true);
  });

  it('does not mutate the document it was handed', () => {
    const original = tour();
    const snapshot = JSON.stringify(original);
    store.load(original);
    store.apply((t) => addTextOverlay(t, 's1', 'A note'));
    expect(JSON.stringify(original)).toBe(snapshot);
  });

  it('undo restores the previous document exactly', () => {
    store.load(tour());
    const before = JSON.stringify(store.draft());
    store.apply((t) => addTextOverlay(t, 's1', 'A note'));
    expect(JSON.stringify(store.draft())).not.toBe(before);
    store.undo();
    expect(JSON.stringify(store.draft())).toBe(before);
  });

  it('pushes one undo entry per applied transform', () => {
    store.load(tour());
    store.apply((t) => addTextOverlay(t, 's1', 'One'));
    store.apply((t) => addTextOverlay(t, 's1', 'Two'));
    store.undo();
    expect(store.draft()!.stops[0].overlays.map((o) => o.title)).toEqual(['One']);
    store.undo();
    expect(store.draft()!.stops[0].overlays).toHaveLength(0);
    expect(store.canUndo()).toBe(false);
  });

  it('caps the undo stack so a long session cannot grow without bound', () => {
    store.load(tour());
    for (let i = 0; i < UNDO_DEPTH + 10; i += 1) {
      store.apply((t) => updateOverlay(t, 'nothing', { title: `t${i}` }));
    }
    let depth = 0;
    while (store.canUndo()) { store.undo(); depth += 1; }
    expect(depth).toBe(UNDO_DEPTH);
  });

  it('clears the selection when the selected overlay is deleted', () => {
    store.load(tour([stop('s1', 1, [overlay('o1')])]));
    store.select('o1');
    store.apply((t) => deleteOverlay(t, 'o1'));
    expect(store.selectedId()).toBeNull();
  });

  it('clears the selection when the stop containing it is deleted', () => {
    store.load(tour([stop('s1', 1, [overlay('o1')]), stop('s2', 2)]));
    store.select('o1');
    store.apply((t) => deleteStop(t, 's1'));
    expect(store.selectedId()).toBeNull();
  });

  it('keeps a selection that still exists', () => {
    store.load(tour([stop('s1', 1, [overlay('o1'), overlay('o2')])]));
    store.select('o2');
    store.apply((t) => deleteOverlay(t, 'o1'));
    expect(store.selectedId()).toBe('o2');
  });

  it('keeps the draft intact when a transform throws', () => {
    store.load(tour([stop('only', 1)]));
    const before = JSON.stringify(store.draft());
    store.apply((t) => deleteStop(t, 'only'));
    expect(JSON.stringify(store.draft())).toBe(before);
    expect(store.canUndo()).toBe(false);
  });

  it('records the message when a transform throws', () => {
    store.load(tour([stop('only', 1)]));
    store.apply((t) => deleteStop(t, 'only'));
    expect(store.lastError()).toMatch(/at least one stop/);
  });

  it('clears a previous error on the next successful transform', () => {
    store.load(tour([stop('only', 1)]));
    store.apply((t) => deleteStop(t, 'only'));
    store.apply((t) => addTextOverlay(t, 'only', 'A note'));
    expect(store.lastError()).toBeNull();
  });
});
```

Two rules the tests above pin, both easy to get wrong:

- **The dangling-selection rule** (Review Focus item 5): after any `apply`, if
  `selectedId` no longer names a stop or overlay in the draft, clear it. All
  three surfaces read the selection, so a dangling id breaks them together.
- **`apply` catches.** A `LastStopError` becomes `lastError`, not an exception
  escaping into a click handler. A throwing transform must leave the draft and
  the undo stack untouched — a failed edit is not an edit.

- [ ] **Step 6: Assert the mode table against the backend**

Add to `backend/tests/test_models.py`:

```python
def test_the_frontend_mode_table_matches_this_one():
    """frontend/src/app/editor/document-ops.ts carries a copy of
    DISPLAY_MODES_BY_KIND so the editor can offer only legal modes without a
    round trip. Two copies of a rule drift; this fails when they do."""
    src = (Path(__file__).resolve().parents[2] / "frontend" / "src" / "app"
           / "editor" / "document-ops.ts").read_text()
    block = src.split("DISPLAY_MODES_BY_KIND", 1)[1].split("}", 1)[0]
    for kind, modes in DISPLAY_MODES_BY_KIND.items():
        line = next(ln for ln in block.splitlines() if ln.strip().startswith(kind))
        for mode in modes:
            assert f"'{mode}'" in line, f"{kind} should allow {mode}"
        for mode in {"marker", "inWorld", "ambient"} - set(modes):
            assert f"'{mode}'" not in line, f"{kind} should not allow {mode}"
```

Confirm `Path` and `DISPLAY_MODES_BY_KIND` are imported in that file.

- [ ] **Step 7: Verify and commit**

Run: `make check`
Expected: green, counts up, bundle unchanged (this task adds no imports).

```bash
git add frontend/src/app/editor backend/tests/test_models.py
git commit -m "$(cat <<'EOF'
Add the editor's document transforms and draft store

Every document change is a pure function returning a new document, and
EditorStore holds the draft, selection and undo stack as plain signals.
No DOM, no HTTP, no map — which is what makes the editor's logic
testable in an environment where no browser can run.

The display-mode table is mirrored from the backend so the editor can
offer only legal modes without a round trip, with a test that fails if
the two copies drift.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 2: Routing, loading and autosave

**Files:**
- Modify: `frontend/src/app/app.config.ts` (add `provideRouter`)
- Create: `frontend/src/app/app.routes.ts`
- Modify: `frontend/src/app/app.ts`, `frontend/src/app/app.html` (host a `<router-outlet>`)
- Create: `frontend/src/app/editor/editor-page.ts` (shell only; panes arrive in tasks 3-5)
- Create: `frontend/src/app/editor/autosave.ts`, `autosave.spec.ts`
- Modify: `frontend/src/app/core/session-api.ts` (if it needs anything beyond `get`/`putTour`)

**Interfaces:**
- Consumes: `EditorStore`, `SessionApi.get()`, `SessionApi.putTour(doc)`, `TourApi.getTour()`.
- Produces: routes `''` → viewer, `'edit'` → `EditorPage`; `Autosave` service with `start()`, `flush()`, `status: Signal<'idle'|'saving'|'error'>`.

- [ ] **Step 1: Write the failing autosave tests**

The debounce and the error path are the whole of the logic, so test them
directly with a fake clock and a fake `SessionApi`:

```typescript
it('does not save until the debounce elapses', ...);
it('coalesces several rapid changes into one save', ...);
it('keeps the draft when the save is rejected', ...);      // Review Focus 4
it('surfaces the rejection message', ...);
it('retries on the next change after a rejection', ...);   // must not deadlock
it('reports saving then idle around a successful save', ...);
it('does not save when there is no draft', ...);
```

- [ ] **Step 2: Run them and watch them fail**

Run: `make frontend-test`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement routing, the shell and autosave**

`app.routes.ts` maps `''` to the existing viewer component and `'edit'` to
`EditorPage`, both lazily where that costs nothing. `app.config.ts` gains
`provideRouter(routes)`.

`EditorPage` on init: `SessionApi.get()`. If no tour is open, render a short
explanation and a **New tour** action rather than an error — nothing being
open is a normal state, not a failure. Otherwise `TourApi.getTour()` into
`EditorStore.load()`.

`Autosave` subscribes to the store's `dirty` signal, debounces (500 ms is a
reasonable default; name the constant), and `PUT`s the whole document. On
422 it records the message and leaves the draft alone. A later change retries.

**The viewer must keep working unchanged.** `real-tour.spec.ts` is the guard.

- [ ] **Step 4: Prove an editor-produced document is acceptable to the backend**

The frontend's idea of a valid document is not evidence. Add to
`backend/tests/test_session_api.py` a test that takes the **skeleton** a new
session produces, applies the same shapes the editor's transforms produce — a
second stop, a text overlay with an `original` credit — and `PUT`s it,
asserting 200. This is the contract the editor depends on and it belongs in
the backend suite.

- [ ] **Step 5: Verify and commit**

Run: `make check`
Expected: green. Report the bundle size — the router is new in the graph.

```bash
git add frontend/src backend/tests/test_session_api.py
git commit -m "$(cat <<'EOF'
Add the /edit route, document loading and debounced autosave

A rejected save keeps the draft and retries on the next change, so a
validation error never costs the author their work.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 3: The outline and the inspector

**Files:**
- Create: `frontend/src/app/editor/outline-pane.ts`, `.css`, `.spec.ts`
- Create: `frontend/src/app/editor/inspector-pane.ts`, `.css`, `.spec.ts`
- Modify: `frontend/src/app/editor/editor-page.ts` (compose them)

**Interfaces:** consumes `EditorStore` and every transform from Task 1.

- [ ] **Step 1: Write the failing component tests**

Outline: lists stops in `order` with their overlays; clicking selects; add
stop, add text overlay, delete, move up/down; deleting the last stop shows the
refusal message rather than doing nothing silently; the add-image and
add-audio actions are **present but disabled**, with a note that they arrive
with media upload (the spec requires showing them rather than hiding them).

Inspector: reflects the selection; numeric fields for `lng`, `lat`,
`altitudeM`, and — when the display mode is `inWorld` — `headingDeg`,
`widthM`, `heightM`, `opacity`; text fields for title, body and credit; a kind
selector offering only `legalModesFor` the chosen kind; a **Derive heading
from panorama** action; and a visible marker when the heading has been
manually overridden.

Use `@angular/forms` for the numeric fields. Assert on rendered DOM and on
store state after interaction, not on internals.

- [ ] **Step 2: Run, fail, implement, run**

Run: `make frontend-test` at each stage.

- [ ] **Step 3: Verify and commit**

Run: `make check`

```bash
git add frontend/src/app/editor
git commit -m "$(cat <<'EOF'
Add the editor's outline and numeric inspector

The inspector is the third surface on the same state: nudge until it
looks right, or type the exact value, without the two competing.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 4: The editable map pane

**Files:**
- Create: `frontend/src/app/editor/edit-map-pane.ts`, `.css`, `.spec.ts`
- Create: `frontend/src/app/editor/footprint.ts`, `footprint.spec.ts`
- Modify: `frontend/src/app/editor/editor-page.ts`

**Interfaces:**
- Produces: `footprintCorners(anchor, headingDeg, widthM): [LngLatLike, LngLatLike]` — the two ends of the line an in-world plane occupies on the ground, and `rotationHandleAt(anchor, headingDeg, offsetM): LngLatLike`.

- [ ] **Step 1: Write the failing footprint tests**

This is the pure part and carries the verification weight:

```typescript
it('draws a footprint perpendicular to the heading', ...);
it('scales the footprint with widthM', ...);
it('puts the rotation handle in front of the face', ...);
it('is stable across the antimeridian and at high latitude', ...);  // or document the limit
```

Reuse the metres-to-degrees arithmetic already in `align-mode.ts` rather than
writing a second copy — extract it if it is not already exported.

- [ ] **Step 2: Implement the pane**

A Leaflet map showing: every overlay in the current stop as a draggable
marker; the current stop's panorama position and a field-of-view wedge for
orientation; for the selected in-world overlay, its footprint line and a
rotation handle. Dragging a marker applies a position update; dragging the
handle applies a heading update **and marks the heading manually overridden**.

Follow `map/map-pane.ts`'s existing patterns for Leaflet lifecycle; it already
solves container sizing and teardown in this codebase.

- [ ] **Step 3: Verify and commit**

Run: `make check`

```bash
git add frontend/src/app/editor
git commit -m "$(cat <<'EOF'
Add the editable map pane

Position and heading are set here, where a top-down view can actually
show them, and every overlay in the stop is visible at once.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 5: The editable panorama pane, and retiring `?align=1`

**Files:**
- Create: `frontend/src/app/editor/edit-panorama-pane.ts`, `.css`, `.spec.ts`
- Modify: `frontend/src/app/editor/editor-page.ts`
- Delete: `frontend/src/app/align/align-mode.ts`, `align-mode.spec.ts`
- Move: `nudgeAnchor`, `STEP_M`, `STEP_DEG` and the metre conversions into `frontend/src/app/editor/nudge.ts` (with their tests), since they are the correct arithmetic and are already proven
- Modify: `frontend/src/app/app.ts`, `app.html` (drop the `?align=1` branch)

- [ ] **Step 1: Move the reducer and its tests first, green at each step**

`git mv` where possible so history follows. Run `make frontend-test` after the
move and before anything else changes, to prove the move alone broke nothing.

- [ ] **Step 2: Write the failing pane tests, then implement**

The pane renders the panorama with the stop's overlays, and for the selected
in-world overlay supports keyboard nudging (the moved reducer), altitude and
size adjustment, and the existing opacity control.

**`triggerRerender()` after every scene mutation.** mapillary-js renders on
demand: without it nothing visibly changes, and a screenshot taken after
mutating the scene shows a stale frame. This has already produced two wrong
root-cause conclusions in this project's history, and an editor mutates the
scene far more often than the viewer does. Assert it through the existing
`FakeViewer`.

- [ ] **Step 3: Confirm `?align=1` is gone**

```bash
grep -rn "align=1\|AlignMode\|align-mode" frontend/src docs README.md || echo "clean"
```
Anything left in `docs/` or `README.md` is Task 6's to update; code must be clean.

- [ ] **Step 4: Verify and commit**

Run: `make check`

```bash
git add -A frontend/src
git commit -m "$(cat <<'EOF'
Add the editable panorama pane and retire ?align=1

The stopgap keyboard mode existed for exactly this job; keeping two
placement mechanisms would mean two to maintain and two to disagree.
Its nudge arithmetic was correct and is kept, tests and all.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 6: Record the decisions and sweep the docs

**Files:**
- Create: `docs/decisions/0003-the-editor-is-three-surfaces-on-one-state.md`
- Modify: `docs/HANDOFF.md`, `README.md`, `docs/ENVIRONMENT.md` as the sweep requires

- [ ] **Step 1: Write the decision record**

Follow the format `docs/decisions/README.md` sets. Cover: why three surfaces
each own distinct properties rather than all of them being fully editable
(inverse-projecting a panorama drag needs an invisible depth assumption); why
`EditorStore` is separate from `TourStore`; why undo is whole-document
snapshots; why the manual-heading-override flag is editor state and never
reaches the document; and why `?align=1` was retired rather than kept.

- [ ] **Step 2: Sweep**

```bash
grep -n "align=1\|alignment mode\|rephoto alignment" README.md docs/HANDOFF.md docs/ENVIRONMENT.md
```

`docs/HANDOFF.md`'s outstanding item 1 told the author to use `?align=1`. That
mode is gone; the item should now point at `/edit`. Judge whether the item can
be closed or only reworded — **it can only be closed by the author actually
aligning the photographs in a browser**, which cannot happen in this
environment, so reword rather than close.

Update test counts and the state line. Add the editor to "Running it".

- [ ] **Step 3: Verify and commit**

Run: `make check`

```bash
git add docs README.md
git commit -m "$(cat <<'EOF'
Record why the editor is three surfaces on one state

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```
