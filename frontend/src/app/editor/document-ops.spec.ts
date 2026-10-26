import { describe, expect, it } from 'vitest';
import {
  LastStopError, addStop, addTextOverlay, defaultCreditFor, deleteOverlay,
  deleteStop, deriveHeading, legalModesFor, moveStop, renumberStops,
  setOverlayKind, slugify, uniqueId, updateOverlay,
  creditText, deriveOverlayHeading, setOverlayHeadingManual, setCreditText, setInWorldField, setOverlayAnchor, setOverlayMode, setStopTitle, legalKindsFor,
} from './document-ops';
import { overlay, stop, tour } from './test-builders';

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

describe('inspector helpers', () => {
  // DECOY: the stop's location is deliberately far from the panorama fix. The
  // panorama stands where the camera car drove, the stop is the building, and
  // deriving from the stop once pointed a photograph 178 degrees backwards.
  // With the two apart, any code path that reads stop.location gives a
  // different heading and fails loudly instead of passing by coincidence.
  const STOP_LOC = { lng: -77.5, lat: 38.7 };
  const PANO = { imageId: 'img-1', lng: -77.31, lat: 38.85 };
  const ANCHOR = { type: 'geo' as const, lng: -77.3, lat: 38.84, altitudeM: 2 };
  const IMG = () => overlay('o1', {
    kind: 'image', mediaId: 'p.jpg', anchor: { ...ANCHOR },
    display: { mode: 'marker', icon: 'photo' },
  });
  const t = (loc = STOP_LOC) => tour([stop('s1', 1, [IMG()], { location: loc })]);
  const get = (x: ReturnType<typeof tour>) => x.stops[0].overlays[0];
  const heading = (x: ReturnType<typeof tour>) => (get(x).display as { headingDeg: number }).headingDeg;
  const inWorldTour = () => setOverlayMode(t(), 'o1', 'inWorld', PANO);
  const frozen = <T,>(x: T): string => JSON.stringify(x);

  it('the decoy really is far from the panorama fix', () => {
    expect(deriveHeading(ANCHOR, STOP_LOC)).not.toBeCloseTo(deriveHeading(ANCHOR, PANO), 0);
  });

  it('patches the anchor without mutating the input', () => {
    const before = t();
    const snap = frozen(before);
    const after = setOverlayAnchor(before, 'o1', { lng: -77.1 });
    expect(get(after).anchor.lng).toBe(-77.1);
    expect(frozen(before)).toBe(snap);
  });

  it('rejects non-finite and out-of-range anchor values by identity', () => {
    const x = t();
    expect(setOverlayAnchor(x, 'o1', { lng: NaN })).toBe(x);
    expect(setOverlayAnchor(x, 'o1', { lat: 91 })).toBe(x);
    expect(setOverlayAnchor(x, 'o1', { lng: -181 })).toBe(x);
    expect(setOverlayAnchor(x, 'o1', { altitudeM: Infinity })).toBe(x);
  });

  it('entering inWorld derives the heading from the fix, not the stop', () => {
    const x = inWorldTour();
    expect(get(x).display.mode).toBe('inWorld');
    expect(heading(x)).toBeCloseTo(deriveHeading(ANCHOR, PANO), 9);
  });

  it('the derived heading is unchanged when stop.location changes', () => {
    const a = deriveOverlayHeading(inWorldTour(), 'o1', PANO);
    const moved = tour([stop('s1', 1, [get(inWorldTour())], { location: { lng: -77.1, lat: 38.95 } })]);
    const b = deriveOverlayHeading(moved, 'o1', PANO);
    expect(heading(a)).toBeCloseTo(deriveHeading(ANCHOR, PANO), 9);
    expect(heading(b)).toBe(heading(a));
  });

  it('refuses to enter inWorld with no fix or a fix for another panorama, by identity', () => {
    const x = t();
    expect(setOverlayMode(x, 'o1', 'inWorld', null)).toBe(x);
    expect(setOverlayMode(x, 'o1', 'inWorld', { ...PANO, imageId: 'other' })).toBe(x);
  });

  it('refuses a mode that is illegal for the kind, by identity', () => {
    const base = tour([stop('s1', 1, [overlay('o1')])]);
    expect(setOverlayMode(base, 'o1', 'inWorld', { ...PANO })).toBe(base);
  });

  it('an overlay already inWorld keeps its heading when the position is unknown', () => {
    const x = setInWorldField(inWorldTour(), 'o1', { headingDeg: 77 });
    expect(deriveOverlayHeading(x, 'o1', null)).toBe(x);
    expect(heading(x)).toBe(77);
  });

  it('derive refuses a fix belonging to a different panorama, by identity', () => {
    const x = inWorldTour();
    expect(deriveOverlayHeading(x, 'o1', { ...PANO, imageId: 'previous-pano' })).toBe(x);
  });

  it('re-derives from the fix after the anchor moves', () => {
    let x = setInWorldField(inWorldTour(), 'o1', { headingDeg: 1 });
    x = setOverlayAnchor(x, 'o1', { lat: 38.841 });
    x = deriveOverlayHeading(x, 'o1', PANO);
    expect(heading(x)).toBeCloseTo(deriveHeading({ ...ANCHOR, lat: 38.841 }, PANO), 9);
  });

  it('setInWorldField ignores non-inWorld overlays, by identity', () => {
    const x = t();
    expect(setInWorldField(x, 'o1', { widthM: 9 })).toBe(x);
  });

  it('setInWorldField validates, clamps and normalises, without mutating', () => {
    const x = inWorldTour();
    const snap = frozen(x);
    expect(setInWorldField(x, 'o1', { widthM: 0 })).toBe(x);
    expect(setInWorldField(x, 'o1', { heightM: -2 })).toBe(x);
    expect(setInWorldField(x, 'o1', { opacity: NaN })).toBe(x);
    const d = get(setInWorldField(x, 'o1', { opacity: 3, headingDeg: 370 })).display as
      { opacity: number; headingDeg: number };
    expect(d.opacity).toBe(1);
    expect(d.headingDeg).toBe(10);
    expect(frozen(x)).toBe(snap);
  });

  it('mode and derive transforms do not mutate their input', () => {
    const x = t(); const snap = frozen(x);
    const y = setOverlayMode(x, 'o1', 'inWorld', PANO);
    const snapY = frozen(y);
    deriveOverlayHeading(y, 'o1', PANO);
    expect(frozen(x)).toBe(snap);
    expect(frozen(y)).toBe(snapY);
  });

  it('edits credit text for original and sourced credits, without mutating', () => {
    const x = t(); const snap = frozen(x);
    const y = setCreditText(x, 'o1', 'New Name');
    expect(creditText(get(y).credit)).toBe('New Name');
    expect(frozen(x)).toBe(snap);
    const s = tour([stop('s1', 1, [overlay('o1', {
      credit: { type: 'sourced', source: 'LoC', url: 'http://x', license: 'PD', creator: null } })])]);
    expect(creditText(get(setCreditText(s, 'o1', 'NARA')).credit)).toBe('NARA');
  });

  it('setStopTitle does not mutate', () => {
    const x = t(); const snap = frozen(x);
    expect(setStopTitle(x, 's1', 'Renamed').stops[0].title).toBe('Renamed');
    expect(frozen(x)).toBe(snap);
  });

  it('legalKindsFor offers image and audio only when media is attached', () => {
    expect(legalKindsFor(overlay('a'))).toEqual(['text']);
    expect(legalKindsFor(overlay('a', { mediaId: 'm.jpg' }))).toEqual(['text', 'image', 'audio']);
    // the current kind stays listed even if the data is odd
    expect(legalKindsFor(overlay('a', { kind: 'image', mediaId: null }))).toEqual(['text', 'image']);
  });

  it('regression: courthouse 1863 derives from the real panorama (about 105, not 283)', () => {
    // DECOY: stop.location is the building, 38.7 m from the camera. Deriving
    // from it gives about 283, facing exactly backwards; from the real
    // panorama position it is about 105.
    const x = tour([stop('s1', 1, [overlay('o1', {
      kind: 'image', mediaId: 'c.jpg',
      anchor: { type: 'geo', lng: -77.30732, lat: 38.84562, altitudeM: 2 },
      display: { mode: 'inWorld', opacity: 0.8, headingDeg: 0, widthM: 4, heightM: 3 },
    })], { location: { lng: -77.30732, lat: 38.84562 } })]);
    const out = deriveOverlayHeading(x, 'o1', { imageId: 'img-1', lng: -77.306888, lat: 38.845534 });
    expect(heading(out)).toBeGreaterThan(100);
    expect(heading(out)).toBeLessThan(110);
  });
});

describe('setOverlayHeadingManual (the map rotation handle)', () => {
  const PANO = { imageId: 'img-1', lng: -77.3069, lat: 38.8455 };
  const build = () => tour([stop('s1', 1, [overlay('o1', {
    kind: 'image', mediaId: 'p.jpg',
    display: { mode: 'inWorld', opacity: 0.8, headingDeg: 10, widthM: 4, heightM: 3 },
  })])]);
  const heading = (t: ReturnType<typeof build>) =>
    (t.stops[0].overlays[0].display as { headingDeg: number }).headingDeg;

  it('sets the heading when the fix belongs to this stop panorama', () => {
    expect(heading(setOverlayHeadingManual(build(), 'o1', 123, PANO))).toBe(123);
  });

  it('normalises into [0, 360)', () => {
    expect(heading(setOverlayHeadingManual(build(), 'o1', -90, PANO))).toBe(270);
  });

  it('is refused (same reference) with no fix', () => {
    const t = build();
    expect(setOverlayHeadingManual(t, 'o1', 123, null)).toBe(t);
  });

  it('is refused for a fix that belongs to another panorama', () => {
    const t = build();
    expect(setOverlayHeadingManual(t, 'o1', 123, { ...PANO, imageId: 'img-2' })).toBe(t);
  });

  it('is refused for a non-finite heading and for a non-inWorld overlay', () => {
    const t = build();
    expect(setOverlayHeadingManual(t, 'o1', NaN, PANO)).toBe(t);
    const m = tour([stop('s1', 1, [overlay('o1')])]);
    expect(setOverlayHeadingManual(m, 'o1', 5, PANO)).toBe(m);
  });
});
